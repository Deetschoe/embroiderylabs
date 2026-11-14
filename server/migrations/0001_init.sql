-- EmbroideryLabs accounts, plans, export counting and saved canvases.
-- Apply with: wrangler d1 migrations apply embroiderylabs --remote
-- Times are milliseconds since 1970 (UTC). Ids are random text.

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,               -- our id (random)
  google_sub          TEXT NOT NULL UNIQUE,           -- Google's stable account id ("sub" in the ID token)
  email               TEXT NOT NULL,
  name                TEXT NOT NULL DEFAULT '',
  picture             TEXT NOT NULL DEFAULT '',
  stripe_customer_id  TEXT UNIQUE,                    -- set after the first checkout
  created_at          INTEGER NOT NULL,
  last_login_at       INTEGER NOT NULL
);

-- One row per Stripe subscription. The plan a user has is the best row whose status is active,
-- trialing or past_due; without one, the user is on Free.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                    TEXT PRIMARY KEY,             -- Stripe subscription id (sub_...)
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan                  TEXT NOT NULL,                -- 'hobby' | 'pro' | 'unknown'
  status                TEXT NOT NULL,                -- Stripe status: active, trialing, past_due, canceled, ...
  price_id              TEXT NOT NULL DEFAULT '',
  current_period_end    INTEGER,                      -- ms
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
  event_created         INTEGER NOT NULL DEFAULT 0,   -- Stripe event time (s) of the last change: older events are ignored
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id);

-- One row per machine-file export. Free counts its rows with plan = 'free' (3 in total);
-- Hobby counts paid rows in the calendar month (UTC). Failed exports are not counted.
CREATE TABLE IF NOT EXISTS export_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,                          -- 'YYYY-MM' (UTC)
  plan        TEXT NOT NULL,                          -- plan at the time of the export
  format      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok',             -- 'ok' | 'failed'
  stitches    INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS export_log_user_month ON export_log(user_id, month);
CREATE INDEX IF NOT EXISTS export_log_user_plan ON export_log(user_id, plan);

-- Saved canvases. data is the editor's design payload as JSON text (size capped by the Worker).
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,                       -- made by the browser (random)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, updated_at);

-- Stripe webhook events already handled (Stripe can send the same event more than once).
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
