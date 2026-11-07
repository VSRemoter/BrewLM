-- A second live Polar subscription on one account (e.g. two checkouts opened
-- before either was paid). The account's plan stays in `subscriptions` (the
-- better of the two); the other waits here, kept current by its webhooks, and
-- takes over if the main one ends while it's still paid for. The admin is
-- emailed once so the extra can be refunded (src/billing.ts).
CREATE TABLE extra_subscriptions (
  polar_subscription_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  product_id TEXT,
  updated_at INTEGER NOT NULL,
  notified_at INTEGER
);
CREATE INDEX extra_subscriptions_user ON extra_subscriptions(user_id);
