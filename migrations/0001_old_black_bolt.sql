-- 2026-08-10. Idempotent on purpose.
--
-- shadow_replies and trialed_numbers were created on production with `drizzle-kit push` before
-- the migration discipline landed, so they already exist there while being absent from the
-- migration history. A bare CREATE TABLE would abort this migration on "relation already
-- exists" and block every migration after it. IF NOT EXISTS makes the file safe to apply to a
-- database that has them and to a fresh one that does not — which is also what makes the
-- baseline honest rather than a file nobody dares run.

CREATE TABLE IF NOT EXISTS "shadow_replies" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"phone" text NOT NULL,
	"channel" text NOT NULL,
	"author_file" text NOT NULL,
	"body" text NOT NULL,
	"media_urls" jsonb,
	"commit_sha" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trialed_numbers" (
	"phone_hash" text PRIMARY KEY NOT NULL,
	"first_trialed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "turn_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"input_type" text,
	"input_text" text,
	"resolved_day" text,
	"state_read" jsonb,
	"mutations" jsonb,
	"reply" text,
	"reply_ms" integer,
	"version" text,
	"failure_category" text
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "turn_ledger" ADD CONSTRAINT "turn_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shadow_replies_phone_idx" ON "shadow_replies" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shadow_replies_created_idx" ON "shadow_replies" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "turn_ledger_user_date_idx" ON "turn_ledger" USING btree ("user_id","created_at");