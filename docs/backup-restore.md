# Database Backup & Restore Runbook

KamLife's Postgres database is backed up to **Cloudflare R2** every 6 hours by the
GitHub Actions workflow [`.github/workflows/db-backup.yml`](../.github/workflows/db-backup.yml).
Backups run independently of the Railway app, so they continue even if the app is
down. Each backup is a gzipped `pg_dump` named `kamlife-YYYYMMDD-HHMMSS.sql.gz`
under the `daily/` prefix. Retention: 30 days (older dumps auto-pruned).

---

## One-time setup

### 1. Create the R2 bucket
1. Cloudflare dashboard → **R2** → **Create bucket** → name it `kamlife-db-backups`.
2. **R2** → **Manage R2 API Tokens** → **Create API token**.
   - Permissions: **Object Read & Write**, scoped to this bucket.
   - Copy the **Access Key ID** and **Secret Access Key** (shown once).
3. Note your **S3 API endpoint**: `https://<account-id>.r2.cloudflarestorage.com`
   (the account id is on the R2 overview page).

### 2. Get the PUBLIC database URL
GitHub's runners cannot reach Railway's private network, so you need the public URL.
- Railway → **Postgres** service → **Variables** (or the **Connect** tab → *Public Network*).
- Use the connection string whose host is `*.proxy.rlwy.net` (NOT `*.railway.internal`).

### 3. Add the repository secrets
GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `BACKUP_DATABASE_URL` | the **public** Postgres connection string |
| `R2_ACCESS_KEY_ID` | R2 token access key id |
| `R2_SECRET_ACCESS_KEY` | R2 token secret |
| `R2_BUCKET` | `kamlife-db-backups` |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |

### 4. Test it
GitHub repo → **Actions → Database Backup → Run workflow**. It should finish green
and you should see `daily/kamlife-….sql.gz` appear in the R2 bucket. **Then do a
test restore (below) at least once** — an untested backup is only a hope.

---

## Restore

> Restore into a **fresh, empty** database first and verify it, before pointing
> production at it. Never restore over a live DB unless you've accepted the data loss.

### A. Restore to a scratch database (recommended verification)
```bash
# 1. Pull the latest backup from R2 (configure aws-cli env first, see below)
LATEST=$(aws s3 ls "s3://$R2_BUCKET/daily/" --endpoint-url "$R2_ENDPOINT" \
  | awk '{print $4}' | sort | tail -1)
aws s3 cp "s3://$R2_BUCKET/daily/$LATEST" "/tmp/$LATEST" --endpoint-url "$R2_ENDPOINT"

# 2. Restore into a throwaway DB (e.g. a new Railway Postgres or local docker)
gunzip -c "/tmp/$LATEST" | psql "$SCRATCH_DATABASE_URL"

# 3. Sanity check
psql "$SCRATCH_DATABASE_URL" -c "SELECT count(*) FROM users;"
psql "$SCRATCH_DATABASE_URL" -c "SELECT count(*) FROM payment_events;"
```

