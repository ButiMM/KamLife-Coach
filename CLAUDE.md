# KamLife Coach — Claude Code Instructions

## Git workflow
- **Always work directly on `main`.**
- Commit and push to `main` after every task. No feature branches.
- Never create a PR unless explicitly asked.

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
Slugs: `squat`, `hip-thrust`, `leg-press`, `leg-curl`, `leg-extension`, `calf-raise`,
`rdl`, `bulgarian-split-squat`, `chest-press`, `chest-fly`, `lat-pulldown`,
`seated-row`, `face-pull`, `lateral-raise`, `shoulder-press`, `bicep-curl`,
`tricep-pushdown`, `cable-kickback`, `push-up`, `plank`, `dead-bug`

## Handler pipeline order
Safety → Onboarding → POPIA → Subscription → Frustration → FoodLogMgmt →
EarlyCommands → Media → Workout → Steps → Water → FoodContext → Progress →
Misc → Lifecycle → GPT

## Never touch without full understanding
- `server/coach-prompt.ts` — any change to food philosophy or coaching voice must preserve goal-aware logic (fat_loss gets portion context, muscle_gain gets encouragement)
- `server/onboarding.ts` — completeOnboarding() is the first impression
- Payment/billing flows in `server/routes/` and `server/scheduler/jobs/business.ts`
