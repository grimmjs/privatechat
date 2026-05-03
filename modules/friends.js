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
      "INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted') ON CONFLICT (user_id, friend_id) DO UPDATE SET status = EXCLUDED.status",
      [userId, target.id]
    )
    return { status: 'accepted', target }
  }

  // Create pending request: one row where user_id = sender, friend_id = receiver
  await run(
    "INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'pending') ON CONFLICT (user_id, friend_id) DO UPDATE SET status = EXCLUDED.status",
    [userId, target.id]
  )
  return { status: 'pending', target }
}

async function acceptFriendRequest(userId, fromId) {
  if (!fromId) throw new Error("Richiesta non valida")
  if (!userId) throw new Error("User ID mancante")

  console.log("[friends] acceptFriendRequest: userId=", userId, "fromId=", fromId)

  // Validate both users exist
  const userExists = await get("SELECT id FROM users WHERE id = ?", [userId])
  const fromUserExists = await get("SELECT id FROM users WHERE id = ?", [fromId])
  
  if (!userExists) {
    console.error("[friends] userId non esiste:", userId)
    throw new Error("User non trovato")
  }
  if (!fromUserExists) {
    console.error("[friends] fromId non esiste:", fromId)
    throw new Error("Utente che ha inviato la richiesta non trovato")
  }

  // Check the request exists (fromId requested userId)
  let req = await get(
    "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
    [fromId, userId]
  )
  console.log("[friends] cercata richiesta (fromId->userId):", !!req)

  if (!req) {
    // Try opposite direction
    req = await get(
      "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
      [userId, fromId]
    )
    console.log("[friends] cercata richiesta opposta (userId->fromId):", !!req)

    if (req) {
      // Reverse request exists - accept it
      console.log("[friends] accettando richiesta opposta")
      await run(
        "UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ?",
        [userId, fromId]
      )
      await run(
        "INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted') ON CONFLICT (user_id, friend_id) DO UPDATE SET status = EXCLUDED.status",
        [fromId, userId]
      )
      return
    }

    // Check if already friends
    const accepted1 = await get(
      "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'",
      [fromId, userId]
    )
    const accepted2 = await get(
      "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'",
      [userId, fromId]
    )
    console.log("[friends] già amici?", !!accepted1 || !!accepted2)

    if (accepted1 || accepted2) return // Already friends, idempotent

    // No pending request found - create friendship anyway
    console.log("[friends] nessuna richiesta trovata, creando amicizia diretta")
    await run(
      "INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted') ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted'",
      [fromId, userId]
    )
    await run(
      "INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted') ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted'",
      [userId, fromId]
    )
    return
  }

  // Found pending request in correct direction - accept it
  console.log("[friends] accettando richiesta nella direzione corretta")
  await run(
    "UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ?",
    [fromId, userId]
  )
  await run(
    "INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted') ON CONFLICT (user_id, friend_id) DO UPDATE SET status = EXCLUDED.status",
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
