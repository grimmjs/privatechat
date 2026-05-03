/**
 * Web Push subscription helper.
 * Public API:
 *   await window.PushClient.subscribe(ws);
 *   await window.PushClient.unsubscribe(ws);
 *   window.PushClient.isSupported();
 */
(function () {
  "use strict"
  const NS = (window.PushClient = window.PushClient || {})

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4)
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
    const raw = atob(base64)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i)
    return out
  }

  function isSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined"
  }

  async function getRegistration() {
    if (!("serviceWorker" in navigator)) return null
    return await navigator.serviceWorker.ready
  }

  async function subscribe(ws) {
    if (!isSupported()) throw new Error("Push not supported")
    const perm = await Notification.requestPermission()
    if (perm !== "granted") throw new Error("Permission denied")
    const reg = await getRegistration()
    if (!reg) throw new Error("Service worker not registered")
    const r = await fetch("/api/push/vapid").then(r => r.json()).catch(() => ({}))
    if (!r || !r.publicKey) throw new Error("Server has no VAPID key configured")
    const existing = await reg.pushManager.getSubscription()
    if (existing) {
      sendSub(ws, existing)
      return existing.toJSON()
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(r.publicKey),
    })
    sendSub(ws, sub)
    return sub.toJSON()
  }

  function sendSub(ws, sub) {
    if (!ws || ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify({ type: "push_subscribe", subscription: sub.toJSON ? sub.toJSON() : sub }))
    } catch (e) {}
  }

  async function unsubscribe(ws) {
    const reg = await getRegistration()
    if (!reg) return
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      const endpoint = sub.endpoint
      try { await sub.unsubscribe() } catch (e) {}
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: "push_unsubscribe", endpoint })) } catch (e) {}
      }
    }
  }

  NS.isSupported = isSupported
  NS.subscribe = subscribe
  NS.unsubscribe = unsubscribe
})()
