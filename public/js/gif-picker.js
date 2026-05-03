/**
 * Lightweight GIF picker.
 * Uses Tenor v2 API. The frontend calls /api/gif/search?q=... so the API key
 * stays server-side. If TENOR_API_KEY is not set, search returns empty.
 *
 * Usage:
 *   window.GifPicker.open(anchorEl, (gifUrl) => { ... });
 */
(function () {
  "use strict"
  const NS = (window.GifPicker = window.GifPicker || {})

  let panel = null
  let onPickCb = null
  let lastQ = ""

  function ensurePanel() {
    if (panel) return panel
    panel = document.createElement("div")
    panel.className = "sc-gif-picker"
    panel.style.cssText = "position:fixed;display:none;z-index:9999;width:340px;max-width:calc(100vw - 24px);max-height:380px;overflow:hidden;background:var(--surface,#111);color:var(--fg,#fff);border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:inherit"
    panel.innerHTML = [
      '<div style="display:flex;gap:6px;padding:8px;border-bottom:1px solid rgba(255,255,255,.08)">',
      '  <input id="scGifQ" type="search" placeholder="Search GIFs..." style="flex:1;padding:6px 8px;border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;border-radius:6px">',
      '  <button id="scGifClose" type="button" style="background:transparent;border:0;color:inherit;cursor:pointer">×</button>',
      '</div>',
      '<div id="scGifGrid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px;padding:6px;overflow:auto;max-height:320px"></div>',
    ].join("")
    document.body.appendChild(panel)
    panel.querySelector("#scGifClose").addEventListener("click", close)
    let t
    panel.querySelector("#scGifQ").addEventListener("input", (e) => {
      clearTimeout(t)
      const q = e.target.value
      t = setTimeout(() => search(q), 250)
    })
    return panel
  }

  async function search(q) {
    lastQ = q
    const grid = panel.querySelector("#scGifGrid")
    grid.innerHTML = '<div style="grid-column:1/3;text-align:center;opacity:.6;padding:14px">Loading...</div>'
    try {
      const url = q ? "/api/gif/search?q=" + encodeURIComponent(q) : "/api/gif/featured"
      const j = await fetch(url).then(r => r.json())
      grid.innerHTML = ""
      const items = (j && j.results) || []
      if (!items.length) {
        grid.innerHTML = '<div style="grid-column:1/3;text-align:center;opacity:.6;padding:14px">No results</div>'
        return
      }
      for (const it of items) {
        const img = document.createElement("img")
        img.src = it.preview
        img.alt = it.title || ""
        img.loading = "lazy"
        img.style.cssText = "width:100%;height:100px;object-fit:cover;border-radius:6px;cursor:pointer;background:#222"
        img.addEventListener("click", () => {
          if (onPickCb) onPickCb({ url: it.url, preview: it.preview, w: it.w, h: it.h })
          close()
        })
        grid.appendChild(img)
      }
    } catch (e) {
      grid.innerHTML = '<div style="grid-column:1/3;text-align:center;opacity:.6;padding:14px">Error: ' + e.message + '</div>'
    }
  }

  function open(anchor, onPick) {
    onPickCb = onPick
    ensurePanel()
    panel.style.display = "block"
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect()
      panel.style.left = Math.max(8, Math.min(window.innerWidth - 348, r.left)) + "px"
      panel.style.top = Math.max(8, r.top - 388) + "px"
    } else {
      panel.style.left = "50%"; panel.style.top = "20%"; panel.style.transform = "translateX(-50%)"
    }
    setTimeout(() => panel.querySelector("#scGifQ").focus(), 50)
    if (!lastQ) search("")
  }

  function close() { if (panel) panel.style.display = "none"; onPickCb = null }

  NS.open = open
  NS.close = close
})()
