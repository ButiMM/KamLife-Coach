-- #637: "remove my last meal" means the last one the client SENT. A correction updates its row in place, so
-- xmin made the corrected lunch "last" and supper survived the removal. created_at is set once, at insert.
-- Existing rows take their send time from the message they came from (client_events.received_at); logged_at
-- is when a meal BELONGS, so a backdated "at 9 I had eggs" would sort before the lunch sent earlier (#650
-- attack). Only rows with no recorded message fall back to logged_at.
ALTER TABLE public.meal_logs ADD COLUMN IF NOT EXISTS created_at timestamptz;--> statement-breakpoint
UPDATE public.meal_logs m SET created_at = coalesce(
  (SELECT e.received_at FROM public.client_events e WHERE e.source_message_id = split_part(m.source_message_id, '#', 1)),
  m.logged_at AT TIME ZONE 'UTC')
WHERE m.created_at IS NULL;--> statement-breakpoint
ALTER TABLE public.meal_logs ALTER COLUMN created_at SET DEFAULT now();--> statement-breakpoint
ALTER TABLE public.meal_logs ALTER COLUMN created_at SET NOT NULL;
