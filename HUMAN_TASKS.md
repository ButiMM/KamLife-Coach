# KamLife Coach — Your Task List (Human Tasks Only)

Everything code-side is done or tracked. These are the tasks only YOU can do.
Work top to bottom. Tick them off. Come back to Claude when you're stuck or done.

Updated: 10 June 2026 — after Twilio upgrade + live sandbox testing.

---

## 🔴 TODAY — Security & basics (under 30 minutes total)

### 1. Rotate the ElevenLabs API key (5 min)
The current key was exposed in the codebase. Anyone with repo access can burn your credits.
- [ ] elevenlabs.io → Profile → API Keys → delete the old key → create new
- [ ] Railway → Variables → update `ELEVENLABS_API_KEY`

### 2. Set APP_URL in Railway (2 min)
Payment links and renewal messages currently fall back to a placeholder domain.
- [ ] Railway → Variables → add `APP_URL=https://kamlife-coach-production.up.railway.app`
- [ ] When your real domain is live, change it to `https://kamlifecoach.co.za`

### 3. Verify PayFast passphrase (2 min)
- [ ] Railway → Variables → confirm `PAYFAST_PASSPHRASE` exists and matches your PayFast dashboard

---

## 🟡 THIS WEEK — WhatsApp Business API (the big unlock)

### 4. Meta Business Manager (15 min + waiting)
- [ ] business.facebook.com → Create account → use your business details
- [ ] Verify the business if Meta asks (can take 1–3 days)

### 5. Register your own SA WhatsApp number (30 min + approval wait)
- [ ] Twilio Console → Messaging → Senders → WhatsApp senders → "Sign up a WhatsApp number"
- [ ] Follow the embedded Meta signup (connects your Meta Business Manager)
- [ ] Use a dedicated SA number — NOT your personal number. Buy one through Twilio if needed.
- [ ] Meta approval: typically 2–5 business days

### 6. Submit the 8 message templates (45 min)
Twilio Console → Content Template Builder. Coach K can't message anyone FIRST
(outside the 24-hour reply window) without these pre-approved by Meta.

- [ ] `morning_checkin` — "Morning {{1}}. What's for breakfast today? One line is all I need."
- [ ] `evening_accountability` — "{{1}}, how did today go? Tell me your last meal before bed."
- [ ] `workout_reminder` — "{{1}}, training day. Your session is ready — reply *workout* to see it."
- [ ] `missed_session` — "{{1}}, yesterday's session didn't happen. Today is the reset — reply *workout*."
- [ ] `weekly_summary` — "{{1}}, week {{2}} done. Reply *progress* to see where you stand."
- [ ] `milestone_celebration` — "{{1}} — {{2}} sessions completed. That's a real milestone. Keep going."
- [ ] `re_engagement` — "{{1}}, been {{2}} days — no lecture. Reply *hi* and we pick up where you left off."
- [ ] `subscription_renewal` — "{{1}}, your subscription renews in {{2}} days. Reply *pay* if your details changed."

Tips: category UTILITY for renewal, MARKETING for the rest. Keep them exactly this
plain — Meta rejects anything that looks spammy.

### 7. Update Railway when approved (5 min)
- [ ] `TWILIO_WHATSAPP_NUMBER` → your new SA number (+27XXXXXXXXX)
- [ ] `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` stay the same
- [ ] Tell Claude — template sending needs a quick wiring check before going live

### 8. Turn on proactive messages (1 min — ONLY after #7)
- [ ] Railway → Variables → delete `PROACTIVE_PAUSED` (or set to `false`)
- [ ] Unlocks: morning check-ins, evening accountability, win-back, renewals
- [ ] Billing alerts already flow even while paused — that's by design

---

## 🟡 THIS WEEK — Legal/POPIA (one hour, once)

### 9. Register as Information Officer (15 min, free)
- [ ] inforegulator.org.za → Information Officer registration → register yourself for KamLife
- [ ] Legally required before commercially handling health-related personal data

### 10. Create the privacy email (10 min)
- [ ] Create `privacy@kamlifecoach.co.za` (Google Workspace or forward to personal email)
- [ ] Your privacy policy promises this address exists — it must receive mail

### 11. Fill the privacy policy placeholders (10 min)
`client/src/pages/privacy.tsx` still has two blanks:
- [ ] `[Information Officer Name]` — can be you
- [ ] `[Company Registration Number]` — from CIPC
- [ ] Or just tell Claude both values — Claude fills and pushes

### 12. Sign the DPAs (10 min, free, click-through)
- [ ] OpenAI: platform.openai.com/docs/data-processing-addendum
- [ ] Twilio: twilio.com/legal/data-protection-addendum

---

## 🟢 WHEN READY — Polish

### 13. Exercise GIFs (optional — static images work today)
- [ ] Host them (Cloudflare R2 / Bunny / S3), set `MEDIA_BASE_URL` in Railway
- [ ] Upload to `MEDIA_BASE_URL/ex/<slug>.gif` — slugs: squat, hip-thrust, leg-press,
      leg-curl, leg-extension, calf-raise, rdl, bulgarian-split-squat, chest-press,
      chest-fly, lat-pulldown, seated-row, face-pull, lateral-raise, shoulder-press,
      bicep-curl, tricep-pushdown, cable-kickback, push-up, plank, dead-bug
- [ ] Tell Claude to flip the uploaded-slugs list on

### 14. Portion-guide images — ✅ ALREADY MADE, just need uploading
Two reusable infographics (same two for every client):
1. "WHAT COUNTS AS WHAT" hand card → `hand-guide.png`
2. "STOP COUNTING CALORIES / BUILD BETTER PLATES" → `plate-guide.png`
- [ ] Now (no code): send both to current manual clients directly on WhatsApp
- [ ] For the bot: upload to `MEDIA_BASE_URL/portions/` → tell Claude (1-line wire-up)

### 15. Landing page hero video (optional)
- [ ] Compress an .mp4 under 5MB, host it, set `HERO_VIDEO_URL` in Railway Variables (runtime — no rebuild needed; `VITE_HERO_VIDEO_URL` is a build-time var baked into the bundle, so the server now reads `HERO_VIDEO_URL` at request time and serves it to the landing page)

### 16. Test PayFast end to end (15 min)
- [ ] R1 sandbox payment from a test account
- [ ] Confirm subscription flips to active and the welcome message arrives

### 17. First 5–10 real users
- [ ] Friends/family/status followers — sandbox or new number
- [ ] Watch what they actually send Coach K — every confusion is a fix
- [ ] Collect the first real before/after — that's your marketing engine

### 18. Housekeeping
- [ ] Stale Railway branch `railway/code-change-5eCm_i` (April) must never merge — close any PR from it
- [ ] Bookmark your admin dashboard: `kamlife-coach-production.up.railway.app/login`

---

## 📋 ONGOING

- Test every flow yourself before marketing: onboarding, food log (text/photo/VOICE),
  workout, "show me squats", "gonna have X for lunch" → "ate it", "dinner same as lunch"
- Note every weird bot reply — bring it to Claude. Refinement never stops.

---

## Quick reference — what's LIVE right now
- Twilio account: funded and active ✅
- Sandbox number: +1 415 523 8886 (joined testers only, 24h reply window, buttons
  show as numbered lists — real tappable buttons come with your own approved number)
- Railway: kamlife-coach-production.up.railway.app — auto-deploys from `main`
- Proactive messages: PAUSED (by design until your own number is approved)
- Payments: PayFast wired, untested end to end in production
