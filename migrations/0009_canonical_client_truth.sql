ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "truth_revision" integer DEFAULT 0 NOT NULL;

ALTER TABLE "client_understanding"
  ADD COLUMN IF NOT EXISTS "source_revision" integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS "client_truth_commits" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "source_message_id" text,
  "revision" integer NOT NULL,
  "operations" jsonb NOT NULL,
  "received_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_truth_commits_user_source_uidx"
  ON "client_truth_commits" ("user_id", "source_message_id");

CREATE UNIQUE INDEX IF NOT EXISTS "client_truth_commits_user_revision_uidx"
  ON "client_truth_commits" ("user_id", "revision");
