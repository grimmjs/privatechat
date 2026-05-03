/**
 * Unit tests for rate-limit lockout logic.
 */

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const PROGRESSIVE_LOCKOUT_STEPS = [
  { failed: 5,  lockoutMs: 30 * 1000 },
  { failed: 8,  lockoutMs: 2 * 60 * 1000 },
  { failed: 12, lockoutMs: 15 * 60 * 1000 },
  { failed: 20, lockoutMs: 60 * 60 * 1000 },
]

function pickLockout(failedCount) {
  let step = null
  for (const s of PROGRESSIVE_LOCKOUT_STEPS) {
    if (failedCount >= s.failed) step = s
  }
  return step
}

describe("pickLockout", () => {
  test("null under threshold", () => {
    expect(pickLockout(0)).toBeNull()
    expect(pickLockout(4)).toBeNull()
  })
  test("returns correct step at boundaries", () => {
    expect(pickLockout(5).lockoutMs).toBe(30000)
    expect(pickLockout(8).lockoutMs).toBe(120000)
    expect(pickLockout(12).lockoutMs).toBe(900000)
    expect(pickLockout(20).lockoutMs).toBe(3600000)
  })
  test("highest step for large counts", () => {
    expect(pickLockout(100).lockoutMs).toBe(3600000)
  })
})

describe("SSRF hostname guards", () => {
  const blocked = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|172\.(1[6-9]|2[0-9]|3[01])\.)/
  const cases = [
    ["localhost", true],
    ["127.0.0.1", true],
    ["10.0.0.1", true],
    ["192.168.1.1", true],
    ["169.254.1.1", true],
    ["0.0.0.0", true],
    ["172.16.0.1", true],
    ["172.20.5.5", true],
    ["172.31.255.255", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["example.com", false],
    ["1.2.3.4", false],
  ]
  test.each(cases)("%s blocked=%s", (host, expected) => {
    expect(blocked.test(host)).toBe(expected)
  })
})
