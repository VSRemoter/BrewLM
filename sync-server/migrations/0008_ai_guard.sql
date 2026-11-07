-- BrewLM AI protection (src/aiGuard.ts).

-- Server-wide switches, as JSON. 'pause': BrewLM AI paused for everyone
-- ({ by: "admin" | "ceiling", reason, at, until }), by the admin or by the
-- daily spending ceiling (until the next UTC day).
CREATE TABLE ai_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- BrewLM's whole OpenRouter spend per UTC day, from OpenRouter's running
-- total (GET /credits), checked every 10 minutes; and which emails went out.
CREATE TABLE ai_days (
  day TEXT PRIMARY KEY,                -- 'YYYY-MM-DD' (UTC)
  start_usage REAL NOT NULL,           -- OpenRouter's total_usage as the day began
  last_usage REAL NOT NULL,            -- … at the latest check
  balance REAL,                        -- credit left at the latest check
  alerted_at INTEGER,                  -- daily alert sent
  ceiling_at INTEGER,                  -- spending ceiling hit: AI paused
  low_balance_at INTEGER,              -- low-credit warning sent
  summary_at INTEGER                   -- this day's summary sent (the next morning)
);

-- Accounts BrewLM AI is turned off for (abuse), whatever their plan.
CREATE TABLE ai_blocks (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Each AI account's spend at the last daily check, to see who used a lot in a day.
CREATE TABLE ai_marks (
  user_id TEXT PRIMARY KEY,
  cycle TEXT NOT NULL,
  spent REAL NOT NULL,
  at INTEGER NOT NULL
);

-- Refunded Pro/Max orders: the refunded share of this month's allowance is
-- taken away once per order (refunds of top-ups are in ai_topups).
CREATE TABLE ai_plan_refunds (
  order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  refunded_amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
