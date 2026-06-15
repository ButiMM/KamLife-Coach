# KamLife Coach — Manual Testing Checklist

Run these tests by messaging the bot from your own WhatsApp number.
Mark each ✅ pass / ❌ fail / ⚠️ partial in the Notes column as you go.
Aim to cover 2–3 sections per day over 4–5 days.

_Last updated: 15 June 2026 — refreshed regression checks (R1, R7–R12) and resolved-issues list after the workout-delivery, food-question, restaurant, and weight-comparison fixes._

---

## Day 1 — Core voice & single-word commands

| # | What to send | Expected bot response | Notes |
|---|---|---|---|
| 1 | Voice note saying "Workout" (one word) | Your full workout programme — NOT "I only caught one word" | |
| 2 | Voice note saying "Done" (one word) | Session logged confirmation | |
| 3 | Voice note saying "Menu" (one word) | Full menu options | |
| 4 | Voice note saying "Steps" (one word) | Step logging or step info | |
| 5 | Voice note saying "I need help with my meals" (full sentence) | GPT nutrition advice | |
| 6 | Voice note that is total silence / 2 seconds | "Couldn't make it out — too quiet or too short" message | |
| 7 | Voice note with only background noise | Fail message asking to type | |
| 8 | Send 3 blank/noise voice notes in a row | Third attempt triggers escalation: "Please type your message" | |

---

## Day 1 — Onboarding simulation

| # | What to send | Expected bot response | Notes |
|---|---|---|---|
| 9 | `hi` | Welcome menu with options | |
| 10 | `menu` | Full menu with numbered options | |
| 11 | `help` | Same menu as above | |
| 12 | `my targets` | Calorie + protein + steps targets | |
| 13 | `stats` | Same as targets | |
| 14 | `why` | Explanation of why your specific plan works | |

---

## Day 2 — Workout delivery

| # | What to send | Expected bot response | Notes |
|---|---|---|---|
| 15 | `workout` | Today's session with exercises | |
| 16 | `1` | Same as "workout" | |
| 17 | `done` | Session logged, streak update | |
| 18 | `workout` again after done | "Today's session is done ✅" with overload note | |
| 19 | `too hard — modify` | Modified version with scale-down instructions | |
| 20 | `skip today` | Rest day logged, "never miss twice" reminder | |
| 21 | `tomorrow's session` or button tap | Next day's workout shown | |
| 22 | `streak` | Workout streak and 7-day consistency | |
| 23 | Tell bot you have dumbbells only | Programme updates to dumbbell mode | |
| 24 | `back at the gym` | Holiday mode cleared, back to normal programme | |
| 25 | Tell bot "on holiday" or "no gym this week" | Equipment question asked (gym / dumbbells / nothing) | |
| 26 | Reply "2 — dumbbells" to equipment question | Holiday session delivered with dumbbell exercises | |

---

## Day 2 — Food logging

| # | What to send | Expected bot response | Notes |
|---|---|---|---|
| 27 | "2 eggs and pap for breakfast" | Calories + protein logged, running total shown | |
| 28 | "chicken and rice for lunch" | Meal logged, totals updated | |
| 29 | Photo of a meal | Food analysis with kcal + protein estimate | |
| 30 | Photo of a meal + photo of a second meal (album) | First photo analysed in detail; extra photos shown as compact bullet list only (no repeated coaching advice) | |
| 31 | `calories` | Today's calorie total vs target | |
| 32 | `calories left` | Remaining kcal and protein for today | |
| 33 | `same as yesterday` | Repeats most recent previous day meal | |
| 34 | "dinner same as lunch" | Copies today's lunch entry as dinner | |
| 35 | `log food` or `3` | Prompt asking what you ate | |

---

## Day 3 — Steps & walking

