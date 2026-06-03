# Human Tasks — Things Only You Can Do

These cannot be done in code. They pile up. Work through them when the product is stable.

---

## 🔴 URGENT

### Rotate the ElevenLabs API key
The key `sk_3f50bf258f61101366a456afd37cb4730d8b1f589d8ba8ee` was exposed in this codebase.
Go to ElevenLabs → Profile → API Keys → delete the old one → create a new one → update `ELEVENLABS_API_KEY` in Railway environment variables.

### Register your Information Officer with the SA Information Regulator
POPIA legally requires this. Without it, your privacy policy is just words on a page.
Go to → **inforegulator.org.za** → register. Free. Required.

---

## 🟡 IMPORTANT — Do Before You Start Marketing

### Fill in placeholders in the Privacy Policy
Go to `client/src/pages/privacy.tsx` and replace:
- `[Information Officer Name]` — the person legally responsible for data at KamLife (can be you)
- `[Company Registration Number]` — your business registration number from CIPC

### Create the privacy inbox
The privacy policy lists `privacy@kamlifecoach.co.za` as the official contact.
Create this email inbox (Google Workspace, or forward to your personal email).

### Sign Data Processing Agreements with Twilio and OpenAI
Both offer standard DPAs. If someone takes legal action over data, your defence depends on having contracts with your processors.
- Twilio DPA: twilio.com/legal/data-protection-addendum
- OpenAI DPA: platform.openai.com/docs/data-processing-addendum

### Set PROACTIVE_PAUSED=false in Railway
Currently `PROACTIVE_PAUSED=true` — all proactive messages (morning check-ins, evening nudges, weekly reports) are paused globally. When you're ready to go live with clients, change this to `false` in Railway environment variables.

---

## 🟢 WHEN READY

### Set VITE_HERO_VIDEO_URL in Railway build env vars
A compressed `.mp4` hero video will replace the gradient background on the landing page.
Compress to under 5MB, host it (Cloudinary or S3), then set `VITE_HERO_VIDEO_URL=https://your-video-url.mp4` in Railway build variables (not runtime — this is a Vite build-time variable).

### Upload exercise GIFs to your CDN
Set `MEDIA_BASE_URL` in Railway, then upload files to `MEDIA_BASE_URL/ex/<slug>.gif`.
Slugs needed: `squat`, `hip-thrust`, `leg-press`, `leg-curl`, `leg-extension`, `calf-raise`, `rdl`, `bulgarian-split-squat`, `chest-press`, `chest-fly`, `lat-pulldown`, `seated-row`, `face-pull`, `lateral-raise`, `shoulder-press`, `bicep-curl`, `tricep-pushdown`, `cable-kickback`, `push-up`, `plank`, `dead-bug`

### Create + upload portion-guide images
The bot's PORTION_CONTROL handler teaches the hand method in text — but clients need the visual (this is how Precision Nutrition, Noom, and MyPlate all do it). Make 3 reusable infographics (NOT per-client):
1. **The hand guide** — palm = protein, fist = veg, cupped hand = carbs, thumb = fats, with SA foods (chicken, pap, spinach, peanut butter)
2. **Lunch/dinner plate** — ½ veg, ¼ protein, ¼ carb, SA food shown
3. **Breakfast plate** — the structure you already used before (eggs/oats/fruit)

How: use ChatGPT/DALL·E for the *food photography* only, then add text labels in **Canva** (AI image gen spells text wrong — don't let it write "protein"). Then:
- Send these 3 to your current manual clients now (reuse for everyone)
- Upload to `MEDIA_BASE_URL/portions/hand-guide.png`, `plate-lunch.png`, `plate-breakfast.png`
- Tell Claude once uploaded — wiring them into the bot reply is a 3-line, goal-aware change

### Run npm run diagnose:voice in Railway shell
If ElevenLabs voice recaps are still not delivering to WhatsApp, run this in the Railway shell to diagnose the issue.

### Block the stale Railway agent branch
Branch `railway/code-change-5eCm_i` is from April 25. It is 6 weeks behind main and must never be merged.
Tell the Railway agent: do not create PRs from this branch. If a PR appears, close it immediately.

### Bookmark your dashboard
Your admin dashboard is at `yourapp.railway.app/login` (or `kamlifecoach.co.za/login`).
No link from the public site — clients cannot see it. Just bookmark it.

---

## 📋 ONGOING

### Test every WhatsApp message manually before marketing
Send yourself each flow: onboarding, food log, workout request, "show me squats", voice note, photo.
The bot is only as good as what clients experience in the first 5 minutes.

### Compile a list of what clients are actually saying
Every time a client says something unexpected or the bot responds badly — note it.
Bring it here and we fix it. Refinement is ongoing.
