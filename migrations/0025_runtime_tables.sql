-- #343: the three tables only server/index.ts's boot block created (rate limiter, voice broadcasts, voice recaps),
-- and its webhook-pruning index. Same definitions; IF NOT EXISTS, so production (which has them) is unchanged.
CREATE TABLE IF NOT EXISTS rate_limits (
  phone TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS voice_broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL DEFAULT 'Voice Broadcast',
  audio_base64 TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'audio/ogg',
  duration_secs INTEGER,
  sent_count INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS voice_recap_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  message_text TEXT NOT NULL,
  audio_base64 TEXT,
  content_type TEXT NOT NULL DEFAULT 'audio/mpeg',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, week_start)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS voice_recap_logs_user_idx ON voice_recap_logs(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS voice_recap_logs_week_idx ON voice_recap_logs(week_start DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS processed_webhooks_ts_idx ON processed_webhooks(processed_at);
