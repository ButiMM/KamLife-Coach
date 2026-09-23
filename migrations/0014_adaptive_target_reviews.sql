-- C18: the seven-day target decision must be auditable, including a deliberate hold.
-- The adaptive job writes one row per client/SAST day with prior and next visible targets,
-- canonical reason, and the measured evidence it used. No backfill can invent old reasons.
CREATE TABLE IF NOT EXISTS public.adaptive_target_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  decision_day date NOT NULL,
  state text NOT NULL CHECK (state IN ('CHANGE', 'HOLD')),
  reason text NOT NULL,
  prior_targets jsonb NOT NULL,
  next_targets jsonb NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS adaptive_target_reviews_user_day_unique
  ON public.adaptive_target_reviews(user_id, decision_day);
