/**
 * Secure Chat Server - Main entry point
 * - Express serves static frontend and handles file uploads
 * - WebSocket handles real-time messaging
 * - SQLite for persistence
 * - Security headers, structured JSON logging, GDPR endpoints, /health and /metrics
 */
const express = require("express")
const http = require("http")
const path = require("path")
const fs = require("fs").promises
const { WebSocketServer } = require("ws")
const pino = require("pino")({ level: process.env.LOG_LEVEL || "info" })
const prom = require("prom-client")
const Sentry = require("@sentry/node")
const rateLimit = require("express-rate-limit")
const { RedisStore } = require("rate-limit-redis")

Sentry.init({
  dsn: process.env.SENTRY_DSN || "",
  tracesSampleRate: 1.0,
})

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({
  server,
  maxPayload: 15 * 1024 * 1024,
  clientTracking: true,
})

const PORT = process.env.PORT || 3000
const TRUST_PROXY = process.env.TRUST_PROXY === "1"

if (TRUST_PROXY) app.set("trust proxy", true)

// Initialize database and wait before starting listeners.
const { init: dbInit, isPg } = require("./database/db")

// ---- Prometheus metrics ----
const httpRequestDuration = new prom.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
})
const wsConnectionsGauge = new prom.Gauge({
  name: "websocket_connections_active",
  help: "Active WebSocket connections",
})
const messagesRelayedCounter = new prom.Counter({
  name: "messages_relayed_total",
  help: "Total messages relayed",
})
const filesUploadedCounter = new prom.Counter({
  name: "files_uploaded_total",
  help: "Total files uploaded",
})
const loginAttemptsCounter = new prom.Counter({
  name: "login_attempts_total",
  help: "Total login attempts",
  labelNames: ["result"],
})

prom.register.registerMetric(httpRequestDuration)
prom.register.registerMetric(wsConnectionsGauge)
prom.register.registerMetric(messagesRelayedCounter)
prom.register.registerMetric(filesUploadedCounter)
prom.register.registerMetric(loginAttemptsCounter)

// Legacy metrics object for WS handler compatibility
const metrics = {
  startedAt: Date.now(),
  httpRequests: 0,
  httpErrors: 0,
  messagesRelayed: 0,
  filesUploaded: 0,
  loginAttempts: 0,
  loginFailures: 0,
  get wsConnections() { return wss.clients.size },
}

// ---- Logger ----
const logger = pino

// ---- Security headers ----
app.use((req, res, next) => {
  if (req.secure || (TRUST_PROXY && req.headers["x-forwarded-proto"] === "https")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  }
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(self), microphone=(self), payment=()")
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  )
  next()
})

// ---- Metrics middleware ----
app.use((req, res, next) => {
  metrics.httpRequests++
  const end = httpRequestDuration.startTimer()
  res.on("finish", () => {
    if (res.statusCode >= 400) metrics.httpErrors++
    end({ method: req.method, route: req.route?.path || req.path, status_code: res.statusCode })
  })
  next()
})

// Body parsers
app.use(express.json({ limit: "20mb" }))
app.use(express.urlencoded({ extended: true, limit: "20mb" }))

// Serve frontend (admin.html excluded for session-based protection)
app.use(express.static(path.join(__dirname, "public"), {
  index: "index.html",
  maxAge: "5m",
  setHeaders: (res, filePath) => {
    if (/\.(js|css|svg|png|jpg|jpeg|webp|woff2?)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=300")
    }
  }
}))

// Rate Limiter
const { redis } = require("./modules/redis")
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  store: redis ? new RedisStore({ sendCommand: (...args) => redis.call(...args) }) : undefined,
  standardHeaders: true,
  legacyHeaders: false,
})
app.use("/api/auth", apiLimiter)
app.use("/api/admin", apiLimiter)

const filesModule = require("./modules/files")
const uploadsDir = filesModule.UPLOADS_DIR

