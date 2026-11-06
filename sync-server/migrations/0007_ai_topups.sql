-- The Polar product a subscription is on (its plan and billing interval), so
-- POST /v1/billing/change can tell monthly from yearly. Filled by webhooks.
ALTER TABLE subscriptions ADD COLUMN product_id TEXT;

-- BrewLM AI top-ups (one-time Polar orders). Each order's credit is added to
-- ai_accounts.topup once; refunds take back the refunded share.
CREATE TABLE ai_topups (
  order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  credit REAL NOT NULL,                -- dollars of OpenRouter credit the order added
  net_amount INTEGER NOT NULL,         -- what was paid, in cents before tax
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_topups_user ON ai_topups(user_id);
