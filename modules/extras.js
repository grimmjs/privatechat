/**
 * Extras module — groups/channels, stickers (custom packs), push subscriptions.
 * Schema is created idempotently here so the file is self-contained.
 *
 * NOTE: group messages remain end-to-end encrypted client-side using a
 * symmetric "sender key" the creator distributes 1:1 to each member after
 * a successful X25519 ECDH handshake (handled in the client). The server
 * only relays opaque ciphertext.
 */
const crypto = require("crypto")
const { db, run, get, all } = require("../database/db")

// ---- Schema migrations (idempotent) ----
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      topic TEXT,
      kind TEXT NOT NULL DEFAULT 'group', -- 'group' | 'channel'
      owner_id TEXT NOT NULL,
      invite_code TEXT UNIQUE,
      created_at INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', -- 'owner' | 'admin' | 'member'
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      payload TEXT,
      reply_to_id INTEGER,
      timestamp INTEGER NOT NULL,
      edited_at INTEGER,
      deleted_at INTEGER,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
    )
  `)
  db.run("CREATE INDEX IF NOT EXISTS idx_group_messages_group_ts ON group_messages (group_id, timestamp)")

  db.run(`
    CREATE TABLE IF NOT EXISTS sticker_packs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cover TEXT,
      shared INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS stickers (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      data TEXT NOT NULL, -- data:image/* base64 (already cropped/edited client-side)
      label TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (pack_id) REFERENCES sticker_packs(id) ON DELETE CASCADE
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      ua TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.run("CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id)")
})

// ---- Helpers ----
function newId() {
  return crypto.randomBytes(8).toString("hex")
}
function newInviteCode() {
  return crypto.randomBytes(6).toString("base64url")
}

// ---- Groups ----
async function createGroup(ownerId, name, topic, kind = "group") {
  const id = newId()
  const inviteCode = newInviteCode()
  const now = Date.now()
  await run(
    "INSERT INTO groups (id, name, topic, kind, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, String(name).slice(0, 80), String(topic || "").slice(0, 240), kind === "channel" ? "channel" : "group", ownerId, inviteCode, now]
  )
  await run(
    "INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    [id, ownerId, now]
  )
  return getGroup(id)
}

async function getGroup(groupId) {
  return get("SELECT * FROM groups WHERE id = ?", [groupId])
}

async function listGroupsForUser(userId) {
  return all(
    `SELECT g.*, gm.role
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = ?
     ORDER BY g.created_at DESC`,
    [userId]
  )
}

async function listMembers(groupId) {
  return all(
    `SELECT u.id, u.username, u.code, u.avatar, gm.role, gm.joined_at
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ?`,
    [groupId]
  )
}

async function isMember(groupId, userId) {
  const r = await get(
    "SELECT 1 as ok FROM group_members WHERE group_id = ? AND user_id = ?",
    [groupId, userId]
  )
  return !!r
}

async function getRole(groupId, userId) {
  const r = await get(
    "SELECT role FROM group_members WHERE group_id = ? AND user_id = ?",
    [groupId, userId]
  )
  return r ? r.role : null
}

async function joinByInvite(userId, inviteCode) {
  const g = await get("SELECT * FROM groups WHERE invite_code = ?", [String(inviteCode || "")])
  if (!g) throw new Error("Invalid invite")
  // 100-member cap (groups). Channels are unlimited but read-only for members.
  if (g.kind === "group") {
    const cnt = await get("SELECT COUNT(*) as c FROM group_members WHERE group_id = ?", [g.id])
    if ((cnt && cnt.c) >= 100) throw new Error("Group is full (100)")
  }
  await run(
    "INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
    [g.id, userId, Date.now()]
  )
  return g
}

async function leaveGroup(groupId, userId) {
  await run("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", [groupId, userId])
}

async function setMemberRole(groupId, requesterId, targetId, role) {
  const reqRole = await getRole(groupId, requesterId)
  if (reqRole !== "owner" && reqRole !== "admin") throw new Error("Forbidden")
  if (!["admin", "member"].includes(role)) throw new Error("Invalid role")
  await run(
    "UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?",
    [role, groupId, targetId]
  )
}

async function saveGroupMessage(groupId, senderId, ciphertext, iv, opts = {}) {
  const ts = Date.now()
  const r = await run(
    `INSERT INTO group_messages (group_id, sender_id, ciphertext, iv, kind, payload, reply_to_id, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      groupId,
      senderId,
      ciphertext,
      iv,
      opts.kind || "text",
      opts.payload ? (typeof opts.payload === "string" ? opts.payload : JSON.stringify(opts.payload)) : null,
      opts.replyToId || null,
      ts,
    ]
  )
  return { id: r.lastID, timestamp: ts }
}

async function getGroupHistory(groupId, beforeTs = Date.now(), limit = 50) {
  const rows = await all(
    `SELECT id, sender_id, ciphertext, iv, kind, payload, reply_to_id, timestamp, edited_at, deleted_at
     FROM group_messages WHERE group_id = ? AND timestamp < ?
     ORDER BY timestamp DESC LIMIT ?`,
    [groupId, beforeTs, limit]
  )
  return rows.reverse()
}

// ---- Stickers ----
async function createPack(ownerId, name) {
  const id = newId()
  await run(
    "INSERT INTO sticker_packs (id, owner_id, name, shared, created_at) VALUES (?, ?, ?, 0, ?)",
    [id, ownerId, String(name || "Pack").slice(0, 60), Date.now()]
  )
  return id
}

async function listPacks(userId) {
  return all(
    "SELECT * FROM sticker_packs WHERE owner_id = ? OR shared = 1 ORDER BY created_at DESC",
    [userId]
  )
}

async function listStickers(packId) {
  return all("SELECT * FROM stickers WHERE pack_id = ? ORDER BY created_at ASC", [packId])
}

async function addSticker(packId, ownerId, dataUrl, label) {
  const pack = await get("SELECT owner_id FROM sticker_packs WHERE id = ?", [packId])
  if (!pack || pack.owner_id !== ownerId) throw new Error("Not your pack")
  if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(String(dataUrl || ""))) throw new Error("Invalid image data")
  if (dataUrl.length > 600 * 1024) throw new Error("Sticker too large (>600KB)")
  const id = newId()
  await run(
    "INSERT INTO stickers (id, pack_id, data, label, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, packId, dataUrl, String(label || "").slice(0, 40), Date.now()]
  )
  return id
}

async function deleteSticker(stickerId, ownerId) {
  const row = await get(
    `SELECT s.id FROM stickers s
     JOIN sticker_packs p ON p.id = s.pack_id
     WHERE s.id = ? AND p.owner_id = ?`,
    [stickerId, ownerId]
  )
  if (!row) throw new Error("Not found")
  await run("DELETE FROM stickers WHERE id = ?", [stickerId])
}

async function setPackShared(packId, ownerId, shared) {
  await run(
    "UPDATE sticker_packs SET shared = ? WHERE id = ? AND owner_id = ?",
    [shared ? 1 : 0, packId, ownerId]
  )
}

// ---- Push subscriptions (storage only; actual VAPID send is optional) ----
async function savePushSubscription(userId, sub, ua) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error("Invalid subscription")
  }
  await run(
    `INSERT OR REPLACE INTO push_subscriptions
       (id, user_id, endpoint, p256dh, auth, ua, created_at)
     VALUES (
       (SELECT id FROM push_subscriptions WHERE endpoint = ?),
       ?, ?, ?, ?, ?, ?
     )`,
    [sub.endpoint, userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(ua || "").slice(0, 240), Date.now()]
  )
}

async function deletePushSubscription(userId, endpoint) {
  await run("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?", [userId, endpoint])
}

async function listPushSubscriptions(userId) {
  return all("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?", [userId])
}

module.exports = {
  // groups
  createGroup, getGroup, listGroupsForUser, listMembers, isMember, getRole,
  joinByInvite, leaveGroup, setMemberRole, saveGroupMessage, getGroupHistory,
  // stickers
  createPack, listPacks, listStickers, addSticker, deleteSticker, setPackShared,
  // push
  savePushSubscription, deletePushSubscription, listPushSubscriptions,
}
