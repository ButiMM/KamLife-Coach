-- 0006 — DURABLE CLIENT FACTS
--
-- Purpose:
--   Give the coach a memory that is a PERSON, not a search index.
--
-- What was there before:
--   Every durable thing a client told us in ordinary conversation was turned into a sentence of
--   prose, embedded with text-embedding-3-small, and written to the pgvector `memories` table:
--
--       "Client reported injury: \"my knee has been killing me since Saturday\""
--
--   That is search over chat. It costs an API call per matched message, it is retrieved by cosine
--   similarity against whatever the client happens to say next, and NOTHING in the coaching path
--   can act on it — because acting requires a field, not a paragraph.
--
-- The defect this exposes, and the reason this migration is not a nicety:
--   `users.injuries` is a typed column, and it already works. programme.ts filters exercises
--   against it (filterInjuredExercises / filterInjuredGymExercises), verifiers/injury-rules.ts
--   parses body parts out of it, response-gate.ts and programme-validator.ts both read it. A
--   client who goes through pain triage, or who types the injury command, gets their programme
--   built around the injury from that moment on.
--
--   A client who simply MENTIONS it — "my knee has been killing me since Saturday" — hits the
--   detector in handlers/gpt-block.ts, which embeds the sentence and does not touch the column.
--   The programme keeps prescribing squats. Same client, same fact, two outcomes, decided by
--   which handler the sentence happened to route to.
--
-- Design:
--   Three more typed columns beside the ones that already work (injuries, medical_conditions,
--   work_schedule, dream_goal, biggest_struggle). Six durable facts in total, all readable by the
--   decision, none of them requiring a vector search to recall.
--
--     dietary_restrictions — allergies, intolerances, "I don't eat pork". Comma-separated, the
--                            same shape as medical_conditions, so meal-plan and the swap logic
--                            can read it the way they already read that one.
--     life_context         — night shifts, a new baby, retrenchment, a move. This is what makes a
--                            month-gone "just say hi" land as a coach rather than a reminder.
--     do_not_mention       — topics the client has asked us to drop. The one fact whose whole
--                            value is that it constrains what we say.
--
-- Additive: three nullable text columns. No renames, no type changes, no backfill — there is
-- nothing to backfill from, because the old store holds prose and this holds fields.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS dietary_restrictions text,
  ADD COLUMN IF NOT EXISTS life_context text,
  ADD COLUMN IF NOT EXISTS do_not_mention text;
