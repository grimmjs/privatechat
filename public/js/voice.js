/**
 * Voice messages.
 *  - record(): returns a Promise resolving to { blob, durationMs, waveform }
 *      waveform is a Uint8Array of normalized peaks (0..255) sampled while recording.
 *  - renderPlayer(container, blob, durationMs, waveform): builds a UI element with play/scrub.
 *
 * The encrypted bytes of the blob are sent through the existing file upload
 * endpoint as a `kind: "voice"` message; the recipient decrypts it client-side.
 */
(function () {
  "use strict"
  const NS = (window.Voice = window.Voice || {})

  let activeRecorder = null
  let activeStream = null
  let activeAnalyser = null
  let activeAudioCtx = null
  let activeChunks = []
  let activeStart = 0
  let activeWave = []
  let waveTimer = null

  async function start() {
    if (activeRecorder) throw new Error("Already recording")
    activeStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    activeAudioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const src = activeAudioCtx.createMediaStreamSource(activeStream)
    activeAnalyser = activeAudioCtx.createAnalyser()
    activeAnalyser.fftSize = 256
    src.connect(activeAnalyser)
    activeChunks = []
    activeWave = []
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm"
    activeRecorder = new MediaRecorder(activeStream, { mimeType: mime })
    activeRecorder.ondataavailable = (e) => { if (e.data && e.data.size) activeChunks.push(e.data) }
    activeRecorder.start(250)
    activeStart = Date.now()
    const buf = new Uint8Array(activeAnalyser.frequencyBinCount)
    waveTimer = setInterval(() => {
      activeAnalyser.getByteTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] - 128)
        if (v > peak) peak = v
      }
      activeWave.push(Math.min(255, peak * 2))
    }, 80)
  }

  function cancel() {
    if (waveTimer) { clearInterval(waveTimer); waveTimer = null }
    try { if (activeRecorder && activeRecorder.state === "recording") activeRecorder.stop() } catch (e) {}
    if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null }
    if (activeAudioCtx) { try { activeAudioCtx.close() } catch (e) {} activeAudioCtx = null }
    activeRecorder = null
    activeChunks = []
    activeWave = []
  }

  function stop() {
    return new Promise((resolve, reject) => {
      if (!activeRecorder) return reject(new Error("Not recording"))
      activeRecorder.onstop = () => {
        if (waveTimer) { clearInterval(waveTimer); waveTimer = null }
        const blob = new Blob(activeChunks, { type: activeRecorder.mimeType })
        const durationMs = Date.now() - activeStart
        const waveform = new Uint8Array(activeWave)
        if (activeStream) activeStream.getTracks().forEach(t => t.stop())
        if (activeAudioCtx) try { activeAudioCtx.close() } catch (e) {}
        activeStream = null; activeAudioCtx = null; activeRecorder = null; activeChunks = []
        resolve({ blob, durationMs, waveform })
      }
      try { activeRecorder.stop() } catch (e) { reject(e) }
    })
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000)
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0")
  }

  /**
   * @param {Blob} blob
   * @param {number} durationMs
   * @param {Uint8Array|number[]} waveform
   * @returns {HTMLElement}
   */
  function renderPlayer(blob, durationMs, waveform) {
    const wrap = document.createElement("div")
    wrap.className = "sc-voice-player"
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:10px;padding:8px 14px;border-radius:18px;background:var(--bg-elev-2, #1c1c22);border:1px solid var(--border, #2a2a32);min-width:200px;max-width:300px"
    const btn = document.createElement("button")
    btn.type = "button"
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
    btn.style.cssText = "background:var(--primary,#3b82f6);border:0;color:#fff;width:34px;height:34px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(59,130,246,0.3);transition:transform 0.1s"
    const waveWrap = document.createElement("div")
    waveWrap.style.cssText = "flex:1;display:flex;flex-direction:column;gap:4px;min-width:0"
    const canvas = document.createElement("canvas")
    canvas.width = 180; canvas.height = 32
    canvas.style.cssText = "background:transparent;cursor:pointer;width:100%;height:32px;border-radius:4px"
    const time = document.createElement("span")
    time.style.cssText = "font-variant-numeric:tabular-nums;font-size:11px;color:var(--text-muted,#9a9aa3);font-weight:500"
    time.textContent = fmtTime(durationMs)
    waveWrap.appendChild(canvas)
    waveWrap.appendChild(time)
    wrap.appendChild(btn); wrap.appendChild(waveWrap)

    const audio = new Audio(URL.createObjectURL(blob))
    let playing = false
    let progress = 0  // 0..1
    const wave = Array.from(waveform || [])
    function draw() {
      const ctx = canvas.getContext("2d")
      const w = canvas.width, h = canvas.height
      ctx.clearRect(0, 0, w, h)
      const bars = 45
      const gap = 1
      const barW = (w / bars) - gap
      const step = wave.length ? Math.max(1, Math.floor(wave.length / bars)) : 0
      for (let i = 0; i < bars; i++) {
        const v = wave.length ? (wave[i * step] || 0) / 255 : 0.2
        const bh = Math.max(3, v * (h - 4))
        const x = i * (barW + gap)
        const y = (h - bh) / 2
        const filled = (i / bars) <= progress
        ctx.fillStyle = filled ? "#3b82f6" : "rgba(150,150,170,0.3)"
        ctx.beginPath()
        ctx.roundRect(x, y, barW, bh, 2)
        ctx.fill()
      }
    }
    draw()
    audio.addEventListener("timeupdate", () => {
      progress = audio.duration ? (audio.currentTime / audio.duration) : 0
      time.textContent = fmtTime(audio.currentTime * 1000) + " / " + fmtTime(durationMs)
      draw()
    })
    audio.addEventListener("ended", () => {
      playing = false
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
      progress = 0; draw()
      time.textContent = fmtTime(durationMs)
    })
    btn.addEventListener("click", () => {
      if (playing) {
        audio.pause(); playing = false
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
      } else {
        audio.play(); playing = true
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="5" y="4" width="4" height="16" rx="1"/><rect x="15" y="4" width="4" height="16" rx="1"/></svg>'
      }
    })
    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect()
      const p = (e.clientX - rect.left) / rect.width
      if (audio.duration) audio.currentTime = audio.duration * p
    })
    return wrap
  }

  NS.start = start
  NS.stop = stop
  NS.cancel = cancel
  NS.renderPlayer = renderPlayer
  NS.isRecording = () => !!activeRecorder
})()
