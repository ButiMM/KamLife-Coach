# KamLife Coach — Claude Code Instructions

## Standing orders (read first, every session)
- **The founder's Claude capacity is the scarcest resource (25 Sep: about half the week left). Spend it only on moving rows:**
  - one builder session only (lanes 2 and 3 run *after* lane 1 in the same session, unless the founder opens more)
  - status comments of 10 lines or fewer, with no long narration
  - don't re-run full suites locally when CI will run them
  - read only the files the row needs
  - batch fixes into one push
  - don't re-explain the plan back
  - if a task can wait for CI, wait with a scheduled check-in, not by exploring
- **Never go idle while there's work (25 Sep).** Nothing outside this session can wake you. The watch and the CTO can only write in GitHub. So before you ever end a turn:
  1. Re-read the latest comments on #391 and the top of #280 (CTO orders and alerts land there).
  2. If the queue has an item you can work, start it now.
  3. If you're only waiting (CI, a merge, credits), **schedule your own check-in in 15-20 minutes**, and at that check-in repeat from step 1.

  End a turn with nothing scheduled only when the queue is empty **and** nothing is pending.
- **Two roles share this file.** If this session was started as the **attacker**, follow `docs/ATTACKER.md` only: never build, fix or merge. Otherwise you are the **builder**, and everything below applies. Since 25 Sep, **only `switch` and `[harm]` PRs need an attack** (done by the CTO, or Codex when it has capacity). Every other PR merges on green tests, the ratchet and, where labelled, the replay gate. Don't wait for attacks on them, and don't call @codex on them.
- **The product is the goal (`docs/ORDERS.md` §0, founder 24 Sep night).**
  - Pick work from `docs/COVERAGE.md`: live harm first, then the least complete row with the most tester impact.
  - Every PR description carries `Coverage row:` and `Reuses:` lines.
  - Before writing anything new, search the repo for code that already does the job, and finish or reuse it. Never start a foundation while one for the same job sits unwired.
  - Answering attacks deeper and deeper in one spot is not progress. Map each finding to a row, and move the product forward across the map.
