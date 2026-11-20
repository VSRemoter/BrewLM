-- Refund abuse, request caps and data retention (see each file named below).

-- When the account first had a paid BrewLM AI plan (not a trial). Starts the
-- slow start (ai.ts) and opens top-ups 30 days later (billing.ts). Kept after
-- the plan ends, so a returning subscriber doesn't start slow again.
ALTER TABLE users ADD COLUMN ai_paid_since INTEGER;
-- Subscribers already on Pro or Max (or who bought a top-up) count as paid
-- for over 30 days: no slow start, top-ups stay open.
UPDATE users SET ai_paid_since = CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 31 * 86400000
WHERE id IN (SELECT user_id FROM subscriptions WHERE plan IN ('pro', 'max') AND status IN ('active', 'past_due'))
   OR id IN (SELECT user_id FROM ai_topups);

-- The slow start (ai.ts): until this time the plan's part of the allowance is
-- held to a share of the month's. NULL = not slowed.
ALTER TABLE ai_accounts ADD COLUMN ramp_until INTEGER;

-- What each account spent in finished months, for refund quotes (billing.ts).
-- plan_spent is the part paid for by the plan's allowance (top-ups excluded).
CREATE TABLE ai_spend (
  user_id TEXT NOT NULL,
  cycle TEXT NOT NULL,                 -- 'YYYY-MM' (UTC)
  plan_spent REAL NOT NULL,
  spent REAL NOT NULL,
  PRIMARY KEY (user_id, cycle)
);

-- Paid plan orders (first payments and renewals), for refund quotes.
CREATE TABLE plan_orders (
  order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  interval TEXT NOT NULL,              -- 'month' | 'year'
  net_amount INTEGER NOT NULL,         -- cents, before tax
  paid_at INTEGER NOT NULL
);
CREATE INDEX plan_orders_user ON plan_orders(user_id, paid_at);

-- Requests per account per UTC day, counted by sampling (limits.ts).
CREATE TABLE request_days (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,                   -- 'YYYY-MM-DD' (UTC)
  n INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- Synced data of accounts without a plan (retention.ts): when the plan or
-- trial ended, the deletion date the emails gave, the two warnings, when the
-- data was deleted (or found empty), and when to look at the account again.
CREATE TABLE retention (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  lapsed_at INTEGER NOT NULL,
  delete_at INTEGER,
  warned_first_at INTEGER,
  warned_last_at INTEGER,
  deleted_at INTEGER,
  next_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX retention_next ON retention(next_at);
