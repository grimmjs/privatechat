/**
 * WebSocket handler — login/register/recover/2FA/sessions, messages, polls, files, audit.
 */
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const auth = require("../modules/auth")
const users = require("../modules/users")
const friends = require("../modules/friends")
const chat = require("../modules/chat")
const files = require("../modules/files")
const security = require("../modules/security")
const totp = require("../modules/totp")
const sessions = require("../modules/sessions")
const polls = require("../modules/polls")
const linkPreview = require("../modules/link-preview")
const extras = require("../modules/extras")

const UPLOADS_DIR = path.join(__dirname, "..", "uploads")

// userId -> Set<ws>
const onlineUsers = new Map()

function addOnline(userId, ws) {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set())
  onlineUsers.get(userId).add(ws)
}
function removeOnline(userId, ws) {
  const set = onlineUsers.get(userId)
  if (!set) return false
  set.delete(ws)
  if (set.size === 0) {
    onlineUsers.delete(userId)
    return true
  }
  return false
}
function isOnline(userId) {
  return onlineUsers.has(userId)
}
function sendToUser(userId, payload) {
  const set = onlineUsers.get(userId)
  if (!set) return false
  let any = false
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(payload))
        any = true
      } catch {}
    }
  }
  return any
}

const rateLimits = new Map()
function checkRateLimit(userId, type, maxPerMinute) {
  const now = Date.now()
  const key = `${userId}:${type}`
  const entry = rateLimits.get(key) || { lastReset: now, count: 0 }
  if (now - entry.lastReset > 60000) {
    entry.lastReset = now
    entry.count = 0
  }
  entry.count++
  rateLimits.set(key, entry)
  return entry.count <= maxPerMinute
}
setInterval(() => {
  const now = Date.now()
  for (const [k, e] of rateLimits.entries()) if (now - e.lastReset > 120000) rateLimits.delete(k)
}, 60000).unref?.()

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify({ type, ...payload }))
    } catch {}
  }
}

async function broadcastFriendUpdate(userId) {
  try {
    const [friendList, incomingReqs, outgoingReqs] = await Promise.all([
      users.getFriendList(userId),
      users.getPendingRequests(userId),
      users.getOutgoingPendingRequests(userId),
    ])
    const friendsWithStatus = friendList.map((f) => ({ ...f, online: isOnline(f.id) }))
    sendToUser(userId, {
      type: "friends_update",
      friends: friendsWithStatus,
      requests: incomingReqs,
      outgoingRequests: outgoingReqs,
    })
  } catch (err) {
    console.error("[WS] broadcastFriendUpdate error:", err.message)
  }
}

async function notifyFriendsStatus(userId, online) {
  try {
    const friendList = await users.getFriendList(userId)
    const t = online ? "friend_online" : "friend_offline"
    for (const f of friendList) sendToUser(f.id, { type: t, userId })
  } catch {}
}

function getRequestIp(req) {
  if (!req) return ""
  const fwd = req.headers["x-forwarded-for"]
  if (fwd) return String(fwd).split(",")[0].trim()
  return req.socket?.remoteAddress || ""
}

