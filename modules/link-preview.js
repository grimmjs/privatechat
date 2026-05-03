/**
 * Lightweight OpenGraph fetcher — no external deps.
 * Cached in `link_previews` to limit outbound requests.
 *
 * Privacy note: the SERVER fetches link metadata, not the user's browser.
 * Only the URL (chosen explicitly by the user) leaves the server.
 */
const crypto = require("crypto")
const https = require("https")
const http = require("http")
const { URL } = require("url")
const { run, get } = require("../database/db")

const CACHE_TTL = 24 * 60 * 60 * 1000 // 24h
const MAX_BYTES = 256 * 1024
const TIMEOUT = 6000

function hashUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex")
}

function decodeEntities(s) {
  if (!s) return ""
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
}

function pickMeta(html, names) {
  for (const name of names) {
    // property="og:title" or name="twitter:title"
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`,
      "i"
    )
    const m = html.match(re)
    if (m) return decodeEntities(m[1])
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`,
      "i"
    )
    const m2 = html.match(re2)
    if (m2) return decodeEntities(m2[1])
  }
  return ""
}

function fetchWithLimit(targetUrl) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(targetUrl)
    } catch {
      return reject(new Error("Invalid URL"))
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return reject(new Error("Unsupported protocol"))
    }
    // SSRF guard — block private/localhost/link-local ranges.
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(url.hostname)) {
      return reject(new Error("Private host blocked"))
    }
    const lib = url.protocol === "https:" ? https : http
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          "User-Agent": "PrivateChat-LinkPreview/1.0",
          Accept: "text/html",
        },
        timeout: TIMEOUT,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          // One redirect hop only.
          fetchWithLimit(new URL(res.headers.location, url).toString()).then(resolve, reject)
          return
        }
        const ct = (res.headers["content-type"] || "").toLowerCase()
        if (!ct.includes("text/html")) {
          res.resume()
          return reject(new Error("Not HTML"))
        }
        const chunks = []
        let bytes = 0
        res.on("data", (c) => {
          bytes += c.length
          if (bytes > MAX_BYTES) {
            res.destroy()
            return
          }
          chunks.push(c)
        })
        res.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8"), finalUrl: url.toString() }))
        res.on("error", reject)
      }
    )
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", reject)
    req.end()
  })
}

async function getPreview(url) {
  if (!url || typeof url !== "string") return null
  const trimmed = url.trim().slice(0, 1024)
  const key = hashUrl(trimmed)
  const cached = await get("SELECT * FROM link_previews WHERE url_hash = ?", [key])
  if (cached && Date.now() - cached.created_at < CACHE_TTL) {
    return {
      url: cached.url,
      title: cached.title,
      description: cached.description,
      image: cached.image,
      site: cached.site,
    }
  }
  let preview
  try {
    const { html, finalUrl } = await fetchWithLimit(trimmed)
    const title =
      pickMeta(html, ["og:title", "twitter:title"]) ||
      (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [, ""])[1].trim()
    const description = pickMeta(html, ["og:description", "twitter:description", "description"])
    const image = pickMeta(html, ["og:image", "twitter:image"])
    const site = pickMeta(html, ["og:site_name"]) || new URL(finalUrl).hostname
    preview = {
      url: finalUrl,
      title: decodeEntities(title).slice(0, 200),
      description: description.slice(0, 280),
      image: image.slice(0, 500),
      site: site.slice(0, 80),
    }
  } catch {
    return null
  }
  await run(
    `INSERT OR REPLACE INTO link_previews (url_hash, url, title, description, image, site, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [key, preview.url, preview.title, preview.description, preview.image, preview.site, Date.now()]
  )
  return preview
}

module.exports = { getPreview }
