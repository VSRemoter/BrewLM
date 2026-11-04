-- Shared notebook links (src/shares.ts). The snapshot and its files are
-- encrypted with a key only the link carries; the server keeps the bytes in
-- R2 under _shares/<id>/ and counts them against the owner's storage.
CREATE TABLE shares (
  id TEXT PRIMARY KEY,                 -- random, 32 hex characters
  owner_id TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 0,  -- 0 = nothing published yet
  manifest_key TEXT NOT NULL DEFAULT '',  -- R2 object of the current version
  manifest_bytes INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,                  -- NULL = never
  disabled_at INTEGER                  -- set when a link is taken down
);
CREATE INDEX shares_owner ON shares(owner_id);

-- The media files of each share.
CREATE TABLE share_blobs (
  share_id TEXT NOT NULL REFERENCES shares(id),
  id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, id)
);
