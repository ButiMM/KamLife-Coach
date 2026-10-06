-- A19 (#545): the commitment loop stores the client's one promise as a client_facts row of kind
-- 'commitment'. 0017's CHECK allowed only the six original kinds, so every such insert failed.
ALTER TABLE client_facts DROP CONSTRAINT IF EXISTS client_facts_kind_check;--> statement-breakpoint
ALTER TABLE client_facts ADD CONSTRAINT client_facts_kind_check
  CHECK (kind IN ('goal','injury','constraint','schedule','preference','life_event','commitment'));
