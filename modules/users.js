/**
 * Users module - user management
 */
const { get, all } = require("../database/db")
const auth = require("./auth")

function sanitize(str, max = 200) {
  if (typeof str !== "string") return ""
  return str.replace(/[<>]/g, "").trim().slice(0, max)
}

async function getPublicUser(userId) {
  const u = await get("SELECT id, username, code, avatar FROM users WHERE id = ?", [userId])
  if (!u) return null
  return { id: u.id, username: u.username, code: u.code, avatar: u.avatar || null }
}

async function getFriendList(userId) {
  const rows = await all(
    `SELECT u.id, u.username, u.code, u.avatar
     FROM friends f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ? AND f.status = 'accepted'`,
    [userId]
  )
  return rows
}

async function getPendingRequests(userId) {
  // Incoming requests: where user is the target (friend_id = userId) and status = 'pending'
  const rows = await all(
    `SELECT f.user_id as fromId, u.username as fromUsername, u.code as fromCode, u.avatar as fromAvatar
     FROM friends f
     JOIN users u ON u.id = f.user_id
     WHERE f.friend_id = ? AND f.status = 'pending'`,
    [userId]
  )
  return rows
}

async function getOutgoingPendingRequests(userId) {
  // Outgoing requests: where user is the sender (user_id = userId) and status = 'pending'
  const rows = await all(
    `SELECT f.friend_id as toId, u.username as toUsername, u.code as toCode, u.avatar as toAvatar
     FROM friends f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ? AND f.status = 'pending'`,
    [userId]
  )
  return rows
}

module.exports = { sanitize, getPublicUser, getFriendList, getPendingRequests, getOutgoingPendingRequests }