- **When you're blocked on the founder** (a secret, an account, a decision), post a PR comment starting `BLOCKED:` with the exact action he must take. The watch puts it at the top of the status issue. Keep working on something else meanwhile.
- **See a blind spot? File it.** Anything that could hurt the product or company and that nobody asked about gets an issue labelled `blind-spot`, one line of evidence, and the row it touches. That's part of your job, not a distraction from it.
- **Before asking the founder anything, check `docs/SYSTEM.md` and the repo.** Asking him for something already recorded or findable is a failure. Add anything durable you learn to `docs/SYSTEM.md`.
- `docs/ORDERS.md` is the plan. It overrides every other doc.
- **The watch merges for you (24 Sep).** When a PR's checks are all green, the mouth ratchet passes, and its Codex attack is answered (or 45 minutes passed with no attack), `.github/workflows/cto-watch.yml` merges it within minutes of the tests finishing. Don't wait on it. Add the label `hold` to stop a PR auto-merging. Label any PR that moves real testers onto the new coach `switch`. **Ship as finished (26 Sep):** the switch is on for everyone and deletes the old code in the same PR, and it merges on a green replay gate plus the reach check. **Add the label `final`** once its other checks are green: only that run uses the strong (paid) judge, and the watch merges a switch only on a green gate run started after `final` (#467). There's no founder-only step and no waiting for an attack; the CTO attacks after merge. After it merges, send testers a short "what's new" note through the broadcast path (#442), with no approval needed.
- **Don't call Codex on docs-only PRs** (status, queue, docs). The watch merges those without an attack. Codex's review capacity is limited; spend it on `[core]`, `[harm]` and `switch` PRs.
- **Run three worktrees in parallel, all day:** **A** (attack follow-ups and security), **B1** (#270 gate, then #293 Coach Health) and **B2** (#271 client record, then #272 understanding and composer). File ownership rules in `docs/ORDERS.md` apply between them. Never let one lane wait on another.
- **Test diet (24 Sep):** code the new core will replace gets a **minimal** failing-then-passing test, with no new red-on-revert harness. Heavy acceptances and revert harnesses are only for code that survives: plumbing, safety, billing, and the new core. For coaching behaviour, add a **gate case** (a journey in `docs/TESTER-EXPERIENCE.md`), not a handler acceptance. Script code is already 57k lines against 75k of server code.
- **No new model calls outside the new core.** `model_call_sites` is now in the mouth ratchet.
- **Keep PRs small** (under ~600 changed lines where possible), so a test run and an attack each take minutes, not hours.
- **Reuse, don't rebuild; replace, don't add.** `docs/COMPONENTS.md` says what the new core calls as tools (food data, targets, day maths, programmes, vision, voice) and what each switch PR deletes. When you delete a file listed in `docs/delete-list.txt`, remove its line in the same PR.
- **Lane B is the priority (CTO, 24 Sep).** Finish and merge the lane A PRs already open; start no new lane A work. All new effort goes to lane B in `docs/QUEUE.md`, in order. Old-pipeline bugs become gate cases for the new core, not new patterns.
- **Builder lanes (25 Sep):** if you were started as "builder lane 2" or "builder lane 3", work only that lane's rows in `docs/ORDERS.md` (FULL PRODUCT, IN PARALLEL). Otherwise you are lane 1. No row is ever parked as "after launch".
- **Your work queue is `docs/QUEUE.md`.** It has two lanes. If no other session is on lane B (no open or recent branch for #270), run lane B yourself in parallel, in a separate worktree or subagent, starting with #270. Nobody will tell you to; this line is the instruction. In each lane, take the first unchecked item, build it as one pull request, then take the next.
- Every PR: open the description with "What testers will notice:", add the label `attack:codex`, and comment `@codex attack this PR per docs/ORDERS.md §6` with the head SHA.
- **CI is free again (public repo).** GitHub runs the full suite, including the database suite, on every PR push. **Merge when GitHub checks are green**, attacks are answered under the merge standard, and the mouth ratchet passes. Batch fixes into one push anyway: every push restarts the ~47-minute run.
- **Merge standard:** see `docs/ORDERS.md` §6. If a Codex finding is not worse than current `main`, open a follow-up issue labelled `harm` (or `core`), add it to the top of `docs/QUEUE.md`, reply `ANSWER: follow-up #N, not a regression against main`, and merge. After two attack rounds, merge with follow-ups.
- If `main` has moved and your PR conflicts, rebase it first; that outranks everything except answering attacks.
- **Priority order, checked before every new task:** (1) answer every open Codex attack on your PRs, (2) merge every PR whose attack is answered and whose tests pass, (3) only then start the next queue item. Nothing reaches testers until it merges, so an unanswered attack outranks new work.
- **Never sit idle waiting for a review.** After opening a PR, start the next queue item on a new branch. Come back when Codex attacks.
- Answer every Codex attack with a comment starting `ANSWER`: the fix commit, or why it doesn't apply.
- Merge when tests pass (and the gate, once #270 exists) and the attack is answered. If Codex hasn't attacked within 45 minutes of your last push, you may merge; any later finding goes to the top of `docs/QUEUE.md`.
- The CTO watch (`.github/workflows/cto-watch.yml`) comments on your PRs when something is missing. Treat those comments as orders.
- After merging: tick the item in `docs/QUEUE.md` and append a line to `docs/STATUS.md`.

## Git workflow
- **Never push to `main`.** `main` deploys straight to production (Railway), so anything pushed there reaches testers with no checks.
- Every change: create a branch from `main`, commit there, push the branch, and open a pull request.
- One task per pull request. Keep them small.
- Every pull request description states: what changed, why, how it was verified, and lines added / removed.
- Do not merge your own pull request until the tests pass on it and the other builder has reviewed it.
- Never write "fixed" or "done" in a commit or pull request unless a test shows it.
- These rules override any older instruction in this repo that says otherwise.

## Stack
- TypeScript / Node.js / Express — deployed on Railway
- PostgreSQL + Drizzle ORM
- WhatsApp via Twilio (`\n\n---\n\n` splits into separate WA messages)
- SMS fallback via `sendCriticalAlert()` — requires `TWILIO_SMS_NUMBER` env var

## Key env vars (Railway)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`
- `TWILIO_SMS_NUMBER` — SMS fallback for critical payment alerts
- `MEDIA_BASE_URL` — CDN root for exercise GIFs and portion images
- `PAYFAST_MERCHANT_ID`, `APP_URL`
- `PROACTIVE_PAUSED=true` — global killswitch for all proactive messages

## GIF setup (pending human task)
Set `MEDIA_BASE_URL` in Railway, then upload files to `MEDIA_BASE_URL/ex/<slug>.gif`.
IMPORTANT final step: gifs only serve once each uploaded slug is added to
`UPLOADED_GIF_SLUGS` in `server/exercise-media.ts` (tell Claude — 1-line change).
Without it the code keeps using the safe fallback and uploads do nothing.
Slugs: `squat`, `hip-thrust`, `leg-press`, `leg-curl`, `leg-extension`, `calf-raise`,
`rdl`, `bulgarian-split-squat`, `chest-press`, `chest-fly`, `lat-pulldown`,
`seated-row`, `face-pull`, `lateral-raise`, `shoulder-press`, `bicep-curl`,
`tricep-pushdown`, `cable-kickback`, `push-up`, `plank`, `dead-bug`

## Handler pipeline order
Safety → Onboarding → POPIA → Subscription → Frustration → **Normalizer** → FoodLogMgmt →
EarlyCommands → Media → Workout → Steps → Water → FoodContext → Progress →
Misc → Lifecycle → GPT

### Normalizer (front-door brain)
`classifyIntent` (gpt-4o-mini, fired in background at message entry) classifies AND
rewrites messy phrasing into the canonical forms the deterministic handlers expect —
"I want to go into a building phase" → "change my goal to muscle gain". Applied in
routes.ts before FoodLogMgmt. High-confidence action intents only; numbers in the
canonical must exist in the original (hallucination brake); on timeout/error the
original message proceeds unchanged. Killswitch: `NORMALIZER=off` in Railway.
QUESTION classification also guards the step logger from eating questions.
Voice transcripts get normalized too — media recursion re-enters handleMessage as text.

## Never touch without full understanding
- `server/coach-prompt.ts` — any change to food philosophy or coaching voice must preserve goal-aware logic (fat_loss gets portion context, muscle_gain gets encouragement)
- `server/onboarding.ts` — completeOnboarding() is the first impression
- Payment/billing flows in `server/routes/` and `server/scheduler/jobs/business.ts`
