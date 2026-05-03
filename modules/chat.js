/**
 * Chat module - message persistence, edit/delete, reactions, status
 */
const { run, get, all } = require("../database/db")

async function saveMessage(senderId, receiverId, ciphertext, iv, timestamp, opts = {}) {
  const result = await run(
    `INSERT INTO messages (client_id, sender_id, receiver_id, ciphertext, iv, timestamp, status, reply_to_id, expires_at, kind, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.clientId || null,
      senderId,
      receiverId,
      ciphertext,
      iv,
      timestamp,
      opts.delivered ? "delivered" : "sent",
      opts.replyToId || null,
      opts.expiresAt || null,
      opts.kind || "text",
      opts.payload ? (typeof opts.payload === "string" ? opts.payload : JSON.stringify(opts.payload)) : null,
    ]
  )
  return result.lastID
}

async function getChatHistory(user1Id, user2Id, beforeTimestamp = Date.now(), limit = 50) {
  const rows = await all(
    `SELECT id, client_id, sender_id, receiver_id, ciphertext, iv, timestamp, status,
            reply_to_id, edited_at, deleted_at
     FROM messages
     WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
       AND timestamp < ?
     ORDER BY timestamp DESC
     LIMIT ?`,
    [user1Id, user2Id, user2Id, user1Id, beforeTimestamp, limit]
  )
  return rows.reverse()
}

async function getMessage(messageId) {
  return get("SELECT * FROM messages WHERE id = ?", [messageId])
}

async function markDelivered(messageId) {
  await run(
    "UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'sent'",
    [messageId]
  )
}

async function markRead(senderId, receiverId, upToTs) {
  await run(
    `UPDATE messages SET status = 'read'
     WHERE sender_id = ? AND receiver_id = ?
       AND status != 'read' AND timestamp <= ?`,
    [senderId, receiverId, upToTs]
  )
}

async function editMessage(messageId, senderId, ciphertext, iv) {
  const m = await get(
    "SELECT id FROM messages WHERE id = ? AND sender_id = ? AND deleted_at IS NULL",
    [messageId, senderId]
  )
  if (!m) throw new Error("Message not found or not editable")
  await run(
    "UPDATE messages SET ciphertext = ?, iv = ?, edited_at = ? WHERE id = ?",
    [ciphertext, iv, Date.now(), messageId]
  )
}

async function deleteMessage(messageId, requesterId, scope = "self") {
  const m = await getMessage(messageId)
  if (!m) throw new Error("Message not found")
  if (scope === "everyone") {
    if (m.sender_id !== requesterId) throw new Error("Only the sender can delete for everyone")
    await run("UPDATE messages SET deleted_at = ?, ciphertext = '', iv = '' WHERE id = ?", [Date.now(), messageId])
    return { scope: "everyone", message: m }
  }
  // self-only delete: best handled client-side by hiding; record nothing on the server.
  return { scope: "self", message: m }
}

async function addReaction(messageId, userId, emoji) {
  await run(
    "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)",
    [messageId, userId, String(emoji).slice(0, 8)]
  )
}

async function removeReaction(messageId, userId, emoji) {
  await run(
    "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
    [messageId, userId, String(emoji).slice(0, 8)]
  )
}

async function getReactionsForMessages(messageIds) {
  if (!messageIds || messageIds.length === 0) return []
  const placeholders = messageIds.map(() => "?").join(",")
  return all(
    `SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${placeholders})`,
    messageIds
  )
}

async function deleteAllForUser(userId) {
  await run("DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?", [userId, userId])
}

module.exports = {
  saveMessage,
  getChatHistory,
  getMessage,
  markDelivered,
  markRead,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
  getReactionsForMessages,
  deleteAllForUser,
}