// File upload endpoint (encrypted blob) — auth via X-Session-Id header
app.post("/api/upload", async (req, res) => {
  const { encryptedData, originalName, mimeType, senderId, receiverId } = req.body
  const sid = req.headers["x-session-id"]
  if (!sid) return res.status(401).json({ error: "Missing session" })

  if (!encryptedData || !senderId || !receiverId) {
    return res.status(400).json({ error: "Missing required fields" })
  }

  let fileBuffer
  try {
    fileBuffer = Buffer.from(encryptedData, "base64")
  } catch {
    return res.status(400).json({ error: "Invalid encrypted data" })
  }

  const friendsModule = require("./modules/friends")
  const sessions = require("./modules/sessions")
  const revoked = await sessions.isRevoked(sid)
  if (revoked) return res.status(401).json({ error: "Session revoked" })
  const isFriend = await friendsModule.areFriends(senderId, receiverId)
  if (!isFriend) return res.status(403).json({ error: "Access denied: not friends" })

  try {
    const { filename } = await filesModule.saveFile(fileBuffer, originalName)
    const timestamp = Date.now()
    await filesModule.recordFile(
      senderId, receiverId, filename, filesModule.safeBasename(originalName || "unknown"),
      fileBuffer.length, mimeType || "application/octet-stream",
      "", timestamp
    )
    filesUploadedCounter.inc()
    metrics.filesUploaded++
    res.json({ success: true, fileUrl: `/api/files/${encodeURIComponent(filename)}`, filename })
  } catch (err) {
    logger.warn({ err: err.message }, "Upload failed")
    res.status(500).json({ error: "Failed to save file: " + err.message })
  }
})

// File download (friend-only access + path traversal guard)
app.get("/api/files/:filename", async (req, res) => {
  const safe = filesModule.safeBasename(req.params.filename)
  const { userId, friendId } = req.query
  if (!userId || !friendId) return res.status(400).json({ error: "Missing userId or friendId" })
  const friendsModule = require("./modules/friends")
  const isFriend = await friendsModule.areFriends(userId, friendId)
  if (!isFriend) return res.status(403).json({ error: "Access denied" })
  const filepath = path.join(uploadsDir, safe)
  try {
    await fs.access(filepath)
    res.sendFile(path.resolve(filepath))
  } catch {
    res.status(404).json({ error: "File not found" })
  }
})

// Chat history API
app.get("/api/messages/:peerId", async (req, res) => {
  const { userId } = req.query
  const { peerId } = req.params
  const { before } = req.query
  if (!userId || !peerId) return res.status(400).json({ error: "Missing userId or peerId" })
  const friendsModule = require("./modules/friends")
  const isFriend = await friendsModule.areFriends(userId, peerId)
  if (!isFriend) return res.status(403).json({ error: "Access denied" })
  const chatModule = require("./modules/chat")
  const beforeTs = before ? parseInt(before) : Date.now()
  const messages = await chatModule.getChatHistory(userId, peerId, beforeTs, 50)
  // Attach reactions
  const ids = messages.map(m => m.id)
  const reactions = await chatModule.getReactionsForMessages(ids)
  const byMsg = new Map()
  reactions.forEach(r => {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, [])
    byMsg.get(r.message_id).push({ userId: r.user_id, emoji: r.emoji })
  })
  const out = messages.map(m => ({ ...m, reactions: byMsg.get(m.id) || [] }))
  res.json({ messages: out })
})

// ---- GDPR ----
app.get("/api/account/export", async (req, res) => {
  const { userId } = req.query
  if (!userId) return res.status(400).json({ error: "Missing userId" })
  const auth = require("./modules/auth")
  const user = await auth.getUserById(userId)
  if (!user) return res.status(404).json({ error: "Not found" })
  const friendsModule = require("./modules/friends")
  const friendsList = await friendsModule.getFriends(userId)
  const { all } = require("./database/db")
  const messages = await all(
    `SELECT id, sender_id, receiver_id, ciphertext, iv, timestamp, status, edited_at, deleted_at
     FROM messages WHERE sender_id = ? OR receiver_id = ? ORDER BY timestamp ASC`,
    [userId, userId]
  )
  const audit = await all(
    "SELECT event, ip, user_agent, meta, timestamp FROM audit_log WHERE user_id = ? ORDER BY timestamp DESC LIMIT 500",
    [userId]
  )
  res.setHeader("Content-Disposition", `attachment; filename="private-chat-export-${userId}.json"`)
  res.json({
    exportedAt: new Date().toISOString(),
    user: { id: user.id, username: user.username, code: user.code, createdAt: user.created_at },
    friends: friendsList,
    messages,
    audit,
    note: "Message ciphertext is end-to-end encrypted; without the derived key it cannot be decrypted.",
  })
})

