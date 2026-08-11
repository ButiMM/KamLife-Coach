-- 0002 — RECONCILE user_id FOREIGN KEYS WITH THE COMMITTED SCHEMA.
--
-- (2026-08-11. Prepared for CTO review. NOT executed.)
--
-- Production carries foreign keys named "<table>_user_id_fkey" — PostgreSQL's DEFAULT name —
-- with ON DELETE NO ACTION. The committed schema and baseline migration declare
-- "<table>_user_id_users_id_fk" with ON DELETE CASCADE. The live database was never migrated,
-- so it still holds the original constraints. Consequence beyond the test harness: deleting a
-- user FAILS, which is the POPIA erasure path.
--
-- WHY EVERY CASCADE TABLE IS LISTED RATHER THAN THE 15 KNOWN-BAD ONES:
-- the live inventory says 15 are NO ACTION and 4 are already CASCADE, but the row-level output
-- naming WHICH is which was never available to the author of this file. Guessing a table name
-- into a production migration is the exact error this review gate exists to prevent. So each
-- block below INSPECTS the live catalog and acts only if that constraint is not already
-- ON DELETE CASCADE. A table already correct is untouched — no lock, no rewrite, no-op.
-- Re-running the file is therefore safe, and the same file works whichever 15 they turn out to be.
--
-- quality_signals is deliberately ABSENT: it is ON DELETE SET NULL by design in both the schema
-- and the baseline, production already agrees, and it must not be converted.
--
-- turn_ledger is also absent: 0001_old_black_bolt.sql already creates the table, its FK and its
-- index, idempotently. It has simply never been applied. This file does not duplicate it.

DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'ab_assignments' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'ab_assignments: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'ab_assignments: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.ab_assignments DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.ab_assignments
      ADD CONSTRAINT ab_assignments_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'ab_assignments: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'body_measurements' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'body_measurements: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'body_measurements: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.body_measurements DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.body_measurements
      ADD CONSTRAINT body_measurements_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'body_measurements: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'chat_history' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'chat_history: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'chat_history: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.chat_history DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.chat_history
      ADD CONSTRAINT chat_history_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'chat_history: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'client_actions' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'client_actions: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'client_actions: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.client_actions DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.client_actions
      ADD CONSTRAINT client_actions_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'client_actions: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'client_intelligence_profiles' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'client_intelligence_profiles: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'client_intelligence_profiles: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.client_intelligence_profiles DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.client_intelligence_profiles
      ADD CONSTRAINT client_intelligence_profiles_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'client_intelligence_profiles: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'client_understanding' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'client_understanding: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'client_understanding: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.client_understanding DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.client_understanding
      ADD CONSTRAINT client_understanding_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'client_understanding: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'clothing_checkins' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'clothing_checkins: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'clothing_checkins: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.clothing_checkins DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.clothing_checkins
      ADD CONSTRAINT clothing_checkins_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'clothing_checkins: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'escalations' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'escalations: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'escalations: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.escalations DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.escalations
      ADD CONSTRAINT escalations_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'escalations: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'exercise_logs' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'exercise_logs: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'exercise_logs: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.exercise_logs DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.exercise_logs
      ADD CONSTRAINT exercise_logs_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'exercise_logs: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'gpt_costs' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'gpt_costs: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'gpt_costs: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.gpt_costs DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.gpt_costs
      ADD CONSTRAINT gpt_costs_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'gpt_costs: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'meal_logs' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'meal_logs: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'meal_logs: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.meal_logs DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.meal_logs
      ADD CONSTRAINT meal_logs_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'meal_logs: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'progress_photos' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'progress_photos: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'progress_photos: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.progress_photos DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.progress_photos
      ADD CONSTRAINT progress_photos_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'progress_photos: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'reminders' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'reminders: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'reminders: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.reminders DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.reminders
      ADD CONSTRAINT reminders_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'reminders: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'sent_proactive' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'sent_proactive: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'sent_proactive: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.sent_proactive DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.sent_proactive
      ADD CONSTRAINT sent_proactive_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'sent_proactive: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'step_logs' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'step_logs: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'step_logs: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.step_logs DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.step_logs
      ADD CONSTRAINT step_logs_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'step_logs: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'user_integrations' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'user_integrations: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'user_integrations: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.user_integrations DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.user_integrations
      ADD CONSTRAINT user_integrations_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'user_integrations: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'weekly_checkins' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'weekly_checkins: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'weekly_checkins: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.weekly_checkins DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.weekly_checkins
      ADD CONSTRAINT weekly_checkins_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'weekly_checkins: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'weight_logs' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'weight_logs: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'weight_logs: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.weight_logs DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.weight_logs
      ADD CONSTRAINT weight_logs_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'weight_logs: converted % -> CASCADE', con_name;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE con_name text; con_del "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO con_name, con_del
  FROM pg_constraint c
  JOIN pg_class ch  ON ch.oid  = c.conrelid
  JOIN pg_class par ON par.oid = c.confrelid
  WHERE c.contype = 'f' AND ch.relname = 'workout_logs' AND par.relname = 'users';

  IF con_name IS NULL THEN
    RAISE NOTICE 'workout_logs: no FK to users found — SKIPPED, investigate before assuming success';
  ELSIF con_del = 'c' THEN
    RAISE NOTICE 'workout_logs: already ON DELETE CASCADE (%) — left untouched', con_name;
  ELSE
    EXECUTE format('ALTER TABLE public.workout_logs DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.workout_logs
      ADD CONSTRAINT workout_logs_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'workout_logs: converted % -> CASCADE', con_name;
  END IF;
END $$;
