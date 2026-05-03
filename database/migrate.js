/**
 * Migration runner — idempotent, versioned, works with SQLite and Postgres.
 *
 * Reads *.sql files from database/migrations/ in lexical order.
 * Tracks applied versions in a `migrations` table.
 *
 * Expects helpers = { run(sql,params), get(sql,params)->row|null, all(sql,params)->rows[], isPg: boolean }
 *
 * For Postgres, minimal dialect transforms are applied to the raw SQL:
 *   - INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL PRIMARY KEY
 *   - DEFAULT (strftime('%s','now') * 1000) -> DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
 *   - COLLATE NOCASE -> (removed; PG is case-sensitive by default)
 *   - INSERT OR IGNORE INTO -> INSERT INTO ... ON CONFLICT DO NOTHING
 *   - INSERT OR REPLACE INTO -> INSERT INTO ... ON CONFLICT DO UPDATE (simplified)
 */

const fs = require("fs")
const path = require("path")

function pgTransform(sql) {
  return sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, "SERIAL PRIMARY KEY")
    .replace(/INTEGER/g, "BIGINT")
    .replace(/DEFAULT \(strftime\('%s','now'\) \* 1000\)/g, "DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint")
    .replace(/COLLATE NOCASE/g, "")
    .replace(/INSERT OR IGNORE INTO\s+(\w+)\s+\(([^)]+)\)\s+VALUES\s+\(([^)]+)\)/gi, (match, table, cols, vals) => {
      return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING`
    })
    .replace(/INSERT OR REPLACE INTO\s+(\w+)\s+\(([^)]+)\)\s+VALUES\s+\(([^)]+)\)/gi, (match, table, cols, vals) => {
      // Naive ON CONFLICT DO UPDATE for primary-key tables.
      const setClause = cols.split(",").map((c) => `${c.trim()} = EXCLUDED.${c.trim()}`).join(", ")
      return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT DO UPDATE SET ${setClause}`
    })
}

async function ensureMigrationsTable(helpers) {
  if (helpers.isPg) {
    await helpers.run(`
      CREATE TABLE IF NOT EXISTS migrations (
        version TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
      )
    `)
  } else {
    await helpers.run(`
      CREATE TABLE IF NOT EXISTS migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      )
    `)
  }
}

async function listPending(helpers, dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".pg.sql"))
    .sort()

  const appliedRows = await helpers.all("SELECT version FROM migrations ORDER BY version")
  const applied = new Set(appliedRows.map((r) => r.version))

  const pending = []
  for (const f of files) {
    const version = f.replace(/\.sql$/, "")
    if (!applied.has(version)) pending.push({ version, file: f })
  }
  return pending
}

async function applyMigration(helpers, dir, { version, file }) {
  let sql = fs.readFileSync(path.join(dir, file), "utf8")
  if (helpers.isPg) sql = pgTransform(sql)

  const stmts = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const stmt of stmts) {
    await helpers.run(stmt + ";")
  }

  if (helpers.isPg) {
    await helpers.run(
      "INSERT INTO migrations (version, applied_at) VALUES ($1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint) ON CONFLICT DO NOTHING",
      [version]
    )
  } else {
    await helpers.run(
      "INSERT OR IGNORE INTO migrations (version, applied_at) VALUES (?, strftime('%s','now') * 1000)",
      [version]
    )
  }
}

async function runMigrations(helpers, dir) {
  await ensureMigrationsTable(helpers)
  const pending = await listPending(helpers, dir)
  if (pending.length === 0) return { applied: [] }
  const applied = []
  for (const m of pending) {
    await applyMigration(helpers, dir, m)
    applied.push(m.version)
  }
  return { applied }
}

module.exports = { runMigrations }
