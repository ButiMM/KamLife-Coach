-- Shadow replies — staging capture for the one-brain rebuild (Slice 1, 2026-08-04).
--
-- With SHADOW=on the outbound door writes here instead of calling Twilio: the whole
-- pipeline runs and nothing reaches a human. Deliberately NOT foreign-keyed to users —
-- a capture must never fail because the phone has no row yet, and shadow rows must
-- survive a client deletion so a post-mortem still has the evidence.
--
-- Apply via: psql $DATABASE_URL -f migrations/add_shadow_replies.sql
-- Or: npm run db:push (from Railway console)

CREATE TABLE IF NOT EXISTS shadow_replies (
  id           SERIAL PRIMARY KEY,
  user_id      UUID,
  phone        TEXT        NOT NULL,
  -- 'reply' | 'proactive' | 'template' | 'buttons'
  channel      TEXT        NOT NULL,
  -- Which file called the door. The authorship count, per message, from live traffic.
  author_file  TEXT        NOT NULL,
  body         TEXT        NOT NULL,
  media_urls   JSONB,
  commit_sha   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shadow_replies_phone_idx   ON shadow_replies (phone, created_at);
CREATE INDEX IF NOT EXISTS shadow_replies_created_idx ON shadow_replies (created_at);
