/**
 * RFC 6238 TOTP — Google Authenticator compatible.
 * No external dependencies (uses Node crypto).
 */
const crypto = require("crypto")

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

function base32Encode(buf) {
  let bits = 0
  let value = 0
  let out = ""
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(str) {
  const clean = str.replace(/=+$/g, "").toUpperCase().replace(/\s+/g, "")
  let bits = 0
  let value = 0
  const out = []
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i])
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function generateSecret(length = 20) {
  const buf = crypto.randomBytes(length)
  return base32Encode(buf)
}

function buildOtpauthUrl(secret, label, issuer = "PrivateChat") {
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" })
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params.toString()}`
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8)
  // 64-bit big-endian counter
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff
    counter = Math.floor(counter / 256)
  }
  const hmac = crypto.createHmac("sha1", secretBuf).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return (code % 1000000).toString().padStart(6, "0")
}

function totp(secretB32, time = Date.now()) {
  const counter = Math.floor(time / 30000)
  return hotp(base32Decode(secretB32), counter)
}

/** Verify token against secret with ±1 step tolerance. */
function verify(secretB32, token) {
  if (!secretB32 || !token || !/^\d{6}$/.test(token)) return false
  const buf = base32Decode(secretB32)
  const counter = Math.floor(Date.now() / 30000)
  for (const offset of [-1, 0, 1]) {
    if (hotp(buf, counter + offset) === token) return true
  }
  return false
}

module.exports = { generateSecret, buildOtpauthUrl, totp, verify }
