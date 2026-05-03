/**
 * Redis layer — rate limiting, sessions, presence, pub/sub.
 * Gracefully degrades to in-memory maps if REDIS_URL is absent.
 */
const process = require("process")

const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL || null
let redis = null
let connected = false

if (REDIS_URL) {
  try {
    const Redis = require("ioredis")
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
      tls: REDIS_URL.startsWith("rediss://") || REDIS_URL.includes("upstash") ? { rejectUnauthorized: false } : undefined,
    })
    redis.on("connect", () => { connected = true })
    redis.on("error", (err) => {
      // Log once to avoid spam; fallback works automatically.
      if (connected) {
        console.error("[Redis] connection error:", err.message)
        connected = false
      }
    })
    redis.connect().catch(() => {
      console.warn("[Redis] Unable to connect; falling back to in-memory maps.")
      redis = null
    })
  } catch (e) {
    console.warn("[Redis] ioredis not available; using in-memory fallback.")
    redis = null
  }
}

// ---- In-memory fallback maps ----
const memRateLimits = new Map() // key -> { lastReset, count }
const memSessions = new Map()   // sessionId -> { userId, expiresAt }
const memPresence = new Map()     // userId -> { lastSeen }

// ---- Rate limiter ----
async function checkRateLimit(key, maxPerMinute) {
  const now = Date.now()
  if (redis && connected) {
    const pipeline = redis.pipeline()
    pipeline.incr(`rl:${key}`)
    pipeline.pexpire(`rl:${key}`, 60000)
    const [[, count], [,]] = await pipeline.exec()
    return count <= maxPerMinute
  }
  const entry = memRateLimits.get(key) || { lastReset: now, count: 0 }
  if (now - entry.lastReset > 60000) {
    entry.lastReset = now
    entry.count = 0
  }
  entry.count++
  memRateLimits.set(key, entry)
  return entry.count <= maxPerMinute
}

// ---- Session store (TTL-based) ----
async function setSession(sessionId, userId, ttlSec = 86400) {
  const expiresAt = Date.now() + ttlSec * 1000
  if (redis && connected) {
    await redis.setex(`sess:${sessionId}`, ttlSec, JSON.stringify({ userId, expiresAt }))
  } else {
    memSessions.set(sessionId, { userId, expiresAt })
  }
}

async function getSession(sessionId) {
  if (redis && connected) {
    const raw = await redis.get(`sess:${sessionId}`)
    if (!raw) return null
    try {
      const obj = JSON.parse(raw)
      return obj.expiresAt > Date.now() ? obj : null
    } catch { return null }
  }
  const obj = memSessions.get(sessionId)
  if (!obj || obj.expiresAt < Date.now()) {
    memSessions.delete(sessionId)
    return null
  }
  return obj
}

async function delSession(sessionId) {
  if (redis && connected) {
    await redis.del(`sess:${sessionId}`)
  } else {
    memSessions.delete(sessionId)
  }
}

async function touchSession(sessionId, ttlSec = 86400) {
  if (redis && connected) {
    await redis.expire(`sess:${sessionId}`, ttlSec)
  }
}

// ---- Presence (lightweight) ----
async function setPresence(userId, online = true) {
  if (redis && connected) {
    if (online) {
      await redis.setex(`presence:${userId}`, 120, Date.now().toString())
    } else {
      await redis.del(`presence:${userId}`)
    }
  } else {
    if (online) memPresence.set(userId, { lastSeen: Date.now() })
    else memPresence.delete(userId)
  }
}

async function isPresent(userId) {
  if (redis && connected) {
    const val = await redis.get(`presence:${userId}`)
    return !!val
  }
  const p = memPresence.get(userId)
  if (p && Date.now() - p.lastSeen > 120000) {
    memPresence.delete(userId)
    return false
  }
  return !!p
}

// ---- Pub/Sub (cross-instance WebSocket relay) ----
function publish(channel, message) {
  if (redis && connected) {
    return redis.publish(channel, JSON.stringify(message))
  }
  return Promise.resolve(0)
}

function subscribe(channel, onMessage) {
  if (redis && connected) {
    const sub = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      tls: REDIS_URL.startsWith("rediss://") || REDIS_URL.includes("upstash") ? { rejectUnauthorized: false } : undefined,
    })
    sub.subscribe(channel, (err) => {
      if (err) console.error("[Redis] subscribe error:", err.message)
    })
    sub.on("message", (ch, msg) => {
      try { onMessage(JSON.parse(msg)) } catch {}
    })
    return () => sub.unsubscribe(channel).then(() => sub.disconnect())
  }
  return () => {}
}

// ---- Cleanup ----
setInterval(() => {
  const now = Date.now()
  for (const [k, e] of memRateLimits.entries()) {
    if (now - e.lastReset > 120000) memRateLimits.delete(k)
  }
  for (const [k, s] of memSessions.entries()) {
    if (s.expiresAt < now) memSessions.delete(k)
  }
  for (const [k, p] of memPresence.entries()) {
    if (now - p.lastSeen > 120000) memPresence.delete(k)
  }
}, 60000)

module.exports = {
  redis,
  checkRateLimit,
  setSession,
  getSession,
  delSession,
  touchSession,
  setPresence,
  isPresent,
  publish,
  subscribe,
}