function findUrl(text) {
  if (!text || typeof text !== "string") return null
  const m = text.match(/https?:\/\/[^\s<>"]+/)
  return m ? m[0] : null
}

function handleConnection(ws, req, metrics) {
  let currentUserId = null
  let currentUsername = null
  let currentSessionId = null
  let pending2FA = null // { userId, username, code, avatar }
  const ip = getRequestIp(req)
  const userAgent = (req && req.headers["user-agent"]) || ""

  ws.isAlive = true
  ws.on("pong", () => (ws.isAlive = true))
  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return
    if (!ws.isAlive) {
      try {
        ws.terminate()
      } catch {}
      return
    }
    ws.isAlive = false
    try {
      ws.ping()
    } catch {}
  }, 30000)

  async function finalizeLogin(user) {
    currentUserId = user.id
    currentUsername = user.username
    currentSessionId = await sessions.createSession(user.id, ip, userAgent)
    addOnline(user.id, ws)
    await notifyFriendsStatus(user.id, true)
    send(ws, "registered", {
      id: user.id,
      username: user.username,
      code: user.code,
      avatar: user.avatar || null,
      restored: true,
      sessionId: currentSessionId,
      totpEnabled: !!user.totp_enabled,
    })
    await broadcastFriendUpdate(user.id)
  }

  ws.on("message", async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return send(ws, "error", { message: "Invalid JSON" })
    }

    // ---- REGISTER / SESSION RESTORE ----
    if (msg.type === "register") {
      if (currentUserId) return send(ws, "error", { message: "Already registered" })
      const username = users.sanitize(msg.username, 24)
      const password = typeof msg.password === "string" ? msg.password : ""
      const existingId = msg.existingId
      const sessionId = msg.sessionId

      try {
        if (existingId) {
          if (sessionId && (await sessions.isRevoked(sessionId))) {
            return send(ws, "session_revoked", {})
          }
          const user = await auth.getUserById(existingId)
          if (user) {
            currentUserId = user.id
            currentUsername = user.username
            currentSessionId = sessionId || (await sessions.createSession(user.id, ip, userAgent))
            await sessions.touchSession(currentSessionId)
            addOnline(user.id, ws)
            await notifyFriendsStatus(user.id, true)
            send(ws, "registered", {
              id: user.id,
              username: user.username,
              code: user.code,
              avatar: user.avatar || null,
              restored: true,
              sessionId: currentSessionId,
              totpEnabled: !!user.totp_enabled,
            })
            await broadcastFriendUpdate(user.id)
            await security.logAudit(user.id, "session_restore", ip, userAgent)
            return
          }
        }
        if (!username) return send(ws, "error", { message: "Invalid username" })
        const lock = await security.checkLockout(ip, username)
        if (lock.locked) {
          metrics && metrics.loginFailures++
          return send(ws, "error", {
            message: `Too many attempts. Retry in ${Math.ceil(lock.remainingMs / 1000)}s.`,
            lockoutRemainingMs: lock.remainingMs,
          })
        }
        const user = await auth.registerUser(username, password)
        await security.recordAuthAttempt(ip, username, true)
        await security.logAudit(user.id, "register", ip, userAgent)
        currentUserId = user.id
        currentUsername = user.username
        currentSessionId = await sessions.createSession(user.id, ip, userAgent)
        addOnline(user.id, ws)
        await notifyFriendsStatus(user.id, true)
        send(ws, "registered", {
          id: user.id,
          username: user.username,
          code: user.code,
          avatar: user.avatar || null,
          recoveryCode: user.recoveryCode,
          sessionId: currentSessionId,
          totpEnabled: false,
        })
        await broadcastFriendUpdate(user.id)
      } catch (err) {
        await security.recordAuthAttempt(ip, username, false)
        send(ws, "error", { message: err.message || "Registration failed" })
      }
      return
    }

    // ---- LOGIN (may require 2FA) ----
    if (msg.type === "login") {
      if (currentUserId) return send(ws, "error", { message: "Already logged in" })
      const username = users.sanitize(msg.username, 24)
      const password = typeof msg.password === "string" ? msg.password : ""
      metrics && metrics.loginAttempts++
      try {
        const lock = await security.checkLockout(ip, username)
        if (lock.locked) {
          metrics && metrics.loginFailures++
          await security.logAudit(null, "login_locked", ip, userAgent, { username })
          return send(ws, "error", {
            message: `Too many attempts. Retry in ${Math.ceil(lock.remainingMs / 1000)}s.`,
            lockoutRemainingMs: lock.remainingMs,
          })
        }
        const user = await auth.loginUser(username, password)
        await security.recordAuthAttempt(ip, username, true)
        if (user.totp_enabled) {
          pending2FA = user
          await security.logAudit(user.id, "login_2fa_required", ip, userAgent)
          return send(ws, "totp_required", {})
        }
        await security.logAudit(user.id, "login_success", ip, userAgent)
        await finalizeLogin(user)
      } catch (err) {
        metrics && metrics.loginFailures++
        await security.recordAuthAttempt(ip, username, false)
        await security.logAudit(null, "login_failure", ip, userAgent, {
          username,
          reason: err.message,
        })
        send(ws, "error", { message: err.message || "Login failed" })
      }
      return
    }

    // ---- TOTP VERIFY (after totp_required) ----
    if (msg.type === "totp_verify") {
      if (!pending2FA) return send(ws, "error", { message: "No pending login" })
      try {
        const u = await auth.getUserById(pending2FA.id)
        const ok = totp.verify(u.totp_secret, String(msg.token || ""))
        if (!ok) {
          await security.logAudit(u.id, "totp_failure", ip, userAgent)
          return send(ws, "error", { message: "Invalid 2FA code" })
        }
        await security.logAudit(u.id, "login_success", ip, userAgent)
        await finalizeLogin({
          id: u.id,
          username: u.username,
          code: u.code,
          avatar: u.avatar,
          totp_enabled: true,
        })
        pending2FA = null
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }

    // ---- ACCOUNT RECOVERY (single-use code) ----
    if (msg.type === "recover") {
      try {
        const username = users.sanitize(msg.username, 24)
        const code = String(msg.recoveryCode || "")
        const newPwd = String(msg.newPassword || "")
        if (newPwd.length < 6) throw new Error("Password too short")
        const lock = await security.checkLockout(ip, username)
        if (lock.locked) throw new Error("Too many attempts")
        const u = await auth.recoverWithCode(username, code)
        await auth.changePassword.call(null, u.id, "", newPwd).catch(async () => {
          // changePassword requires old; for recovery we set directly:
          const { run } = require("../database/db")
          const { salt, hash } = auth.hashPassword(newPwd)
          await run("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?", [
            hash,
            salt,
            u.id,
          ])
        })
        // Issue a fresh recovery code immediately.
        const newRecovery = await auth.rotateRecoveryCode(u.id)
        await security.logAudit(u.id, "account_recovered", ip, userAgent)
        send(ws, "recovered", { username: u.username, recoveryCode: newRecovery })
      } catch (err) {
        await security.recordAuthAttempt(ip, msg.username || "", false)
        send(ws, "error", { message: err.message || "Recovery failed" })
      }
      return
    }

    if (!currentUserId) return send(ws, "error", { message: "Not authenticated" })

    // touch session timestamp on any authenticated message (cheap)
    if (currentSessionId && Math.random() < 0.05) sessions.touchSession(currentSessionId).catch(() => {})

    // ---- AVATAR ----
    if (msg.type === "update_avatar") {
      try {
        const newAvatar =
          typeof msg.avatar === "string" && msg.avatar.length < 300000 ? msg.avatar : null
        await auth.updateAvatar(currentUserId, newAvatar)
        send(ws, "avatar_updated", { avatar: newAvatar })
        await broadcastFriendUpdate(currentUserId)
        const friendList = await users.getFriendList(currentUserId)
        for (const f of friendList) await broadcastFriendUpdate(f.id)
      } catch (err) {
        send(ws, "error", { message: "Avatar update failed: " + err.message })
      }
      return
    }

    // ---- PROFILE / PREFS ----
    if (msg.type === "update_profile") {
      try {
        const { run } = require("../database/db")
        const bio = users.sanitize(msg.bio || "", 240)
        const status = users.sanitize(msg.status || "", 80)
        await run("UPDATE users SET bio = ?, status_text = ? WHERE id = ?", [
          bio,
          status,
          currentUserId,
        ])
        send(ws, "profile_updated", { bio, status })
      } catch (err) {
        send(ws, "error", { message: "Profile update failed" })
      }
      return
    }
    if (msg.type === "update_prefs") {
      try {
        const { run } = require("../database/db")
        const accent = typeof msg.accent === "string" ? msg.accent.slice(0, 16) : null
        const wallpaper = typeof msg.wallpaper === "string" ? msg.wallpaper.slice(0, 32) : null
        const locale = typeof msg.locale === "string" ? msg.locale.slice(0, 8) : null
        await run(
          "UPDATE users SET accent_color = COALESCE(?, accent_color), wallpaper = COALESCE(?, wallpaper), locale = COALESCE(?, locale) WHERE id = ?",
          [accent, wallpaper, locale, currentUserId]
        )
        send(ws, "prefs_updated", { accent, wallpaper, locale })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }

    // ---- CHANGE PASSWORD / USERNAME ----
    if (msg.type === "change_password") {
      try {
        await auth.changePassword(currentUserId, String(msg.oldPassword || ""), String(msg.newPassword || ""))
        await security.logAudit(currentUserId, "password_changed", ip, userAgent)
        send(ws, "info", { message: "Password updated" })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "change_username") {
      try {
        const newName = await auth.changeUsername(currentUserId, users.sanitize(msg.username, 24))
        currentUsername = newName
        await security.logAudit(currentUserId, "username_changed", ip, userAgent, { newUsername: newName })
        send(ws, "username_changed", { username: newName })
        const friendList = await users.getFriendList(currentUserId)
        for (const f of friendList) await broadcastFriendUpdate(f.id)
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }

    // ---- IDENTITY PUBKEY (for safety-number) ----
    if (msg.type === "publish_pubkey") {
      try {
        await auth.setIdentityPubkey(currentUserId, msg.pubkey)
        // send(ws, "info", { message: "Public key saved" })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "get_pubkey") {
      try {
        const u = await auth.getUserById(msg.userId)
        send(ws, "pubkey", { userId: msg.userId, pubkey: u ? u.identity_pubkey : null })
      } catch {
        send(ws, "pubkey", { userId: msg.userId, pubkey: null })
      }
      return
    }

    // ---- 2FA SETUP ----
    if (msg.type === "totp_setup") {
      try {
        const secret = totp.generateSecret(20)
        await auth.setTotpSecret(currentUserId, secret)
        const u = await auth.getUserById(currentUserId)
        send(ws, "totp_setup", {
          secret,
          otpauthUrl: totp.buildOtpauthUrl(secret, u.username),
        })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "totp_enable") {
      try {
        const u = await auth.getUserById(currentUserId)
        if (!u.totp_secret) throw new Error("Run setup first")
        if (!totp.verify(u.totp_secret, String(msg.token || ""))) throw new Error("Invalid code")
        await auth.enableTotp(currentUserId)
        await security.logAudit(currentUserId, "2fa_enabled", ip, userAgent)
        send(ws, "totp_enabled", {})
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "totp_disable") {
      try {
        const u = await auth.getUserById(currentUserId)
        if (!auth.verifyPassword(String(msg.password || ""), u.password_salt, u.password_hash)) {
          throw new Error("Wrong password")
        }
        await auth.disableTotp(currentUserId)
        await security.logAudit(currentUserId, "2fa_disabled", ip, userAgent)
        send(ws, "totp_disabled", {})
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }

    // ---- SESSIONS ----
    if (msg.type === "list_sessions") {
      try {
        const list = await sessions.listSessions(currentUserId)
        send(ws, "sessions", {
          current: currentSessionId,
          sessions: list,
        })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "revoke_session") {
      try {
        await sessions.revokeSession(currentUserId, String(msg.sessionId || ""))
        await security.logAudit(currentUserId, "session_revoked", ip, userAgent, { sessionId: msg.sessionId })
        send(ws, "info", { message: "Session revoked" })
        // If user revoked their own current session, also disconnect.
        if (msg.sessionId === currentSessionId) {
          send(ws, "session_revoked", {})
          try {
            ws.close(4001, "Session revoked")
          } catch {}
        }
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "rotate_recovery") {
      try {
        const u = await auth.getUserById(currentUserId)
        if (!auth.verifyPassword(String(msg.password || ""), u.password_salt, u.password_hash)) {
          throw new Error("Wrong password")
        }
        const code = await auth.rotateRecoveryCode(currentUserId)
        await security.logAudit(currentUserId, "recovery_rotated", ip, userAgent)
        send(ws, "recovery_rotated", { recoveryCode: code })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }

    // ---- FRIENDS ----
    if (msg.type === "friend_request") {
      if (!checkRateLimit(currentUserId, "friend_request", 10))
        return send(ws, "error", { message: "Too many requests" })
      try {
        const targetCode = users.sanitize(msg.code, 16).toUpperCase()
        const result = await friends.sendFriendRequest(currentUserId, targetCode)
        if (result.status === "accepted") {
          send(ws, "info", { message: "Friend added" })
          await broadcastFriendUpdate(currentUserId)
          await broadcastFriendUpdate(result.target.id)
          await notifyFriendsStatus(currentUserId, true)
        } else {
          send(ws, "info", { message: "Request sent" })
          await broadcastFriendUpdate(currentUserId)
          await broadcastFriendUpdate(result.target.id)
        }
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "accept_request") {
      try {
        if (!msg.fromId) throw new Error("fromId mancante")
        console.log("[WS] accept_request: currentUserId=", currentUserId, "fromId=", msg.fromId, "type=", typeof msg.fromId)
        
        // Ensure IDs are strings
        const fromId = String(msg.fromId).trim()
        if (!fromId || fromId === "undefined") throw new Error("fromId non valido")
        
        await friends.acceptFriendRequest(currentUserId, fromId)
        console.log("[WS] accept_request SUCCESS")
        send(ws, "info", { message: "Request accepted" })
        await broadcastFriendUpdate(currentUserId)
        await broadcastFriendUpdate(fromId)
        await notifyFriendsStatus(currentUserId, true)
      } catch (err) {
        console.error("[WS] accept_request ERROR:", err.message, "stack:", err.stack)
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "reject_request") {
      try {
        await friends.rejectFriendRequest(currentUserId, msg.fromId)
        send(ws, "info", { message: "Request rejected" })
        await broadcastFriendUpdate(currentUserId)
        await broadcastFriendUpdate(msg.fromId)
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "cancel_request") {
      try {
        await friends.cancelFriendRequest(currentUserId, msg.targetId)
        send(ws, "info", { message: "Request cancelled" })
        await broadcastFriendUpdate(currentUserId)
        await broadcastFriendUpdate(msg.targetId)
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }

    // ---- BLOCK / UNBLOCK / REPORT ----
    if (msg.type === "block_user") {
      try {
        const { run } = require("../database/db")
        await run("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)", [
          currentUserId,
          msg.userId,
        ])
        send(ws, "info", { message: "User blocked" })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "unblock_user") {
      try {
        const { run } = require("../database/db")
        await run("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", [
          currentUserId,
          msg.userId,
        ])
        send(ws, "info", { message: "User unblocked" })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "list_blocks") {
      try {
        const { all } = require("../database/db")
        const rows = await all(
          `SELECT u.id, u.username, u.code FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?`,
          [currentUserId]
        )
        send(ws, "blocks_list", { blocks: rows })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "report_user") {
      try {
        const { run } = require("../database/db")
        await run(
          "INSERT INTO reports (reporter_id, reported_id, reason, details) VALUES (?, ?, ?, ?)",
          [
            currentUserId,
            msg.userId,
            users.sanitize(msg.reason || "", 80),
            users.sanitize(msg.details || "", 500),
          ]
        )
        await security.logAudit(currentUserId, "user_reported", ip, userAgent, { reportedId: msg.userId })
        send(ws, "info", { message: "Report submitted" })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }

    // ---- MESSAGE ----
    if (msg.type === "message") {
      if (!checkRateLimit(currentUserId, "message", 60))
        return send(ws, "error", { message: "Rate limit exceeded" })
      const toId = users.sanitize(msg.to, 64)
      try {
        const isFriend = await friends.areFriends(currentUserId, toId)
        if (!isFriend) return send(ws, "error", { message: "Not friends" })

        const timestamp = Date.now()
        const delivered = isOnline(toId)
        // Disappearing TTL (seconds) -> expires_at
        const ttlSec = parseInt(msg.ttlSec, 10)
        const expiresAt = Number.isFinite(ttlSec) && ttlSec > 0 ? timestamp + ttlSec * 1000 : null
        const messageId = await chat.saveMessage(
          currentUserId,
          toId,
          msg.ciphertext,
          msg.iv,
          timestamp,
          {
            clientId: msg.clientId,
            replyToId: msg.replyToId || null,
            delivered,
            expiresAt,
            kind: msg.kind || "text",
            payload: msg.payload || null,
          }
        )
        sendToUser(toId, {
          type: "message",
          id: messageId,
          from: currentUserId,
          fromUsername: currentUsername,
          ciphertext: msg.ciphertext,
          iv: msg.iv,
          replyToId: msg.replyToId || null,
          timestamp,
          expiresAt,
          kind: msg.kind || "text",
          payload: msg.payload || null,
        })
        send(ws, "message_sent", {
          id: messageId,
          to: toId,
          timestamp,
          clientId: msg.clientId || null,
          delivered,
          expiresAt,
        })
        metrics && metrics.messagesRelayed++
        // Send push notification if recipient offline (no ciphertext leaked).
        if (!delivered) {
          try {
            const push = require("../modules/push")
            push.sendToUser(toId, {
              title: currentUsername || "New message",
              body: "You have a new private message",
              tag: "msg:" + currentUserId,
              click_url: "/?from=" + encodeURIComponent(currentUserId),
            }).catch(() => {})
          } catch (_) {}
        }
      } catch (err) {
        send(ws, "error", { message: "Message error: " + err.message })
      }
      return
    }

    if (msg.type === "edit_message") {
      try {
        const id = parseInt(msg.id, 10)
        const m = await chat.getMessage(id)
        if (!m) throw new Error("Not found")
        if (m.sender_id !== currentUserId) throw new Error("Not your message")
        await chat.editMessage(id, currentUserId, msg.ciphertext, msg.iv)
        sendToUser(currentUserId, { type: "message_edited", id, ciphertext: msg.ciphertext, iv: msg.iv, editedAt })
        sendToUser(m.receiver_id, {
          type: "message_edited",
          id,
          ciphertext: msg.ciphertext,
          iv: msg.iv,
          editedAt,
          from: currentUserId,
        })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "delete_message") {
      try {
        const id = parseInt(msg.id, 10)
        const scope = msg.scope === "everyone" ? "everyone" : "self"
        const result = await chat.deleteMessage(id, currentUserId, scope)
        sendToUser(currentUserId, { type: "message_deleted", id, scope })
        if (scope === "everyone") {
          sendToUser(result.message.receiver_id, {
            type: "message_deleted",
            id,
            scope: "everyone",
            from: currentUserId,
          })
        }
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "react") {
      try {
        const id = parseInt(msg.id, 10)
        const m = await chat.getMessage(id)
        if (!m) throw new Error("Not found")
        if (m.sender_id !== currentUserId && m.receiver_id !== currentUserId)
          throw new Error("Not allowed")
        const emoji = String(msg.emoji || "").slice(0, 8)
        const peerId = m.sender_id === currentUserId ? m.receiver_id : m.sender_id
        if (msg.action === "remove") await chat.removeReaction(id, currentUserId, emoji)
        else await chat.addReaction(id, currentUserId, emoji)
        const payload = {
          type: "reaction",
          id,
          userId: currentUserId,
          emoji,
          action: msg.action || "add",
        }
        sendToUser(peerId, payload)
        sendToUser(currentUserId, payload)
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "mark_read") {
      try {
        const peerId = users.sanitize(msg.peerId, 64)
        const upTo = parseInt(msg.upToTs, 10) || Date.now()
        await chat.markRead(peerId, currentUserId, upTo)
        sendToUser(peerId, { type: "messages_read", by: currentUserId, upToTs: upTo })
      } catch {}
      return
    }

    // ---- POLLS ----
    if (msg.type === "poll_create") {
      try {
        const id = parseInt(msg.messageId, 10)
        const m = await chat.getMessage(id)
        if (!m || m.sender_id !== currentUserId) throw new Error("Not allowed")
        const pollId = await polls.createPoll(
          id,
          msg.question || "",
          Array.isArray(msg.options) ? msg.options : [],
          !!msg.multi
        )
        const payload = {
          type: "poll_state",
          messageId: id,
          poll: await polls.getPollByMessage(id),
          pollId,
        }
        send(ws, "poll_state", payload)
        sendToUser(m.receiver_id, payload)
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "poll_vote") {
      try {
        const id = parseInt(msg.messageId, 10)
        const m = await chat.getMessage(id)
        if (!m) throw new Error("Not found")
        if (m.sender_id !== currentUserId && m.receiver_id !== currentUserId)
          throw new Error("Not allowed")
        const poll = await polls.getPollByMessage(id)
        if (!poll) throw new Error("No poll")
        await polls.vote(poll.id, currentUserId, msg.options || [])
        const updated = { type: "poll_state", messageId: id, poll: await polls.getPollByMessage(id) }
        send(ws, "poll_state", updated)
        const peer = m.sender_id === currentUserId ? m.receiver_id : m.sender_id
        sendToUser(peer, updated)
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }

    // ---- LINK PREVIEW ----
    if (msg.type === "link_preview") {
      try {
        const url = findUrl(String(msg.url || ""))
        if (!url) return send(ws, "link_preview", { url: null })
        const preview = await linkPreview.getPreview(url)
        send(ws, "link_preview", { url, preview })
      } catch (err) {
        send(ws, "link_preview", { url: msg.url, preview: null })
      }
      return
    }

    // ---- FILE RELAY ----
    if (msg.type === "file") {
      if (!checkRateLimit(currentUserId, "message", 60))
        return send(ws, "error", { message: "Rate limit exceeded" })
      const toId = users.sanitize(msg.to, 64)
      try {
        const isFriend = await friends.areFriends(currentUserId, toId)
        if (!isFriend) return send(ws, "error", { message: "Not friends" })
        const timestamp = Date.now()
        if (msg.ciphertext) {
          try {
            const fileBuffer = Buffer.from(msg.ciphertext, "base64")
            const { filename } = await files.saveFile(fileBuffer, "encrypted_file")
            await files.recordFile(
              currentUserId,
              toId,
              filename,
              "encrypted_file",
              fileBuffer.length,
              "application/octet-stream",
              JSON.stringify({ iv: msg.iv }),
              timestamp
            )
            metrics && metrics.filesUploaded++
          } catch (e) {
            console.error("[WS] File save error:", e.message)
          }
        }
        sendToUser(toId, {
          type: "file",
          from: currentUserId,
          fromUsername: currentUsername,
          ciphertext: msg.ciphertext,
          iv: msg.iv,
          filename: msg.filename,
          mimeType: msg.mimeType,
          timestamp,
        })
        send(ws, "message_sent", { to: toId, timestamp, clientId: msg.clientId || null })
      } catch (err) {
        send(ws, "error", { message: "File error: " + err.message })
      }
      return
    }

    if (msg.type === "typing") {
      const toId = users.sanitize(msg.to, 64)
      if (!toId) return
      const isFriend = await friends.areFriends(currentUserId, toId)
      if (!isFriend) return
      sendToUser(toId, {
        type: "typing",
        from: currentUserId,
        fromUsername: currentUsername,
        isTyping: !!msg.isTyping,
      })
      return
    }

    // ---- WEBRTC CALL SIGNALING (relay-only) ----
    // Server only forwards opaque SDP/ICE between friends; no media touches the server.
    if (msg.type === "call_offer" || msg.type === "call_answer" ||
        msg.type === "call_ice"   || msg.type === "call_end"    ||
        msg.type === "call_reject") {
      try {
        const toId = users.sanitize(msg.to, 64)
        if (!toId) return
        const allowed = await friends.areFriends(currentUserId, toId)
        if (!allowed) return send(ws, "error", { message: "Not friends" })
        if (!checkRateLimit(currentUserId, "signal", 120))
          return send(ws, "error", { message: "Rate limit exceeded" })
        sendToUser(toId, {
          type: msg.type,
          from: currentUserId,
          fromUsername: currentUsername,
          callId: msg.callId,
          media: msg.media,        // 'audio' | 'video'
          sdp: msg.sdp,
          candidate: msg.candidate,
          reason: msg.reason,
          timestamp: Date.now(),
        })
        if (msg.type === "call_offer")
          await security.logAudit(currentUserId, "call_offer", ip, userAgent, { to: toId, media: msg.media })
      } catch (err) {
        send(ws, "error", { message: "Signal error: " + err.message })
      }
      return
    }

    // ---- GROUPS / CHANNELS ----
    if (msg.type === "group_create") {
      try {
        const name = users.sanitize(msg.name, 80)
        const topic = users.sanitize(msg.topic || "", 240)
        const kind = msg.kind === "channel" ? "channel" : "group"
        if (!name) throw new Error("Missing name")
        const g = await extras.createGroup(currentUserId, name, topic, kind)
        send(ws, "group_created", { group: g })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }
    if (msg.type === "group_list") {
      try {
        const list = await extras.listGroupsForUser(currentUserId)
        send(ws, "group_list", { groups: list })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "group_members") {
      try {
        if (!(await extras.isMember(msg.groupId, currentUserId))) throw new Error("Not a member")
        const members = await extras.listMembers(msg.groupId)
        send(ws, "group_members", { groupId: msg.groupId, members })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "group_join") {
      try {
        const g = await extras.joinByInvite(currentUserId, msg.invite)
        send(ws, "group_joined", { group: g })
        // Notify existing members
        const members = await extras.listMembers(g.id)
        for (const m of members) if (m.id !== currentUserId) sendToUser(m.id, { type: "group_member_joined", groupId: g.id, userId: currentUserId, username: currentUsername })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "group_leave") {
      try {
        await extras.leaveGroup(msg.groupId, currentUserId)
        send(ws, "info", { message: "Left group" })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "group_set_role") {
      try {
        await extras.setMemberRole(msg.groupId, currentUserId, msg.userId, msg.role)
        send(ws, "info", { message: "Role updated" })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "group_message") {
      try {
        if (!checkRateLimit(currentUserId, "group_message", 60))
          return send(ws, "error", { message: "Rate limit exceeded" })
        const role = await extras.getRole(msg.groupId, currentUserId)
        if (!role) throw new Error("Not a member")
        const g = await extras.getGroup(msg.groupId)
        if (!g) throw new Error("Group not found")
        // In channels only owner/admin can post
        if (g.kind === "channel" && role !== "owner" && role !== "admin") throw new Error("Read-only channel")
        const saved = await extras.saveGroupMessage(msg.groupId, currentUserId, msg.ciphertext, msg.iv, {
          kind: msg.kind || "text",
          payload: msg.payload || null,
          replyToId: msg.replyToId || null,
        })
        const out = {
          type: "group_message",
          id: saved.id,
          groupId: msg.groupId,
          from: currentUserId,
          fromUsername: currentUsername,
          ciphertext: msg.ciphertext,
          iv: msg.iv,
          kind: msg.kind || "text",
          payload: msg.payload || null,
          replyToId: msg.replyToId || null,
          timestamp: saved.timestamp,
        }
        const members = await extras.listMembers(msg.groupId)
        for (const m of members) sendToUser(m.id, out)
        metrics && metrics.messagesRelayed++
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "group_history") {
      try {
        if (!(await extras.isMember(msg.groupId, currentUserId))) throw new Error("Not a member")
        const before = parseInt(msg.before, 10) || Date.now()
        const messages = await extras.getGroupHistory(msg.groupId, before, 50)
        send(ws, "group_history", { groupId: msg.groupId, messages })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }

    // ---- STICKERS ----
    if (msg.type === "sticker_pack_create") {
      try {
        const id = await extras.createPack(currentUserId, msg.name)
        send(ws, "sticker_pack_created", { id })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "sticker_pack_list") {
      try {
        const packs = await extras.listPacks(currentUserId)
        send(ws, "sticker_pack_list", { packs })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "sticker_list") {
      try {
        const stickers = await extras.listStickers(msg.packId)
        send(ws, "sticker_list", { packId: msg.packId, stickers })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "sticker_add") {
      try {
        const id = await extras.addSticker(msg.packId, currentUserId, msg.data, msg.label)
        send(ws, "sticker_added", { id, packId: msg.packId })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "sticker_delete") {
      try {
        await extras.deleteSticker(msg.stickerId, currentUserId)
        send(ws, "sticker_deleted", { stickerId: msg.stickerId })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "sticker_pack_share") {
      try {
        await extras.setPackShared(msg.packId, currentUserId, !!msg.shared)
        send(ws, "info", { message: "Pack updated" })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }

    // ---- PUSH SUBSCRIPTIONS ----
    if (msg.type === "push_subscribe") {
      try {
        await extras.savePushSubscription(currentUserId, msg.subscription, userAgent)
        send(ws, "info", { message: "Push registered" })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }
    if (msg.type === "push_unsubscribe") {
      try {
        await extras.deletePushSubscription(currentUserId, String(msg.endpoint || ""))
        send(ws, "info", { message: "Push removed" })
      } catch (err) { send(ws, "error", { message: err.message }) }
      return
    }

    if (msg.type === "get_audit") {
      try {
        const log = await security.getAuditLog(currentUserId, 100)
        send(ws, "audit_log", { entries: log })
      } catch (err) {
        send(ws, "error", { message: err.message })
      }
      return
    }

    send(ws, "error", { message: "Unknown message type" })
  })

  ws.on("close", () => {
    clearInterval(heartbeat)
    if (!currentUserId) return
    const fullyOffline = removeOnline(currentUserId, ws)
    if (fullyOffline) {
      notifyFriendsStatus(currentUserId, false)
      console.log(`[WS] User ${currentUsername || currentUserId} offline`)
    }
  })

  ws.on("error", (err) => console.error("[WS] Error:", err.message))
}

module.exports = { handleConnection, onlineUsers, sendToUser, isOnline }
