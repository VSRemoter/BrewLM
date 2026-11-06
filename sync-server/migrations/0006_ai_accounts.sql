-- BrewLM AI (src/ai.ts): each Pro/Max subscriber's monthly AI allowance and
-- the OpenRouter key that spends it. Amounts are US dollars of OpenRouter
-- credit. A cycle is a calendar month (UTC); a key never outlives its cycle.
CREATE TABLE ai_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  cycle TEXT NOT NULL,                 -- 'YYYY-MM' (UTC)
  monthly REAL NOT NULL,               -- the plan's allowance this cap was last set from (0 = no AI)
  cap REAL NOT NULL,                   -- this cycle's allowance: prorated, adjusted on plan changes
  topup REAL NOT NULL DEFAULT 0,       -- bought this cycle (Phase A2)
  carried REAL NOT NULL DEFAULT 0,     -- spent this cycle on keys since revoked
  key_hash TEXT,                       -- OpenRouter's id for the current key
  key_enc TEXT,                        -- the key itself, AES-GCM under AI_KEY_SECRET
  key_created_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0,      -- bumped on every write (optimistic locking)
  updated_at INTEGER NOT NULL
);
CREATE INDEX ai_accounts_cycle ON ai_accounts(cycle);
