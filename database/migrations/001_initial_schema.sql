-- Migration 001: Initial unified schema (SQLite + Postgres compatible)
-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  avatar TEXT,
  bio TEXT,
  status_text TEXT,
  password_hash TEXT,
  password_salt TEXT,
  recovery_hash TEXT,
  recovery_salt TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  accent_color TEXT,
  wallpaper TEXT,
  identity_pubkey TEXT,
  locale TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  banned_at INTEGER,
  ban_reason TEXT,
  deleted_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_users_username_nocase ON users (username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_code ON users (code);

-- Friends
CREATE TABLE IF NOT EXISTS friends (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  PRIMARY KEY (user_id, friend_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Blocks
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  PRIMARY KEY (blocker_id, blocked_id),
  FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Reports
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL,
  reported_id TEXT NOT NULL,
  reason TEXT,
  details TEXT,
  status TEXT DEFAULT 'open',
  resolved_at INTEGER,
  resolution TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_label TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  status TEXT DEFAULT 'sent',
  reply_to_id INTEGER,
  edited_at INTEGER,
  deleted_at INTEGER,
  expires_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'text',
  payload TEXT,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_pair_ts ON messages (sender_id, receiver_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_client_id ON messages (client_id);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages (expires_at);

-- Reactions
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  PRIMARY KEY (message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Polls
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  multi INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id, option_index),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);

-- Files
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  original_name TEXT,
  file_size INTEGER,
  mime_type TEXT,
  encrypted_meta TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Link previews cache
CREATE TABLE IF NOT EXISTS link_previews (
  url_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  image TEXT,
  site TEXT,
  created_at INTEGER NOT NULL
);

-- Auth attempts (brute-force protection)
CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  username TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip_ts ON auth_attempts (ip, timestamp);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_user_ts ON auth_attempts (username, timestamp);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  event TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  meta TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_ts ON audit_log (user_id, timestamp DESC);

-- Groups
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  topic TEXT,
  kind TEXT NOT NULL DEFAULT 'group',
  owner_id TEXT NOT NULL,
  invite_code TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  payload TEXT,
  reply_to_id INTEGER,
  timestamp INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_messages_group_ts ON group_messages (group_id, timestamp);

-- Stickers
CREATE TABLE IF NOT EXISTS sticker_packs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cover TEXT,
  shared INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  data TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (pack_id) REFERENCES sticker_packs(id) ON DELETE CASCADE
);

-- Push subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  ua TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);

-- Prekeys (Signal protocol preparation)
CREATE TABLE IF NOT EXISTS prekeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  key_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  private_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, key_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prekeys_user ON prekeys (user_id);

-- Devices (multi-device support preparation)
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT,
  identity_pubkey TEXT,
  last_seen INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id);