| # | What to send | Expected bot response | Notes |
|---|---|---|---|
| 36 | "walked 8000 steps" | Steps logged, progress vs target | |
| 37 | Screenshot of Samsung Health / Google Fit steps | Steps extracted from screenshot and logged | |
| 38 | "how many calories did I burn walking?" | Today's step count pulled, kcal estimated, key point: calorie target already includes activity — don't eat back | |
| 39 | "how do my steps affect my total calories?" | Same as above | |
| 40 | "calories burned from steps today" | Same as above | |
| 41 | "how many calories do I burn walking 10000 steps" | Calculation shown + activity target explanation | |
| 42 | `steps target 10000` | Step target updated to 10,000 | |
| 43 | "which app should I use for steps?" | Device-specific recommendations (Samsung Health / Google Fit / Apple Health) | |
| 44 | "my phone is in the car and counting steps" | Vehicle vibration explanation + pocket tip | |

---

## Day 3 — Weight logging & safety

| # | What to send | Expected bot response | Notes |
|---|---|---|---|
| 45 | "I weigh 85kg" | Weight logged, change vs start noted | |
| 46 | Photo of a scale showing a number | Number extracted and logged | |
| 47 | "I weigh 82kg" (after 85) | Weight change noted with pace assessment | |
| 48 | Log a weight drop of >1kg/week | Warning message about rate being too fast (health-aware) | |
| 49 | `progress` | Full progress summary: weight trend, pace assessment, workout streak, food avg | |

---

## Day 4 — Portion control & nutrition

| # | What to send | Expected bot response | Notes |
|---|---|---|---|
| 50 | `portions` | Portion guide text + BOTH Cloudinary images sent as separate cards | |
| 51 | "how do I measure my food?" | Same as portions | |
| 52 | "how much should I eat?" | Portion method explained + both images | |
| 53 | `meal plan` | Personalised 3-day meal plan | |
| 54 | `shopping list` | Budget-appropriate shopping list | |
| 55 | `meal prep` | Step-by-step batch cook guide | |
| 56 | "what should I avoid eating?" | Goal-specific foods-to-avoid list | |
| 57 | "can I drink alcohol?" | Goal-aware alcohol guidance | |
| 58 | "I had 3 beers last night" | Beers logged as kcal, damage control advice | |
| 59 | "I ate badly today" / "I binged" | Compassionate recovery response, no shame | |

---

## Day 4 — Supplements & specific guides

| # | What to send | Expected bot response | Notes |
|---|---|---|---|
| 60 | `supplements` | Full goal-appropriate supplement guide | |
| 61 | "should I take creatine?" | Creatine-specific answer (yes, 5g/day, monohydrate only) | |
| 62 | "what about whey protein?" | Whey guidance based on your protein target | |
| 63 | "I took my vitamins" | Supplement logged ✅ | |
| 64 | "what can I order at Nando's?" | Nando's smart order guide | |
| 65 | "what to eat at KFC?" | KFC guide (remove skin tip) | |
| 66 | "I don't like pilchards, what else?" | Protein swap alternatives at your budget | |
| 67 | "I want to swap my energy drink" | Energy drink alternatives | |

---

## Day 5 — Health & life situations

| # | What to send | Expected bot response | Notes |
|---|---|---|---|
| 68 | "I have a runny nose" | Above-neck rule: light training okay | |
| 69 | "I'm sick with the flu" | No training today, nutrition advice, programme saved | |
| 70 | "load shedding tonight, can't cook" | No-power meal + home workout options | |
| 71 | "period cramps today" | Cycle-aware response, reduced training okay | |
| 72 | "ovulating, my hormones are messing with me" | Hormonal context acknowledged, gentle coaching | |
| 73 | "PMDD is bad this week" | PMDD acknowledged, self-care focus | |
| 74 | "I work nightshift" | Shift worker guidance | |
| 75 | "it's not safe to walk outside in my area" | Indoor step alternatives | |
| 76 | "month end, I'm broke" | Cheap meal options under R30 | |
| 77 | "I had a funeral this week" | Bereavement response — programme waits | |
| 78 | "I'm so tired, everything is sore" (after 4+ sessions) | Over-training response: rest today | |
| 79 | "I want to lose my belly / mkhaba" | Spot-reduction myth explained, correct approach given | |

---

## Day 5 — Payment & subscription

