/**
 * Web Push notifications.
 * - Loads VAPID keys from env (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT).
 * - sendToUser(userId, payload) iterates the user's saved subscriptions and prunes dead ones.
 * - Payload should be small (titles + click_url); ciphertext is NEVER pushed.
 */
let webpush = null
try {
  webpush = require("web-push")
} catch (e) {
  webpush = null
}

const { all, run } = require("../database/db")

const PUB = process.env.VAPID_PUBLIC_KEY || ""
const PRIV = process.env.VAPID_PRIVATE_KEY || ""
const SUBJ = process.env.VAPID_SUBJECT || "mailto:admin@example.com"

let configured = false
if (webpush && PUB && PRIV) {
  try {
    webpush.setVapidDetails(SUBJ, PUB, PRIV)
    configured = true
  } catch (e) {
    configured = false
  }
}

function isConfigured() {
  return configured
}

async function sendToUser(userId, payload) {
  if (!configured) return { sent: 0, failed: 0, skipped: true }
  const rows = await all(
    "SELECT id, endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?",
    [userId]
  )
  let sent = 0, failed = 0
  for (const r of rows) {
    const sub = {
      endpoint: r.endpoint,
      keys: { p256dh: r.keys_p256dh, auth: r.keys_auth },
    }
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 })
      sent++
    } catch (err) {
      failed++
      // 404/410 -> subscription gone; clean up.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        try { await run("DELETE FROM push_subscriptions WHERE id = ?", [r.id]) } catch (_) {}
      }
    }
  }
  return { sent, failed, skipped: false }
}

module.exports = { sendToUser, isConfigured }