app.delete("/api/account", async (req, res) => {
  const { userId, password } = req.body || {}
  if (!userId || !password) return res.status(400).json({ error: "Missing fields" })
  const auth = require("./modules/auth")
  const security = require("./modules/security")
  const user = await auth.getUserById(userId)
  if (!user) return res.status(404).json({ error: "Not found" })
  const ok = await auth.verifyPassword(password, user.password_salt, user.password_hash)
  if (!ok) return res.status(401).json({ error: "Wrong password" })

  const { run } = require("./database/db")
  // Soft-delete (tombstone) for GDPR compliance: preserve referential integrity
  await run("UPDATE users SET username = '[deleted]', bio = NULL, status_text = NULL, avatar = NULL, identity_pubkey = NULL, password_hash = NULL, password_salt = NULL, recovery_hash = NULL, recovery_salt = NULL, totp_secret = NULL, totp_enabled = 0, deleted_at = ? WHERE id = ?", [Date.now(), userId])
  // Wipe messages content but keep rows for tombstone display
  await run("UPDATE messages SET ciphertext = '', iv = '', deleted_at = ? WHERE sender_id = ? OR receiver_id = ?", [Date.now(), userId, userId])
  await run("DELETE FROM friends WHERE user_id = ? OR friend_id = ?", [userId, userId])
  await run("DELETE FROM reactions WHERE user_id = ?", [userId])
  await run("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?", [userId, userId])
  await run("DELETE FROM sessions WHERE user_id = ?", [userId])
  await security.logAudit(null, "account_deleted", req.ip, req.headers["user-agent"], { username: user.username })
  res.json({ success: true })
})

// VAPID public key for Web Push (frontend uses this when subscribing).
// If VAPID_PUBLIC_KEY is unset, push endpoint returns null and client falls back to in-app notifications.
app.get("/api/push/vapid", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null })
})


// ---- USER REPORTS (creates a moderation report visible to admin console) ----
app.post("/api/reports", async (req, res) => {
  const { userId, targetId, reason, details } = req.body || {}
  if (!userId || !targetId || !reason) return res.status(400).json({ error: "Missing fields" })
  try {
    await require("./modules/admin").createReport(userId, targetId, reason, details || "")
    res.json({ success: true })
  } catch (err) { res.status(400).json({ error: err.message }) }
})

// TURN/STUN servers for WebRTC (configurable via env).
// Default to public Google STUN. For production add a TURN server for NAT traversal.
app.get("/api/turn", (req, res) => {
  const iceServers = []
  const stun = (process.env.STUN_URLS || "stun:stun.l.google.com:19302").split(",").map(s => s.trim()).filter(Boolean)
  iceServers.push({ urls: stun })
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(",").map(s => s.trim()),
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || "",
    })
  }
  res.json({ iceServers })
})

// ---- Session helpers ----
async function requireAdminSession(req, res, next) {
  const sid = req.headers["x-session-id"] || req.query.sid
  if (!sid) {
    if (req.method === "GET" && !req.path.startsWith("/api/")) return res.status(403).send("Admin access denied")
    return res.status(401).json({ error: "Missing session" })
  }
  const sessions = require("./modules/sessions")
  const auth = require("./modules/auth")
  const { get } = require("./database/db")
  const revoked = await sessions.isRevoked(sid)
  if (revoked) return res.status(401).json({ error: "Session revoked" })
  const sess = await get("SELECT user_id FROM sessions WHERE id = ?", [sid])
  if (!sess) return res.status(401).json({ error: "Invalid session" })
  const isAdm = await auth.isAdmin(sess.user_id)
  if (!isAdm) return res.status(403).json({ error: "Admin only" })
  req.adminUserId = sess.user_id
  next()
}