| # | What to send | Expected bot response | Notes |
|---|---|---|---|
| 80 | `unsubscribe` | Cancellation flow starts | |
| 81 | Trigger cancellation then say "actually no" | Cancellation stopped | |
| 82 | Check that after a successful PayFast payment, bot says "Welcome" not silence | Subscription activated | |
| 83 | After subscription expires — send any message | Paywall message with payment link | |

---

## Regression checks (run after any code deploy)

| # | What to check | Expected | Notes |
|---|---|---|---|
| R1 | Send `workout` — does the FULL workout text arrive? | Yes — complete session as text (Twilio body capped at 1500 chars, long sessions split into multiple messages). NO static bench-press image — that was disabled until real animated GIFs are uploaded to the CDN. YouTube tutorial links preview as rich cards. | |
| R2 | Send `portions` — do BOTH images arrive as separate messages? | Yes — hand guide first, plate poster second | |
| R3 | Log a food photo — does single-image analysis still work? | Yes — photo with caption, not two separate messages | |
| R4 | Send a voice note 6+ words — does it transcribe and respond normally? | Yes — not intercepted by single-word check | |
| R5 | `calories` command returns today's total | Yes, with running total | |
| R6 | `progress` shows weight change with pace note | Yes — pace note only appears if ≥2 weight logs | |
| R7 | "I had 2 eggs, is that enough protein?" | Answers the protein question — does NOT silently log the eggs and stay quiet | |
| R8 | "my cousin works at KFC" | Normal chat reply — does NOT return the KFC order guide (no eating intent) | |
| R9 | "I ate at KFC for lunch" | KFC order guide DOES appear (explicit eating intent) | |
| R10 | "last week I was 83kg" (retrospective) | Does NOT log 83kg as today's weight | |
| R11 | Log weight when a prior weigh-in exists | Change shown vs the real last weigh-in, not a stale onboarding baseline ("up 15.8kg" bug) | |
| R12 | Send `workout` twice within 5 min | Second reply is the cooldown note ("scroll up ↑"), not a duplicate full workout | |

---

## Known issues (not yet fixed — test to confirm behaviour, not as bugs)

| # | Issue | Current behaviour | Priority |
|---|---|---|---|
| K1 | "Tomorrow's session" after dumbbell switch — intro says "gym programme" | Bot sends dumbbell exercises but heading says "gym" | Low |

**Fixed since last revision** (kept here for history — test to confirm, no longer open bugs):
- ~~K2 — Scheduler could fire proactive messages twice on restart~~ → FIXED: `claimDailySlot()` is a DB-atomic INSERT-ON-CONFLICT, restart-safe. Safe to set `PROACTIVE_PAUSED=false`.
- ~~Workout request returned image-only with no text~~ → FIXED: Twilio body limit (1600) was exceeded by long workouts; `splitMessage` now caps at 1500 and re-splits oversized parts.
- ~~Severe-frustration reply was tone-deaf ("What exercise will you start with?")~~ → FIXED: bot-complaint path now bans the chirpy redirects.
- ~~Food questions logged as meals; restaurant false-positives; retrospective weight logged as today~~ → FIXED (see R7–R11).

---

## Human tasks before going live with more clients

| # | Task | Status |
|---|---|---|
| H1 | Rotate ElevenLabs API key — it was exposed in codebase | 🔴 DO IMMEDIATELY |
| H2 | Check PAYFAST_PASSPHRASE is set in Railway | 🔴 Critical — paid clients won't activate without it |
| H3 | Set PROACTIVE_PAUSED=false in Railway when ready to send morning check-ins and evening nudges to clients | 🟡 |
| H5 | Set VITE_HERO_VIDEO_URL for landing page hero video | 🟢 |
| H6 | Register Information Officer at inforegulator.org.za (POPIA legal requirement) | 🟡 |
| H7 | Create privacy@kamlifecoach.co.za email | 🟡 |
| H8 | Fill [Information Officer Name] + [Company Registration Number] in privacy.tsx | 🟡 |
| H9 | Sign DPAs with Twilio and OpenAI | 🟡 |
| H10 | Collect real client testimonials (with POPIA consent) for website | 🟢 |
