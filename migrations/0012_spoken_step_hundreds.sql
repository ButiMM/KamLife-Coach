-- SPOKEN STEP COUNTS KEEP THE HUNDREDS (2026-09-10).
--
-- STT commonly returns an accurate phrase such as "eight thousand five hundred steps". The
-- TypeScript parser and this provenance function both stopped at "eight thousand", so the
-- durable row became 8,000 and the database could not mark the original 8,500 claim trusted.
-- Replace the existing function in place; no table or existing row is rewritten.

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
  hundreds_word text;
  half_bonus numeric := 0;
  hundreds_bonus numeric := 0;
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

  -- Voice-note word forms, including the hundreds Whisper/Scribe preserve:
  -- "eight thousand", "eight and a half thousand", "eight thousand five hundred".
  m := regexp_match(lower(COALESCE(raw, '')), '\y(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(\s+and\s+a\s+half)?\s+thousand(?:\s+(?:and\s+)?(one|two|three|four|five|six|seven|eight|nine|[1-9])\s+hundred)?\s*(?:steps?|staps?)\y');
  IF m IS NOT NULL THEN
    IF m[2] IS NOT NULL THEN half_bonus := 500; END IF;
    word := m[1];
    parsed := CASE word
      WHEN 'one' THEN 1 WHEN 'two' THEN 2 WHEN 'three' THEN 3 WHEN 'four' THEN 4
      WHEN 'five' THEN 5 WHEN 'six' THEN 6 WHEN 'seven' THEN 7 WHEN 'eight' THEN 8
      WHEN 'nine' THEN 9 WHEN 'ten' THEN 10 WHEN 'eleven' THEN 11 WHEN 'twelve' THEN 12
      WHEN 'thirteen' THEN 13 WHEN 'fourteen' THEN 14 WHEN 'fifteen' THEN 15
      WHEN 'sixteen' THEN 16 WHEN 'seventeen' THEN 17 WHEN 'eighteen' THEN 18
      WHEN 'nineteen' THEN 19 WHEN 'twenty' THEN 20 ELSE NULL
    END;
    hundreds_word := m[3];
    IF hundreds_word IS NOT NULL THEN
      hundreds_bonus := (CASE hundreds_word
        WHEN 'one' THEN 1 WHEN 'two' THEN 2 WHEN 'three' THEN 3 WHEN 'four' THEN 4
        WHEN 'five' THEN 5 WHEN 'six' THEN 6 WHEN 'seven' THEN 7 WHEN 'eight' THEN 8
        WHEN 'nine' THEN 9 ELSE hundreds_word::numeric
      END) * 100;
    END IF;
    IF parsed IS NOT NULL THEN
      parsed := parsed * 1000 + half_bonus + hundreds_bonus;
      IF parsed > 100 AND parsed < 100000 THEN
        RETURN round(parsed)::integer;
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;
