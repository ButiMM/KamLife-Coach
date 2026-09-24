# What already exists: check here before asking the founder anything

Every builder, reviewer and the CTO reads this before asking the founder a question. **Asking him for something recorded here, or findable in the repo, is a failure.** If you learn something durable, add it here in the same PR.

## GitHub Actions secrets (names only; values are never written anywhere)

| Secret | Used by | Notes |
|---|---|---|
| `AI_INTEGRATIONS_OPENAI_API_KEY` | replay gate, gauntlet, model-drill, reality-test | The OpenAI key for CI. **The value stored in GitHub is rejected by OpenAI (401, key ending `wfkA`), found 24 Sep.** It must hold the same working key production uses in Railway. Production's key is separate and works. |
| `BACKUP_DATABASE_URL` | `db-backup.yml` | Production database, for backups |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | `db-backup.yml` | Cloudflare R2, where backups are stored |
| `REPLAY_HELDOUT_JSON` | replay gate | Not set yet. Held-out cases; until it exists, split the audit's real failures into seen and held-out. |

## Key rotation

When the OpenAI key changes in Railway, update the GitHub secret `AI_INTEGRATIONS_OPENAI_API_KEY` the same day. They're separate copies. On 24 Sep the GitHub copy was an old revoked key (ending `wfkA`), and the replay gate failed with 401 until the founder updated it.

## Services

- **Hosting:** Railway, deploys `main` automatically. Runtime settings and flags live in Railway, not in the repo.
- **Database:** Railway Postgres. Backed up by `db-backup.yml` to R2.
- **Messaging:** Twilio WhatsApp; templates need Meta approval.
- **Payments:** PayFast.
- **Models:** OpenAI.
- **CI:** GitHub Actions, free: **the repo is public since 24 Sep 2026.**

## Runtime flags and env vars

The full list of names and code defaults is in the outgoing CTO's handover (22-23 Sep), summarised in `docs/ORDERS.md` §7 context. Production values are only in Railway; only the founder can read them.

## Decisions already made (don't re-ask)

| Date | Decision |
|---|---|
| 22 Sep | Replace the coaching core behind existing plumbing; no fifth full rebuild |
| 22 Sep | ChatGPT/Codex removed as CTO; stays on as attacker |
| 23 Sep | Claude Code builds everything; Codex attacks every PR; Grok out |
| 23 Sep | Merge standard: better than `main` ships; non-regression findings become follow-ups; max two attack rounds |
| 23 Sep | Every PR states "What testers will notice" |
| 24 Sep | Repo public: CI free again; the database suite runs on GitHub |
| 24 Sep | Lane B (new core) is the priority; old pipeline frozen except live harm |
| 24 Sep | Test phone numbers and names in old Replit logs are **not** real people |
| 24 Sep | The founder's 10 manual clients stay on manual coaching for now; **the goal is to move everyone onto the bot** once it's accurate. The founder, his clients and testers all use the bot continuously. |
| 24 Sep | **No new paid services, API keys or subscriptions** without a written case from the CTO and a yes from the founder. It's an MVP: free first. The nightly paid sweep was dropped for a free one. |
| 24 Sep | **No read-only production database access for agents.** Real tester threads reach the gate through Coach Health (#293), which runs inside production and exports de-identified cases. No credentials leave Railway. |
| 24 Sep | Gate baseline on main (out of 10): first day 7, logging 7.2, coaching 6.2, **memory 4.0**, proactive 6.5, training 8, weekly story 5.5, safety 7.9. R0.009 a message, 2.3 s a reply. |
| parked | Coach K price: founder wants R199-R249 (code says R149). Decide when the core works. |

## Founder checks still open (Railway, only the founder can see it)

- `COACH_ALERT_PHONE` is set to the founder's WhatsApp number. Safety escalations go nowhere without it.
- `COACH_DASHBOARD_KEY` is a long random value.

## Where the plan lives

`docs/ORDERS.md` (the plan), `docs/QUEUE.md` (the order of work), `docs/FINDINGS.md` (every review finding, mapped to an issue), `docs/RISKS.md` (risk register), issue #280 (live status).
