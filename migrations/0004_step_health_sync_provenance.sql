-- 0004 — HEALTH-SYNC STEP PROVENANCE
--
-- The P1 step provenance migration already marks STEP_LOG rows as client_report.
-- The connected health-app path writes a step_logs row first and then records a
-- STEPS_AUTO_SYNC chat receipt. That existing receipt is the provenance event for
-- this write path. Reuse it rather than changing the webhook handler's write shape.
--
-- Fail closed: only rows matching the exact user, step count, SAST day and a
-- five-minute proximity window to the receipt are promoted to health_sync.

CREATE OR REPLACE FUNCTION public.kamlife_mark_step_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parsed_steps integer;
  report_day text;
  trusted_provenance text;
BEGIN
  IF upper(COALESCE(NEW.intent, '')) NOT IN ('STEP_LOG', 'STEPS_AUTO_SYNC') THEN
    RETURN NEW;
  END IF;

  parsed_steps := public.kamlife_parse_step_report(NEW.message_in);
  IF parsed_steps IS NULL THEN
    RETURN NEW;
  END IF;

  report_day := to_char(COALESCE(NEW.created_at, NOW()) AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD');
  trusted_provenance := CASE
    WHEN upper(COALESCE(NEW.intent, '')) = 'STEPS_AUTO_SYNC' THEN 'health_sync'
    ELSE 'client_report'
  END;

  UPDATE public.step_logs s
  SET provenance = trusted_provenance,
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
EXECUTE FUNCTION public.kamlife_mark_step_provenance();
