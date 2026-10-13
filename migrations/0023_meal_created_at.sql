-- #637: "remove my last meal" means the last one the client SENT. A correction updates its row in place, so
-- xmin made the corrected lunch "last" and supper survived the removal. created_at is set once, at insert.
-- Existing rows are backfilled from logged_at (the best record of when they were sent).
ALTER TABLE public.meal_logs ADD COLUMN IF NOT EXISTS created_at timestamptz;--> statement-breakpoint
UPDATE public.meal_logs SET created_at = logged_at AT TIME ZONE 'UTC' WHERE created_at IS NULL;--> statement-breakpoint
ALTER TABLE public.meal_logs ALTER COLUMN created_at SET DEFAULT now();--> statement-breakpoint
ALTER TABLE public.meal_logs ALTER COLUMN created_at SET NOT NULL;
