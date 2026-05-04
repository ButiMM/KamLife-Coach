# KamLife Coach — Active Backlog

> This file is the single source of truth for what's open, what's done, and what's next.
> Read this at the start of every session before touching any code.

---

## 🔴 BLOCKING — Do before launch

### 1. Exercise GIFs — upload & activate
**Status:** System built and wired. Waiting on media hosting.

What still needs to happen (owner action):
1. Host GIF files on any public CDN (Cloudflare R2, Backblaze B2, or Railway static)
2. Name files exactly: `squat.gif`, `bench-press.gif`, `deadlift.gif`, `hip-thrust.gif` etc. (slugs are in `server/exercise-media.ts`)
3. Upload portion plate images: `breakfast.jpg`, `lunch.jpg`, `dinner.jpg`
4. Set Railway env var: `MEDIA_BASE_URL=https://your-cdn.com`

Everything activates automatically once `MEDIA_BASE_URL` is set. No code changes needed.

**Exercise slugs reference:** see `server/exercise-media.ts` — EXERCISE_SLUGS constant (70+ exercises)
**Portion image dimensions:** Use 800×600 minimum. JPEG is fine.

---

### 2. Environment variables — set in Railway
All of these need to be set before going live:

| Env Var | Where to get it |
|---|---|
| `TWILIO_AUTH_TOKEN` | Twilio dashboard → Account → API keys |
| `TWILIO_ACCOUNT_SID` | Twilio dashboard |
| `TWILIO_WHATSAPP_NUMBER` | Your Twilio WhatsApp number (e.g. +27XXXXXXXX) |
| `PAYFAST_MERCHANT_ID` | PayFast dashboard → Integration |
| `PAYFAST_MERCHANT_KEY` | PayFast dashboard |
| `OPENAI_API_KEY` | OpenAI platform |
| `COACH_ALERT_PHONE` | The owner's WhatsApp number for escalation alerts |
| `ELEVENLABS_API_KEY` | ElevenLabs dashboard (for Sunday voice recaps) |
| `ELEVENLABS_VOICE_ID` | Your cloned voice ID in ElevenLabs |
| `MEDIA_BASE_URL` | Your CDN root URL (see GIF task above) |
| `APP_URL` | Your Railway app public URL (needed for voice recap audio delivery) |

---

## 🟡 NEXT UP — High value, do soon

### 3. ElevenLabs Sunday voice recap
**Status:** Code complete. Blocked on env vars.
Set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in Railway — recap fires automatically every Sunday 10pm SAST.

### 4. PayFast trial-to-paid flow
**Status:** Code present. Need to verify IPN webhook URL is registered in PayFast dashboard.
PayFast IPN URL: `https://your-app.railway.app/payfast/itn`

---

## 🟢 DONE — Recently completed

- [x] 40+ product audit gaps fixed (safety, scheduler, UX, business logic)
- [x] Acute medical emergency handler (chest pain → 10177)
- [x] Medication/diagnosis disclaimer
- [x] Cancel confirmation two-step flow
- [x] Refund handler
- [x] Injury note on workout delivery
- [x] Recomposition dinner carbs fix (rest vs training day)
- [x] Step streak query window extended to 90 days (was 14)
- [x] `claimDailySlot()` race condition fixed (atomic DB insert)
- [x] Duplicate escalation deduplication
- [x] SLA breach alert env var fix (`COACH_ALERT_PHONE`)
- [x] Pause resume notification
- [x] `DAMAGE_RECOVERY` positive reset handler
- [x] Exercise GIF system built (`server/exercise-media.ts`)
- [x] Portion plate images with SA-specific captions (pap/samp/sweet potato/morogo)
- [x] `[MEDIA:url]` parsing in whatsapp.ts → TwiML `<Body>` + `<Media>` delivery
- [x] Workout delivery attaches first exercise GIF automatically
- [x] Exercise demo handler ("show me squat", "how to bench press", "squat gif")
- [x] Meal plate image handler ("breakfast plate", "lunch portions", "dinner guide")
- [x] Instant diabetes food alert — white pap/rice/bread/sugary drinks → swap suggestion, no GPT

---

## 📋 KNOWN GAPS — Not yet prioritised

- [ ] YouTube tutorial links in workout text are search URLs not real videos — replace with actual exercise video URLs or remove
- [ ] No push notification when trial expires at midnight (only when client next messages)
- [ ] Admin dashboard: no way to bulk-message all active users
- [ ] Shopping list not auto-refreshed when user changes budget tier mid-programme
- [ ] Progress photo comparison (before/after) is stored but no diff description is sent back automatically

---

## 🗂 ARCHITECTURE NOTES (for Claude)

- **Push directly to `main`** — no PRs, no feature branches
- **Do not use GPT for anything that has a hardcoded answer** — equipment alternatives, food substitutions, portion guide, supplement guide, store advice, injury modifications are all constants in `server/constants.ts`
- **`server/exercise-media.ts`** — GIF and portion image URL builder. Null-safe: returns null if `MEDIA_BASE_URL` not set
- **`[MEDIA:url]`** marker in reply strings — parsed by `server/routes/whatsapp.ts` → becomes TwiML `<Media>` tag
- **`claimDailySlot()`** in scheduler — atomic, use this for all proactive messages
- **ElevenLabs recap** — `server/weekly-recap.ts`, fires Sunday cron at `0 20 * * 0` (20:00 UTC = 22:00 SAST)
- **PayFast** — ITN webhook at `/payfast/itn`, handles subscription activation
- **Food logging flow** — SA food scanner first (hardcoded, instant), GPT fallback only if scanner finds nothing
