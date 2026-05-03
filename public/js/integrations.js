/**
 * Glue layer that bolts the new feature modules onto the existing app without
 * editing app.js. It taps into the WebSocket the app creates by replacing
 * WebSocket.prototype.send/onmessage hooks via a passive observer.
 *
 * - Forwards `call_*` messages to window.Calls
 * - Auto-subscribes to push notifications after first authenticated session
 * - Adds a "call" and "voice" button next to the chat header
 * - Adds a "GIF" entry to the emoji picker
 */
(function () {
  "use strict"

  // Find the live WebSocket the app is using by monkey-patching the
  // WebSocket constructor *before* app.js runs is too risky; instead, observe
  // global send activity by hooking into navigator.serviceWorker or DOM events.
  // Simpler: poll until we see one connected on the page, by exposing a hook.
  //
  // The app stores its ws inside a closure. We rely on a DOM convention: the
  // app dispatches `sc:ws-open`, `sc:ws-message` and `sc:ws-close` events on
  // window when those events happen.
  //
  // To avoid editing app.js, we patch WebSocket transparently here.

  if (window.__sc_ws_patched) return
  window.__sc_ws_patched = true

  let liveWs = null
  let myUserId = null
  let pushSubscribed = false

  const NativeWS = window.WebSocket
  function PatchedWS(url, protocols) {
    const sock = protocols ? new NativeWS(url, protocols) : new NativeWS(url)
    liveWs = sock
    sock.addEventListener("open", () => {
      window.dispatchEvent(new CustomEvent("sc:ws-open", { detail: { ws: sock } }))
    })
    sock.addEventListener("close", () => {
      if (liveWs === sock) liveWs = null
      window.dispatchEvent(new CustomEvent("sc:ws-close"))
    })
    sock.addEventListener("message", (ev) => {
      let m = null
      try { m = JSON.parse(ev.data) } catch (e) { return }
      if (!m || !m.type) return
      // Track our own user id once "registered"
      if (m.type === "registered" && m.id) {
        myUserId = m.id
        // Subscribe to push opportunistically (only once and only if SW present)
        if (!pushSubscribed && window.PushClient && window.PushClient.isSupported()) {
          pushSubscribed = true
          window.PushClient.subscribe(sock).catch(() => { pushSubscribed = false })
        }
        // Init Double Ratchet identity and publish pubkey
        if (window.DoubleRatchet) {
          window.DoubleRatchet.init(m.id).then((pub) => {
            try { sock.send(JSON.stringify({ type: "publish_pubkey", pubkey: JSON.stringify(pub) })) } catch (e) {}
          }).catch(() => {})
        }
      }
      // Calls signaling
      if (m.type === "call_offer" || m.type === "call_answer" || m.type === "call_ice" ||
          m.type === "call_end" || m.type === "call_reject") {
        if (window.Calls) {
          window.Calls.attach({
            ws: sock,
            getMyId: () => myUserId,
            getPeerById: (id) => {
              const friends = window.App && window.App.getFriends ? window.App.getFriends() : []
              const p = friends.find(f => f.id === id)
              return { username: p ? p.username : (id === m.from ? (m.fromUsername || "Friend") : "Friend") }
            }
          })
          window.Calls.handleSignal(m)
        }
      }
      // Group / sticker events: re-broadcast as DOM events for any UI to consume.
      if (m.type === "group_message" || m.type === "group_list" || m.type === "group_created" ||
          m.type === "sticker_pack_list" || m.type === "sticker_list" || m.type === "bot_list" ||
          m.type === "bot_created" || m.type === "bot_token_rotated") {
        window.dispatchEvent(new CustomEvent("sc:" + m.type, { detail: m }))
      }
    })
    return sock
  }
  PatchedWS.prototype = NativeWS.prototype
  PatchedWS.CONNECTING = NativeWS.CONNECTING
  PatchedWS.OPEN = NativeWS.OPEN
  PatchedWS.CLOSING = NativeWS.CLOSING
  PatchedWS.CLOSED = NativeWS.CLOSED
  window.WebSocket = PatchedWS

  // --- Inject call buttons into chat header once available ---
  function injectCallButtons() {
    const header = document.querySelector(".chat-header")
    const searchBtn = document.getElementById("searchToggleBtn")
    if (!header || !searchBtn || document.getElementById("scCallBtnAudio")) return
    const audio = document.createElement("button")
    audio.id = "scCallBtnAudio"
    audio.type = "button"
    audio.className = "icon-btn call-action"
    audio.title = "Voice call"
    audio.style.display = "none"
    audio.setAttribute("aria-label", "Voice call")
    audio.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z"/></svg>'
    const video = document.createElement("button")
    video.id = "scCallBtnVideo"
    video.type = "button"
    video.className = "icon-btn call-action"
    video.title = "Video call"
    video.style.display = "none"
    video.setAttribute("aria-label", "Video call")
    video.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>'
    
    header.insertBefore(audio, searchBtn)
    header.insertBefore(video, searchBtn)

    const peerName = document.getElementById("peerName")
    if (peerName) {
      const toggleVis = () => {
        const text = peerName.textContent.toLowerCase()
        const isSel = text !== "select a friend" && text !== "seleziona un amico"
        audio.style.display = isSel ? "" : "none"
        video.style.display = isSel ? "" : "none"
      }
      new MutationObserver(toggleVis).observe(peerName, { childList: true, characterData: true, subtree: true })
      toggleVis()
    }

    function startCall(media) {
      const peerId = window.App && window.App.getPeerId ? window.App.getPeerId() : null
      if (!peerId) return window.App && window.App.showToast ? window.App.showToast("Seleziona un amico", "error") : null
      if (!window.Calls) return
      // Ensure attach with latest ws
      const friends = window.App.getFriends ? window.App.getFriends() : []
      window.Calls.attach({
        ws: liveWs,
        getMyId: () => myUserId,
        getPeerById: (id) => {
          const p = friends.find(f => f.id === id)
          return { username: p ? p.username : "Friend" }
        }
      })
      window.Calls.startCall(peerId, media)
    }
    audio.addEventListener("click", () => startCall("audio"))
    video.addEventListener("click", () => startCall("video"))
  }

  // --- Inject voice-record button next to send ---
  function injectVoiceButton() {
    const form = document.getElementById("messageForm")
    if (!form || document.getElementById("scVoiceBtn")) return
    const btn = document.createElement("button")
    btn.id = "scVoiceBtn"
    btn.type = "button"
    btn.className = "icon-btn"
    btn.title = "Record voice message"
    btn.setAttribute("aria-label", "Record voice message")
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
    const sendBtn = form.querySelector(".send-btn")
    form.insertBefore(btn, sendBtn)

    // Create recording indicator bar
    const recBar = document.createElement("div")
    recBar.id = "scRecBar"
    recBar.style.cssText = "display:none;align-items:center;gap:10px;flex:1;padding:0 12px;height:44px;background:var(--bg-elev-2);border-radius:22px;border:1px solid hsl(0 70% 50% / 0.4);animation:fadeUp 0.15s ease"
    recBar.innerHTML = '<span style="width:10px;height:10px;border-radius:50%;background:#e74c3c;animation:pulse 1.2s infinite;flex-shrink:0"></span><span id="scRecTimer" style="font-size:14px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums">00:00</span><span style="flex:1;font-size:13px;color:var(--text-muted)">Registrazione...</span><button type="button" id="scRecCancel" style="background:transparent;border:none;color:var(--danger);font-size:13px;font-weight:600;cursor:pointer;padding:4px 8px;border-radius:8px">Annulla</button>'

    let recording = false
    let recInterval = null
    let recStartTime = 0
    const msgInput = document.getElementById("messageInput")

    function showRecBar() {
      if (msgInput) msgInput.style.display = "none"
      // hide other buttons
      form.querySelectorAll(".icon-btn:not(#scVoiceBtn)").forEach(b => b.style.display = "none")
      form.insertBefore(recBar, btn)
      recBar.style.display = "flex"
      recStartTime = Date.now()
      recInterval = setInterval(() => {
        const s = Math.floor((Date.now() - recStartTime) / 1000)
        const m = String(Math.floor(s / 60)).padStart(2, "0")
        const sec = String(s % 60).padStart(2, "0")
        const timer = document.getElementById("scRecTimer")
        if (timer) timer.textContent = m + ":" + sec
      }, 200)
    }

    function hideRecBar() {
      recBar.style.display = "none"
      if (msgInput) msgInput.style.display = ""
      form.querySelectorAll(".icon-btn:not(#scVoiceBtn)").forEach(b => b.style.display = "")
      clearInterval(recInterval)
      recInterval = null
    }

    btn.addEventListener("click", async () => {
      if (!window.Voice) return
      if (recording) {
        try {
          const { blob, durationMs, waveform } = await window.Voice.stop()
          recording = false
          btn.style.color = ""
          hideRecBar()
          // Dispatch voice ready event for the app to handle
          window.dispatchEvent(new CustomEvent("sc:voice-ready", { detail: { blob, durationMs, waveform } }))
        } catch (e) { if (window.App) window.App.showToast(e.message, "error") }
      } else {
        try {
          await window.Voice.start()
          recording = true
          btn.style.color = "#e74c3c"
          showRecBar()
        } catch (e) { if (window.App) window.App.showToast(e.message, "error") }
      }
    })

    // Cancel button inside recording bar
    recBar.addEventListener("click", (e) => {
      if (e.target.id === "scRecCancel") {
        if (recording && window.Voice) { window.Voice.cancel(); recording = false; btn.style.color = "" }
        hideRecBar()
      }
    })

    // Cancel on right-click / long-press
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      if (recording && window.Voice) { window.Voice.cancel(); recording = false; btn.style.color = "" }
      hideRecBar()
    })
  }


  // Listen to SW for notification clicks
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (ev) => {
      if (ev.data && ev.data.type === "notif_click" && ev.data.url) {
        try { window.focus() } catch (e) {}
      }
    })
  }

  function tryInject() {
    injectCallButtons()
    injectVoiceButton()
    initCapacitor()
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryInject)
  } else {
    tryInject()
  }
  // Also re-run after the app shows the chat view (it may rebuild header on selection)
  const obs = new MutationObserver(() => tryInject())
  if (document.body) obs.observe(document.body, { subtree: true, childList: true })

  // --- Capacitor Phase 3 ---
  async function initCapacitor() {
    if (!window.Capacitor || !window.Capacitor.Plugins) return
    const { PushNotifications, App } = window.Capacitor.Plugins

    if (App) {
      App.addListener('appStateChange', async ({ isActive }) => {
        if (!isActive) {
          // App went to background
        } else {
          // App returned to foreground
          if (liveWs && liveWs.readyState !== 1) {
            // Attempt to reconnect if WS died in background
            try { window.App && window.App.refreshConnection && window.App.refreshConnection() } catch (e) {}
          }
        }
      })
      App.addListener('appUrlOpen', data => {
        if (data.url.startsWith("privatechat://")) {
          const path = data.url.replace("privatechat://", "")
          console.log("Deeplink opened:", path)
          // Handle navigation here (e.g. select peer)
        }
      })
    }

    if (PushNotifications) {
      try {
        let permStatus = await PushNotifications.checkPermissions()
        if (permStatus.receive === 'prompt') {
          permStatus = await PushNotifications.requestPermissions()
        }
        if (permStatus.receive === 'granted') {
          await PushNotifications.register()
          PushNotifications.addListener('registration', token => {
            if (liveWs && myUserId) {
              liveWs.send(JSON.stringify({ type: "push_subscribe", subscription: { endpoint: token.value, capacitor: true } }))
            }
          })
          PushNotifications.addListener('pushNotificationReceived', notification => {
            window.dispatchEvent(new CustomEvent("sc:toast", { detail: { msg: "New push: " + notification.title, kind: "info" } }))
          })
        }
      } catch (e) { console.error("[Capacitor Push]", e) }
    }
  }

  // Expose helper for programmatic access
  window.SC = window.SC || {}
  window.SC.getWS = () => liveWs
  window.SC.getMyId = () => myUserId
})()
