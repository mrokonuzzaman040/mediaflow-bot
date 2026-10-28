-- MediaFlow usage database (Cloudflare D1, free plan).
-- Stores Telegram user profile info, job requests and command events.
-- Never stores media files or any credentials. Timestamps are unix seconds (UTC).

CREATE TABLE IF NOT EXISTS users (
  user_id        INTEGER PRIMARY KEY,          -- Telegram user id
  username       TEXT,
  first_name     TEXT,
  last_name      TEXT,
  language_code  TEXT,
  is_premium     INTEGER NOT NULL DEFAULT 0,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  total_requests INTEGER NOT NULL DEFAULT 0,   -- jobs started
  is_blocked     INTEGER NOT NULL DEFAULT 0    -- 1 = may not start jobs
);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);
CREATE INDEX IF NOT EXISTS idx_users_first_seen ON users(first_seen);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,              -- one row per started job
  menu_id       TEXT,                          -- the link/menu id the job came from
  user_id       INTEGER NOT NULL,
  chat_id       INTEGER NOT NULL,
  url           TEXT NOT NULL,
  platform      TEXT,
  action        TEXT NOT NULL,                 -- video | mp3 | watermark | crop | frames
  options       TEXT,                          -- JSON
  status        TEXT NOT NULL DEFAULT 'queued',-- queued | running | done | failed
  error_code    TEXT,
  error_message TEXT,
  title         TEXT,
  file_size     INTEGER,                       -- bytes of the delivered file
  duration_sec  REAL,                          -- source media duration
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  processing_ms INTEGER,
  token_hash    TEXT                           -- SHA-256 of the one-time runner callback token
);
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_platform ON jobs(platform);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  chat_id    INTEGER,
  type       TEXT NOT NULL,                    -- command | link | callback
  detail     TEXT,                             -- e.g. "/start", or the link
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
