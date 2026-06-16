# KamLife Coach — Launch Blockers
_Last updated: 2026-05-23_

**Decision: Can KamLife safely accept paying customers next week?**

> **YES — with one caveat (see item 2).** All payment, security, and data-integrity blockers are fixed. Admin auth is a single shared secret, which is acceptable for a solo-operator launch. Scale-out concerns (distributed dedup, distributed rate-limiting) are not launch blockers at single-instance Railway deployment.

---

## CRITICAL — Must be fixed before first paying customer

| # | Finding | Status | Fix | Test evidence |
|---|---------|--------|-----|---------------|
| 1 | **PayFast ITN replay** — duplicate subscription extension, duplicate referral reward, duplicate welcome messages on PayFast retry | ✅ FIXED | `payment_events` table with `UNIQUE(provider, provider_payment_id)`. On duplicate, `INSERT` returns PG error code `23505` → webhook returns early. Subscription update + referral reward wrapped in single DB transaction. | Commit `74e1bde`. To verify: POST `/webhook/payfast` twice with same `pf_payment_id` — second call must log `SKIPPED — duplicate ITN` and make no DB changes. |
| 2 | **PayFast signature forgeable** — passphrase was optional; `passphrase \|\| ""` computed signature without passphrase, making forged webhooks possible | ✅ FIXED | Webhook now requires `PAYFAST_PASSPHRASE` env var. If not set, ITN is rejected with log `REJECTED — PAYFAST_PASSPHRASE not set`. | Commit `6c12a10`. **Action required**: confirm `PAYFAST_PASSPHRASE` is set in Railway env vars before launch. |
| 3 | **OpenAI crash on startup** — server started with no error if `OPENAI_API_KEY` missing, then crashed mid-request | ✅ FIXED | `process.exit(1)` at startup if neither `AI_INTEGRATIONS_OPENAI_API_KEY` nor `OPENAI_API_KEY` is set. | Commit `6c12a10`. Verify: deploy without key → process should refuse to start. |
| 4 | **Food correction not atomic** — delete old meal + recount totals was not wrapped in a transaction; partial failure left DB in inconsistent state | ✅ FIXED | Correction flow wrapped in `db.transaction()`. | Commit `6c12a10`. |

---

## HIGH — Must be fixed before scale marketing (not before first 50 customers)

| # | Finding | Status | Fix | Notes |
|---|---------|--------|-----|-------|
| 5 | **Scheduler silent failures** — cron job crashes were swallowed silently; coach never knew | ✅ FIXED | `safe()` function tracks consecutive failures, alerts coach via WhatsApp after 2nd failure on critical jobs. | Commit `6c12a10`. |
| 6 | **Escalation SLA never queried** — daily SLA check fetched ALL open escalations regardless of `sla_deadline`, falsely reporting every open escalation as a breach | ✅ FIXED | `WHERE sla_deadline <= NOW()` filter added. Separate 30-minute cron for urgent (1h SLA) escalations. | Commit `515e088`. |
| 7 | **Admin query-string auth** — `?key=` on force-activate and test-buttons leaked the admin key in server logs and HTTP referrer headers | ✅ FIXED | Removed `req.query.key` from both endpoints. Header-only (`x-coach-key`) is now required. | Commit `74e1bde`. |
| 8 | **No audit trail for admin actions** — force-activate calls left no durable record | ✅ FIXED | `admin_events` table logs every force-activate with phone, reason, and timestamp. Reconciliation endpoint `GET /api/admin/reconcile` shows active users with no payment event + full admin action history. | Commit `81c6919`. |
| 9 | **Funnel endpoint full-table scan** — `SELECT * FROM users` with no WHERE/LIMIT, all filtering in JavaScript — crashes at scale | ✅ FIXED | Replaced with single SQL `COUNT(*) FILTER(WHERE ...)` aggregate query. One DB round-trip. Also fixed d1 retention cohort logic (was always returning 100% due to inverted filter condition). | Commit `81c6919`. |
| 10 | **Admin auth = single shared secret** | ⚠️ ACCEPTED RISK | For a solo-operator launch (one coach, one dashboard), a shared secret with header-only auth is acceptable. Per-user accounts + MFA is a v2 milestone. | Mitigations in place: timing-safe compare, no query-string leakage, brute-force lockout (in-memory, sufficient for single instance). |
| 11 | **In-memory Twilio SID dedup** — `processedSids` Map is process-local | ⚠️ ACCEPTED RISK | Already has size-capped eviction at 2000 entries with 24h TTL. At single-instance Railway deployment, this is sufficient. Becomes a problem only with horizontal scaling. | No fix needed at launch. |
| 12 | **In-memory login rate-limit** — `loginAttempts` Map resets on restart | ⚠️ ACCEPTED RISK | Dashboard login rate-limit resets on redeploy. Acceptable at single instance. | No fix needed at launch. |

