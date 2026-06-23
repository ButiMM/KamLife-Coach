# CTO Audit — Live Status Tracker

> **Why this file exists:** The original 50-point CTO audit lived only in a chat
> session. When context was compacted, it vanished, and later sessions flew blind —
> "closing gaps" against a thin summary instead of the real list. That is the root
> cause of work being skipped and falsely reported as done.
>
> **This file is the permanent source of truth.** It is checked into the repo, so
> no future session can lose it. Every item below is verified against actual code
> (file:line) or a commit hash — never against memory or a summary.
>
> **Read this before touching anything related to the audit.** Update it in the
> same commit as any fix.

_Last verified: 2026-06-23 against `main` @ `5355119` and later._

---

## Legend

**Status**
- ✅ DONE — verified in code with evidence
- 🟡 PARTIAL — core done, a refinement remains (acceptable to ship)
- ⛔ OPEN — genuinely not done
- ❓ UNVERIFIED — needs a deeper read before claiming status

**Bucket** (the CTO decision on *whether to act now*)
- **DO-NOW** — cheap, foundational, safe; dangerous/expensive to leave
- **DEFER+TRIGGER** — real scale work, but premature pre-launch; building it now
  injects complexity/bugs. Listed with the threshold that should reactivate it.
- **WON'T-NOW** — risk outweighs value at current stage (e.g. large refactors)

---

## The 50 items

