-- 0008 — REPAIR THE STEP-PROVENANCE PARSER'S REGULAR EXPRESSIONS (#184)
--
-- WHAT WAS WRONG
--
-- 0003 introduced public.kamlife_parse_step_report, the single owner of "what step count did
-- the client actually state". Its three patterns were written with doubled backslashes:
--
--     '\\[Step Screenshot:\s*([0-9,]+)\\]'
--
-- Inside a dollar-quoted body PostgreSQL performs NO backslash processing, so `\\` reaches the
-- regex engine as an escaped literal backslash and the following `[` opens a bracket expression.
-- That expression then swallows everything up to the first `]` — which is the one inside
-- `[0-9,]` — leaving the `)` after it with nothing to close:
--
--     ERROR:  invalid regular expression: parentheses () not balanced
--     CONTEXT: PL/pgSQL function kamlife_parse_step_report(text) line 10 at assignment
--              PL/pgSQL function kamlife_mark_step_client_report() line 10 at assignment
--     STATEMENT: insert into "chat_history" ...
--
-- The screenshot branch is the FIRST statement in the function, so the throw happened on every
-- call, whatever the client had written. The AFTER INSERT trigger on chat_history therefore
-- aborted the chat-history write for every STEP_LOG turn.
--
-- WHY IT MATTERED, AND WHY IT WAS INVISIBLE
--
-- The step row is written before the chat row, and the application catches a failed chat write.
-- So the client saw a normal reply and the count was stored — but nothing ever marked the row
-- 'client_report', and canonical state deliberately filters untrusted step evidence. A client
-- could state their steps and be coached, later, as though they had never said anything. The
-- only symptom was a line in the database log.
--
-- The two silent halves are worth naming as well: `\\b` reached the engine as a literal
-- backslash followed by `b`, so even if the first branch had not thrown, the numeric and
-- word-form branches would simply never have matched. All three patterns were dead.
--
-- THE REPAIR
--
--   • single backslashes, which is what a dollar-quoted body needs;
--   • \y for a word boundary, because in PostgreSQL's regular expressions \b means BACKSPACE.
--     This is the trap underneath the first one: `\b` written correctly for JavaScript is still
--     wrong here, so the repair is not just "remove a backslash".
--
-- Nothing else changes. Same function name, same signature, same three branches in the same
-- order, same plausibility window, same return contract — so the trigger created by 0003 keeps
-- pointing at the one owner and no trigger is redefined. 0003 is left exactly as it was applied:
-- an already-run migration is history, and rewriting history is how two databases end up
-- claiming the same version with different contents.
--
-- DELIBERATELY NO BACKFILL. Rows written while the trigger was throwing have no chat-history
-- evidence — that write is precisely what failed — so there is nothing to read them back from.
-- Marking them 'client_report' would be inventing the trust this column exists to record.

CREATE OR REPLACE FUNCTION public.kamlife_parse_step_report(raw text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  m text[];
  raw_number text;
  parsed numeric;
  word text;
  half_bonus numeric := 0;
BEGIN
  -- Screenshot receipts emitted by the media handler.
  m := regexp_match(COALESCE(raw, ''), '\[Step Screenshot:\s*([0-9,]+)\]', 'i');
  IF m IS NOT NULL THEN
    RETURN regexp_replace(m[1], '[^0-9]', '', 'g')::integer;
  END IF;

  -- Numeric reports: 12000 steps, 12,000 steps, 12k steps, walked 12k steps, etc.
  m := regexp_match(COALESCE(raw, ''), '\y([0-9][0-9,]*(?:\.[0-9]+)?\s*[kK]?)\s*(?:steps?|staps?)\y', 'i');
  IF m IS NOT NULL THEN
    raw_number := regexp_replace(m[1], '[,[:space:]]', '', 'g');
    IF right(lower(raw_number), 1) = 'k' THEN
      parsed := replace(lower(raw_number), 'k', '')::numeric * 1000;
    ELSE
      parsed := raw_number::numeric;
    END IF;
    IF parsed > 100 AND parsed < 100000 THEN
      RETURN round(parsed)::integer;
    END IF;
  END IF;

  -- Voice-note word form: "ten thousand steps", "twelve and a half thousand steps".
  m := regexp_match(lower(COALESCE(raw, '')), '\y(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(\s+and\s+a\s+half)?\s+thousand\s*(?:steps?|staps?)\y');
  IF m IS NOT NULL THEN
    IF m[2] IS NOT NULL THEN half_bonus := 500; END IF;
    word := m[1];
    parsed := CASE word
      WHEN 'one' THEN 1
      WHEN 'two' THEN 2
      WHEN 'three' THEN 3
      WHEN 'four' THEN 4
      WHEN 'five' THEN 5
      WHEN 'six' THEN 6
      WHEN 'seven' THEN 7
      WHEN 'eight' THEN 8
      WHEN 'nine' THEN 9
      WHEN 'ten' THEN 10
      WHEN 'eleven' THEN 11
      WHEN 'twelve' THEN 12
      WHEN 'thirteen' THEN 13
      WHEN 'fourteen' THEN 14
      WHEN 'fifteen' THEN 15
      WHEN 'sixteen' THEN 16
      WHEN 'seventeen' THEN 17
      WHEN 'eighteen' THEN 18
      WHEN 'nineteen' THEN 19
      WHEN 'twenty' THEN 20
      ELSE NULL
    END;
    IF parsed IS NOT NULL THEN
      parsed := parsed * 1000 + half_bonus;
      IF parsed > 100 AND parsed < 100000 THEN
        RETURN round(parsed)::integer;
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;
