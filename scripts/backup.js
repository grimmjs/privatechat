#!/usr/bin/env node
/**
 * SQLite hot-backup using the SQLite Online Backup API exposed by sqlite3.
 * Usage: node scripts/backup.js [destDir]
 */
const path = require("path")
const fs = require("fs")
const sqlite3 = require("sqlite3").verbose()

const SRC = path.join(__dirname, "..", "data", "securechat.sqlite")
const DEST_DIR = process.argv[2] || path.join(__dirname, "..", "backups")
const RETENTION_DAYS = 14

if (!fs.existsSync(SRC)) {
  console.error("[backup] Source DB not found:", SRC)
  process.exit(1)
}
if (!fs.existsSync(DEST_DIR)) fs.mkdirSync(DEST_DIR, { recursive: true })

const ts = new Date().toISOString().replace(/[:.]/g, "-")
const destFile = path.join(DEST_DIR, `securechat-${ts}.sqlite`)

const src = new sqlite3.Database(SRC)
const dest = new sqlite3.Database(destFile)

src.serialize(() => {
  // sqlite3 npm module exposes db.backup as of v5.1; fall back to file copy if unavailable.
  if (typeof src.backup === "function") {
    const b = src.backup(destFile)
    b.step(-1, (err) => {
      if (err) {
        console.error("[backup] step error:", err)
        process.exit(1)
      }
      b.finish((e) => {
        if (e) console.error("[backup] finish error:", e)
        else console.log("[backup] wrote", destFile)
        cleanup()
      })
    })
  } else {
    fs.copyFileSync(SRC, destFile)
    console.log("[backup] copied", destFile)
    cleanup()
  }
})

function cleanup() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000
  for (const f of fs.readdirSync(DEST_DIR)) {
    if (!f.startsWith("securechat-") || !f.endsWith(".sqlite")) continue
    const full = path.join(DEST_DIR, f)
    const stat = fs.statSync(full)
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(full)
      console.log("[backup] pruned", f)
    }
  }
  src.close()
  dest.close()
}
