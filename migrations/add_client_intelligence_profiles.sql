-- Client Intelligence Profile table
-- One row per user. Updated weekly by runCipUpdate (Sunday 10pm SAST).
-- Injected into every GPT call as the client's full journey memory.
-- Apply via: psql $DATABASE_URL -f migrations/add_client_intelligence_profiles.sql
-- Or: npm run db:push (from Railway console)

CREATE TABLE IF NOT EXISTS client_intelligence_profiles (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Weight journey
  start_weight_kg  NUMERIC(5,1),
  best_weight_kg   NUMERIC(5,1),
  total_kg_changed NUMERIC(5,1),

  -- All-time records
  longest_workout_streak    INTEGER NOT NULL DEFAULT 0,
  longest_food_streak       INTEGER NOT NULL DEFAULT 0,
  best_week_avg_protein_g   INTEGER NOT NULL DEFAULT 0,
  best_week_sessions        INTEGER NOT NULL DEFAULT 0,

  -- Behavioral fingerprint
  weakest_dow              INTEGER,   -- 0=Sun … 6=Sat
  peak_engagement_hour     INTEGER,   -- 0-23 SAST

  -- Lifetime compliance
  lifetime_session_compliance NUMERIC(4,3),
  lifetime_food_log_days      INTEGER NOT NULL DEFAULT 0,
  plateau_count               INTEGER NOT NULL DEFAULT 0,

  -- Rich history blobs
  monthly_snapshots  JSONB,   -- [{month, sessions, planned, proteinDays, avgWeightKg}]
  pattern_flags      JSONB,   -- ["silent_tuesdays", "chronic_protein_gap", ...]

  -- Narrative injected into every GPT call
  coach_narrative    TEXT
);
