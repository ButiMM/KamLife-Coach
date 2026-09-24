-- THE NEW COACH IN SHADOW (#272). What the new core WOULD have said, beside what the old path did
-- say, for the replay gate to grade per journey. Read-only for clients: nothing here is ever sent.
-- Cascades from users(id), so POPIA deletion erases it with the client.
CREATE TABLE IF NOT EXISTS core_shadow (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_id        TEXT,
  input_text     TEXT NOT NULL,
  understanding  JSONB,
  facts_read     INTEGER NOT NULL DEFAULT 0,
  reply          TEXT NOT NULL,
  model          TEXT NOT NULL,
  ms             INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS core_shadow_root_idx ON core_shadow(root_id);