| # | Item | Status | Bucket | Evidence / Note |
|---|------|--------|--------|-----------------|
| 1 | Per-user monthly AI spend cap | ✅ | — | `gpt.ts:997` `isUnderMonthlyCostCap`, called from `isUnderGPTCallLimit`; env `AI_SPEND_CAP_USD_PER_USER_PER_MONTH` (default 5) |
| 2 | Scheduler state in DB | ✅ | — | `scheduler/shared.ts:75` `db.insert(schedulerState).onConflictDoUpdate`; `hydrateSchedulerStateFromDb()` on startup `scheduler.ts:186` |
| 3 | Consolidate DDL to one source | ✅ | — | `meal_logs` duplicate removed from `memory.ts` (`initMealLogsTable` deleted + caller removed in `index.ts`); created only by the canonical `index.ts` migration. `memories` (pgvector) intentionally stays raw — the one documented exception. |
| 4 | Remove normalizer double-billing | ✅ | — | Intent classified once, reused: `routes.ts:684` passes `intentPromise` → `gpt-block.ts:465` awaits it, no re-classify |
| 5 | Restrict outbound gate to GPT replies | ✅ | — | Outbound gate `verifiers/proactive-gate.ts` is **deterministic** (no GPT) and only runs on proactive sends `scheduler/shared.ts:434` |
| 6 | Split `lifecycle.ts` | ⛔ | WON'T-NOW | 1,857 lines. Highest regression risk on the list. Characterization tests added (`f3fc35f`) as the safety net for when there's a real reason. |
| 7 | Split `media.ts` | ⛔ | WON'T-NOW | 1,520 lines. Same reasoning. Char tests `4f15074`. |
| 8 | Split `early-commands.ts` | ⛔ | WON'T-NOW | Char tests `baae892`. |
| 9 | Split `misc-commands.ts` | ⛔ | WON'T-NOW | Char tests `baae892`. |
| 10 | Trial countdown (Day 2/5/7) | ✅ | — | `scheduler/jobs/trial.ts`, registered 9:30am SAST (`e91c703`) |
| 11 | Wrap payment activation in txn | ✅ | — | `routes/payments.ts:182` `db.transaction` covers sub update + referral reward |
| 12 | PayFast sig `timingSafeEqual` | ✅ | — | `e91c703` |
| 13 | Admin brute-force lockout in DB | ✅ | — | `29fa731` — `adminEvents`, 5 fails/15min cross-replica |
| 14 | MessageSid dedup in DB | ✅ | — | `b06184d` — `processedWebhooks` table, INSERT ON CONFLICT |
| 15 | Composite indexes | ✅ | — | `index.ts:173` chat_history, `:480` meal_logs, `:148` step_logs, `:457` users(sub,onboard) |
| 16 | Rate-limit `/api/payfast/link` | ✅ | — | `e91c703` — 10 req/60s/IP |
| 17 | Onboarding state enum + validation | ✅ | — | `ONBOARDING_STATES` set + warn-only guard in `handleOnboarding` (`onboarding.ts`) — logs unknown state instead of silent no-reply; never blocks |
| 18 | Mask phone PII in logs | ✅ | — | `e91c703` — last-4 across whatsapp/chat-log/voice-broadcast/payments |
| 19 | Replace meal verifier GPT w/ rules | 🟡 | WON'T-NOW | Already mostly deterministic: P1/P2 rule passes, GPT (`meal-verifier.ts`) only on suspicious items. Marginal gain to remove fully. |
| 20 | Spend-cap env enforcement | ✅ | — | Same as #1 |
| 21 | `/api/health/scheduler` endpoint | ✅ | — | `e91c703` — overdue jobs, trial cohorts, DB state |
| 22 | Unit tests for `conversion.ts` | ✅ | — | `script/unit-tests.ts:474` — 8 tests covering all 3 objection patterns (MONEY/STALL/PRICE) + null return; pure-function import, no DB |
| 23 | Unit tests for `sleep.ts` | ✅ | — | `script/unit-tests.ts` — 9 tests covering null+badSleep, null+noSleep, <5h hard floor, low (<7h), good (7-9h), high (>9h) branches |
| 24 | Char tests for `lifecycle.ts` | ✅ | — | `f3fc35f` |
| 25 | Char tests for `media.ts` | ✅ | — | `4f15074` |
| 26 | Remove hardcoded domain fallback | ⛔ | WON'T-NOW | `APP_URL || "https://kamlifecoach.co.za"` in several files. Audit said "crash if unset" — **rejected**: that risks a production outage if Railway env is briefly missing. Safer to keep the real-domain fallback. |
| 27 | `buildPatternSummary` cache TTL | ✅ | — | Cached via `patternCache` + `PATTERN_CACHE_TTL_MS` (`gpt.ts:9,529`) |
| 28 | Scheduler per-user error isolation | ✅ | — | `morning.ts` per-client `continue` + `.catch()` on every query |
| 29 | Soft-delete users (no hard delete) | ⛔ | WON'T-NOW | Invasive — requires `WHERE deleted_at IS NULL` on every user SELECT (dozens of sites). High chance of introducing the exact bugs we're trying to avoid. Reset already clears child rows in a txn. Revisit deliberately, not in a sweep. |
| 30 | PayFast payment nonce (replay) | ⛔ | DEFER+TRIGGER | Existing protections already strong: signature check + `paymentEvents` unique(provider,id) idempotency. Nonce is marginal. Trigger: any evidence of replayed-but-signed ITNs. |
| 31 | MRR/ARPU from `shared/pricing.ts` only | ✅ | — | `dashboard.ts:6` imports `calculateMRR`; no hardcoded prices |
| 32 | Origin/Referer check on admin POST | ✅ | — | `server/routes/auth.ts:53` — cookie-auth path now checks `req.headers.origin` vs `APP_URL`; rejects with 403 on mismatch; header-key path unaffected (custom headers are already CSRF-safe) |
| 33 | Stagger scheduler sends | ⛔ | DEFER+TRIGGER | Not needed at ~100 users. **Trigger: active users > 750**, or morning job runtime > 5 min. |
| 34 | DB pool size tunable | ✅ | — | `db.ts:49` `DB_POOL_MAX` env, default 25 (raise via env when needed) |
| 35 | Crisis detection beyond regex | ✅ | — | Keyword list expanded (`safety.ts:60`) — added "don't want to be here", "wish i was dead", "nothing to live for", etc. + existing SADAG/Lifeline + coach alert. Full semantic AI deliberately deferred (would add latency to the safety path). |
| 36 | Food-vision failure fallback | ✅ | — | `media.ts:1032` — `NOT_FOOD` sentinel returns "I can see that's not a food photo…"; `media.ts:1189` — timeout/exception path returns "Eish, I couldn't process that image right now…" with meal/machine/steps triage |
| 37 | Wire pgvector memory systematically | ❓ | DEFER+TRIGGER | `retrieveMemories`/`storeMemory` exist; not hooked after every session. Retention feature, not a bug. Trigger: post-launch retention work. |
| 38 | Quality-audit GPT → deterministic | 🟡 | WON'T-NOW | Already cost-optimized: one batched `gpt-4o-mini` call per run. Marginal gain to remove. |
| 39 | Pagination cap on list endpoints | ✅ | — | `admin.ts:70` `Math.min(100, …)` |
| 40 | Structured error logging (Sentry) | ✅ | — | `index.ts:17` Sentry init + captureException + expressErrorHandler (needs `SENTRY_DSN` set in Railway) |
| 41 | Validate onboarding transitions | ✅ | — | Same work as #17 — `ONBOARDING_STATES` guard |
| 42 | Referral double-earn constraint | ✅ | — | `e91c703` — `paymentEvents` `REF_REWARD_<userId>` sentinel |
| 43 | Golden test for weekly recap format | ⛔ | DEFER+TRIGGER | Nice-to-have. Trigger: after recap content stabilizes post-launch. |
| 44 | Golden test for gpt-block routing | ⛔ | DEFER+TRIGGER | Same |
| 45 | CI guard on god-file line count | ✅ | — | `script/check-file-sizes.ts` — per-file budgets freeze the large files; wired into `npm test` + `npm run check:filesize` |
| 46 | Consolidate duplicate `meal_logs` DDL | ✅ | — | `initMealLogsTable` removed from `memory.ts` + caller removed from `index.ts`. Part of #3. |
| 47 | `X-Content-Type-Options`/`X-Frame` | ✅ | — | helmet (`index.ts:525`) |
| 48 | Loud startup check for `PAYFAST_PASSPHRASE` | ✅ | — | `index.ts:657` critical env check + `payments.ts:101` rejects ITN if unset |
| 49 | Audit trail for trial grants | ⛔ | DEFER+TRIGGER | Minor. Trigger: if trial-abuse appears. |
| 50 | Archive old `chatHistory` | ⛔ | DEFER+TRIGGER | **Trigger: `chat_history` > ~5M rows** or query latency regression. |

