-- 0003 — STEP PROVENANCE AND SAST DAY OWNERSHIP
--
-- Purpose:
--   Prevent unverified historical step rows from becoming current-day coaching truth.
--
-- Design:
--   1. Every step row carries provenance. Existing rows become "unverified".
--   2. Every row carries an explicit SAST resolved day, independent of server timezone.
--   3. A STEP_LOG chat-history record establishes client-reported provenance for the
--      matching step row written immediately before it.
--   4. The snapshot layer must consume only trusted provenance.
--
-- Fail closed: legacy/device rows that cannot prove their source are not treated as
-- client-reported coaching evidence until their source is established.

ALTER TABLE public.step_logs
  ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'unverified';

ALTER TABLE public.step_logs
  ADD COLUMN IF NOT EXISTS resolved_day text;

UPDATE public.step_logs
SET resolved_day = to_char(logged_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD')
WHERE resolved_day IS NULL;

CREATE OR REPLACE FUNCTION public.kamlife_step_resolved_day()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.resolved_day := to_char(COALESCE(NEW.logged_at, NOW()) AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS step_logs_set_resolved_day ON public.step_logs;
CREATE TRIGGER step_logs_set_resolved_day
BEFORE INSERT OR UPDATE OF logged_at ON public.step_logs
FOR EACH ROW
EXECUTE FUNCTION public.kamlife_step_resolved_day();

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
  m := regexp_match(COALESCE(raw, ''), '\\[Step Screenshot:\s*([0-9,]+)\\]', 'i');
  IF m IS NOT NULL THEN
    RETURN regexp_replace(m[1], '[^0-9]', '', 'g')::integer;
  END IF;

  -- Numeric reports: 12000 steps, 12,000 steps, 12k steps, walked 12k steps, etc.
  m := regexp_match(COALESCE(raw, ''), '\\b([0-9][0-9,]*(?:\\.[0-9]+)?\\s*[kK]?)\\s*(?:steps?|staps?)\\b', 'i');
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
  m := regexp_match(lower(COALESCE(raw, '')), '\\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(\\s+and\\s+a\\s+half)?\\s+thousand\\s*(?:steps?|staps?)\\b');
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

CREATE OR REPLACE FUNCTION public.kamlife_mark_step_client_report()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parsed_steps integer;
  report_day text;
BEGIN
  IF upper(COALESCE(NEW.intent, '')) <> 'STEP_LOG' THEN
    RETURN NEW;
  END IF;

  parsed_steps := public.kamlife_parse_step_report(NEW.message_in);
  IF parsed_steps IS NULL THEN
    RETURN NEW;
  END IF;

  report_day := to_char(COALESCE(NEW.created_at, NOW()) AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD');

  UPDATE public.step_logs s
  SET provenance = 'client_report',
      resolved_day = COALESCE(s.resolved_day, report_day)
  WHERE s.id = (
    SELECT s2.id
    FROM public.step_logs s2
    WHERE s2.user_id = NEW.user_id
      AND s2.steps = parsed_steps
      AND s2.resolved_day = report_day
      AND ABS(EXTRACT(EPOCH FROM (COALESCE(s2.logged_at, NOW()) - COALESCE(NEW.created_at, NOW())))) <= 300
    ORDER BY s2.logged_at DESC
    LIMIT 1
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_history_mark_step_provenance ON public.chat_history;
CREATE TRIGGER chat_history_mark_step_provenance
AFTER INSERT ON public.chat_history
FOR EACH ROW
EXECUTE FUNCTION public.kamlife_mark_step_client_report();

CREATE INDEX IF NOT EXISTS step_logs_user_resolved_day_idx
  ON public.step_logs (user_id, resolved_day);

CREATE INDEX IF NOT EXISTS step_logs_provenance_idx
  ON public.step_logs (provenance, resolved_day);
