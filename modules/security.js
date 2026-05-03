/**
 * Security module
 * - Brute-force protection (per IP + per username) with progressive lockout
 * - Audit logging
 * - In-memory rate limiter for transient checks (low-overhead)
 */
const { run, get, all } = require("../database/db")

// Lockout policy
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const PROGRESSIVE_LOCKOUT_STEPS = [
  { failed: 5,  lockoutMs: 30 * 1000 },        // 30 s
  { failed: 8,  lockoutMs: 2 * 60 * 1000 },    // 2 min
  { failed: 12, lockoutMs: 15 * 60 * 1000 },   // 15 min
  { failed: 20, lockoutMs: 60 * 60 * 1000 },   // 1 h
]

function pickLockout(failedCount) {
  let step = null
  for (const s of PROGRESSIVE_LOCKOUT_STEPS) {
    if (failedCount >= s.failed) step = s
  }
  return step
}

async function recordAuthAttempt(ip, username, success) {
  try {
    await run(
      "INSERT INTO auth_attempts (ip, username, success, timestamp) VALUES (?, ?, ?, ?)",
      [String(ip || ""), String(username || "").toLowerCase(), success ? 1 : 0, Date.now()]
    )
  } catch (e) {
    // never block flow on logging issue
  }
}

/**
 * Returns { locked: boolean, remainingMs: number, failedRecent: number }.
 * Checks both IP and username buckets independently — the longest applies.
 */
async function checkLockout(ip, username) {
  const since = Date.now() - ATTEMPT_WINDOW_MS

  let ipFailed = 0, userFailed = 0
  try {
    const r1 = await get(
      "SELECT COUNT(*) as c FROM auth_attempts WHERE ip = ? AND success = 0 AND timestamp > ?",
      [String(ip || ""), since]
    )
    ipFailed = (r1 && r1.c) || 0
    if (username) {
      const r2 = await get(
        "SELECT COUNT(*) as c FROM auth_attempts WHERE username = ? AND success = 0 AND timestamp > ?",
        [String(username).toLowerCase(), since]
      )
      userFailed = (r2 && r2.c) || 0
    }
  } catch (e) {
    return { locked: false, remainingMs: 0, failedRecent: 0 }
  }

  const failed = Math.max(ipFailed, userFailed)
  const step = pickLockout(failed)
  if (!step) return { locked: false, remainingMs: 0, failedRecent: failed }

  // Determine when the most recent failed attempt was, then compute remainingMs
  const last = await get(
    `SELECT MAX(timestamp) as t FROM auth_attempts
     WHERE success = 0 AND timestamp > ? AND (ip = ? OR username = ?)`,
    [since, String(ip || ""), String(username || "").toLowerCase()]
  )
  const lastTs = (last && last.t) || 0
  const elapsed = Date.now() - lastTs
  const remainingMs = Math.max(0, step.lockoutMs - elapsed)
  return { locked: remainingMs > 0, remainingMs, failedRecent: failed }
}

async function logAudit(userId, event, ip, userAgent, meta) {
  try {
    await run(
      "INSERT INTO audit_log (user_id, event, ip, user_agent, meta, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      [
        userId || null,
        String(event || "").slice(0, 64),
        String(ip || "").slice(0, 64),
        String(userAgent || "").slice(0, 256),
        meta ? JSON.stringify(meta).slice(0, 1024) : null,
        Date.now(),
      ]
    )
  } catch (e) {
    // best-effort
  }
}

async function getAuditLog(userId, limit = 50) {
  return all(
    "SELECT id, event, ip, user_agent, meta, timestamp FROM audit_log WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
    [userId, Math.min(limit, 200)]
  )
}

// Periodic prune (keep 30 days of data)
const PRUNE_INTERVAL = 6 * 60 * 60 * 1000 // 6h
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
setInterval(() => {
  const cutoff = Date.now() - RETENTION_MS
  run("DELETE FROM auth_attempts WHERE timestamp < ?", [cutoff]).catch(() => {})
  run("DELETE FROM audit_log WHERE timestamp < ?", [cutoff]).catch(() => {})
}, PRUNE_INTERVAL).unref?.()

module.exports = {
  recordAuthAttempt,
  checkLockout,
  logAudit,
  getAuditLog,
}
