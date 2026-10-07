-- D2b (CTO 6 Oct, #391): behaviour patterns move from client_intelligence_profiles.pattern_flags into
-- the client record as client_facts rows of kind 'pattern', written by the weekly jobs/cip-update.ts.
ALTER TABLE client_facts DROP CONSTRAINT IF EXISTS client_facts_kind_check;--> statement-breakpoint
ALTER TABLE client_facts ADD CONSTRAINT client_facts_kind_check
  CHECK (kind IN ('goal','injury','constraint','schedule','preference','life_event','commitment','pattern'));--> statement-breakpoint
-- THE CUTOVER CARRIES WHAT THE OLD STORE KNEW (Codex @ d0a0f21): every client's current patterns are copied
-- across once, so the decision reads the same state tomorrow morning as it did today, not nothing until
-- Sunday's job runs. Only the structured state (an object with a patterns array) of the three known kinds.
INSERT INTO client_facts (user_id, kind, subject, statement, detail, extracted_by)
SELECT p.user_id, 'pattern', e->>'kind', concat(e->>'status', ': ', e->>'kind', ' (from the old profile)'), e, 'backfill:cip'
FROM client_intelligence_profiles p
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.pattern_flags->'patterns') = 'array' THEN p.pattern_flags->'patterns' ELSE '[]'::jsonb END) e
WHERE jsonb_typeof(p.pattern_flags) = 'object'
  AND e->>'kind' IN ('weekend_training_misses','work_pressure_training_misses','minimum_training_reengaged');--> statement-breakpoint
-- The pgvector `memories` store: muted 19 Aug, its code deleted 6 Oct (D2a, #553). Nothing reads or
-- writes it. Dropping it also erases the model-written memories it still held about every client.
DROP TABLE IF EXISTS memories;
