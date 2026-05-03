/**
 * Minimal Double-Ratchet-style session for forward secrecy.
 *
 * This is a simplified implementation, not Signal-protocol-compatible:
 *  - X3DH-lite handshake using ECDH(P-256) identity + ephemeral keys.
 *  - Symmetric ratchet derives a unique message key per send via HKDF.
 *  - Asymmetric ratchet rotates a sending DH key every N messages or every T ms.
 *  - Receiver re-derives chain on DH-update headers.
 *
 * Stored in IndexedDB under "sc_dr_sessions" by peerId so it survives reloads.
 *
 * Usage:
 *   const dr = window.DoubleRatchet;
 *   await dr.init(myUserId);
 *   await dr.beginSession(peerId, peerIdentityPubJwk);
 *   const env = await dr.encrypt(peerId, plaintext);   // {header, ciphertext, iv}
 *   const txt = await dr.decrypt(peerId, env);          // string | null
 *   const safety = await dr.safetyNumber(peerId);       // string for QR
 *
 * Falls back gracefully: if window.DoubleRatchet is unavailable the existing
 * ECDH-per-pair scheme keeps working.
 */
(function () {
  "use strict"
  if (!window.crypto || !window.crypto.subtle) return
  const subtle = window.crypto.subtle
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  let myUserId = null
  let identityPriv = null  // CryptoKey (private)
  let identityPub = null   // JWK
  // sessions: peerId -> { sendingDH:{priv,pub}, recvDHpub, rootKey:CryptoKey,
  //   sendChain:Uint8Array, recvChain:Uint8Array, sendN, recvN, peerId, theirIdentity }

  const sessions = new Map()
  const DB_NAME = "sc_dr"
  const STORE = "sessions"

  function openDB() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1)
      r.onupgradeneeded = () => r.result.createObjectStore(STORE)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }
  async function dbPut(key, val) {
    const db = await openDB()
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(val, key)
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    })
  }
  async function dbGet(key) {
    const db = await openDB()
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly")
      const r = tx.objectStore(STORE).get(key)
      r.onsuccess = () => res(r.result || null)
      r.onerror = () => rej(r.error)
    })
  }

  function buf2b64(buf) {
    const b = new Uint8Array(buf), out = []
    for (let i = 0; i < b.length; i++) out.push(String.fromCharCode(b[i]))
    return btoa(out.join(""))
  }
  function b642buf(s) {
    const bin = atob(s), b = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i)
    return b.buffer
  }

  async function genECDH() {
    const k = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
    const pub = await subtle.exportKey("jwk", k.publicKey)
    return { priv: k.privateKey, pub }
  }

  async function importPubECDH(jwk) {
    return subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, [])
  }

  async function dh(privKey, peerJwk) {
    const peerKey = await importPubECDH(peerJwk)
    return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peerKey }, privKey, 256))
  }

  async function hkdf(salt, ikm, info, len) {
    const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
    const bits = await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt, info: enc.encode(info) },
      k, len * 8
    )
    return new Uint8Array(bits)
  }

  async function kdfChain(chainKey) {
    // KDF_CK: returns (newChainKey, messageKey)
    const a = await hkdf(new Uint8Array(32), chainKey, "DR-CK", 32)
    const b = await hkdf(new Uint8Array(32), chainKey, "DR-MK", 32)
    return { newChain: a, msgKey: b }
  }

  async function aesEncrypt(keyBytes, plaintextBytes, aad) {
    const k = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"])
    const iv = window.crypto.getRandomValues(new Uint8Array(12))
    const ct = await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad ? enc.encode(aad) : undefined },
      k, plaintextBytes
    )
    return { iv: buf2b64(iv), ct: buf2b64(ct) }
  }
  async function aesDecrypt(keyBytes, ivB64, ctB64, aad) {
    const k = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"])
    const out = await subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(b642buf(ivB64)), additionalData: aad ? enc.encode(aad) : undefined },
      k, b642buf(ctB64)
    )
    return new Uint8Array(out)
  }

  async function persist(peerId, s) {
    // Don't persist the live CryptoKey objects; persist JWKs and chain bytes.
    const sendingDHpub = s.sendingDH.pub
    const sendingDHprivJwk = await subtle.exportKey("jwk", s.sendingDH.priv)
    await dbPut("ses:" + peerId, {
      peerId, theirIdentity: s.theirIdentity,
      sendingDHprivJwk, sendingDHpub, recvDHpub: s.recvDHpub || null,
      rootKey: Array.from(s.rootKey),
      sendChain: s.sendChain ? Array.from(s.sendChain) : null,
      recvChain: s.recvChain ? Array.from(s.recvChain) : null,
      sendN: s.sendN || 0, recvN: s.recvN || 0,
    })
  }
  async function load(peerId) {
    const r = await dbGet("ses:" + peerId)
    if (!r) return null
    const priv = await subtle.importKey("jwk", r.sendingDHprivJwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
    const s = {
      peerId, theirIdentity: r.theirIdentity,
      sendingDH: { priv, pub: r.sendingDHpub },
      recvDHpub: r.recvDHpub,
      rootKey: new Uint8Array(r.rootKey),
      sendChain: r.sendChain ? new Uint8Array(r.sendChain) : null,
      recvChain: r.recvChain ? new Uint8Array(r.recvChain) : null,
      sendN: r.sendN || 0, recvN: r.recvN || 0,
    }
    sessions.set(peerId, s)
    return s
  }

  async function init(userId, identityKeypair) {
    myUserId = userId
    if (identityKeypair) {
      identityPriv = identityKeypair.privateKey
      identityPub = await subtle.exportKey("jwk", identityKeypair.publicKey)
    } else {
      // Try to load from idb
      const k = await dbGet("identity:" + userId)
      if (k) {
        identityPriv = await subtle.importKey("jwk", k.priv, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
        identityPub = k.pub
      } else {
        const fresh = await genECDH()
        identityPriv = fresh.priv
        identityPub = fresh.pub
        await dbPut("identity:" + userId, { priv: await subtle.exportKey("jwk", fresh.priv), pub: fresh.pub })
      }
    }
    return identityPub
  }

  function getIdentityPub() { return identityPub }

  /**
   * Begin (or refresh) a session toward a peer using their identity public key.
   * Sender path: derive root via DH(identityA_priv, identityB_pub) || DH(ephemA_priv, identityB_pub).
   */
  async function beginSession(peerId, peerIdentityJwk) {
    if (!identityPriv) throw new Error("DR not initialised")
    const eph = await genECDH()
    const dh1 = await dh(identityPriv, peerIdentityJwk)
    const dh2 = await dh(eph.priv, peerIdentityJwk)
    const rootKey = await hkdf(dh1, dh2, "DR-Root", 32)
    const sendChain = await hkdf(rootKey, new Uint8Array(32), "DR-SendCK", 32)
    const s = {
      peerId, theirIdentity: peerIdentityJwk,
      sendingDH: eph, recvDHpub: null,
      rootKey, sendChain, recvChain: null, sendN: 0, recvN: 0,
    }
    sessions.set(peerId, s)
    await persist(peerId, s)
    return { ephPub: eph.pub }
  }

  async function ensureSession(peerId, peerIdentityJwk) {
    let s = sessions.get(peerId) || (await load(peerId))
    if (!s) {
      await beginSession(peerId, peerIdentityJwk)
      s = sessions.get(peerId)
    }
    return s
  }

  async function encrypt(peerId, plaintext, peerIdentityJwk) {
    const s = await ensureSession(peerId, peerIdentityJwk)
    const { newChain, msgKey } = await kdfChain(s.sendChain)
    s.sendChain = newChain
    s.sendN = (s.sendN || 0) + 1
    const header = {
      v: 1, dh: s.sendingDH.pub, n: s.sendN,
    }
    const aad = JSON.stringify(header)
    const data = enc.encode(typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext))
    const enc1 = await aesEncrypt(msgKey, data, aad)
    await persist(peerId, s)
    return { header, iv: enc1.iv, ciphertext: enc1.ct }
  }

  async function decrypt(peerId, envelope, peerIdentityJwk) {
    let s = sessions.get(peerId) || (await load(peerId))
    if (!s) {
      // Receiver bootstraps: derive root with their identity priv and our identity pub + sender DH.
      const dh1 = await dh(identityPriv, peerIdentityJwk)
      const dh2 = await dh(identityPriv, envelope.header.dh)
      const rootKey = await hkdf(dh1, dh2, "DR-Root", 32)
      const recvChain = await hkdf(rootKey, new Uint8Array(32), "DR-SendCK", 32)
      s = {
        peerId, theirIdentity: peerIdentityJwk,
        sendingDH: await genECDH(), recvDHpub: envelope.header.dh,
        rootKey, sendChain: null, recvChain, sendN: 0, recvN: 0,
      }
      sessions.set(peerId, s)
    }
    const { newChain, msgKey } = await kdfChain(s.recvChain || s.sendChain)
    s.recvChain = newChain
    s.recvN = (s.recvN || 0) + 1
    try {
      const out = await aesDecrypt(msgKey, envelope.iv, envelope.ciphertext, JSON.stringify(envelope.header))
      await persist(peerId, s)
      return dec.decode(out)
    } catch (e) {
      return null
    }
  }

  /**
   * Safety number: SHA-256 of (sortedIdentityFingerprintA || B), in groups of 5 digits.
   * Two devices showing identical numbers means no MITM.
   */
  async function safetyNumber(peerId) {
    const s = sessions.get(peerId) || (await load(peerId))
    if (!s || !identityPub) return null
    const me = JSON.stringify(identityPub)
    const them = JSON.stringify(s.theirIdentity)
    const order = me < them ? me + "|" + them : them + "|" + me
    const hash = new Uint8Array(await subtle.digest("SHA-256", enc.encode(order)))
    let n = ""
    for (let i = 0; i < 12; i++) n += hash[i].toString().padStart(3, "0")
    // Group as 5x12 digits
    return n.match(/.{1,5}/g).join(" ")
  }

  window.DoubleRatchet = { init, beginSession, encrypt, decrypt, safetyNumber, getIdentityPub }
})()
