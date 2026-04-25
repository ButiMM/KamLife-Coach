# KamLife Coach
### AI-Powered Fitness & Nutrition Coaching via WhatsApp

---

## What It Is

KamLife Coach is a South African AI fitness and nutrition coaching service delivered entirely through **WhatsApp** — no app to download, no website to log into. Clients text a WhatsApp number and receive personalised coaching from **Coach K**, an AI coach that responds like a real personal trainer, 24 hours a day, in plain SA English (and Zulu, Xhosa, Sotho, Afrikaans, Tswana, Tsonga).

**The core insight:** Most South Africans don't use fitness apps. They use WhatsApp. KamLife meets them where they already are.

---

## Pricing

| | |
|---|---|
| **Monthly subscription** | R149/month (~R5/day) |
| **Free trial** | 7 days, full access, no credit card required |
| **Always free** | Food logging, step tracking, water, weight logging, basic Q&A |
| **Subscription unlocks** | Workout programmes, shopping lists, full coaching, meal plans |

Payments are processed via **PayFast** — South Africa's leading payment gateway.

---

## Who It's For

South Africans across all income levels and backgrounds. The product is built specifically for SA realities:

- **Budget tiers** from under R100/week to over R600/week for food
- **SA food database** — pap, pilchards, kota, umngqusho, biltong, samp, morogo, boerewors — not American macros
- **Store references** — Shoprite, Boxer, Checkers, Pick n Pay, Dis-Chem
- **Restaurant guides** — Nando's, KFC, Steers, Spur, Wimpy, McDonald's
- **All job types** — domestic workers, mineworkers, retail staff, office workers, nurses, students
- **Medical awareness** — ARVs, hypertension, diabetes, TB treatment, PCOS, joint injuries
- **Age range** — 14 to 65+

---

## What Coach K Does

### Onboarding (~2 minutes, 3 questions)
Client provides their name, age, gender, weight, height, fitness goal, job type, training days per week, equipment available, and weekly food budget. From this, the system instantly calculates personalised daily calorie and protein targets and builds a full 8-week training programme.

### Workout Programmes
- **5 progressive phases over 8 weeks:** Foundation → Build → Push → Peak → Deload
- **3 programme types:** Full gym, Dumbbell-only, Home/no equipment
- Every exercise includes SA-specific descriptions, common mistakes to avoid, and injury modifications
- Clients text *"done"* after a workout — it logs the session, updates their streak, and advances the programme automatically

### Food & Nutrition Tracking
- Log food naturally by texting: *"I had eggs, pap and spinach for lunch"*
- System maps to an SA food database with accurate calorie and protein values
- Tracks running daily totals against personal targets
- **Food photos:** Send a photo of a meal — GPT-4o Vision identifies and logs it
- Handles multi-meal messages, restaurant meals, junk food with context-appropriate coaching notes
- Personal grocery list: built from the client's own actual food logs

### Shopping Lists
Prebuilt weekly grocery lists across 4 budget tiers (under R100 / R100–300 / R300–600 / over R600), with a Week A and Week B for variety. Lists reference Shoprite and Boxer prices.

### Step Tracking
- Client logs steps by text or sends a screenshot of their step count app
- Vision AI reads the screenshot and extracts the number automatically
- Tracks daily streak and milestone badges

### Voice Notes
- Client sends a WhatsApp voice note — transcribed via OpenAI Whisper
- Supports SA English, Zulu, Xhosa, and Afrikaans
- Coaching reply generated from the transcription

### Weight Logging
- Tracks weight over time and shows the change trend
- Automatically recalculates calorie and protein targets when weight changes

### Progress Photos
- Client sends a before/after photo — AI describes visible body composition changes
- Stored for comparison over time

---

## Proactive Messaging

The bot doesn't just wait for clients to message. It sends scheduled WhatsApp messages throughout the week:

- **Daily 8am** — Morning check-in with protein and step summary
- **Friday 4pm** — Weekend meal prep reminder
- **Sunday 7pm** — Week reflection and Monday readiness check
- **Monday 8am** — Week opener with step challenge
- **Wednesday 10am** — Halfway-through-the-week check-in
- **Re-engagement** — Automatic follow-up after 3–7 days of silence
- **Monthly** — Weight-in reminder, monthly goal reset

All proactive messages are capped at one per client per day.

---

## Safety & Compliance

- **Crisis detection** — Keywords for chest pain, suicidal ideation, and self-harm trigger an immediate safety response and escalation alert to the coach
- **Medical guardrails** — Heart condition detected → requests doctor clearance before giving exercise advice
- **POPIA compliant** — SA data protection law. Consent captured on signup. Full data deletion available on request (phone anonymised, all logs deleted)
- **Escalation queue** — All flagged clients surface in the admin dashboard with SLA deadlines for human follow-up

---

## Admin Dashboard

A password-protected web dashboard gives the business owner full visibility:

- All users, subscription status, last active date, workout count
- Live activity feed across all clients
- Escalation queue with urgency flags
- Revenue metrics: MRR, ARPU, LTV, trial conversion rate
- Ability to send manual messages to any user

---

## Technology

Built on a modern, scalable stack:

- **Backend** — Node.js + TypeScript
- **Database** — PostgreSQL with vector memory (pgvector) for personalisation
- **AI** — OpenAI GPT-4o (coaching + food vision), Whisper-1 (voice transcription)
- **WhatsApp** — Twilio Business API
- **Payments** — PayFast ITN webhooks
- **Hosting** — Railway (auto-deploys on every code update)

---

## Business Model

| Metric | Value |
|---|---|
| Price per subscriber | R149/month |
| Free trial | 7 days |
| At 100 subscribers | ~R14,900 MRR |
| At 500 subscribers | ~R74,500 MRR |
| At 1,000 subscribers | ~R149,000 MRR (~R1.79M/year) |
| Marginal cost per user | ~R1–2/month (AI API costs at moderate usage) |

**Acquisition** — WhatsApp word of mouth, QR codes, social media  
**Retention** — Daily proactive messages, streak psychology, 8-week progressive programme that gives clients a reason to return every week  
**Gross margin** — Very high. No physical infrastructure, no human trainers, near-zero marginal cost per additional subscriber

---

## What Makes It Different

1. **WhatsApp-native** — No app friction. Meets SA users where they already spend their time.
2. **Built for South Africa** — SA food, SA stores, SA language, SA economic reality. Not a generic product localised for SA.
3. **Voice notes** — Send a voice note, get coached. No typing required.
4. **Works at every income level** — A client spending R80/week on food gets the same coaching quality as one spending R600/week, adapted to their actual budget.
5. **Proactive** — It messages you. A personal trainer who checks up on you daily.
6. **Scales infinitely** — One system serves 10 clients or 10,000 with no additional headcount.

---

*KamLife Coach — Built in South Africa, for South Africa.*
