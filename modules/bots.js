/**
 * Bot framework.
 *
 * A "bot" is a special user (auto-created on registration) owned by a human user.
 * - Each bot has a long-lived API token (hashed in DB) and a set of scopes.
 * - Bots authenticate to /api/bots/messages (POST) using `Authorization: Bearer <token>`.
 * - Optional outgoing webhook: when a friend (the human user paired with the bot)
 *   sends a message addressed to the bot, the server forwards a JSON envelope to
 *   the configured webhook URL with an HMAC-SHA256 signature header.
 * - Bots cannot read other users' E2EE messages — they only see what is sent to
 *   *them* directly. The ciphertext field is forwarded as-is; the bot must
 *   negotiate keys via the normal friendship handshake.
 *
 * Scopes (string set):
 *   "messages:read"   - receive messages directed to the bot
 *   "messages:write"  - send messages to its owner / friends
 *   "friends:list"    - list its friend list
 *
 * Tables created lazily.
 */
const crypto = require("crypto")
const { run, get, all } = require("../database/db")

let initialised = false
async function init() {
  if (initialised) return
  await run(`CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    avatar TEXT,
    token_hash TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT 'messages:read,messages:write',
    webhook_url TEXT,
    webhook_secret TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE(user_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (owner_id) REFERENCES users(id)
  )`)
  await run(`CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id)`)
  initialised = true
}
init().catch(() => {})

function hashToken(t) {
  return crypto.createHash("sha256").update(t).digest("hex")
}

function generateToken() {
  // 256 bits, prefixed for easy recognition.
  return "scbot_" + crypto.randomBytes(32).toString("hex")
}

async function createBot(ownerId, name, description, avatar, scopes, webhookUrl) {
  if (!ownerId || !name) throw new Error("ownerId and name required")
  // Re-use users table: a bot is a user, but with is_bot flag added below by db migration.
  const auth = require("./auth")
  const safeName = String(name).slice(0, 32)
  const password = crypto.randomBytes(24).toString("hex") // not used to login
  const u = await auth.registerUser("bot_" + crypto.randomBytes(4).toString("hex") + "_" + safeName.toLowerCase().replace(/[^a-z0-9_]+/g, ""), password)
  const token = generateToken()
  const tokenHash = hashToken(token)
  const secret = crypto.randomBytes(24).toString("hex")
  const scopeStr = Array.isArray(scopes) ? scopes.join(",") : (scopes || "messages:read,messages:write")
  await run(
    `INSERT INTO bots (user_id, owner_id, name, description, avatar, token_hash, scopes, webhook_url, webhook_secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [u.id, ownerId, safeName, description || "", avatar || "", tokenHash, scopeStr, webhookUrl || null, secret, Date.now()]
  )
  return { id: u.id, code: u.code, username: u.username, name: safeName, token, scopes: scopeStr.split(","), webhookSecret: secret }
}

async function listBotsForOwner(ownerId) {
  return await all(
    `SELECT b.id as bot_id, b.user_id, b.name, b.description, b.avatar, b.scopes, b.webhook_url, b.created_at, b.last_used_at,
            u.username, u.code
     FROM bots b JOIN users u ON u.id = b.user_id
     WHERE b.owner_id = ? ORDER BY b.created_at DESC`,
    [ownerId]
  )
}

async function rotateToken(botUserId, ownerId) {
  const b = await get("SELECT id FROM bots WHERE user_id = ? AND owner_id = ?", [botUserId, ownerId])
  if (!b) throw new Error("Bot not found")
  const token = generateToken()
  await run("UPDATE bots SET token_hash = ? WHERE id = ?", [hashToken(token), b.id])
  return token
}

async function deleteBot(botUserId, ownerId) {
  const b = await get("SELECT id, user_id FROM bots WHERE user_id = ? AND owner_id = ?", [botUserId, ownerId])
  if (!b) throw new Error("Bot not found")
  // Wipe related data
  await run("DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?", [b.user_id, b.user_id])
  await run("DELETE FROM friends WHERE user_id = ? OR friend_id = ?", [b.user_id, b.user_id])
  await run("DELETE FROM bots WHERE id = ?", [b.id])
  await run("DELETE FROM users WHERE id = ?", [b.user_id])
}

async function authenticateBot(token) {
  if (!token) return null
  const h = hashToken(token)
  const b = await get(
    `SELECT b.*, u.username, u.code FROM bots b JOIN users u ON u.id = b.user_id WHERE b.token_hash = ?`,
    [h]
  )
  if (!b) return null
  await run("UPDATE bots SET last_used_at = ? WHERE id = ?", [Date.now(), b.id])
  return b
}

function botHasScope(bot, scope) {
  if (!bot || !bot.scopes) return false
  return bot.scopes.split(",").map(s => s.trim()).includes(scope)
}

async function findBotByUserId(userId) {
  return await get("SELECT * FROM bots WHERE user_id = ?", [userId])
}

/**
 * Fire-and-forget webhook delivery. Never throws.
 */
function deliverWebhook(bot, envelope) {
  if (!bot || !bot.webhook_url) return
  let url
  try { url = new URL(bot.webhook_url) } catch (e) { return }
  if (url.protocol !== "https:" && url.protocol !== "http:") return
  const body = JSON.stringify(envelope)
  const sig = crypto.createHmac("sha256", bot.webhook_secret || "").update(body).digest("hex")
  const lib = url.protocol === "https:" ? require("https") : require("http")
  const req = lib.request(
    {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "X-Bot-Signature": "sha256=" + sig,
        "X-Bot-Id": String(bot.user_id),
        "User-Agent": "PrivateChat-Bot/1.0",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 5000,
    },
    (res) => { res.resume() }
  )
  req.on("error", () => {})
  req.on("timeout", () => req.destroy())
  req.write(body)
  req.end()
}

module.exports = {
  createBot, listBotsForOwner, rotateToken, deleteBot,
  authenticateBot, botHasScope, findBotByUserId, deliverWebhook,
}
