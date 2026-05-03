const fs = require("fs").promises
const path = require("path")
const { run, get, all } = require("../database/db")
const { deleteFile } = require("../modules/files")

const RETENTION_DAYS = 90
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000

async function runCleanup() {
  console.log(`[Cleanup] Starting 90-day retention cleanup...`)
  const cutoff = Date.now() - RETENTION_MS
  
  try {
    const oldFiles = await all(`SELECT file_path FROM files WHERE timestamp < ?`, [cutoff])
    let deleted = 0
    for (const f of oldFiles) {
      if (f.file_path) {
        await deleteFile(f.file_path)
        deleted++
      }
    }
    
    // Remove from DB
    await run(`DELETE FROM files WHERE timestamp < ?`, [cutoff])
    console.log(`[Cleanup] Successfully deleted ${deleted} files older than 90 days.`)
  } catch (err) {
    console.error("[Cleanup] Error:", err.message)
  }
}

// Run if executed directly
if (require.main === module) {
  runCleanup().then(() => process.exit(0)).catch(() => process.exit(1))
}

module.exports = { runCleanup }
