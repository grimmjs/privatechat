/**
 * Database layer — SQLite (default) or Postgres via DB_DRIVER env.
 * Promise-based run / get / all helpers with unified API.
 */
const path = require("path")
const fs = require("fs")

const DB_DRIVER = (process.env.DB_DRIVER || (process.env.DATABASE_URL ? "pg" : "sqlite")).toLowerCase()
const isPg = DB_DRIVER === "pg"

let db = null
let pool = null
let sqliteDb = null

let run, get, all

if (isPg) {
  const { Pool } = require("pg")
  const conn = process.env.DATABASE_URL
  if (!conn) {
    console.error("[DB] DATABASE_URL required for DB_DRIVER=pg")
    process.exit(1)
  }
  pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } })
  db = pool

  const pgTransform = (sql) => {
    let transformed = sql
      .replace(/INSERT OR IGNORE INTO\s+(\w+)\s+\(([^)]+)\)\s+VALUES\s+\(([^)]+)\)/gi, (match, table, cols, vals) => {
        return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING`
      })
      .replace(/INSERT OR REPLACE INTO\s+(\w+)\s+\(([^)]+)\)\s+VALUES\s+\(([^)]+)\)/gi, (match, table, cols, vals) => {
        const setClause = cols.split(",").map((c) => `${c.trim()} = EXCLUDED.${c.trim()}`).join(", ")
        return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT DO UPDATE SET ${setClause}`
      })
    
    // Translate '?' to '$1', '$2', etc. for Postgres
    let i = 1
    return transformed.replace(/\?/g, () => `$${i++}`)
  }

  run = async (sql, params = []) => {
    sql = pgTransform(sql)
    const isInsert = /^\s*INSERT\s+INTO\s+/i.test(sql) && !/RETURNING/i.test(sql) && !/ON\s+CONFLICT/i.test(sql)
    if (isInsert) {
      sql = sql.trim().replace(/;?$/, "") + " RETURNING id;"
    }
    const result = await pool.query(sql, params)
    const lastID = result.rows[0]?.id ?? null
    return { lastID, changes: result.rowCount }
  }

  get = async (sql, params = []) => {
    const result = await pool.query(pgTransform(sql), params)
    return result.rows[0] ?? null
  }

  all = async (sql, params = []) => {
    const result = await pool.query(pgTransform(sql), params)
    return result.rows
  }
} else {
  const sqlite3 = require("sqlite3").verbose()
  const DATA_DIR = path.join(__dirname, "..", "data")
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  const DB_PATH = path.join(DATA_DIR, "securechat.sqlite")
  sqliteDb = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error("[DB] Failed to open database:", err.message)
      process.exit(1)
    }
    console.log("[DB] Connected to SQLite at", DB_PATH)
  })
  sqliteDb.run("PRAGMA journal_mode = WAL")
  sqliteDb.run("PRAGMA foreign_keys = ON")
  sqliteDb.run("PRAGMA synchronous = NORMAL")
  db = sqliteDb

  run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      sqliteDb.run(sql, params, function (err) {
        if (err) return reject(err)
        resolve({ lastID: this.lastID, changes: this.changes })
      })
    })

  get = (sql, params = []) =>
    new Promise((resolve, reject) => {
      sqliteDb.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
    })

  all = (sql, params = []) =>
    new Promise((resolve, reject) => {
      sqliteDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))
    })
}

// Migrations
const { runMigrations } = require("./migrate")
const MIGRATIONS_DIR = path.join(__dirname, "migrations")

const helpers = { run, get, all, isPg }
let initPromise = null

async function fixPostgresTypes() {
  if (!isPg) return
  const columnsToFix = [
    "created_at", "timestamp", "expires_at", "last_seen", 
    "banned_at", "deleted_at", "edited_at", "joined_at", "resolved_at", "key_id"
  ]
  const tables = ["users", "friends", "blocks", "reports", "sessions", "messages", "reactions", "polls", "poll_votes", "files", "link_previews", "auth_attempts", "audit_log", "groups", "group_members", "group_messages", "sticker_packs", "stickers", "push_subscriptions", "prekeys", "devices"]
  
  for (const table of tables) {
    try {
      for (const col of columnsToFix) {
        // Check if table and column exist before altering
        const check = await get(`
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = $1 AND column_name = $2 AND data_type = 'integer'
        `, [table, col])
        if (check) {
          console.log(`[DB] Fixing type for ${table}.${col} -> BIGINT`)
          await run(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE BIGINT`)
        }
      }
    } catch (e) {
      // Ignore errors (e.g. table doesn't exist yet)
    }
  }
}

async function doInit() {
  const { applied } = await runMigrations(helpers, MIGRATIONS_DIR)
  if (applied.length) console.log("[DB] Applied migrations:", applied.join(", "))
  if (isPg) await fixPostgresTypes()
}

function init() {
  if (!initPromise) initPromise = doInit()
  return initPromise
}

// Fire-and-forget so modules can require immediately.
// server.js should await init() before starting listeners.
init().catch((err) => {
  console.error("[DB] Migration failed:", err.message)
  process.exit(1)
})

module.exports = { db, pool, run, get, all, isPg, init }