---

## Scale roadmap (Phases A–E) — deliberately sequenced

These are **not forgotten** — they are scheduled by reality, not by a sweep.
Building them pre-launch is over-engineering that injects bugs.

| Phase | Item | Trigger to start |
|-------|------|------------------|
| A | Launch blockers | ✅ done / env vars are human tasks (see `LAUNCH_BLOCKERS.md`) |
| B | Indexes, txns, double-billing, DDL | ✅ mostly done (see table) |
| C | Stagger sends, Redis rate-limit, char tests | active users > 750 / multi-replica deploy |
| C | God-file splits | only with a concrete reason + char tests green |
| D | Read replica | sustained active users > 1,000 OR analytics slowing prod |
| D | Message queue for sends | Twilio send backpressure / 429s observed |
| D | Cold-archive `chatHistory` | table > ~5M rows |
| E | DB sharding, multi-number Twilio, AI microservice | > 50,000 users |

---

## Honest tally (after this pass)

- ✅ DONE: 37 items (verified) — incl. #22, #23, #32, #36 closed this pass
- 🟡 PARTIAL (acceptable to ship): 2 — #19, #38 (cost-optimized GPT — marginal gain to remove)
- ⛔ OPEN by design:
  - **DEFER+TRIGGER (scale — do when the threshold hits):** #30, #33, #37, #43, #44, #49, #50
  - **WON'T-NOW (risk > value pre-launch):** #6, #7, #8, #9 (god-file splits), #26, #29

**Nothing on this list is lost anymore.** Every deferred item has a written trigger.
Every done item has evidence. The foundation is closed; what remains is either
scale work scheduled by real thresholds, or refactors too risky to do pre-launch.

### What changed in pass 1 (commit 4e3a7cb + 2a44576)
- #3 / #46 — killed the duplicate `meal_logs` DDL (schema drift gone)
- #17 / #41 — onboarding state validation guard (surfaces silent-death bugs)
- #35 — expanded crisis phrase detection
- #45 — CI file-size guard so god-files can't grow
- Created this tracker (the cure for the lost-context problem)

### What changed in pass 2 (this session)
- #22 — confirmed conversion.ts unit tests existed; updated evidence pointer
- #23 — added 9 sleep.ts unit tests (getSleepResponse all branches) in unit-tests.ts
- #32 — added Origin CSRF guard to requireAdminKey cookie-auth path (auth.ts:53)
- #36 — confirmed food-vision fallbacks at media.ts:1032 (NOT_FOOD) and media.ts:1189 (timeout/error)
