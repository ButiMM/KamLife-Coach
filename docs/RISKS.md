# Risk register: what can hurt KamLife, before it does

Maintained by the CTO. The point of this file: nobody on this team should have to say "I forgot to mention this". Every risk has an owner and a status. Reviewed 24 Sep 2026.

## 1. Will the new core be too expensive?

No, if we hold one rule.

- **Today:** almost every message triggers a classifier model call, then a reply call (`askCoachK` or the engine).
- **New core:** one understanding call, then one composer call. Same number of calls, one owner.
- **Rough cost at small-model prices:** about 8k tokens in and 400 out per message, across both calls. That's around R0.03 a message, or about R10-R15 a month for a client sending 15 messages a day. Comfortably inside R149-R249.
- **What breaks it:** switching the composer to a large model, which costs roughly 15× more and would take most of the price.
- **Rule:**
  - The small-model tier is the default.
  - A larger model only for a message family where the gate proves the small one fails.
  - The gate reports cost per message, with a ceiling of R0.10 average. (Owner: Claude Code, in #270 and #272.)
- **Also:** the spend cap fails open today (#340).

## 2. Won't we end up needing handlers again?

Deterministic code stays, as **tools and guards, not speakers**:
- safety and crisis overrides
- opt-out and consent
- billing
- arithmetic
- ledger writes, validated by their owners

None of them writes client-facing prose except fixed safety templates. The composer is the only voice. The mouth ratchet fails any PR that adds a speaking path.

## 3. Safety escalations may be going nowhere (FOUNDER CHECK, urgent)

Pregnancy, purging, crisis and medical escalations alert the founder through the Railway variable `COACH_ALERT_PHONE` (`server/handlers/safety.ts:175`, `server/handlers/chat-log.ts:30`). **If it isn't set, no alert is sent.** Only the founder can see Railway. **Check that it's set to your WhatsApp number.**

## 4. Security, now that the code is public

| Item | Status |
|---|---|
| Keys or passwords in the 2,642-commit history | **None found** (CTO scan, 24 Sep) |
| Personal data in the repo (old Replit logs) | Removed (#317); confirmed not real people |
| GitHub secret scanning and push protection | **Enabled** (CTO, 24 Sep): a commit containing a key is now blocked |
| Dependabot alerts and security updates | **Enabled** (CTO, 24 Sep) |
| 3 high-severity production dependency vulnerabilities | #339 |
| AI spend cap fails open | #340 |
| Delivery-status webhook weaker with an empty token | #341 |
| Main WhatsApp and PayFast webhooks verify signatures | In place (audit) |
| Admin dashboard key (`COACH_DASHBOARD_KEY`): routes are now visible in public code | **FOUNDER CHECK:** make sure it's a long random value (32+ characters), not a word |
| Jailbreaks: the prompt is public, so it's easier to attack | Scope in code, failing closed (#321), and adversarial cases in the gate (#270) |
| CTO's GitHub token | 7-day expiry. Revoke when this sprint ends. |

## 5. POPIA and data

- **Deletion:** actual deletion (#269, in flight).
- **Retention:** designed with the new client record (#271).
- **Backups:** they keep deleted clients until they age out. The backup window goes into that design (#342).

## 6. Operations and foundations

| Item | Status |
|---|---|
| Backups never test-restored; failures alert nobody | #342 |
| Two schema systems (runtime `CREATE TABLE` plus `migrations/`) | #343 |
| New migrations do run in production on start (PHASE 3 in `server/index.ts`) | Verified by CTO |
| A merge goes live to testers immediately; there's no staging | **Rollback:** Railway → the service → Deployments → redeploy the previous one. A staging environment comes after the core switch. |
| Test suite took 80+ min, and every fix restarted it | Split 6 ways (#337) |
| Codex usage limits stall attacks | Merge standard: a 45-min window, then post-merge attacks |

## 7. WhatsApp and Meta

- **General-purpose assistant ban:** scope enforced in code (#321).
- **Evening coaching outside 24h:** needs a Meta-approved template (#327). **FOUNDER TASK** when the core switches.
- **Messages outside the 24-hour window cost money per template.** Proactive sends go through one owner (#319), so they can be budgeted.

## 8. Company-wide blind spots (CTO sweep, 25 Sep)

| Blind spot | Issue | Owner |
|---|---|---|
| The switch would make the new coach forget existing clients (the record starts on 24 Sep) | #414 (blocks every switch) | builder |
| WhatsApp messaging tier, Meta verification and template approvals cap how many clients the bot can message first | #415 | founder |
| POPIA: health data is special personal information: Information Officer, privacy policy, consent wording | #416 | founder (legal) |
| `COACH_ALERT_PHONE` and `COACH_DASHBOARD_KEY` never confirmed; every founder alert depends on the first | #417 | founder (5 min) |
| The CTO's GitHub token expires about 30 Sep | #418 | founder (2 min) |

Any agent that notices something nobody asked about files it with the `blind-spot` label. The CTO reviews that label every session.
