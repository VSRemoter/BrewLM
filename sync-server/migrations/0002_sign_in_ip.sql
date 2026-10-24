-- Per-address limit on sign-in emails, so one client can't use the server to
-- send mail to many people. (Cloudflare's CF-Connecting-IP.)
ALTER TABLE sign_ins ADD COLUMN ip TEXT NOT NULL DEFAULT '';
CREATE INDEX sign_ins_ip ON sign_ins(ip, created_at);