---

## MEDIUM — Post-launch improvements

| # | Finding | Notes |
|---|---------|-------|
| 13 | Migration drift (dual schema systems) | Runtime `ALTER TABLE IF NOT EXISTS` + Drizzle schema both define structure. Works operationally but creates confusion. Unify to Drizzle migrations in v2. |
| 14 | Dashboard cohort endpoint per-week DB queries in loop | Weekly cohort endpoint queries DB once per week, up to 8 times serially. Acceptable at launch scale; add SQL window functions later. |
| 15 | `chatHistory` / `mealLogs` table archival | No data retention policy. Not a problem at <1,000 users. |
| 16 | Distributed dedup + rate limiting | Redis-backed for multi-replica deployments. Not needed until Railway horizontal scale. |

---

## Previously reported as bugs — VERIFIED AS NOT BUGS

| Finding | Verdict |
|---------|---------|
| Phase advancement "completely broken" | FALSE POSITIVE — advancement runs correctly via `programmeWeek >= 4` + compliance >= 75% check in `programme.ts`. The `phaseReadyToAdvance` flag is dead code but harmless. |
| `processedSids` memory leak | FALSE POSITIVE — already has size-capped eviction at 2000 entries. |
| Memory system "naive substring match" | FALSE POSITIVE — uses OpenAI `text-embedding-3-small` + pgvector cosine similarity. |
| Buddy pairing "buddy never notified" | FALSE POSITIVE — `sendWhatsApp()` call to matched buddy is present in lifecycle.ts:214. |
| `recomputeTodayFoodTotals` "sums in app" | FALSE POSITIVE — uses `COALESCE(SUM(...))` SQL aggregate. Now also has 30s per-user cache with invalidation on every INSERT. |

---

## Launch checklist (verify in Railway before first customer)

> ⚠️ **Presence ≠ validity.** `npm run diagnose:env` now flags placeholder/malformed
> values (e.g. `your-merchant-id`, or the variable name pasted into the value field).
> A var showing 🔶 PLACEHOLDER is as broken as one that is missing. Run it in Railway
> (`railway run npm run diagnose:env`) and fix every ❌ and 🔶 before launch.

- [ ] `PAYFAST_PASSPHRASE` is set to the REAL passphrase (not the `your-…` placeholder)
- [ ] `PAYFAST_MERCHANT_ID` and `PAYFAST_MERCHANT_KEY` are set to REAL values (not `your-merchant-id`)
- [ ] `OPENAI_API_KEY` (or `AI_INTEGRATIONS_OPENAI_API_KEY`) is set
- [ ] `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` are set
- [ ] `COACH_DASHBOARD_KEY` is set and stored securely (not in code)
- [ ] `COACH_ALERT_PHONE` is set (receives scheduler failure + SLA breach alerts)
- [ ] `APP_URL` is set (used in PayFast ITN notify_url)
- [ ] `PAYFAST_SANDBOX=false` for live payments
- [ ] POST `/webhook/payfast` with duplicate `pf_payment_id` → confirms "SKIPPED — duplicate ITN" in logs
- [ ] POST `/api/admin/force-activate` with `?key=` → must return 403 (header-only now)
- [ ] GET `/api/admin/reconcile` with `x-coach-key` header → returns `{ activeWithNoPaymentEvent: [], adminActions: [] }`
