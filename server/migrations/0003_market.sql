-- Marketplace: published designs, stars, key unlocks, activity and the top-5 free sew-out.
-- Rules (keys, discount, badges): src/economy.js. Times are ms since 1970 (UTC).

-- A public name for each person: /api/users/:handle. Set at sign-in (from the Google name) or
-- by PATCH /api/me. display_name, when set, is shown instead of the Google name.
ALTER TABLE users ADD COLUMN handle TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_handle ON users(handle);
CREATE INDEX IF NOT EXISTS users_created ON users(created_at);

CREATE TABLE IF NOT EXISTS market_items (
  id           TEXT PRIMARY KEY,                       -- random
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '[]',             -- JSON array of lower-case tags
  tags_key     TEXT NOT NULL DEFAULT ',',              -- ',tag1,tag2,' for the tag filter
  mode         TEXT NOT NULL CHECK (mode IN ('free','keys','show')),
  price_keys   INTEGER NOT NULL DEFAULT 0,             -- 1..5 when mode = 'keys', else 0
  visibility   TEXT NOT NULL CHECK (visibility IN ('public','private')),
  payload      TEXT NOT NULL,                          -- the .embroidr JSON
  size         INTEGER NOT NULL,
  thumb        TEXT NOT NULL DEFAULT '',               -- data:image/... URL, 'r2:<key>', or '' (none)
  stars        INTEGER NOT NULL DEFAULT 0,             -- = COUNT(stars) for this item, kept in the same batch
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS market_new ON market_items(visibility, created_at, id);
CREATE INDEX IF NOT EXISTS market_top ON market_items(visibility, stars, created_at, id);
CREATE INDEX IF NOT EXISTS market_user ON market_items(user_id, created_at);

-- Current stars: one per person per design; removed by an unstar or when the design is deleted.
CREATE TABLE IF NOT EXISTS stars (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES market_items(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS stars_item ON stars(item_id);

-- Lifetime stars received: the first star a person ever gives a design, kept for good (an unstar
-- or a deleted design does not remove it), so earned keys are never taken back.
CREATE TABLE IF NOT EXISTS star_marks (
  user_id     TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS star_marks_owner ON star_marks(owner_id, created_at);
CREATE INDEX IF NOT EXISTS star_marks_item ON star_marks(item_id, created_at);

-- Key unlocks: one per person per design, forever. Kept when the design is deleted: they are what
-- the buyer spent (keysSpent) and what the owner earned (unlocksOfYourDesigns).
CREATE TABLE IF NOT EXISTS unlocks (
  user_id     TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  price_keys  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS unlocks_owner ON unlocks(owner_id);

-- Activity graph: how many saves, publishes, exports and stars given per person per day (UTC).
CREATE TABLE IF NOT EXISTS events (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('save','publish','export','star-given')),
  day         TEXT NOT NULL,                           -- 'YYYY-MM-DD' (UTC)
  n           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, kind, day)
);

-- The first 5 people to reach 10,000 lifetime stars received: one free sew-out each.
CREATE TABLE IF NOT EXISTS sewout_claims (
  rank        INTEGER PRIMARY KEY CHECK (rank BETWEEN 1 AND 5),
  user_id     TEXT NOT NULL UNIQUE,
  claimed_at  INTEGER NOT NULL
);
