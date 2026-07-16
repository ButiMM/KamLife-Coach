# What KamLife Coach Does — For Every Person (Product Vision)

> **READ THIS FIRST:** this document describes the product experience we are
> shipping — most of it is live today, and the auditable current-state split
> (built ✅ / in-verification ⚠️ / not-built 🔵) lives in
> **`CURRENT-CAPABILITIES.md`** — send THAT to reviewers verifying launch
> readiness. The honest gaps are in §5 of this document; read them before the
> promises. Date: 2026-07-16

The whole thing lives in WhatsApp. No app to download, no dashboard to learn, no
buttons to hunt for. You talk to Coach K the way you'd talk to a person — type,
voice note, or a photo — in English, isiZulu, isiXhosa, Sesotho, Setswana or
Afrikaans, mixed however you speak. That is the "no technology stuff" part: if
you can send a WhatsApp, you can use it.

---

## 1. Onboarding — the first 5 minutes (frictionless, one question at a time)
Coach K asks, never a form. It collects only what it needs to build *your* plan,
one message at a time, and it adapts the questions to your answers:

- **Consent first (POPIA)** — your data, your permission, up front.
- **Age & gender** (blocks under-18), **your goal**, **experience level**.
- **How many days you can train**, **your situation and work schedule** (office
  desk vs shift work vs on-your-feet), so the plan fits your real week.
- **Equipment** — full gym, home with dumbbells/bands, or nothing at all.
- **Weight & height**, **medical conditions & injuries**, **dietary needs**
  (halaal, vegan, allergies), **your real foods**, and **your weekly food
  budget** — so it never tells a person on R100/week to buy salmon.
- **Women** get female-specific and postpartum questions.
- **A baseline photo** (optional) so it can see where you're starting.

Out of that it builds your calorie target, protein target, step target, and a
training programme matched to your goal, body, equipment and schedule.

---

## 2. What EVERY person gets, every day
- **Log by just talking.** "I ate pap and chicken", a voice note, a photo of
  your plate — it logs the food and the calories/protein. Steps, weight,
  workouts, water — same. It handles "yesterday" without messing up the day.
- **Numbers stay hidden unless you ask.** Default is no calorie/kilojoule talk —
  it coaches in food and portions, not spreadsheets. (You *can* ask for numbers.)
- **It remembers you.** Your story, your injuries, your job, last week — so you
  never repeat yourself and it never greets you as a stranger.
- **It never shames you.** Missed a session, ate the cake — it coaches the next
  step, warmly. Consistency beats perfection.
- **It reads the room.** Sick, hurt, stressed, or low — it holds off the push,
  cares first, and (for heavy low moods) surfaces the SADAG helpline.
- **It adjusts itself.** Every 3 weeks it checks your weight trend and quietly
  re-tunes your calories (see §4). You do nothing.
- **It stays in its lane.** Ask it to write an essay and it warmly says no and
  steers you back — it's a coach, not a chatbot.

---

## 3. Person by person — what changes for them

**The obese man / obese woman who wants to lose the stomach (fat loss).**
Onboarding sets a safe deficit off *their* weight, with a floor (never below
~1300 kcal women / 1500 men) so it's never starvation. Steps + a doable
programme. When the scale stalls for 3 weeks, it drops calories by a *small* 100
and bumps protein to protect muscle. If they lose *too fast* (or they're on
Ozempic/Wegovy), it **raises** calories to stop them burning muscle. Belly fat
gets the honest truth: no spot-reduction, no waist-trainer myths — deficit +
steps + strength + sleep.

**Someone who just wants to lose weight generally.** Same fat-loss engine,
tuned to their pace, their food, their budget. Small wins, logged, celebrated.

**The man building muscle in a surplus.** A surplus target (the surplus is *in*
the number — no math for him), higher protein, a hypertrophy programme with
progressive overload. If he's not gaining in 3 weeks, calories go up with carbs
placed around training. If he's losing on a bulk, it catches it and corrects.

**The lady who wants to gain weight and have curves.** Supported directly —
`weight_gain`/`muscle_gain` goal, a surplus, and glute/lower-body emphasis via
the programme. Female-specific onboarding. Not treated like a man who wants abs.

**The grandmother in Soweto / grandfather in Tembisa.** Age-aware coaching tone,
gentler progression, joints respected. If they have arthritis, a bad heart, a
cane or a wheelchair, Coach K recognises low mobility and **does not nag steps or
push training their body can't do** — it works with what they can.

**The person who won't walk / can't walk.** Low-mobility is detected (bad knees,
heart, wheelchair, chronic pain). It stops pushing steps and coaches the levers
that still move the needle — food and what movement they *can* do. No guilt.

**The person who won't touch weights at all.** Equipment "none/bands/home" is a
first-class choice. Every exercise carries a bodyweight or band modification
(push-ups, bodyweight squats, band rows). They still get a real programme —
just without a barbell.

**The office worker who sits all day.** Work-schedule onboarding flags the desk
life; steps and short movement become the focus alongside training, because
that's where a sedentary body wins or loses.

**The mineworker / domestic worker / on-their-feet labourer.** Already active
all day — so it won't pile pointless step targets on an exhausted body; it
leans on strength, recovery and food, and respects a shift schedule.

**The police officer / teacher (shift + stress).** Schedule-aware plan, stress
handled with care (it treats stress as part of the programme, not a distraction),
and flexible training days.

**The white stay-at-home mom / any busy parent who wants a simpler life.**
Postpartum-aware for new mothers. Frictionless — no jargon, no overwhelm, just
"here's your one thing today." Fits around kids and a chaotic day.

**The teenager (18+) / person in their twenties.** Age-appropriate coaching,
myth-busting (it kills the TikTok detox-tea and quick-fix nonsense directly),
and habits that actually build a body over time.

---

## 4. The intelligence that makes it a coach, not an app
- **Auto re-adjustment (live).** Every 3 weeks it reads the weight trend and
  re-tunes calories/protein automatically — plateau, too-fast, or wrong-
  direction — with safe floors, gender-aware, muscle-protecting. The client just
  gets a plain message: "held steady 3 weeks — small adjustment, keep going."
- **Photos.** A baseline physique photo reads their starting point and lagging
  areas; progress photos track change over time; a form-check video/photo gets
  1–2 plain corrections.
- **Menu & grocery help, food scanning** from a photo.
- **Voice-first.** Voice notes are transcribed (with SA-vocabulary cleanup) and
  coached the same as text.

---

## 5. Honest gaps to know before launch (so nothing surprises you)
- **The multilingual logging quality needs one live proof run** — the battery
  (`multilingual-battery.ts`) exists; it must pass before we lean on isiZulu/
  Xhosa/Sotho logging for real testers.
- **Coach K owning the whole conversation is behind `ENGINE_LIVE`** and still
  earning its "winning days" — reversible instantly if a tester hits a rough
  reply.
- **Outcome numbers** (weight change, adherence, retention) are now measured
  (`/api/admin/outcomes`) but only become real once the 10 testers generate data.

**Bottom line for launch:** whoever you hand it to — however they eat, move,
work, or speak — it onboards them in their language, builds a plan for *their*
body and budget, lets them log by just talking, hides the complexity, adjusts
itself as they change, and never shames them. That is the product.
