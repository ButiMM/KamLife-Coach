-- THE CLIENT RECORD (#271, ORDERS §4 Step 3). Design, retention and erasure: docs/CLIENT-RECORD.md.
--
-- client_events: what the client actually sent, one row per inbound message, never rewritten.
-- client_facts:  what the client told us about themselves, typed, sourced and time-scoped.
-- Both hang off users(id) ON DELETE CASCADE, so the confirmed POPIA deletion (which deletes the
-- users row) erases them in the same transaction. Additive and idempotent.

CREATE TABLE IF NOT EXISTS client_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_message_id  TEXT UNIQUE,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel            TEXT NOT NULL DEFAULT 'text',
  raw_text           TEXT NOT NULL,
  transcript_raw     TEXT,
  normalised_text    TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS client_events_user_idx ON client_events(user_id, received_at);
--> statement-breakpoint
-- IMMUTABLE MEANS PROTECTED FROM REWRITING, NOT UNDELETABLE. What the client said cannot be
-- edited after the fact; DELETE (erasure, retention) is allowed.
CREATE OR REPLACE FUNCTION client_events_no_rewrite() RETURNS trigger AS $$
BEGIN
  IF NEW.raw_text IS DISTINCT FROM OLD.raw_text OR NEW.transcript_raw IS DISTINCT FROM OLD.transcript_raw THEN
    RAISE EXCEPTION 'client_events: what the client said is never rewritten (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_events_no_rewrite ON client_events;
--> statement-breakpoint
CREATE TRIGGER client_events_no_rewrite BEFORE UPDATE ON client_events
  FOR EACH ROW EXECUTE FUNCTION client_events_no_rewrite();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS client_facts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('goal','injury','constraint','schedule','preference','life_event')),
  subject          TEXT NOT NULL,
  statement        TEXT NOT NULL,
  detail           JSONB,
  source_event_id  UUID REFERENCES client_events(id) ON DELETE SET NULL,
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until      TIMESTAMPTZ,
  superseded_by    UUID REFERENCES client_facts(id) ON DELETE SET NULL,
  superseded_at    TIMESTAMPTZ,
  extracted_by     TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS client_facts_active_idx ON client_facts(user_id) WHERE superseded_by IS NULL;
