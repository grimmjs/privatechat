const crypto = require("crypto")
const util = require("util")
const scrypt = util.promisify(crypto.scrypt)

// Inline the auth hashing logic to avoid full DB dependency for unit tests
async function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString("hex")
  const buf = await scrypt(secret, salt, 64)
  return { salt, hash: Buffer.from(buf).toString("hex") }
}

async function verifySecret(secret, salt, expectedHash) {
  if (!salt || !expectedHash) return false
  try {
    const buf = await scrypt(secret, salt, 64)
    const a = Buffer.from(buf)
    const b = Buffer.from(expectedHash, "hex")
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

describe("auth crypto (async scrypt)", () => {
  test("hash and verify password", async () => {
    const { salt, hash } = await hashSecret("my-secret")
    expect(await verifySecret("my-secret", salt, hash)).toBe(true)
    expect(await verifySecret("wrong", salt, hash)).toBe(false)
  })

  test("verify with missing salt returns false", async () => {
    expect(await verifySecret("x", null, "abc")).toBe(false)
  })

  test("different salts produce different hashes", async () => {
    const h1 = await hashSecret("same")
    const h2 = await hashSecret("same")
    expect(h1.hash).not.toBe(h2.hash)
    expect(h1.salt).not.toBe(h2.salt)
  })
})
