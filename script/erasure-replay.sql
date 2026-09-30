-- ERASURE REPLAY (docs/backup-restore.md step 4, #499). Keep in step with server/handlers/safety.ts;
-- a unit test checks every table that erasure deletes from explicitly is deleted from here too.
--
-- Re-applies confirmed deletions to a RESTORED database, for every row of the temp table
-- `replay (uid uuid, at timestamp)`: the ids from the old database, the newest R2 tombstone file and
-- the Railway log lines, each with its ORIGINAL erasure time. Set-based and idempotent: an id already
-- absent deletes nothing and never stops the others, and running it twice changes nothing.
BEGIN;
CREATE TEMP TABLE replay_phones ON COMMIT DROP AS
  SELECT u.id AS uid, u.phone_number AS phone FROM users u JOIN replay r ON r.uid = u.id;
DELETE FROM quality_signals WHERE user_id IN (SELECT uid FROM replay);
DELETE FROM shadow_replies WHERE user_id IN (SELECT uid FROM replay) OR phone IN (SELECT phone FROM replay_phones);
DELETE FROM media_jobs WHERE user_id IN (SELECT uid FROM replay) OR phone_number IN (SELECT phone FROM replay_phones);
DELETE FROM admin_events WHERE target_phone IN (SELECT phone FROM replay_phones);
DELETE FROM users WHERE id IN (SELECT uid FROM replay);   -- every other client table cascades from users
-- The tombstone again, at the original time, so the next backup run saves it and its ~30 days still
-- count from the client's DELETE, not from the restore. Never a second row for the same id.
INSERT INTO admin_events (action, meta, performed_at)
  SELECT DISTINCT ON (r.uid) 'account_erased', jsonb_build_object('userId', r.uid::text), r.at
    FROM replay r
   WHERE NOT EXISTS (SELECT 1 FROM admin_events e WHERE e.action = 'account_erased' AND e.meta->>'userId' = r.uid::text)
   ORDER BY r.uid, r.at;
COMMIT;
