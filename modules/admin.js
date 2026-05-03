/**
 * Admin helpers.
 *
 * Authorization: handled upstream via session-based middleware (isAdmin).
 *
 * Tables are maintained by the versioned migration runner in database/migrate.js.
 */
const { run, get, all } = require("../database/db")

async function createReport(reporterId, reportedId, reason, details) {
  if (!reporterId || !reportedId || !reason) throw new Error("Missing fields")
  if (reporterId === reportedId) throw new Error("Cannot report yourself")
  await run(
    `INSERT INTO reports (reporter_id, reported_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?)`,
    [reporterId, reportedId, String(reason).slice(0, 80), (details || "").slice(0, 1000), Date.now()]
  )
}

async function listReports(status) {
  const where = status ? "WHERE r.status = ?" : ""
  const params = status ? [status] : []
  return await all(
    `SELECT r.*, u1.username AS reporter_username, u2.username AS target_username
     FROM reports r
     LEFT JOIN users u1 ON u1.id = r.reporter_id
     LEFT JOIN users u2 ON u2.id = r.reported_id
     ${where}
     ORDER BY r.created_at DESC LIMIT 200`,
    params
  )
}

async function resolveReport(id, resolution) {
  await run(
    "UPDATE reports SET status='resolved', resolved_at=?, resolution=? WHERE id=?",
    [Date.now(), resolution || "", id]
  )
}

async function listUsers(query) {
  if (query && query.length) {
    const q = "%" + String(query).toLowerCase() + "%"
    return await all(
      `SELECT id, username, code, created_at, banned_at, ban_reason
       FROM users WHERE LOWER(username) LIKE ? OR code LIKE ?
       ORDER BY created_at DESC LIMIT 100`,
      [q, q]
    )
  }
  return await all(
    `SELECT id, username, code, created_at, banned_at, ban_reason
     FROM users ORDER BY created_at DESC LIMIT 100`
  )
}

async function banUser(userId, reason) {
  await run("UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?", [Date.now(), reason || null, userId])
}
async function unbanUser(userId) {
  await run("UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = ?", [userId])
}

async function recentAudit(limit) {
  const lim = Math.min(parseInt(limit, 10) || 200, 1000)
  return await all(
    `SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.timestamp DESC LIMIT ?`,
    [lim]
  )
}

async function summary() {
  const [users, msgs, friends, openReports] = await Promise.all([
    get("SELECT COUNT(*) as c FROM users"),
    get("SELECT COUNT(*) as c FROM messages WHERE deleted_at IS NULL"),
    get("SELECT COUNT(*) as c FROM friends WHERE status='accepted'"),
    get("SELECT COUNT(*) as c FROM reports WHERE status='open' OR status IS NULL"),
  ])
  return {
    users: users ? users.c : 0,
    messages: msgs ? msgs.c : 0,
    friendships: friends ? friends.c : 0,
    openReports: openReports ? openReports.c : 0,
  }
}

async function isBanned(userId) {
  const r = await get("SELECT banned_at FROM users WHERE id = ?", [userId])
  return !!(r && r.banned_at)
}

module.exports = {
  createReport, listReports, resolveReport,
  listUsers, banUser, unbanUser, recentAudit, summary, isBanned,
}
