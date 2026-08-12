-- IDEMPOTENCY PATCH v2 (2026-08-12, CTO-authorized fix of the confirmed duplicate-FK defect).
-- Production was never brought under drizzle migration tracking; this baseline predates that
-- discipline and must be safe to run against the schema production already has.
--
-- v1 (superseded) wrapped each ADD CONSTRAINT in EXCEPTION WHEN duplicate_object THEN NULL --
-- a NAME-collision guard. Postgres permits multiple differently-named FK constraints on the
-- same column, so against production's real drift (the same relationship present under
-- Postgres's DEFAULT name, e.g. "meal_logs_user_id_fkey", instead of Drizzle's
-- "meal_logs_user_id_users_id_fk") v1 did not skip -- it silently added a SECOND, redundant
-- constraint. Proven empirically: replaying v1 against a reproduction of the exact production
-- drift took user_id FKs from 20 to 36, duplicating all 15 drifted tables.
--
-- v2 checks for an existing FK by STRUCTURE first -- same child table, same child column, same
-- parent table -- and skips entirely under ANY name if one is found. An existing constraint's
-- ON DELETE behaviour is deliberately left untouched here; reconciling it is 0002's job.

CREATE TABLE IF NOT EXISTS "ab_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"experiment_id" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"delivered" boolean DEFAULT false,
	"responded" boolean DEFAULT false,
	"converted_action" text,
	"delivered_at" timestamp,
	"responded_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ab_experiments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"variant_a" text NOT NULL,
	"variant_b" text NOT NULL,
	"message_type" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"target_phone" text,
	"reason" text,
	"meta" jsonb,
	"performed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "body_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"measurement_type" text NOT NULL,
	"value" text NOT NULL,
	"logged_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"message_in" text,
	"message_out" text,
	"intent" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"due_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_intelligence_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"start_weight_kg" numeric(5, 1),
	"best_weight_kg" numeric(5, 1),
	"total_kg_changed" numeric(5, 1),
	"longest_workout_streak" integer DEFAULT 0 NOT NULL,
	"longest_food_streak" integer DEFAULT 0 NOT NULL,
	"best_week_avg_protein_g" integer DEFAULT 0 NOT NULL,
	"best_week_sessions" integer DEFAULT 0 NOT NULL,
	"weakest_dow" integer,
	"peak_engagement_hour" integer,
	"lifetime_session_compliance" numeric(4, 3),
	"lifetime_food_log_days" integer DEFAULT 0 NOT NULL,
	"plateau_count" integer DEFAULT 0 NOT NULL,
	"monthly_snapshots" jsonb,
	"pattern_flags" jsonb,
	"coach_narrative" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_understanding" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"profile" jsonb,
	"observations" jsonb,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clothing_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"jeans_fit" text,
	"energy_level" text,
	"stomach_feel" text,
	"overall_feel" text,
	"week_number" integer,
	"logged_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "escalations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"trigger_message" text,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"claimed_by" text,
	"resolution" text,
	"created_at" timestamp DEFAULT now(),
	"claimed_at" timestamp,
	"resolved_at" timestamp,
	"sla_deadline" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exercise_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"exercise_name" text NOT NULL,
	"weight_kg" numeric,
	"reps" integer,
	"sets" integer,
	"logged_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gpt_costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"model" text NOT NULL,
	"feature" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meal_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"logged_at" timestamp DEFAULT now() NOT NULL,
	"raw_message" text,
	"source" text NOT NULL,
	"kcal_int" integer DEFAULT 0 NOT NULL,
	"protein_int" integer DEFAULT 0 NOT NULL,
	"carbs_int" integer DEFAULT 0 NOT NULL,
	"fat_int" integer DEFAULT 0 NOT NULL,
	"items" jsonb,
	"meal_label" text,
	"corrected" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_message_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"user_id" uuid,
	"media_type" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "media_jobs_source_message_id_unique" UNIQUE("source_message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"phone" text NOT NULL,
	"amount_gross" numeric,
	"payment_status" text NOT NULL,
	"raw_body" jsonb,
	"processed_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processed_webhooks" (
	"message_sid" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "progress_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"photo_number" integer DEFAULT 1 NOT NULL,
	"photo_base64" text NOT NULL,
	"content_type" text DEFAULT 'image/jpeg' NOT NULL,
	"logged_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quality_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"phone_last4" text,
	"kind" text NOT NULL,
	"message_in" text,
	"message_out" text,
	"detail" text,
	"reviewed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone_number" text NOT NULL,
	"body" text NOT NULL,
	"fire_at" timestamp NOT NULL,
	"recurrence" text,
	"kind" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduler_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sent_proactive" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"message_key" text NOT NULL,
	"dedupe_window" text NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "step_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"steps" integer NOT NULL,
	"logged_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"token_expiry" timestamp,
	"last_sync_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number" text NOT NULL,
	"email" text,
	"name" text,
	"gender" text,
	"goal_type" text,
	"age" integer,
	"height_cm" integer,
	"current_weight" numeric,
	"training_days_per_week" integer,
	"budget_level" text,
	"calorie_target" integer,
	"protein_target" integer,
	"steps_target" integer,
	"subscription_status" text DEFAULT 'inactive' NOT NULL,
	"onboarding_state" text,
	"beta_bypass_until" timestamp,
	"last_active_at" timestamp,
	"training_mode" text DEFAULT 'home',
	"program_day_index" integer DEFAULT 1,
	"awaiting_input_type" text,
	"weekly_score" integer DEFAULT 0,
	"compliance_level" text DEFAULT 'RESET',
	"carb_portion_level" integer,
	"referral_code" text,
	"referred_by" text,
	"signup_source" text,
	"injuries" text,
	"programme_phase" integer DEFAULT 1,
	"programme_week" integer DEFAULT 1,
	"programme_day_in_week" integer DEFAULT 1,
	"programme_start_date" timestamp,
	"training_experience" text,
	"last_workout_date" timestamp,
	"total_workouts_completed" integer DEFAULT 0,
	"phase_ready_to_advance" boolean DEFAULT false,
	"home_equipment" text,
	"life_situation" text,
	"job_type" text,
	"activity_level" text,
	"primary_focus_area" text,
	"lagging_areas" text,
	"dominant_areas" text,
	"physique_analysed_at" timestamp,
	"baseline_week_active" boolean DEFAULT false,
	"baseline_week_complete" boolean DEFAULT false,
	"profile_notes" text,
	"dream_goal" text,
	"biggest_struggle" text,
	"food_likes" text,
	"food_dislikes" text,
	"today_water" numeric DEFAULT '0',
	"water_streak" integer DEFAULT 0,
	"water_last_reset_date" text,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"bmi" numeric,
	"medical_conditions" text,
	"nutrition_protocol" text,
	"meal_timing_strict" boolean DEFAULT false,
	"doctor_clearance_required" boolean DEFAULT false,
	"training_location" text,
	"gym_name" text,
	"weekly_food_budget" text,
	"work_schedule" text,
	"elderly_client" boolean DEFAULT false,
	"awaiting_programme_answers" boolean DEFAULT false,
	"other_medical_notes" text,
	"popi_consent" boolean DEFAULT false,
	"popi_consent_at" timestamp,
	"last_goal_check_week" integer DEFAULT 0,
	"workout_streak" integer DEFAULT 0,
	"subscription_renews_at" timestamp,
	"payment_reference" text,
	"today_calories" integer DEFAULT 0,
	"today_calories_date" text,
	"today_protein_g" integer DEFAULT 0,
	"buddy_id" uuid,
	"buddy_paired_at" timestamp,
	"target_weight_kg" numeric,
	"diet_break_ends_at" timestamp,
	"diet_break_cal_target" integer,
	CONSTRAINT "users_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weekly_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"weight" numeric,
	"waist_cm" numeric,
	"workouts_completed" integer,
	"avg_steps" integer,
	"hunger_score" integer,
	"auto_adjustment_note" text,
	"escalation_flag" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weight_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"weight" numeric NOT NULL,
	"logged_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workout_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workout_completed" boolean DEFAULT false,
	"logged_at" timestamp DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'ab_assignments' AND par.relname = 'ab_experiments' AND a.attname = 'experiment_id'
  ) THEN
    ALTER TABLE "ab_assignments" ADD CONSTRAINT "ab_assignments_experiment_id_ab_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."ab_experiments"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'ab_assignments' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "ab_assignments" ADD CONSTRAINT "ab_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'body_measurements' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "body_measurements" ADD CONSTRAINT "body_measurements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'chat_history' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "chat_history" ADD CONSTRAINT "chat_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'client_actions' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "client_actions" ADD CONSTRAINT "client_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'client_intelligence_profiles' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "client_intelligence_profiles" ADD CONSTRAINT "client_intelligence_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'client_understanding' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "client_understanding" ADD CONSTRAINT "client_understanding_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'clothing_checkins' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "clothing_checkins" ADD CONSTRAINT "clothing_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'escalations' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "escalations" ADD CONSTRAINT "escalations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'exercise_logs' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "exercise_logs" ADD CONSTRAINT "exercise_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'gpt_costs' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "gpt_costs" ADD CONSTRAINT "gpt_costs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'meal_logs' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "meal_logs" ADD CONSTRAINT "meal_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'messages' AND par.relname = 'conversations' AND a.attname = 'conversation_id'
  ) THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'progress_photos' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "progress_photos" ADD CONSTRAINT "progress_photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'quality_signals' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "quality_signals" ADD CONSTRAINT "quality_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'reminders' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'sent_proactive' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "sent_proactive" ADD CONSTRAINT "sent_proactive_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'step_logs' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "step_logs" ADD CONSTRAINT "step_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'user_integrations' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "user_integrations" ADD CONSTRAINT "user_integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'weekly_checkins' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "weekly_checkins" ADD CONSTRAINT "weekly_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'weight_logs' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "weight_logs" ADD CONSTRAINT "weight_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class par ON par.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND ch.relname = 'workout_logs' AND par.relname = 'users' AND a.attname = 'user_id'
  ) THEN
    ALTER TABLE "workout_logs" ADD CONSTRAINT "workout_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ab_assignments_exp_user_idx" ON "ab_assignments" USING btree ("experiment_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ab_assignments_exp_idx" ON "ab_assignments" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_events_action_idx" ON "admin_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_events_performed_at_idx" ON "admin_events" USING btree ("performed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "body_measurements_user_idx" ON "body_measurements" USING btree ("user_id","logged_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_history_user_date_idx" ON "chat_history" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_history_user_intent_idx" ON "chat_history" USING btree ("user_id","intent","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_actions_user_idx" ON "client_actions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clothing_checkins_user_idx" ON "clothing_checkins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "escalations_status_idx" ON "escalations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "escalations_user_idx" ON "escalations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exercise_logs_user_idx" ON "exercise_logs" USING btree ("user_id","logged_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gpt_costs_user_date_idx" ON "gpt_costs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gpt_costs_date_idx" ON "gpt_costs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_logs_user_date_idx" ON "meal_logs" USING btree ("user_id","logged_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_jobs_status_idx" ON "media_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_events_unique_idx" ON "payment_events" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "progress_photos_user_idx" ON "progress_photos" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_signals_kind_date_idx" ON "quality_signals" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_signals_reviewed_idx" ON "quality_signals" USING btree ("reviewed","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminders_due_idx" ON "reminders" USING btree ("status","fire_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminders_user_idx" ON "reminders" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sent_proactive_uniq_idx" ON "sent_proactive" USING btree ("user_id","message_key","dedupe_window");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sent_proactive_user_idx" ON "sent_proactive" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sent_proactive_sent_at_idx" ON "sent_proactive" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "step_logs_user_idx" ON "step_logs" USING btree ("user_id","logged_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_integrations_user_provider_idx" ON "user_integrations" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_integrations_user_idx" ON "user_integrations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_phone_idx" ON "users" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_sub_onboard_idx" ON "users" USING btree ("subscription_status","onboarding_state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weekly_checkins_user_idx" ON "weekly_checkins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weight_logs_user_idx" ON "weight_logs" USING btree ("user_id","logged_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workout_logs_user_idx" ON "workout_logs" USING btree ("user_id","logged_at");