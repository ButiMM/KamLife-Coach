# KamLife Coach — Comprehensive Overview
### AI fitness & nutrition coaching delivered entirely over WhatsApp
_Prepared for third-party review · 2026-07-14_

> This document is a complete, plain-language snapshot of the product, the market,
> the business model, and the technical foundation. It is written so a reviewer with
> no prior context can understand what KamLife is, who it's for, how it works, and
> where the risks and opportunities are.

---

## 1. What it is, in one paragraph

KamLife Coach is a South African AI fitness and nutrition coach that lives **entirely
inside WhatsApp**. There is no app to download and no website to log into. A client
messages a WhatsApp number and gets personalised coaching from **"Coach K"** — food
logging, a training programme, step and water targets, daily accountability, and
progress tracking — that replies like a real personal trainer, 24/7, in plain South
African English. The client sends a photo of their plate, a voice note, or a few
typed words; Coach K does all the maths and tells them, in human language, what to do
next.

**The core insight:** most of the target market does not use fitness apps. They use
WhatsApp every day. KamLife meets them exactly where they already are, and asks them
to learn nothing new.

---

## 2. The market and the client

- **Total addressable market:** tens of millions of South Africans. The realistic
  early market is the large majority who are overweight or want to change their body
  but have **never used a fitness app and do not think in calories, macros, or gym
  terminology.**
