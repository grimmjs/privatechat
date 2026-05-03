const { safeBasename, safeExt } = require("../modules/files")

describe("files safeBasename", () => {
  test("strips path traversal", () => {
    expect(safeBasename("../../../etc/passwd")).toBe("passwd")
    expect(safeBasename("/tmp/malicious")).toBe("malicious")
  })
  test("strips null bytes", () => {
    expect(safeBasename("file\0.txt")).toBe("file.txt")
  })
  test("defaults to bin", () => {
    expect(safeBasename("")).toBe("bin")
  })
})

describe("files safeExt", () => {
  test("allows normal extensions", () => {
    expect(safeExt("photo.png")).toBe(".png")
    expect(safeExt("archive.zip")).toBe(".zip")
  })
  test("rejects weird extensions", () => {
    expect(safeExt("file.exe..")).toBe(".bin")
    expect(safeExt("file")).toBe(".bin")
  })
})
