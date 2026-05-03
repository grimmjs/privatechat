/**
 * Friends module - friend request system
 * Uses single row for pending, double rows for accepted (bidirectional)
 */
const { run, get, all } = require("../database/db")

async function sendFriendRequest(userId, targetCode) {
  const target = await get("SELECT * FROM users WHERE code = ?", [targetCode.toUpperCase()])
  if (!target) throw new Error("Codice non trovato")
  if (target.id === userId) throw new Error("Non puoi aggiungere te stesso")

  // Check if already friends (accepted in either direction)
  const existingFriend = await get(
    "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'",
    [userId, target.id]
  )
  if (existingFriend) throw new Error("Già amici")

  const existingFriend2 = await get(
    "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'",
    [target.id, userId]
  )
  if (existingFriend2) throw new Error("Già amici")

  // Check if user already sent a request to target
  const existingOutgoing = await get(
    "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
    [userId, target.id]
  )
  if (existingOutgoing) throw new Error("Richiesta già inviata")

  // Check if target already sent a request to user (reverse request)
  const existingIncoming = await get(
    "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
    [target.id, userId]
  )
  if (existingIncoming) {
    // Auto-accept: both sent requests to each other
    await run(
      "UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ?",
      [target.id, userId]
    )
    await run(
      "INSERT OR REPLACE INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted')",
      [userId, target.id]
    )
    return { status: 'accepted', target }
  }

  // Create pending request: one row where user_id = sender, friend_id = receiver
  await run(
    "INSERT OR REPLACE INTO friends (user_id, friend_id, status) VALUES (?, ?, 'pending')",
    [userId, target.id]
  )
  return { status: 'pending', target }
}

async function acceptFriendRequest(userId, fromId) {
  // Check the request exists (fromId requested userId)
  const req = await get(
    "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
    [fromId, userId]
  )
  if (!req) throw new Error("Richiesta non trovata")

  // Accept: update request row to accepted, and insert reverse row
  await run(
    "UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ?",
    [fromId, userId]
  )
  await run(
    "INSERT OR REPLACE INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted')",
    [userId, fromId]
  )
}

async function rejectFriendRequest(userId, fromId) {
  // Delete incoming pending request (fromId -> userId)
  await run(
    "DELETE FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
    [fromId, userId]
  )
}

async function cancelFriendRequest(userId, targetId) {
  // Cancel outgoing pending request (userId -> targetId)
  await run(
    "DELETE FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
    [userId, targetId]
  )
}

async function areFriends(userId, otherId) {
  const row = await get(
    "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'",
    [userId, otherId]
  )
  return !!row
}

async function getFriends(userId) {
  const rows = await all(
    "SELECT friend_id as id, username, code FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? AND f.status = 'accepted'",
    [userId]
  )
  return rows
}

module.exports = { sendFriendRequest, acceptFriendRequest, rejectFriendRequest, cancelFriendRequest, areFriends, getFriends }