- **The core persona:** *"the person who has tried everything and stopped trusting
  themselves."* Anxious, overwhelmed, often shame-carrying about food and past
  failures. Wants results (a body they're proud of) but is easily confused and easily
  discouraged. Wants to lose weight **without** necessarily going to a gym or walking
  10,000 steps a day.
- **Deliberately broad in capability, narrow in message.** The product can serve a
  complete beginner, an intermediate, and an advanced lifter — but the *voice* speaks
  to the beginner who needs to be told, calmly, exactly what to do.
- **SA-specific realities baked in:** local foods (pap, samp, vetkoek, pilchards,
  Nando's, KFC, braai), grocery budgets in rands, load-shedding, WhatsApp-first
  behaviour, and multiple home languages.

---

## 3. Business model & pricing

| | |
|---|---|
| **Subscription** | **R199 / month** (≈ R6.63/day — "less than a coffee") |
| **Free trial** | 7 days, full access, **no credit card required** |
| **Payment** | PayFast (SA's leading gateway) — card, EFT, instant EFT |
| **Cancellation** | Anytime, self-service |
| **Beta testers** | Rolling full-access bypass (kept off the paying-customer count) |

Payments are secured against replay and signature forgery (see §8). Trial-to-paid
conversion is the primary revenue lever; retention past week two is the primary
business risk (see §7).

---

## 4. Core features (what the client actually gets)

1. **Food logging, three ways** — a **photo** of the plate, a **voice note**, or
   **typed** text. Vision + an SA food database estimate calories and protein
   automatically. The client never counts anything.
2. **A training programme** matched to their equipment — full gym, dumbbells only,
   home/bodyweight, or **walking-only** (for the ~half of clients who can't or won't
   do 10k steps or a gym). Progressive overload built in: sessions get harder week by
   week, phases advance on real compliance, and a plateau-detection loop changes one
   variable at a time until the scale moves.
3. **Step targets** — realistic, weight-and-goal-aware, adjustable by the client
   ("keep my steps at 10,000"), with accommodations for low-mobility clients.
4. **Water, weight, and progress** — daily water target, weigh-in tracking with
   safe-rate coaching, and **progress photos** (front/side/back) with an AI physique
   analysis that names lagging body parts and compares month over month.
5. **Form check** — send a short video of a lift; Coach K returns 1–2 plain
   corrections.
6. **Meal plans & budget-aware shopping lists** — personalised to goal, budget tier,
   dietary restriction (halal/vegetarian/vegan), and food likes/dislikes.
7. **Proactive coaching** — morning brief, evening accountability, milestone
   celebrations, comeback recognition, and retention nudges (all globally pausable).

---

## 5. The delivery philosophy (the current strategic focus)

The features are standard; **how they're delivered is the differentiation.** Three
principles:

- **The client's job is tiny.** Send what you ate and how you feel. That's it. Coach K
  carries 100% of the maths, invisibly.
- **Speak food, not calories.** A raw "2,098 kcal" is anxiety for a low-literacy
  client. Every reply now **leads with a plain human verdict** — *"🟢 Nicely done —
  still room for a light meal or a good snack today"* — with the numbers as a quiet
  footnote for the minority who want them (the "Cal-AI crowd").
- **The bot adapts per client.** It **learns** who can't read numbers (from confusion
  signals or a "keep it simple" request) and switches that client to fully
  number-free replies — reversible with "show me the numbers." No onboarding
  question, no manual split. One product, each person gets the density they can
  handle. (This same adaptive pattern is being extended to tone and other axes.)

_See `docs/delivery-decision.md` for the full rationale and `docs/retention-playbook.md`._

---

## 6. Architecture & infrastructure

- **Stack:** TypeScript / Node.js / Express, deployed on **Railway**.
- **Data:** PostgreSQL with the Drizzle ORM. All client history (meals, workouts,
  steps, weight, chat) is the company's core asset and moat.
- **Messaging:** WhatsApp via **Twilio** (text, voice notes, images, video). Critical
  payment alerts fall back to SMS.
- **AI:** OpenAI GPT-4o / GPT-4o-mini power the conversational "brain" and vision;
  **ElevenLabs** generates voice-note recaps in a cloned coach voice.
- **The decisive architectural choice — deterministic handlers outrank the model.**
  Every message runs through an ordered pipeline of ~50 deterministic handlers
  (safety → onboarding → consent → subscription → food → workout → steps → water →
  progress → …). The AI "brain" is the **last resort**, gated, and only speaks when no
  deterministic handler owns the message. This is what makes replies predictable and
  safe instead of improvised.
- **The asking-vs-reporting gate.** One shared function decides whether a message is a
  *question* or a *report*, so "does this fit my macros?" is never logged as a meal.
  This replaced dozens of local, hole-ridden keyword checks.
- **Safety nets that self-correct.** Nightly audits recompute every client's calorie/
  protein/step targets from their profile and fix drift (a wrong target can't survive
  24h). A "never-silent" guarantee means a client always gets a reply even when
  something upstream fails. A "quality signals" table captures every fumble (empty
  reply, the brain giving up, a caught contradiction) so real use improves the product
  without the founder screenshotting.
- **Scheduler.** Cron jobs drive the proactive layer: morning brief, evening
  accountability, milestones, retention, plateau detection, phase advancement, and a
  **nightly live-brain test battery** that replays every past failure against the real
  model and alerts the founder if any regress.

---

## 7. Retention & distribution

**Retention (the existential problem — "I gain five, I lose five").** Diagnosis: most
churn is **shame and mismatched expectations, not results**. Shipped countermeasures:
a day-3 quit-prevention message at the known cliff, a day-14 "receipt" of real
progress, comeback recognition ("you came back — that's the real streak"), a **30-day
expectation reset** at signup ("you won't look like a new person yet — the goal is to
prove you can show up"), shame-free food tone, and a churn-shape analytics endpoint to
see where people drop.

**Distribution.** Channels being built in parallel: WhatsApp Status campaigns, a
referral loop (friend gets 50% off month 1, referrer gets R50 credit), and
pod/stokvel group pilots. **Sequencing rule:** build the channels now, but don't scale
*volume* until a handful of real testers go two weeks with zero "what does this mean"
moments — distribution amplifies the retention curve, so a leaky bucket scaled just
churns faster and burns word-of-mouth.

---

## 8. Security, compliance, quality

- **POPIA** (SA data-protection law) consent captured at onboarding; "delete my data"
  honoured; special personal information (health) handled accordingly.
- **Payment security:** PayFast webhooks are replay-proof (unique payment-event
  constraint) and signature-verified (passphrase required).
- **Admin security:** dashboard behind a shared secret with timing-safe compare,
  header/cookie auth, same-origin CSRF protection, and DB-backed brute-force lockout.
- **Test foundation (runs in CI on every push):** ~343 unit, 252 routing, 165 gap,
  77 safety, 38 integration, 50 food-scanner, plus onboarding end-to-end, video-path,
  golden-regression, file-size, and pricing guards. A "stabilization contract"
  freezes new features until a verifiable quality bar is met.

---

## 9. What's been built recently (last few days)

- Architecture flip so deterministic handlers outrank the AI brain product-wide.
- The shared asking-vs-reporting gate + a generated question-matrix that measures it.
- Sick-flow, meal-slot, and step-target fixes rooted as *classes* of bug, not
  phrasings, each with regression tests.
- Recalc-on-change so a mid-journey goal/weight/training change can't leave stale
  (dangerous) calorie targets.
- The full delivery decision: plain-language-first replies + adaptive per-client
  numbers mode.
- Quality-signals capture and a nightly live-brain drill so real use feeds the build.

---

## 10. Known gaps & near-term roadmap

- **Finish airtight number-free mode:** the plain-language treatment covers the
  *typed* food reply; extend it to the *photo* reply and the morning brief so a
  low-numeracy client never meets a raw number anywhere. _(Next up.)_
- **Tone adaptation per client** — the next adaptive axis after numbers.
- **Silent retroactive-meal detection** for batch-loggers (logging yesterday's meals
  today without saying so).
- **Operational:** move off the Twilio sandbox before scale; per-user admin accounts +
  MFA; database backup discipline (the data is the moat).

---

## 11. The question for the reviewer

We believe our features are standard and correct for the category; our bet is that
**delivery and distribution** win this market, not novel features. The specific ask:
**how do we make this frictionless and valuable for every literacy level — from an
80-year-old grandmother to a 21-year-old who loves the numbers — without overwhelming
the simple users or overbuilding, and without eroding margins?** We want a sharp
outside opinion on the *simplification and delivery*, judged within our lane
(mass-market, WhatsApp-first, low-literacy SA fitness), not against premium
data-heavy apps aimed at a different customer.