aws-cli env for R2:
```bash
export AWS_ACCESS_KEY_ID=<R2_ACCESS_KEY_ID>
export AWS_SECRET_ACCESS_KEY=<R2_SECRET_ACCESS_KEY>
export AWS_DEFAULT_REGION=auto
export R2_BUCKET=kamlife-db-backups
export R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

### B. Restore production (disaster recovery)
1. Stop writes — set `PROACTIVE_PAUSED=true` in Railway and, ideally, pause the app.
2. Provision a fresh Postgres (or drop+recreate the schema on the existing one).
3. `gunzip -c <backup>.sql.gz | psql "$DATABASE_URL"`
4. **Re-apply every deletion made after this backup (POPIA, #342).** A client who asked to be
   deleted after the backup was taken comes back with it. Every confirmed deletion leaves an
   `account_erased` row holding only the account id. If the old database is still readable, copy
   those ids across and delete them in the restored one:
   ```sql
   -- on the OLD database: the ids erased since the backup's timestamp
   SELECT meta->>'userId' FROM admin_events WHERE action = 'account_erased' AND performed_at >= '<backup UTC time>';
   ```
   On the RESTORED database, replay the same deletion `server/handlers/safety.ts` runs, for each id.
   The tables that don't cascade from `users` go first; the phone is read from the restored row.
   A unit test keeps this list equal to the code's.
   ```sql
   \set uid '<id>'
   SELECT phone_number AS phone FROM users WHERE id = :'uid' \gset
   BEGIN;
   -- ERASURE REPLAY (keep in step with safety.ts)
   DELETE FROM quality_signals WHERE user_id = :'uid';
   DELETE FROM shadow_replies WHERE user_id = :'uid' OR phone = :'phone';
   DELETE FROM media_jobs WHERE user_id = :'uid' OR phone_number = :'phone';
   DELETE FROM admin_events WHERE target_phone = :'phone';
   DELETE FROM users WHERE id = :'uid';   -- every other client table cascades from users
   -- and the tombstone again, so the next backup run saves it (it was not in the restored backup)
   INSERT INTO admin_events (action, meta) VALUES ('account_erased', jsonb_build_object('userId', :'uid'));
   COMMIT;
   ```
   **If the old database is lost (#499),** the ids also live outside it, in two places. Replay every id
   from both, whatever the backup's age (replaying an id that is already gone deletes nothing):
   - **R2 `tombstones/`**: every backup run first saves the erased ids to a new `erased-<time>.txt`:
     every id erased since the day before the oldest backup in `daily/`, which is every id any existing
     backup could bring back. After the backup prune, the run deletes every older tombstone file (the new one
     holds every id still needed) and the older `account_erased` rows, so an id is kept only while a
     backup that predates its deletion exists (about 30 days; longer only if backups stop being pruned). Take the newest file:
     `aws s3 ls s3://$R2_BUCKET/tombstones/ --endpoint-url $R2_ENDPOINT`.
   - **Railway logs**, for deletions since that file: the moment a client confirms with DELETE, and before
     anything is deleted, the app logs `[POPIA DELETE] User <id> requested data deletion`. In Railway →
     the app service → Logs, search `[POPIA DELETE] User` from **one hour before** the newest tombstone
     file's time (a request logged just before a run can commit after it). A confirmed request is
     replayed even if its deletion never finished: the client asked for it.
   Railway keeps logs for at least 7 days, far longer than the 6 hours between runs. A run that cannot
   save the tombstones fails and opens the "Database backup failed" issue. A unit test keeps the log
   line, the workflow step and this step in step.
5. Point the app's `DATABASE_URL` at the restored DB and redeploy.
6. Unset `PROACTIVE_PAUSED`. Spot-check recent users, meal logs, and subscription status.

The dump is taken with `--no-owner --no-privileges`, so it restores cleanly under
whatever role the target DB uses.

---

## Notes & gotchas
- **Version**: the workflow installs `postgresql-client-18` (bumped 2026-07-08 —
  Railway silently upgraded Postgres to v18, `pg_dump` must be **≥** the server
  major version or it aborts on a version mismatch). If Railway upgrades again,
  bump the `postgresql-client-NN` line in the workflow the same way.
- **Recovery point**: backups are every 6h, so worst-case data loss is ~6 hours.
- **Every backup is test-restored** (#342): the workflow restores it strictly (any failed statement fails it) into a throwaway Postgres 18 and checks the client and meal counts **before** publishing it to `daily/`. A dump that fails is kept under `failed/` for inspection and never counts as a backup. A failed backup or restore opens a GitHub issue titled "Database backup failed".
  Payment state is additionally reconstructable from PayFast ITN history + the
  `payment_events` table.
- **Retention** is enforced in the workflow's prune step (30 days). To change it,
  edit `RETENTION_DAYS` in the workflow. You can also set an R2 lifecycle rule as
  a belt-and-braces backstop.
- **Failure alerts**: GitHub emails repo admins when a scheduled workflow fails and
  disables the schedule after repeated failures — check the **Actions** tab if you
  stop seeing new backups in R2.
- This is logical backup only. For point-in-time recovery (restore to any second),
  Railway's **Pro** plan PITR is the managed alternative.
