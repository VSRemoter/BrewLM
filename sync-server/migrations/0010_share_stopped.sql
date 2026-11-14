-- A stopped (or expired) shared link keeps its row, without its files, so
-- people who open it later are told it's no longer available (410) instead
-- of "not found". The hourly sweep deletes these records after a year.
ALTER TABLE shares ADD COLUMN stopped_at INTEGER;
CREATE INDEX shares_stopped ON shares(stopped_at);
