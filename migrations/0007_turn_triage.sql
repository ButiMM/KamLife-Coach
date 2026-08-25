-- TURN TRIAGE — give the forensic record a verdict and a lifecycle (2026-08-25).
--
-- turn_ledger has been recording the MECHANISM of every turn since 2026-08-10: what the turn
-- read, what it wrote, what it replied, and which build produced it. Nothing has ever read it.
-- `failure_category` was designed for a human verdict and has never been written.
--
-- What was missing is not more data. It is the two things that turn an observation into closed
-- engineering work: a verdict on WHAT KIND of failure it was, and a state saying HOW FAR the fix
-- has got. Without the second, a dashboard is an analytics page someone looks at once.
--
--   lifecycle_status   observed -> confirmed -> fixed -> deployed -> revalidated
--   fix_ref            the PR or commit that claims to fix it
--   triage_note        why the human classified it that way
--   triaged_at         when the verdict was recorded
--
-- REVALIDATED IS THE POINT. "Fixed" is a claim about a diff; "deployed" is a claim about a build;
-- only "revalidated" says the same conversation was replayed against the build that shipped and
-- behaved. Every recurrence this session came from stopping at one of the first three.

ALTER TABLE "turn_ledger" ADD COLUMN IF NOT EXISTS "lifecycle_status" TEXT;
ALTER TABLE "turn_ledger" ADD COLUMN IF NOT EXISTS "fix_ref" TEXT;
ALTER TABLE "turn_ledger" ADD COLUMN IF NOT EXISTS "triage_note" TEXT;
ALTER TABLE "turn_ledger" ADD COLUMN IF NOT EXISTS "triaged_at" TIMESTAMP;

-- The three axes the triage view actually filters on. Without these, "show me every RESPONSE
-- failure on build 1b49633" is a sequential scan of every turn ever recorded.
CREATE INDEX IF NOT EXISTS "turn_ledger_version_idx" ON "turn_ledger" USING btree ("version");
CREATE INDEX IF NOT EXISTS "turn_ledger_failure_idx" ON "turn_ledger" USING btree ("failure_category");
CREATE INDEX IF NOT EXISTS "turn_ledger_lifecycle_idx" ON "turn_ledger" USING btree ("lifecycle_status");
-- The default view is "most recent turns", which has no user_id to lean on, so the existing
-- (user_id, created_at) index cannot serve it.
CREATE INDEX IF NOT EXISTS "turn_ledger_created_idx" ON "turn_ledger" USING btree ("created_at");
