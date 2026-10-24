-- Pages fetched for the web app (POST /v1/fetch), for its hourly limit per account.
-- Rows older than a day are deleted as new ones are added.
CREATE TABLE page_fetches (
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX page_fetches_user ON page_fetches(user_id, created_at);
