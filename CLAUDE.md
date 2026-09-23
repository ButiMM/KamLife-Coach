# KamLife Coach — Claude Code Instructions

## Standing orders (read first, every session)
- `docs/ORDERS.md` is the plan. It overrides every other doc.
- **Your work queue is `docs/QUEUE.md`.** Take the first unchecked item, build it as one pull request, then take the next. Don't wait to be told.
- Every PR: open the description with "What testers will notice:", add the label `attack:codex`, and comment `@codex attack this PR per docs/ORDERS.md §6` with the head SHA.
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
