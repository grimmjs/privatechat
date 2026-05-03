/**
 * WebRTC voice/video calls (Mesh Network for Groups).
 *
 * Server only relays opaque SDP/ICE between friends; media is peer-to-peer.
 */
(function () {
  "use strict"
  const NS = (window.Calls = window.Calls || {})

  let ws = null
  let getMyId = () => null
  let getPeerById = () => null
  let pcs = new Map() // peerId -> RTCPeerConnection
  let remoteStreams = new Map() // peerId -> MediaStream
  let localStream = null
  let currentCall = null    // { callId, media, state }
  let iceConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }
  let durationTimer = null
  let audioContext = null
  let analysers = new Map()

  fetch("/api/turn").then(r => r.json()).then(j => {
    if (j && j.iceServers) iceConfig = { iceServers: j.iceServers }
  }).catch(() => {})

  function uid() { return "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) }

  function attach(opts) {
    ws = opts.ws
    if (typeof opts.getMyId === "function") getMyId = opts.getMyId
    if (typeof opts.getPeerById === "function") getPeerById = opts.getPeerById
  }

  function setWs(newWs) { ws = newWs }

  function send(type, payload) {
    if (!ws || ws.readyState !== 1) return
    try { ws.send(JSON.stringify(Object.assign({ type }, payload))) } catch (e) {}
  }

  const ICONS = {
    mic: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    micOff: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    video: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
    videoOff: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
    end: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.987.987 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>`
  }

  // ---------- UI ----------
  function ensureUI() {
    if (document.getElementById("scCallOverlay")) return document.getElementById("scCallOverlay")
    const root = document.createElement("div")
    root.id = "scCallOverlay"
    root.style.cssText = "position:fixed;inset:auto 16px 16px auto;width:380px;max-width:calc(100vw - 32px);background:var(--bg-elev,#111);color:var(--text,#fff);border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.6);z-index:9999;display:none;font-family:inherit;overflow:hidden;transition:width 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
    root.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,0.02)">
        <div style="min-width:0"><strong id="scCallTitle" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Call</strong><div id="scCallState" style="opacity:.6;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em"></div></div>
        <button type="button" id="scCallMin" style="background:rgba(255,255,255,0.1);border:0;color:inherit;cursor:pointer;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:background 0.2s">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      <div id="scCallVideos" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));gap:8px;padding:8px;background:#000;max-height:50vh;overflow-y:auto">
        <div style="position:relative" id="scLocalVideoWrap">
          <video id="scCallLocal" autoplay playsinline muted style="width:100%;border-radius:12px;background:#1a1a1a;min-height:100px;object-fit:cover"></video>
          <span style="position:absolute;bottom:6px;left:6px;font-size:10px;background:rgba(0,0,0,0.6);padding:2px 6px;border-radius:6px;font-weight:600">You</span>
        </div>
      </div>
      <div id="scCallControls" style="display:flex;justify-content:center;gap:12px;padding:16px;background:rgba(255,255,255,0.02)">
        <button type="button" id="scCallMute" class="call-ctrl-btn" title="Mute/Unmute">${ICONS.mic}</button>
        <button type="button" id="scCallVideo" class="call-ctrl-btn" title="Toggle Video">${ICONS.video}</button>
        <button type="button" id="scCallEnd" class="call-ctrl-btn danger" title="End Call">${ICONS.end}</button>
      </div>
      <style>
        .call-ctrl-btn {
          width: 48px; height: 48px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.15);
          background: rgba(255,255,255,0.05); color: #fff; cursor: pointer;
          display: flex; align-items: center; justify-content: center; transition: all 0.2s;
        }
        .call-ctrl-btn:hover { background: rgba(255,255,255,0.15); transform: translateY(-2px); }
        .call-ctrl-btn.danger { background: #e74c3c; border: none; }
        .call-ctrl-btn.danger:hover { background: #c0392b; box-shadow: 0 4px 12px rgba(231, 76, 60, 0.4); }
        .call-ctrl-btn.off { background: rgba(255,255,255,0.2); color: #e74c3c; }
        #scCallOverlay.minimized { width: 180px !important; }
        #scCallOverlay.minimized #scCallVideos { display: none !important; }
        #scCallOverlay.minimized #scCallControls { padding: 10px; gap: 8px; }
        #scCallOverlay.minimized .call-ctrl-btn { width: 36px; height: 36px; }
        #scCallOverlay.minimized .call-ctrl-btn svg { width: 16px; height: 16px; }
      </style>`
    document.body.appendChild(root)
    document.getElementById("scCallEnd").addEventListener("click", () => endCall("user"))
    document.getElementById("scCallMute").addEventListener("click", toggleMute)
    document.getElementById("scCallVideo").addEventListener("click", toggleVideo)
    document.getElementById("scCallMin").addEventListener("click", () => {
      root.classList.toggle("minimized")
    })
    return root
  }

  function showUI(title, state, media) {
    const root = ensureUI()
    root.style.display = "block"
    root.classList.remove("minimized")
    document.getElementById("scCallTitle").textContent = title
    document.getElementById("scCallState").textContent = state || ""
    document.getElementById("scCallVideo").style.display = (media === "audio" ? "none" : "flex")
  }
  function setState(s) { const el = document.getElementById("scCallState"); if (el) el.textContent = s }
  function hideUI() { const root = document.getElementById("scCallOverlay"); if (root) root.style.display = "none" }

  function addVideoNode(peerId, name) {
    let wrap = document.getElementById("vid_" + peerId)
    if (wrap) return wrap.querySelector("video")
    wrap = document.createElement("div")
    wrap.id = "vid_" + peerId
    wrap.style.position = "relative"
    const v = document.createElement("video")
    v.autoplay = true; v.playsInline = true
    v.style.cssText = "width:100%;border-radius:8px;background:#111;min-height:100px;border:2px solid transparent;transition:border-color 0.2s"
    const label = document.createElement("span")
    label.style.cssText = "position:absolute;bottom:4px;left:4px;font-size:10px;background:rgba(0,0,0,.5);padding:2px 4px;border-radius:4px"
    label.textContent = name
    wrap.appendChild(v); wrap.appendChild(label)
    document.getElementById("scCallVideos").appendChild(wrap)
    return v
  }
  function removeVideoNode(peerId) {
    const wrap = document.getElementById("vid_" + peerId)
    if (wrap) wrap.remove()
  }

  // ---------- WebRTC Mesh ----------
  async function getMedia(media) {
    const constraints = media === "video" ? { audio: true, video: { width: 640, height: 480 } } : { audio: true, video: false }
    localStream = await navigator.mediaDevices.getUserMedia(constraints)
    document.getElementById("scCallLocal").srcObject = localStream
    document.getElementById("scLocalVideoWrap").style.display = media === "video" ? "block" : "none"
  }

  async function createPC(peerId, peerName, isInitiator) {
    if (pcs.has(peerId)) return pcs.get(peerId)
    const pc = new RTCPeerConnection(iceConfig)
    pcs.set(peerId, pc)
    const rs = new MediaStream()
    remoteStreams.set(peerId, rs)
    
    const videoEl = addVideoNode(peerId, peerName)
    videoEl.srcObject = rs

    // Dominant speaker audio analyzer
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)()
    
    pc.onicecandidate = e => {
      if (e.candidate && currentCall) send("call_ice", { to: peerId, callId: currentCall.callId, candidate: e.candidate })
    }
    pc.ontrack = e => {
      e.streams[0].getTracks().forEach(t => rs.addTrack(t))
      if (e.track.kind === "audio") {
        try {
          const src = audioContext.createMediaStreamSource(new MediaStream([e.track]))
          const analyser = audioContext.createAnalyser()
          analyser.fftSize = 256
          src.connect(analyser)
          analysers.set(peerId, analyser)
        } catch (err) {}
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        pc.close(); pcs.delete(peerId); remoteStreams.delete(peerId); removeVideoNode(peerId); analysers.delete(peerId)
        if (pcs.size === 0) endCall("network")
      }
    }

    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream))

    if (isInitiator) {
      const offer = await pc.createOffer({ offerToReceiveAudio: 1, offerToReceiveVideo: currentCall.media === "video" ? 1 : 0 })
      await pc.setLocalDescription(offer)
      send("call_offer", { to: peerId, callId: currentCall.callId, media: currentCall.media, sdp: offer })
    }
    return pc
  }

  // ---------- Call control ----------
  async function startCall(peerIdOrIds, media) {
    if (currentCall) return
    if (!ws || ws.readyState !== 1) { if (window.App) window.App.showToast("Non connesso", "error"); return }
    const peerIds = Array.isArray(peerIdOrIds) ? peerIdOrIds : [peerIdOrIds]
    currentCall = { callId: uid(), media, state: "ringing" }
    
    showUI("Group Call", media + " · ringing", media)
    try { await getMedia(media) } catch (e) { if (window.App) window.App.showToast("Microfono/camera non disponibile", "error"); return endCall("media") }
    
    for (const pid of peerIds) {
      const peer = getPeerById(pid) || { username: "Friend" }
      await createPC(pid, peer.username, true)
    }
  }

  async function handleIncoming(msg) {
    if (currentCall && currentCall.callId !== msg.callId) {
      send("call_reject", { to: msg.from, callId: msg.callId, reason: "busy" })
      return
    }
    if (!currentCall) {
      const accept = confirm((msg.fromUsername || "Friend") + " is inviting to a call (" + (msg.media || "audio") + "). Join?")
      if (!accept) return send("call_reject", { to: msg.from, callId: msg.callId, reason: "declined" })
      currentCall = { callId: msg.callId, media: msg.media || "audio", state: "connected" }
      showUI("Group Call", "connected", currentCall.media)
      try { await getMedia(currentCall.media) } catch (e) { alert("Mic/cam err"); return endCall("media") }
      startDurationTimer()
    }
    const pc = await createPC(msg.from, msg.fromUsername || "Friend", false)
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    send("call_answer", { to: msg.from, callId: msg.callId, sdp: answer })
  }

  async function handleSignal(msg) {
    if (msg.type === "call_offer") return handleIncoming(msg)
    if (!currentCall || msg.callId !== currentCall.callId) return
    
    if (msg.type === "call_answer" && pcs.has(msg.from)) {
      try { await pcs.get(msg.from).setRemoteDescription(new RTCSessionDescription(msg.sdp)); startDurationTimer() } catch (e) {}
    } else if (msg.type === "call_ice" && pcs.has(msg.from)) {
      try { await pcs.get(msg.from).addIceCandidate(new RTCIceCandidate(msg.candidate)) } catch (e) {}
    } else if (msg.type === "call_reject" || msg.type === "call_end") {
      if (pcs.has(msg.from)) {
        pcs.get(msg.from).close(); pcs.delete(msg.from); remoteStreams.delete(msg.from); removeVideoNode(msg.from); analysers.delete(msg.from)
      }
      if (pcs.size === 0) endCall("remote")
    }
  }

  function endCall(reason) {
    if (currentCall) {
      for (const [pid, pc] of pcs.entries()) {
        send("call_end", { to: pid, callId: currentCall.callId, reason: reason || "ended" })
        try { pc.close() } catch (e) {}
      }
    }
    pcs.clear(); remoteStreams.clear(); analysers.clear()
    const container = document.getElementById("scCallVideos")
    if (container) {
      const nodes = container.querySelectorAll("div[id^='vid_']")
      nodes.forEach(n => n.remove())
    }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null }
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null }
    currentCall = null
    hideUI()
  }

  function toggleMute() {
    if (!localStream) return
    const tr = localStream.getAudioTracks()[0]
    if (tr) {
      tr.enabled = !tr.enabled
      const btn = document.getElementById("scCallMute")
      btn.innerHTML = tr.enabled ? ICONS.mic : ICONS.micOff
      btn.classList.toggle("off", !tr.enabled)
    }
  }
  function toggleVideo() {
    if (!localStream) return
    const tr = localStream.getVideoTracks()[0]
    if (tr) {
      tr.enabled = !tr.enabled
      const btn = document.getElementById("scCallVideo")
      btn.innerHTML = tr.enabled ? ICONS.video : ICONS.videoOff
      btn.classList.toggle("off", !tr.enabled)
    }
  }

  function startDurationTimer() {
    if (durationTimer) return
    const start = Date.now()
    durationTimer = setInterval(() => {
      if (!currentCall) return
      const s = Math.floor((Date.now() - start) / 1000)
      const mm = String(Math.floor(s / 60)).padStart(2, "0")
      const ss = String(s % 60).padStart(2, "0")
      setState(currentCall.media.toUpperCase() + " · " + mm + ":" + ss)

      // Highlight dominant speaker
      let maxVol = 0; let domPeer = null
      for (const [pid, analyser] of analysers.entries()) {
        const arr = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(arr)
        let sum = 0; for(let i=0; i<arr.length; i++) sum+=arr[i]
        const avg = sum / arr.length
        if (avg > maxVol) { maxVol = avg; domPeer = pid }
      }
      document.querySelectorAll("#scCallVideos > div[id^='vid_'] video").forEach(v => v.style.borderColor = "transparent")
      if (maxVol > 15 && domPeer) {
        const domVid = document.querySelector("#vid_" + domPeer + " video")
        if (domVid) domVid.style.borderColor = "#3498db"
      }
    }, 1000)
  }

  NS.attach = attach; NS.setWs = setWs; NS.startCall = startCall
  NS.handleSignal = handleSignal; NS.endCall = endCall; NS.isInCall = () => !!currentCall
})()
