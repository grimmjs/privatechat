/**
 * SecureChat — E2E Encryption (Client-side)
 * - PBKDF2 → key derivation from shared passphrase
 * - AES-GCM 256 → authenticated symmetric encryption
 * - Deterministic salt per pair (id1+id2 sorted) → both users derive same key
 *
 * Server NEVER sees the passphrase or keys.
 */
const SecureCrypto = (() => {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const keyCache = new Map() // peerId -> CryptoKey

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf)
    let binary = ''
    const chunkSize = 8192
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize)
      binary += String.fromCharCode(...chunk)
    }
    return btoa(binary)
  }

  function b64ToBuf(b64) {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes.buffer
  }

  async function pairSalt(id1, id2) {
    const [a, b] = [id1, id2].sort()
    const data = enc.encode(`securechat:v1:${a}|${b}`)
    const hash = await crypto.subtle.digest("SHA-256", data)
    return new Uint8Array(hash).slice(0, 16) // 128-bit salt
  }

  async function deriveKey(passphrase, myId, peerId) {
    if (!passphrase || passphrase.length < 6) {
      throw new Error("Passphrase troppo corta (min 6 caratteri)")
    }
    const salt = await pairSalt(myId, peerId)
    const baseKey = await crypto.subtle.importKey(
      "raw", enc.encode(passphrase),
      { name: "PBKDF2" }, false, ["deriveKey"]
    )
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    )
  }

  async function setKeyForPeer(peerId, passphrase, myId) {
    const key = await deriveKey(passphrase, myId, peerId)
    keyCache.set(peerId, key)
    return key
  }

  // Derives a deterministic key from the sorted pair of user IDs.
  // Both clients automatically derive the same key, no passphrase required.
  async function setAutoKey(peerId, myId) {
    const [a, b] = [String(myId), String(peerId)].sort()
    const autoSecret = `securechat:auto-key:v1:${a}|${b}`
    const key = await deriveKey(autoSecret, myId, peerId)
    keyCache.set(peerId, key)
    return key
  }

  function hasKey(peerId) {
    return keyCache.has(peerId)
  }

  function clearKey(peerId) {
    keyCache.delete(peerId)
  }

  async function encryptString(peerId, plaintext) {
    const key = keyCache.get(peerId)
    if (!key) throw new Error("Nessuna chiave per questo peer")
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key, enc.encode(plaintext)
    )
    return { ciphertext: bufToB64(ct), iv: bufToB64(iv) }
  }

  async function decryptString(peerId, ciphertextB64, ivB64) {
    const key = keyCache.get(peerId)
    if (!key) throw new Error("Nessuna chiave per questo peer")
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(b64ToBuf(ivB64)) },
      key, b64ToBuf(ciphertextB64)
    )
    return dec.decode(pt)
  }

  async function encryptJSON(peerId, obj) {
    return encryptString(peerId, JSON.stringify(obj))
  }

  async function decryptJSON(peerId, ciphertextB64, ivB64) {
    const txt = await decryptString(peerId, ciphertextB64, ivB64)
    return JSON.parse(txt)
  }

  return {
    setKeyForPeer, setAutoKey, hasKey, clearKey,
    encryptString, decryptString, encryptJSON, decryptJSON,
  }
})()
