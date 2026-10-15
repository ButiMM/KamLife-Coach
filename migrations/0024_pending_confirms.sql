-- #322: the one action a client was asked to confirm ("reply yes to log it") lived in an in-process map and
-- was lost on every redeploy. One row per client, replaced by the next offer, deleted when taken.
CREATE TABLE IF NOT EXISTS public.pending_confirms (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  action jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
