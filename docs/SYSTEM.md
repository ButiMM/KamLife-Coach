# What already exists: check here before asking the founder anything

Every builder, reviewer and the CTO reads this before asking the founder a question. **Asking him for something recorded here, or findable in the repo, is a failure.** If you learn something durable, add it here in the same PR.

## GitHub Actions secrets (names only; values are never written anywhere)

| Secret | Used by | Notes |
|---|---|---|
| `AI_INTEGRATIONS_OPENAI_API_KEY` | (deleted 27 Sep) | **Removed by the CTO so CI can't spend production's credits.** CI's key must come from a **separate OpenAI project with a hard cap**, saved as `OPENAI_API_KEY`. Never reuse the production key. |
| `BACKUP_DATABASE_URL` | `db-backup.yml` | Production database, for backups |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | `db-backup.yml` | Cloudflare R2, where backups are stored |
| `REPLAY_HELDOUT_JSON` | replay gate | **Set 25 Sep by the CTO:** 8 hidden cases, 2 per wave-1 row. Maintained by the CTO only; the builder never sees it. |
| — | — | **No GitHub secret for the what's-new note (CTO, 1 Oct).** Each switch PR adds a dated line to `WHATS_NEW` in `server/scheduler/jobs/evening.ts`; that evening's message carries it through the normal proactive sender. `whats-new.yml` and its secrets are gone. |

## AI budget firewall (founder action, 24 Sep)

The OpenAI credits ran out on 24 Sep because the live-model gate ran on every PR push. Fix, done once in the OpenAI dashboard:
1. Create a separate **project** for CI (Settings → Projects → Create), for example "kamlife-ci".
2. Set a **monthly budget** on that project (Limits → Budget), for example $10, with a hard stop.
3. Create a key in that project, and put it in GitHub as the `AI_INTEGRATIONS_OPENAI_API_KEY` secret.
4. Production (Railway) keeps its own key in its own project. CI can then never spend the live coach's money.

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
| 30 Sep | **Price range: R199 to R250 a month** (founder). R149 and R99 are no longer candidates. The first paying group tests R199 against R249. |
| 30 Sep | **WhatsApp templates:** the founder submitted templates to Twilio/Meta weeks ago and is in contact with Twilio. Status is tracked in `admin` issues, not re-asked. |
| 30 Sep | **Responsibilities split** (see ORDERS §6): CTO (Claude, chat) = engineering and build direction; Codex = attacks, reviews and administration (Twilio/Meta, billing, POPIA paperwork); marketing and market research in a separate room; Grok = daily independent review. |
| 6 Oct | **The till charges R199** (#567, CTO ruling: the low end of the decided range). Earlier subscribers' PayFast tokens keep renewing at R149 and the ITN check accepts both (`shared/pricing.ts` `legacyPricesZAR`). |

## Founder checks still open (Railway, only the founder can see it)

- ✅ `COACH_ALERT_PHONE` is set to the founder's own number (confirmed 25 Sep). Don't ask again.
- `COACH_DASHBOARD_KEY` is a long random value.

## Reviewers

Grok reviews on a fixed rhythm (`docs/GROK.md`): daily at ~07:00, and on every `switch` PR. Codex is out of capacity this week.

## Where the plan lives

`docs/ORDERS.md` (the plan), `docs/QUEUE.md` (the order of work), `docs/FINDINGS.md` (every review finding, mapped to an issue), `docs/RISKS.md` (risk register), issue #280 (live status).
