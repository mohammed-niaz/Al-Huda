-- Database tables. Safe to run again: nothing is deleted.
CREATE TABLE IF NOT EXISTS subs (
  endpoint TEXT PRIMARY KEY,                -- the phone's private notification address
  p256dh   TEXT NOT NULL,
  auth     TEXT NOT NULL,
  adhan    INTEGER NOT NULL DEFAULT 1,      -- wants adhan + 10-minute reminder
  status   INTEGER NOT NULL DEFAULT 1,      -- wants masjid open/closed, reminder of the day, news
  created  TEXT
);
CREATE TABLE IF NOT EXISTS kv     (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, topic TEXT, payload TEXT, opts TEXT, created TEXT, done INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS log    (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, who TEXT, action TEXT);
CREATE TABLE IF NOT EXISTS admins (name TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fails  (ip TEXT PRIMARY KEY, n INTEGER, since INTEGER);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (done, created);

-- Accounts (Phase 3): the imam (owner) approves admins; each account is tied to its device(s).
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,            -- lower-case
  name        TEXT NOT NULL,
  pass        TEXT NOT NULL,                   -- pbkdf2$… (lib/password.js)
  role        TEXT NOT NULL DEFAULT 'admin',   -- 'owner' (the imam) or 'admin'
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' or 'active'
  must_change INTEGER NOT NULL DEFAULT 0,      -- 1 = choose a new password at next sign-in
  max_devices INTEGER NOT NULL DEFAULT 1,
  created     TEXT,
  approved_at TEXT,
  approved_by TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  id        TEXT PRIMARY KEY,
  user_id   INTEGER NOT NULL,
  key_hash  TEXT NOT NULL,                     -- hash of the secret kept in that browser
  label     TEXT,                              -- e.g. "iPhone · Safari"
  created   TEXT,
  last_seen TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  device_id  TEXT NOT NULL,
  expires    INTEGER NOT NULL,                 -- ms since 1970
  seen       INTEGER
);
CREATE TABLE IF NOT EXISTS alerts (            -- things the imam should look at
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT,
  kind     TEXT,                               -- 'signup', 'device', 'locked'
  user_id  INTEGER,
  text     TEXT,
  label    TEXT,
  key_hash TEXT,                               -- for 'device': the device that was blocked
  done     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_subs (        -- the imam's phones that get account alerts
  endpoint  TEXT PRIMARY KEY,
  p256dh    TEXT NOT NULL,
  auth      TEXT NOT NULL,
  user_id   INTEGER NOT NULL,
  device_id TEXT
);
CREATE INDEX IF NOT EXISTS devices_user ON devices (user_id);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS alerts_open ON alerts (done, id);
