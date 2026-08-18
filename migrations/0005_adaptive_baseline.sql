-- 0005 — CANONICAL ADAPTIVE BASELINE
--
-- Purpose:
--   Stop daily adaptation compounding on itself. Adaptation must derive from a STABLE profile
--   baseline plus today's evidence — never from yesterday's adapted number.
--
-- The defect, measured on 2026-08-18 (script/trace-proactive.ts, 80kg stalled client):
--   day 1: 2000 -> 1860   day 3: 1760 -> 1760  (floor)
--   day 2: 1860 -> 1760   day 4: 1760 -> 1760
--   12% down in 72 hours, because scheduler/jobs/adaptive.ts fed users.calorie_target back in
--   as baseCalories and wrote the result to the same column.
--
--   Worse than the walk-down: the client ate 1,980 every day and never changed anything. Once
--   the target passed under 1,800 their unchanged eating became "over target", and the job began
--   telling them the target "hasn't been tested yet". The system moved the goalposts and then
--   blamed the client for missing them.
--
-- Design:
--   1. Three baseline columns. The engine reads these; it never writes them.
--   2. calorie_target / protein_target / steps_target keep their meaning — the CURRENT number the
--      client sees — and become an overlay recomputed from baseline + evidence each day.
--   3. Baseline is written by onboarding and programme rebuilds, i.e. the places that legitimately
--      set a client's profile.
--
-- BACKFILL, and what it honestly cannot do:
--   Every existing client gets baseline = their current target. For a client mid-ratchet that
--   number is ALREADY reduced, and the pre-drift value is not recoverable from this database —
--   nothing recorded it. So this stops the bleeding, it does not undo it. Their true baseline is
--   restored the next time their programme is rebuilt.
--   Chosen deliberately over leaving those rows NULL: a NULL baseline would make the engine fall
--   back to the stored target, which is the recursion this migration exists to end.
--
--   adapted_until is cleared in the same statement. It marks "this target was deliberately moved,
--   do not treat it as corruption", and every target is now a fresh overlay from a real baseline.
--
-- Additive: three nullable columns, one UPDATE, one token cleared. No renames, no type changes.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS baseline_calorie_target integer,
  ADD COLUMN IF NOT EXISTS baseline_protein_target integer,
  ADD COLUMN IF NOT EXISTS baseline_steps_target integer;

UPDATE public.users
SET baseline_calorie_target = COALESCE(baseline_calorie_target, calorie_target),
    baseline_protein_target = COALESCE(baseline_protein_target, protein_target),
    baseline_steps_target   = COALESCE(baseline_steps_target, steps_target)
WHERE calorie_target IS NOT NULL OR protein_target IS NOT NULL OR steps_target IS NOT NULL;

UPDATE public.users
SET profile_notes = btrim(regexp_replace(COALESCE(profile_notes, ''), '\s*\badapted_until:\d{4}-\d{2}-\d{2}\b', '', 'g'))
WHERE profile_notes LIKE '%adapted_until:%';
