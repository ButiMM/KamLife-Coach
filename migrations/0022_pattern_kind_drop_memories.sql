-- D2b (CTO 6 Oct, #391): behaviour patterns move from client_intelligence_profiles.pattern_flags into
-- the client record as client_facts rows of kind 'pattern', written by the weekly jobs/cip-update.ts.
ALTER TABLE client_facts DROP CONSTRAINT IF EXISTS client_facts_kind_check;--> statement-breakpoint
ALTER TABLE client_facts ADD CONSTRAINT client_facts_kind_check
  CHECK (kind IN ('goal','injury','constraint','schedule','preference','life_event','commitment','pattern'));--> statement-breakpoint
-- The pgvector `memories` store: muted 19 Aug, its code deleted 6 Oct (D2a, #553). Nothing reads or
-- writes it. Dropping it also erases the model-written memories it still held about every client.
DROP TABLE IF EXISTS memories;
