-- CHAT HISTORY IS READ ONCE PER CLIENT, EVER (#467). learnFromHistory (server/core/coach.ts) claims this
-- column before its model call. Until now "already learned" lived in memory, and only a stored fact proved
-- it on disk, so every deploy re-read the history of every client whose history held no fact.
ALTER TABLE users ADD COLUMN IF NOT EXISTS history_learned_at TIMESTAMPTZ;
--> statement-breakpoint
-- Clients already learned (they have a history fact) are marked, so this deploy does not read them again.
UPDATE users SET history_learned_at = now() WHERE history_learned_at IS NULL
  AND id IN (SELECT user_id FROM client_facts WHERE extracted_by = 'backfill:history');
