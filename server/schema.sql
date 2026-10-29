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
