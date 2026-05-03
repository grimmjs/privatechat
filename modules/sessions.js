/**
 * Active sessions — tracks per-device login records for remote logout.
 * Sessions expire after 30 days of inactivity by default.
 */
const crypto = require("crypto")
const { run, get, all } = require("../database/db")

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function newSessionId() {
  return crypto.randomBytes(24).toString("hex")
}

function deviceLabel(userAgent) {
  if (!userAgent) return "Unknown device"
  const ua = String(userAgent)
  if (/Android/i.test(ua)) return "Android"
  if (/iPhone|iPad|iOS/i.test(ua)) return "iOS"
  if (/Mac OS X/i.test(ua)) return "Mac"
  if (/Windows/i.test(ua)) return "Windows"
  if (/Linux/i.test(ua)) return "Linux"
  return ua.slice(0, 40)
}

async function createSession(userId, ip, userAgent, ttlMs = SESSION_TTL_MS) {
  const id = newSessionId()
  const now = Date.now()
  const expiresAt = now + ttlMs
  await run(
    "INSERT INTO sessions (id, user_id, device_label, ip, user_agent, created_at, last_seen, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
    [id, userId, deviceLabel(userAgent), ip || "", String(userAgent || "").slice(0, 240), now, now, expiresAt]
  )
  return id
}

async function touchSession(sessionId, ttlMs = SESSION_TTL_MS) {
  if (!sessionId) return
  await run("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?", [Date.now(), Date.now() + ttlMs, sessionId])
}

async function listSessions(userId) {
  return all(
    "SELECT id, device_label, ip, user_agent, created_at, last_seen, revoked FROM sessions WHERE user_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?) ORDER BY last_seen DESC",
    [userId, Date.now()]
  )
}

async function revokeSession(userId, sessionId) {
  await run("UPDATE sessions SET revoked = 1 WHERE id = ? AND user_id = ?", [sessionId, userId])
}

async function isRevoked(sessionId) {
  if (!sessionId) return false
  const row = await get("SELECT revoked, expires_at FROM sessions WHERE id = ?", [sessionId])
  if (!row) return true
  if (row.revoked) return true
  if (row.expires_at && row.expires_at < Date.now()) return true
  return false
}

// Periodic cleanup of expired sessions (every 6 hours)
setInterval(() => {
  run("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?", [Date.now()]).catch(() => {})
}, 6 * 60 * 60 * 1000)

module.exports = { createSession, touchSession, listSessions, revokeSession, isRevoked, deviceLabel }
