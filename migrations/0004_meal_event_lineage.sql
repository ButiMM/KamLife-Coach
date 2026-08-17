-- 0004 — MEAL EVENT LINEAGE
--
-- Purpose:
--   Let one client message produce SEVERAL independent eating events that can still be
--   corrected or undone as the one thing the client said.
--
-- Why:
--   A real message — "had eggs and toast in the morning, pap and chicken at lunch, then two
--   amagwinya around four, and this morning a banana" — is four eating events on two dates.
--   The product stored one row: one date, one meal label, one total. The client told the coach
--   two different days and the coach recorded one.
--
-- Design:
--   1. meal_logs gains source_message_id. NULL means "logged before lineage existed" — a real
--      unknown, deliberately NOT backfilled. Every legacy row is its own group of one, which is
--      exactly what it was.
--   2. Rows sharing a source_message_id are ONE client utterance. That is what makes
--      "remove what I just logged" removable as a unit once a message yields four rows, instead
--      of removing one of four and leaving three behind.
--   3. Index on (user_id, source_message_id) — every read is scoped to one client's group.
--
-- Additive and reversible: a nullable column and an index. No existing row changes, no type
-- changes, no renames. Single-event messages keep writing exactly one row.

ALTER TABLE public.meal_logs
  ADD COLUMN IF NOT EXISTS source_message_id text;

CREATE INDEX IF NOT EXISTS meal_logs_user_source_msg_idx
  ON public.meal_logs (user_id, source_message_id);
