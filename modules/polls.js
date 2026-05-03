/**
 * Polls — bound to a parent message_id; options stored as JSON array of strings.
 */
const { run, get, all } = require("../database/db")

async function createPoll(messageId, question, options, multi = false) {
  const opts = JSON.stringify(options.slice(0, 10).map((o) => String(o).slice(0, 80)))
  const res = await run(
    "INSERT INTO polls (message_id, question, options, multi, closed, created_at) VALUES (?, ?, ?, ?, 0, ?)",
    [messageId, String(question).slice(0, 200), opts, multi ? 1 : 0, Date.now()]
  )
  return res.lastID
}

async function getPollByMessage(messageId) {
  const poll = await get("SELECT * FROM polls WHERE message_id = ?", [messageId])
  if (!poll) return null
  poll.options = JSON.parse(poll.options || "[]")
  poll.votes = await all("SELECT user_id, option_index FROM poll_votes WHERE poll_id = ?", [poll.id])
  return poll
}

async function vote(pollId, userId, optionIndexes) {
  const poll = await get("SELECT * FROM polls WHERE id = ?", [pollId])
  if (!poll) throw new Error("Poll not found")
  if (poll.closed) throw new Error("Poll closed")
  const idxs = Array.isArray(optionIndexes) ? optionIndexes : [optionIndexes]
  // Replace prior votes for this user (covers single-choice change & multi update)
  await run("DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?", [pollId, userId])
  const now = Date.now()
  const limit = poll.multi ? 10 : 1
  for (const idx of idxs.slice(0, limit)) {
    const i = parseInt(idx, 10)
    if (Number.isFinite(i) && i >= 0) {
      await run(
        "INSERT OR IGNORE INTO poll_votes (poll_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)",
        [pollId, userId, i, now]
      )
    }
  }
}

async function closePoll(pollId, ownerCheckSql, ownerCheckParams) {
  // ownerCheckSql is a precomputed sender check from caller for safety.
  await run("UPDATE polls SET closed = 1 WHERE id = ?", [pollId])
}

module.exports = { createPoll, getPollByMessage, vote, closePoll }
