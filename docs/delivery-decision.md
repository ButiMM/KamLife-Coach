# Delivery decision — speak food, not calories (2026-07-14)

_The founder, after a tester said "it talks in calories and I don't understand
calories": "We need to find the sweet spot — frictionless, easy to understand,
for a grandmother of 80 and a 21-year-old, without overbuilding. But some people
(the Cal-AI crowd) DO want the numbers. How do we accommodate everybody?"_

## The decision

**The user's job is to send what they ate and how they feel. Never a number, never
a calculation.** The bot carries 100% of the math, invisibly. One product, layered
so each literacy level takes what it needs — we do NOT split into two products and
we do NOT ask people to self-classify up front.

- **Plain verdict leads, numbers support.** Every food reply opens with a
  number-free human line — "🟢 Nicely done — still room for a light meal or a good
  snack today" — and the kcal/protein detail sits below for those who want it. One
  message serves the grandmother (reads the top line) and the Cal-AI user (eye drops
  to the numbers). Shipped: food-scanner `verdictHeadline`, and `remainingInMeals`
  surfaced on every running total (not just the day-3 summary).

- **Number-free by DEFAULT; power users opt in** _(2026-07-14, third-party review —
  "start everyone in number-free mode; let the numbers-lover ask for detail")._ This
  flips the friction: nobody meets a number they didn't ask for — a grandmother is
  protected without having to be confused once first — while the Cal-AI crowd opts in
  a single time with "show me the numbers" (sets `numbers:full`). Onboarding tells
  every client they can ask. Absence of a token = number-free; only `numbers:full`
  turns figures on. Shipped: `server/numbers-mode.ts`, `handlers/numbers-literacy.ts`.

## Why this and not the alternatives

- **Hide numbers for everyone** → loses the Cal-AI crowd who like seeing protein.
- **Ask at onboarding** → friction, and most people can't answer "do you want
  numbers?" before they've used it.
- **Numbers-first (where we were)** → loses the grandmother; the tester's exact
  complaint.
- **Layered + adaptive** → broad by default (everyone included), narrow in effect
  (each person gets what they can handle), zero friction (no setting), and the
  adaptation is a differentiator competitors don't have.

## Adaptation is the throughline, not a one-off

The founder's larger point: the bot should adapt in **every** facet — tone, depth,
number-appetite — per client. Two axes now ship on the same durable profileNotes-token
pattern (read at reply time, absence = default so behaviour is byte-unchanged):

- **`numbers:low`** — number-free food replies (typed, photo, and morning brief).
- **`tone:gentle|direct|hype`** (`server/tone-mode.ts`) — flexes the coaching brain's
  voice. Set when a client asks ("just tell me straight", "be gentle with me", "push
  me"); the steer is injected as one extra system line into the brain (nothing injected
  for the default "warm"). Currently reaches the model brain; extending it to the
  gpt-block fallback and templated openers is the next step.

The pattern generalises to any future axis (depth, language, cadence).

## Distribution vs retention

Equal in importance, but sequence the **volume**: build the distribution channels
(WhatsApp Status, referral, a pod of 5, stokvel) in parallel now, but don't pour
volume through until a handful of real testers go two weeks with zero "what does
this mean" moments. Distribution amplifies the retention curve — a leaky bucket
scaled just churns faster and burns word-of-mouth.

## Next

- Extend the number-free treatment to the **photo** food reply (media.ts) and the
  morning brief, so a `numbers:low` client never meets a raw figure anywhere.
- A lighter-touch "numbers:high" for the Cal-AI crowd (richer macro detail) if the
  data shows demand.