// ---- ADMIN API ----
const adminGuard = requireAdminSession

// Protect admin HTML page
app.get("/admin.html", requireAdminSession, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"))
})

app.get("/api/admin/summary", adminGuard, async (req, res) => {
  res.json(await require("./modules/admin").summary())
})
app.get("/api/admin/users", adminGuard, async (req, res) => {
  res.json({ users: await require("./modules/admin").listUsers(req.query.q) })
})
app.post("/api/admin/users/ban", adminGuard, async (req, res) => {
  const { targetId, reason } = req.body || {}
  if (!targetId) return res.status(400).json({ error: "Missing targetId" })
  await require("./modules/admin").banUser(targetId, reason || "")
  res.json({ success: true })
})
app.post("/api/admin/users/unban", adminGuard, async (req, res) => {
  const { targetId } = req.body || {}
  if (!targetId) return res.status(400).json({ error: "Missing targetId" })
  await require("./modules/admin").unbanUser(targetId)
  res.json({ success: true })
})
app.get("/api/admin/reports", adminGuard, async (req, res) => {
  res.json({ reports: await require("./modules/admin").listReports(req.query.status) })
})
app.post("/api/admin/reports/resolve", adminGuard, async (req, res) => {
  const { id, resolution } = req.body || {}
  if (!id) return res.status(400).json({ error: "Missing id" })
  await require("./modules/admin").resolveReport(id, resolution || "")
  res.json({ success: true })
})
app.get("/api/admin/audit", adminGuard, async (req, res) => {
  res.json({ events: await require("./modules/admin").recentAudit(req.query.limit) })
})
app.get("/api/admin/metrics", adminGuard, (req, res) => {
  res.json({ ...metrics, uptime: Date.now() - metrics.startedAt, activeWsConnections: wss.clients.size })
})

// Health & readiness
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: Date.now() - metrics.startedAt })
})

app.get("/ready", async (req, res) => {
  const checks = { db: false, redis: false }
  try {
    const { run } = require("./database/db")
    await run("SELECT 1")
    checks.db = true
  } catch (e) {
    logger.error({ err: e.message }, " readiness db check failed")
  }
  try {
    const { redis } = require("./modules/redis")
    if (redis) {
      await redis.ping()
      checks.redis = true
    } else {
      checks.redis = true // no redis configured = ok
    }
  } catch (e) {
    logger.error({ err: e.message }, " readiness redis check failed")
  }
  const ok = checks.db && checks.redis
  res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "not ready", checks, uptime: Date.now() - metrics.startedAt })
})

app.get("/metrics", async (req, res) => {
  res.setHeader("Content-Type", prom.register.contentType)
  res.end(await prom.register.metrics())
})

// Static legal pages
app.get(["/privacy", "/privacy.html"], (req, res) =>
  res.sendFile(path.join(__dirname, "public", "privacy.html"))
)
app.get(["/terms", "/terms.html"], (req, res) =>
  res.sendFile(path.join(__dirname, "public", "terms.html"))
)

// Catch errors with Sentry
app.use((err, req, res, next) => {
  Sentry.captureException(err)
  next(err)
})

// 404 fallback for unknown API paths
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }))

// Periodic purge of expired (disappearing) messages.
setInterval(async () => {
  try {
    const { run } = require("./database/db")
    await run("DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?", [Date.now()])
  } catch (err) {
    logger.warn({ err: err.message }, "expire_cleanup_failed")
  }
}, 60 * 1000).unref?.()

// WebSocket handler
const { handleConnection } = require("./websocket/handler")
wss.on("connection", (ws, req) => {
  wsConnectionsGauge.inc()
  ws.on("close", () => wsConnectionsGauge.dec())
  handleConnection(ws, req, metrics)
})

// Start after DB is ready
async function start() {
  await dbInit()
  server.listen(PORT, () => {
    logger.info({ port: PORT, ws: true }, "Server listening")
  })
}
start().catch((err) => {
  logger.error(err, "Failed to start server")
  process.exit(1)
})

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down")
  wss.close(() => {
    server.close(() => {
      logger.info("Bye")
      process.exit(0)
    })
  })
})

module.exports = { metrics, logger }
