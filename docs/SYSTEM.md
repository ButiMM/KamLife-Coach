# What already exists: check here before asking the founder anything

Every builder, reviewer and the CTO reads this before asking the founder a question. **Asking him for something recorded here, or findable in the repo, is a failure.** If you learn something durable, add it here in the same PR.

## GitHub Actions secrets (names only; values are never written anywhere)

| Secret | Used by | Notes |
|---|---|---|
| `AI_INTEGRATIONS_OPENAI_API_KEY` | replay gate, gauntlet, model-drill, reality-test | The OpenAI key. Workflows read it first, then fall back to `OPENAI_API_KEY`. **Already set (Aug 2026). Don't ask for an OpenAI key.** |
| `BACKUP_DATABASE_URL` | `db-backup.yml` | Production database, for backups |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | `db-backup.yml` | Cloudflare R2, where backups are stored |
| `REPLAY_HELDOUT_JSON` | replay gate | Not set yet. Held-out cases; until it exists, split the audit's real failures into seen and held-out. |

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
| parked | Coach K price: founder wants R199-R249 (code says R149). Decide when the core works. |

## Where the plan lives

`docs/ORDERS.md` (the plan), `docs/QUEUE.md` (the order of work), `docs/FINDINGS.md` (every review finding, mapped to an issue), issue #280 (live status).
