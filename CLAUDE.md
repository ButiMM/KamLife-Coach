# KamLife Coach — Claude Code Instructions (one page)

**Freeze, 7 Oct – 21 Oct (founder and CTO, #391).** No new rules, gates, ratchets, harnesses, planning docs or measurement tools. `docs/QUEUE.md`, `docs/STATUS.md` and `docs/ORDERS.md` are frozen: don't update them. Status is a few lines a day on #391, and nowhere else.

## The job
Make what testers experience right. Done means **a tester sees it**: the change shows in the daily tester trace (`TRACE_MODEL=stub npx tsx script/tester-trace.ts`, and on `main`) and on the founder's phone. "Merged" and "green" are not done.

## Every PR
- It opens with **"What testers will notice:"**. If the honest answer is "nothing", don't open it. The exceptions are safety, billing and data loss.
- **One test per fix**: the case that broke, failing without the fix. No revert harnesses, ratchet entries or budget essays for ordinary changes.
- It's based on `main`, small, and one task. Never push to `main` (it deploys straight to Railway).
- **Delete before adding.** If a change makes old code unreachable, delete that code in the same PR.
- `[harm]` and `switch` PRs are reviewed by the CTO. Answer a review with a comment starting `ANSWER`.
- Keep these green: the safety and billing pg suites (`safety-routing`, `opt-out`, `cancel-menu`, `payments-cancel-truth`, `refund-guarantee`, `spend-cap`), unit tests, and `core-wave1-switch`.

## How a message is answered (the front door, #592)
1. **Floors, in code:** safety (crisis, pregnancy, eating disorders, medication, minors), STOP and opt-out, POPIA, onboarding, billing and cancel menus, heart clearance, pending answers (`awaitingInputType`, engine confirm), founder commands.
2. **Exact commands, the whole message only:** `menu`, `progress`, `targets`, `help`, `stop`, button numbers.
3. **Everything else goes to the new coach** (`core/coach.ts` `frontTurn`): one `understand()` read covers meaning, scope, facts and actions. The actions run through the existing tools for every client (executor → scanner, steps, weight, water; corrections; workouts; goal confirm; reminders). Then `compose()`. Two model calls a turn.
4. **The old handlers answer only when** the coach declines: there's no read, the model is down, the spend cap is hit, or `CORE_FRONT=off`. That rollback expires 14 Oct; after 48 clean hours the old handlers behind it are deleted.

A write is claimed only when it happened (the turn's mutation record). A delete needs the client's own removal words.

## Stack and env
TypeScript, Node and Express on Railway; PostgreSQL with Drizzle (migrations run on start). WhatsApp via Twilio (`\n\n---\n\n` splits a reply into separate messages).
Railway vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `TWILIO_SMS_NUMBER`, `MEDIA_BASE_URL`, `PAYFAST_MERCHANT_ID`, `APP_URL`, `PROACTIVE_PAUSED` (must not be `true`), `CORE_FRONT`, `CORE_WAVE2` / `CORE_WAVE4` (must not be `off`), `GLOBAL_AI_DAILY_HARD_CAP_USD`. The founder checks the live build by sending `version`. More in `docs/SYSTEM.md`, and check there before asking the founder anything.
Costs: `docs/COSTS.md` (no new paid spend until revenue).

## Never change without full understanding
- `server/coach-prompt.ts`: the goal-aware food philosophy and coaching voice.
- `server/onboarding.ts`: `completeOnboarding()` is the first impression.
- Billing: `server/routes/` payment flows and `server/scheduler/jobs/business.ts`.

## Working rhythm
One builder session. Never idle while there's work: when waiting on CI, take the next tester-visible fix. When blocked on the founder, post `BLOCKED:` with the exact action he must take. If you're started as the attacker, follow `docs/ATTACKER.md` only. Client words and phone numbers never go into the public repo.
