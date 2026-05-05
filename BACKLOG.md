# KamLife Coach — Active Backlog

> Single source of truth. Read this at the start of every session before touching code.
> Rule: no overbuilding. Every item must justify its complexity with direct user value.

---

## 🔴 BLOCKING — Owner action required before launch

### 1. Set environment variables in Railway
| Env Var | Where to get it |
|---|---|
| `TWILIO_AUTH_TOKEN` | Twilio dashboard → Account → API keys |
| `TWILIO_ACCOUNT_SID` | Twilio dashboard |
| `TWILIO_WHATSAPP_NUMBER` | Your Twilio WhatsApp number (e.g. +27XXXXXXXX) |
| `PAYFAST_MERCHANT_ID` | PayFast dashboard → Integration |
| `PAYFAST_MERCHANT_KEY` | PayFast dashboard |
| `OPENAI_API_KEY` | OpenAI platform |
| `COACH_ALERT_PHONE` | Owner's WhatsApp number for escalation alerts |
| `ELEVENLABS_API_KEY` | ElevenLabs dashboard (Sunday voice recaps) |
| `ELEVENLABS_VOICE_ID` | Cloned voice ID in ElevenLabs |
| `MEDIA_BASE_URL` | CDN root URL for GIFs and plate images |
| `APP_URL` | Railway public URL (needed for voice recap audio) |

### 2. Upload media assets
1. Upload exercise GIFs to: `MEDIA_BASE_URL/ex/<slug>.gif` (slug list in `server/exercise-media.ts`)
2. Upload portion plate images: `MEDIA_BASE_URL/portions/breakfast.jpg`, `lunch.jpg`, `dinner.jpg`
3. Minimum image size: 800×600, JPEG fine

### 3. Register PayFast IPN webhook
In PayFast dashboard, set the notification URL to: `https://your-app.railway.app/payfast/itn`

---

## 🟡 NEXT UP — Code work, do in order

### 4. Progress photo scalability (when user count > 2,000)
**Issue:** Photos stored as base64 text in DB (`photo_base64` column). Fine now, will hurt at scale.
**Fix when ready:** Migrate to object storage (Cloudflare R2 or similar), store URL pointer in DB.
**Do not touch yet** — not a launch blocker at current user count.

### 5. Workout programme restructure (owner confirmed priority)
**Spec from owner:**
- 2-day: Full body (men and women, separate exercises)
- 3-day: Full body (men and women, separate exercises)
- 4-day: Upper / Lower / Upper / Lower split
- All gender-specific — different exercise selection and rep ranges for men vs women
- **File to update:** `server/programme.ts`
- **Do this as a dedicated session** — it's a full rebuild of the programme logic

### 6. YouTube links in workout text
**Issue:** Exercise video links are YouTube search URLs, not direct videos.
**Fix:** Remove links and rely on GIFs (already built in `server/exercise-media.ts`). Or source real video URLs.
**File:** `server/programme.ts` — search for `youtube.com/results?search_query=`

---

## 🟢 DONE — Complete and on main

**Third-party review items (reviewed 2026-05-04):**
- [x] Voice pipeline timeouts — `withTimeout()` used on every AI/media call with stage labels
- [x] Voice stage telemetry — `logMediaFailure()` + `voiceStage` tracking on all error paths
- [x] Monthly cohort snapshot — fires 1st of month, 2am SAST (`server/scheduler.ts` line ~3765)
- [x] Comeback rescue — re-engages clients silent 3–7 days (`server/scheduler.ts` line ~3288)
- [x] Daily Win loop — Mon–Sat 7:30pm SAST, sends one concrete win + one tomorrow action to active clients only
- [x] Shopping list: "diet plan" requests now redirect to goal-adjusted shopping list with explanation
- [x] Shopping list: expanded triggers (grocery, groceries, what to buy, weekly shop, etc.)
- [x] Shopping list: client list analysis prompt tightened — structured response, under 120 words, SA-specific
- [x] 7-day meal plan preserved as opt-in via "7 day meals" command

**Product audit (prior sprint):**
- [x] Acute medical emergency handler (chest pain → 10177)
- [x] Medication/diagnosis disclaimer
- [x] Cancel confirmation two-step flow
- [x] Refund handler
- [x] Injury note on workout delivery
- [x] Recomposition dinner carbs fix (rest vs training day)
- [x] Step streak 90-day query window
- [x] `claimDailySlot()` race condition fixed (atomic insert)
- [x] Duplicate escalation deduplication
- [x] Pause resume notification
- [x] DAMAGE_RECOVERY positive reset handler
- [x] Exercise GIF system (`server/exercise-media.ts`, 70+ exercises)
- [x] Portion plate images with SA-specific captions (pap/samp/sweet potato/morogo/pilchards)
- [x] `[MEDIA:url]` marker → TwiML `<Body>` + `<Media>` delivery in `server/routes/whatsapp.ts`
- [x] Exercise demo handler ("show me squat", "how to bench press", "squat gif")
- [x] Meal plate image handler ("breakfast plate", "lunch portions")
- [x] Instant diabetes food alert (white pap/rice/bread/sugary drinks → no GPT)

**All Finals from builder brief (1–14):**
- [x] Equipment alternatives, food substitutions, portion guide, store advice, injury programmes
- [x] Supplement guide, water logging, body measurements, week 4 check-in
- [x] Language detection, POPIA consent, delete my data, banned phrases
- [x] SA food database: 440 foods

---

## 📋 DEFERRED — Good ideas, not now

These are real gaps from the third-party review. Deferred because they add complexity without proportional user value at current scale:

| Item | Why deferred |
|---|---|
| routes.ts modularisation (~6.7k lines) | High refactor risk, no user-facing value |
| Scheduler reason codes/campaign tagging | Ops tooling, not revenue |
| Integration tests for media endpoints | Important, not blocking |
| Weekly shareable progress card | New feature, needs design decisions |
| Referral challenge trigger | Nice to have, not urgent |
| WhatsApp channel abstraction layer | Pre-emptive architecture, not needed yet |

---

## 🗂 ARCHITECTURE NOTES (for Claude — read before coding)

- **Push directly to `main`** — no PRs, no feature branches
- **No GPT for hardcoded answers** — equipment, food substitutions, portion guide, supplements, store advice, injuries are all in `server/constants.ts`
- **`server/exercise-media.ts`** — GIF/image URL builder. Returns null if `MEDIA_BASE_URL` unset. Safe to call anywhere.
- **`[MEDIA:url]`** in reply strings → parsed by `server/routes/whatsapp.ts` → TwiML `<Media>` tag
- **`claimDailySlot(clientId, jobKey)`** in scheduler — atomic daily gate. Use for every proactive send.
- **ElevenLabs recap** — `server/weekly-recap.ts`, Sunday `0 20 * * 0` UTC (10pm SAST)
- **PayFast** — ITN at `/payfast/itn`
- **Food logging flow** — SA food scanner (instant, no GPT) → GPT fallback only if scanner finds nothing
- **Scale inflection points** — progress photo migration needed at ~2k users; read replicas at ~10k
