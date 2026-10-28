CREATE TABLE comments (
  id                TEXT PRIMARY KEY,
  page              TEXT NOT NULL,           -- host + path, e.g. "you.github.io/post"
  parent_id         TEXT,
  name              TEXT NOT NULL,
  avatar            TEXT,                    -- SHA-256 of email, for Gravatar
  body              TEXT NOT NULL,
  created_at        TEXT NOT NULL,           -- ISO 8601
  status            TEXT NOT NULL CHECK (status IN ('approved', 'pending')),
  deleted           INTEGER NOT NULL DEFAULT 0,
  delete_token_hash TEXT
);

CREATE INDEX idx_comments_page ON comments (page, created_at);
CREATE INDEX idx_comments_parent ON comments (parent_id);
CREATE INDEX idx_comments_pending ON comments (created_at) WHERE status = 'pending';

CREATE TABLE rate_limits (
  ip_hash      TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,             -- epoch ms
  count        INTEGER NOT NULL
);
