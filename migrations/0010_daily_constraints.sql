-- 0010 — DAILY CONSTRAINTS: what the client ruled out today, recorded when they said it (#194)
--
-- Reproduced on main@c420c48 against real PostgreSQL:
--
--   after the two declarations:            foodDayClosed=true   trainingDeclined=true
--   after 26 further ordinary messages:    foodDayClosed=false  trainingDeclined=false
--
-- The client reopened nothing. readHeldConstraints re-derives today's constraints by replaying
-- chat history, and that replay is ORDER BY created_at DESC LIMIT 24 — so on a busy day the
-- declaration falls out of the window and a closed food day silently reopens itself. The client
-- who talks to us most is the one this fails for.
--
-- APPEND-ONLY. A reopening does not edit the closure; it is a second row. The day's effective
-- state is the newest decision, and the assertion before it stays on the record, which is what
-- lets anyone answer "was the coach allowed to say that at 20:00" a week later.
--
-- NOTHING HERE DECIDES ANYTHING. The recognisers in one-action.ts stay the only things that read
-- a message; readHeldConstraints stays the only reader of the state. This is where the answer
-- lives, not a second opinion about what it should be.

CREATE TABLE IF NOT EXISTS public.daily_constraints (
  id                SERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  day               TEXT NOT NULL,
  kind              TEXT NOT NULL,
  state             TEXT NOT NULL,
  via               TEXT NOT NULL,
  source_message_id TEXT,
  said_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS daily_constraints_user_day_kind_idx
  ON public.daily_constraints (user_id, day, kind);

-- A provider retry of the same message must not append a second identical assertion. NULL source
-- ids do not collide in PostgreSQL, which is correct: a constraint resolved by a workout being
-- logged has no provider message and may legitimately recur on another day.
CREATE UNIQUE INDEX IF NOT EXISTS daily_constraints_user_source_kind_uidx
  ON public.daily_constraints (user_id, source_message_id, kind);
