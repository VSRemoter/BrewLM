-- Reports of shared links (POST /v1/shares/:id/report). The server can't read
-- a link, so a report is someone's description of it; the admin takes a link
-- down (shares.disabled_at) without reading it. Old reports are deleted by the
-- hourly sweep.
CREATE TABLE share_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX share_reports_share ON share_reports(share_id);
CREATE INDEX share_reports_ip ON share_reports(ip, created_at);
