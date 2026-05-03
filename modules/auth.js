/**
 * Auth module — registration, login, recovery code, change username/password,
 * identity public-key storage. Passwords + recovery codes hashed with async scrypt + per-record salt.
 * First registered user becomes admin automatically.
 */
const crypto = require("crypto")
const util = require("util")
const { run, get, all, isPg } = require("../database/db")

const scrypt = util.promisify(crypto.scrypt)

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const RECOVERY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function generateUserId() {
  return crypto.randomBytes(16).toString("hex")
}

async function generateUserCode() {
  let retries = 0
  let code
  while (true) {
    if (retries++ > 1000) throw new Error("No available user codes")
    code = ""
    for (let i = 0; i < 8; i++) code += CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)]
    const existing = await get("SELECT id FROM users WHERE code = ?", [code])
    if (!existing) return code
  }
}

function generateRecoveryCode() {
  let raw = ""
  for (let i = 0; i < 24; i++) raw += RECOVERY_CHARS[crypto.randomInt(0, RECOVERY_CHARS.length)]
  return raw.match(/.{1,6}/g).join("-")
}

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString("hex")
  const buf = await scrypt(secret, salt, 64)
  return { salt, hash: Buffer.from(buf).toString("hex") }
}

async function verifySecret(secret, salt, expectedHash) {
  if (!salt || !expectedHash) return false
  try {
    const buf = await scrypt(secret, salt, 64)
    const a = Buffer.from(buf)
    const b = Buffer.from(expectedHash, "hex")
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

const hashPassword = hashSecret
const verifyPassword = verifySecret

async function getUserByUsername(username) {
  if (!username) return null
  const sql = isPg
    ? "SELECT * FROM users WHERE LOWER(username) = LOWER($1)"
    : "SELECT * FROM users WHERE username = ? COLLATE NOCASE"
  return get(sql, [username])
}

async function registerUser(username, password) {
  if (!username || !/^[A-Za-z0-9_.\- ]{2,24}$/.test(username)) throw new Error("Invalid username")
  if (!password || password.length < 6) throw new Error("Password must be at least 6 characters")
  const existing = await getUserByUsername(username)
  if (existing && existing.password_hash) throw new Error("Username already taken. Sign in instead.")

  // First user ever becomes admin
  const anyUser = await get("SELECT id FROM users LIMIT 1")
  const isAdmin = anyUser ? 0 : 1

  const id = generateUserId()
  const code = await generateUserCode()
  const { salt, hash } = await hashPassword(password)
  const recoveryCode = generateRecoveryCode()
  const recoveryHashed = await hashSecret(recoveryCode)
  await run(
    `INSERT INTO users (id, username, code, avatar, password_hash, password_salt, recovery_hash, recovery_salt, is_admin)
     VALUES (${isPg ? "$1,$2,$3,$4,$5,$6,$7,$8,$9" : "?,?,?,?,?,?,?,?,?"})`,
    [id, username, code, null, hash, salt, recoveryHashed.hash, recoveryHashed.salt, isAdmin]
  )
  return { id, username, code, avatar: null, recoveryCode, isAdmin: !!isAdmin }
}

async function loginUser(username, password) {
  if (!username || !password) throw new Error("Missing credentials")
  const user = await getUserByUsername(username)
  if (!user) throw new Error("User not found")
  if (!user.password_hash) throw new Error("Account has no password. Create a new account.")
  if (!(await verifyPassword(password, user.password_salt, user.password_hash))) throw new Error("Wrong password")
  return {
    id: user.id,
    username: user.username,
    code: user.code,
    avatar: user.avatar || null,
    totp_enabled: !!user.totp_enabled,
    is_admin: !!user.is_admin,
  }
}

async function recoverWithCode(username, recoveryCode) {
  if (!username || !recoveryCode) throw new Error("Missing fields")
  const user = await getUserByUsername(username)
  if (!user || !user.recovery_hash) throw new Error("No recovery available for this account")
  const normalized = String(recoveryCode).trim().toUpperCase().replace(/\s+/g, "")
  const candidates = [normalized, normalized.match(/.{1,6}/g)?.join("-") || normalized]
  let ok = false
  for (const c of candidates) { if (await verifySecret(c, user.recovery_salt, user.recovery_hash)) ok = true }
  if (!ok) throw new Error("Invalid recovery code")
  await run("UPDATE users SET recovery_hash = NULL, recovery_salt = NULL WHERE id = ?", [user.id])
  return { id: user.id, username: user.username, code: user.code }
}

async function rotateRecoveryCode(userId) {
  const code = generateRecoveryCode()
  const { salt, hash } = await hashSecret(code)
  await run("UPDATE users SET recovery_hash = ?, recovery_salt = ? WHERE id = ?", [hash, salt, userId])
  return code
}

async function changeUsername(userId, newUsername) {
  if (!newUsername || !/^[A-Za-z0-9_.\- ]{2,24}$/.test(newUsername)) throw new Error("Invalid username")
  const dup = await getUserByUsername(newUsername)
  if (dup && dup.id !== userId) throw new Error("Username already taken")
  await run("UPDATE users SET username = ? WHERE id = ?", [newUsername, userId])
  return newUsername
}

async function changePassword(userId, oldPassword, newPassword) {
  if (!newPassword || newPassword.length < 6) throw new Error("Password too short")
  const user = await getUserById(userId)
  if (!user) throw new Error("User not found")
  if (!(await verifyPassword(oldPassword, user.password_salt, user.password_hash))) throw new Error("Wrong current password")
  const { salt, hash } = await hashPassword(newPassword)
  await run("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?", [hash, salt, userId])
}

async function setIdentityPubkey(userId, pubkey) {
  if (!pubkey) return
  await run("UPDATE users SET identity_pubkey = ? WHERE id = ?", [String(pubkey).slice(0, 256), userId])
}

async function getUserByCode(code) {
  return get("SELECT * FROM users WHERE code = ?", [String(code || "").toUpperCase()])
}

async function getUserById(id) {
  return get("SELECT * FROM users WHERE id = ?", [id])
}

async function updateAvatar(userId, avatar) {
  await run("UPDATE users SET avatar = ? WHERE id = ?", [avatar || null, userId])
}

async function setTotpSecret(userId, secret) {
  await run("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?", [secret, userId])
}
async function enableTotp(userId) {
  await run("UPDATE users SET totp_enabled = 1 WHERE id = ?", [userId])
}
async function disableTotp(userId) {
  await run("UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?", [userId])
}

async function isAdmin(userId) {
  if (!userId) return false
  const u = await get("SELECT is_admin FROM users WHERE id = ?", [userId])
  return !!(u && u.is_admin)
}

module.exports = {
  generateUserId,
  generateUserCode,
  registerUser,
  loginUser,
  recoverWithCode,
  rotateRecoveryCode,
  changeUsername,
  changePassword,
  setIdentityPubkey,
  getUserByCode,
  getUserById,
  getUserByUsername,
  updateAvatar,
  setTotpSecret,
  enableTotp,
  disableTotp,
  hashPassword,
  verifyPassword,
  isAdmin,
}
