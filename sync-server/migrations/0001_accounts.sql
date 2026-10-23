-- Accounts for BrewLM Sync. Each user's library is the vault named by users.id.

CREATE TABLE users (
  id TEXT PRIMARY KEY,                 -- also the vault id
  email TEXT NOT NULL UNIQUE,          -- lower-cased
  created_at INTEGER NOT NULL,
  trial_ends_at INTEGER NOT NULL       -- 14 days after sign-up; no card needed
);

-- Email sign-in in progress. The app holds the pending id, the email holds the
-- token; both are stored only as SHA-256 hashes.
CREATE TABLE sign_ins (
  pending_hash TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  code TEXT NOT NULL,                  -- shown in the app and on the confirm page
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  consumed_at INTEGER
);
CREATE INDEX sign_ins_email ON sign_ins(email, created_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- The user's Polar subscription, kept current by webhooks.
CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  polar_subscription_id TEXT NOT NULL,
  plan TEXT NOT NULL,                  -- 'sync' | 'plus'
  status TEXT NOT NULL,                -- Polar's SubscriptionStatus
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Webhook deliveries already handled (Polar retries; handling must be idempotent).
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
