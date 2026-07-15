# KamLife Coach — Systemic Diagnostic & Architecture Briefing

**Prepared for an external technical/product reviewer.**
**Purpose:** an honest, complete account of what this product is, how it actually
works today, every recurring problem we have not durably solved, the root causes,
and how it needs to function for our market — so an outside expert can help us fix
the foundation, not the symptoms.

This document does not soften anything. Where something is broken, it says so.

---

## 1. What KamLife Coach is

- **Product:** an AI fitness + nutrition coach that lives entirely inside **WhatsApp**. No app to download. The client texts or sends a voice note; the coach ("Coach K") replies.
- **Market:** the South African mass market — **low-income, low-literacy, first-language often not English**. A grandmother who has never counted a calorie. A domestic worker on month-end. People who send 5–6 minute voice notes and stay for **accountability and being pushed and supported**, not dashboards.
- **Price/model:** R199/month, pay-to-start (no free trials). One price for now; premium tiers deliberately deferred until the mass-market wedge is proven.
- **The promise:** a coach that **listens, knows you, remembers you, adapts to you, and keeps you safe** — human-coach quality at a mass-market price.

**The gap this document is about:** the promise is "a coach that knows you." The lived experience is too often **generic, robotic, canned, or silent** — and fixes have not held across the board over ~6 months.

---

## 2. The stack, and how a message actually flows today

**Stack:** TypeScript / Node / Express on Railway · PostgreSQL + Drizzle ORM · WhatsApp via Twilio · OpenAI **gpt-4o / gpt-4o-mini** for reasoning and vision · voice transcription (Whisper-class) + TTS · PayFast for payments.

**Inbound pipeline (the real order a text runs through):**

```
Safety → Onboarding → POPIA → Subscription → Frustration → Normalizer →
FoodLogMgmt → EarlyCommands → Media → Workout → Steps → Water →
FoodContext → Progress → Misc → Lifecycle → BRAIN → gpt-block (agents)
```

Each stage is a **deterministic handler**: it pattern-matches the message and, if it "claims" it, returns a canned reply and stops the pipeline. Only messages that **no handler claims** reach the intelligent layer at the end.

**There are TWO separate intelligent layers, and this is the first structural problem:**

1. **`coach-brain.ts` ("the brain")** — a single tool-calling model with the richest context: a live client snapshot (today's food, protein trend, weight direction, streak, sick state), long-term memory, per-client tone, number-free delivery, and a self-verifier. It is **gated behind an environment flag (`MODEL_BRAIN`)** and is **inert by default**.
2. **`gpt-block.ts` ("the agents")** — the fallback path: routes to specialist sub-agents (nutrition / programming / mindset / admin) or a general "Coach K" call. Until very recently this path was fed **far less context** than the brain.

**Which one is live in production is currently ambiguous** — it depends on the `MODEL_BRAIN` env var on Railway, which must be confirmed. Evidence from live testing (below) suggests the brain is **on** in the test environment. **This ambiguity is itself a core problem:** we have two "brains," they do not share the same wiring, and we are not certain which one is answering our clients.

**Supporting systems:**
- **Memory:** long-term facts (injuries, preferences, milestones) + 6h of recent chat. Wired into the LLM paths **only**. Deterministic templates have **no memory**.
- **Adaptation:** per-client **tone** (gentle/direct/hype) and **number-free delivery** (many clients don't understand calories). Until this week these were wired into only **three** places — food logging, photo logging, and the morning message — and **not** into normal conversation.
- **Safety:** crisis/medical/injury/pain-triage handled deterministically and first. This part is correct and must stay deterministic.
- **Proactive:** a scheduler fires morning/evening/comeback/milestone/feelings messages — separate from replies.

---

## 3. The core systemic problems (with evidence)

### P1 — Two "brains," and we're not sure which is driving
The sophisticated brain (`coach-brain.ts`) holds all the good wiring but ships **off by default**. The active fallback (`gpt-block`) historically had a fraction of that context. So the best-built component may not be the one serving clients, and the one serving clients was under-equipped. **Nobody looking at the code can tell, without checking a Railway env var, which brain answered a given message.** That is not an acceptable state for a production system.

### P2 — 223 deterministic templates front-run conversation (the "wall")
There are **223 distinct canned reply templates**. Roughly a third are legitimate (safety, and transaction confirmations like "logged ✅"). **The other ~two-thirds are conversational/advisory templates that fire on a keyword match and ignore what the person actually said.**

**Evidence (live, this week):** a client already noted sick wrote *"I feel like I should be walking or doing something, I'm not used to just sitting around but I'm also not well, I can feel it"* — a vulnerable, human message. The sick-template matched the words "not well" and returned a **fixed holding paragraph, word-for-word identical** to what it had sent 60 seconds earlier for a bare "I'm still sick today." The coach did not listen; it pattern-matched and repeated itself.

### P3 — The pieces don't share state (no nervous system)
Memory, tone adaptation, number-free delivery, and the live client snapshot each exist — but each is wired into only *some* paths. A template has no memory and no adaptation. The fallback agents had no snapshot. So "the coach that knows you" only knows you in the narrow corners where the wiring happens to reach. **Good organs, no nervous system connecting them.**

### P4 — The intelligent layer over-fires tools/actions on open-ended messages, and does not correct even when told
**Evidence (live, this week):** a **voice note "Map out my entire journey"** — a request for the roadmap/plan ahead — was answered with a **full workout dump for today's session** ("Week 2 — Upper Body A", sets/reps, form cues). The deterministic gates do **not** match that phrase (verified); the workout was delivered by a **tool call**, meaning the intelligent layer interpreted an open, aspirational request as "show me today's workout."

**It then failed again after an explicit correction.** The same client immediately clarified, by voice: *"That's not what I'm saying. **Don't give me a workout.** I'm saying map my journey from here onwards **after I recover from the flu**, [expletive]."* The coach replied with **another schedule dump** — "Wednesday — Rest Day… Next training day: Thursday. **Hit your food and steps today.**" This single exchange fails on four axes at once:
- **Ignored the explicit instruction** ("don't give me a workout") — and gave workout/schedule content anyway.
- **Ignored the emotion** — the client was angry and swearing; the reply is oblivious.
- **Ignored the sick state** — the client said "after I recover from the flu," yet the coach nagged **steps** at a flu patient (a safety/empathy violation of our own sick=rest rule).
- **Never understood the actual ask** — "map my journey from here onwards" (a forward-looking progression/roadmap) was again force-fit to a schedule.

This is the clearest single proof of the systemic failure: **the coach does not listen, does not adapt, does not remember state (sickness), and does not self-correct even when the client spells it out.**

### P5 — Silent failures (a message gets NO reply)
**Evidence (live, this week):** a client (Bonolo) sent a **0:38 video** and received **no response at all** ("And it has still not replied"). The video path can fall through to a state where nothing is sent. For a WhatsApp product, **silence is the worst failure mode** — the client assumes the coach is broken or ignoring them.

### P6 — Generic / robotic replies in the exact moments that matter
The specialist agents (especially the **mindset** agent that handles emotional moments) were, until this week, fed only the client's **name and workout count** — no today's food, no protein trend, no weight direction, no streak, no sick state. So the most human moments — a rant, "I'm struggling", "I feel like giving up" — got **generic empathy**, because the coach literally could not see where the client was.

### P7 — Regression whack-a-mole
Because behaviour is spread across 223 templates plus two model paths, fixing one phrasing frequently re-surfaces a problem elsewhere, or a template quietly re-captures a message a fix was meant to send to the model. The founder's repeated, accurate observation: **"same sheet, same sheet — we've been fixing this for six months."** The absence of a single decision point for "what should the coach say here" makes durable fixes hard.

### P8 — Testing does not exercise the live model paths well
The offline test suites (unit/routing/gap — ~750 checks) validate the **deterministic** routing and pass reliably. But the **integration suite hangs** in a sandbox without network/DB, and the **live-model behaviour** is only checked by a nightly "drill battery" against the real model. So a large class of failures — exactly the model-misroute and generic-reply failures above — **are not caught before a client hits them.**

---

## 4. Root causes (the meta-diagnosis)

1. **A deterministic-first architecture, over-extended.** Templates-first was the right instinct for **safety, transactions, and cost/reliability** — and remains right there. But it kept expanding until templates owned **conversation**, where they cannot listen, remember, or adapt. The wall grew past its job.
2. **The good brain was built, then gated off** — and the active fallback was under-fed. The best design and the live design diverged, and no single owner of "the reply" emerged.
3. **Additive fixes without a unifying spine.** Every good capability (memory, tone, number-free, emotional depth, activation, safety) was **bolted on** to whichever path was convenient, rather than flowing from one shared client-state context into one coach voice.
4. **No shared "what we know about this client right now" object** that every path reads from. The live snapshot exists but isn't universal, so coherence is accidental, not structural.
5. **Weak pre-production signal on model behaviour.** We can't reliably see a bad model reply before a client does.

---

## 5. How it NEEDS to function — for OUR demographic

The target is not "a better MyFitnessPal." For this market the coach must be:

- **One voice that always listens.** Every non-transaction message is understood in context and answered for what it actually said — never a canned paragraph, never silence.
- **Voice-first.** Clients send long voice notes. Transcription must be reliable, and a voice note must be understood as intent, not force-fit to an action.
- **Number-free by default, plain language.** Most clients don't understand calories (and SA labels are in **kilojoules**, not calories, anyway). Coach portions, protein, consistency, and showing up — not figures — unless a client opts into numbers.
- **Emotionally present and accountable.** The retention driver is the human relationship: catching people, pushing and supporting, remembering their life. This must be first-class, not a fallback branch.
- **Memory that's real.** It should reference what the client told you weeks ago, naturally.
- **Adaptive per client.** Tone and delivery shaped to the individual, everywhere — not in three special cases.
- **Safe, always.** Crisis/medical/injury handled deterministically and conservatively. "Break the rules of category, never the rules of safety."
- **Cheap enough to sustain R199.** Every design choice has to respect margin.

---

## 6. Recommended target architecture (for the reviewer to challenge)

A candidate end-state — **we want an expert to pressure-test this**:

- **One coach brain owns all conversation.** Deterministic handlers are demoted to exactly three jobs: (a) **safety** (crisis/medical/injury/pain), (b) **transactions** (logging food/steps/water/weight, billing), (c) **unambiguous exact commands** (e.g. the literal word "workout"). Everything else goes to the brain.
- **One shared client-state object** ("what we know about this client right now") that the brain, the agents, and the proactive jobs all read from — so context is structural, not per-path.
- **The brain must not over-reach for tools/actions** on open-ended messages; ambiguity should produce understanding or one clarifying question, never a wrong action.
- **A hard guarantee of a reply** — no message, of any media type, ever gets silence.
- **Guardrails + a verifier** on every model reply (we have the pieces: a reply-verifier, output guardrails, real-number snapshot, per-user + global spend caps).
- **Observability**: sample and score live replies so bad behaviour is visible before clients churn (a quality-audit job exists; it needs to be trustworthy and central).

**The open strategic decision:** commit to the brain as the single conversational owner (turn it on, feed it everything, demote templates) — versus continuing to patch a two-path, template-heavy system. Our current direction is the former, staged to protect quality and cost; an outside opinion on sequencing and risk is exactly what's wanted.

---

## 7. Open questions for the reviewer

1. **Models:** we run gpt-4o (hard/emotional moments) and gpt-4o-mini (routine), plus vision and voice. Are these the right choices for cost/quality at R199 scale? Where would you spend or save?
2. **Brain-on decision:** is a single always-on tool-calling brain the right owner of conversation for this use case, or is a more constrained design safer/cheaper?
3. **Latency & voice:** WhatsApp + voice notes + multi-step model calls — how should we structure this for fast, reliable replies?
4. **Testing model behaviour:** how do we get trustworthy pre-production signal on model-quality regressions, not just deterministic routing?
5. **Memory & personalization:** what's the right architecture for durable, cheap, per-client memory and adaptation at this scale?
6. **Safety:** is our deterministic-first safety layer sufficient and appropriately conservative for a health-adjacent product in this market?

---

## 8. What has already been tried (so it isn't re-suggested)

- Deterministic-template-first routing (the current spine) — reliable for safety/transactions, over-extended into conversation.
- A full tool-calling brain with snapshot + memory + tone + numbers + verifier — **built, but gated behind a flag.**
- Per-client tone and number-free delivery — built; only recently being wired into general conversation.
- Deep-emotional path (better model + more tokens for vulnerable shares).
- A nightly "drill battery" replaying real tester failures against the live model.
- A daily quality-audit that samples and scores replies.
- Per-user and global AI spend caps.
- Extensive offline test suites for deterministic routing (~750 checks).

**None of these individually fixed the felt problem** — generic/robotic/inconsistent replies — because the problem is **structural coherence**, not any single component.

---

## Appendix A — concrete live failures (evidence)

| # | Client message | What the coach did | What it should have done |
|---|---|---|---|
| 1 | (sick) "I feel like I should be walking… I'm not used to sitting around but I'm also not well" | Repeated a fixed sick-template **verbatim**, identical to 60s earlier | Acknowledge the restlessness specifically, hold the rest line warmly |
| 2 | voice: "Map out my entire journey" | Dumped **today's workout session** | Explain the roadmap/progression ahead, or ask one clarifying question |
| 2b | voice: "Don't give me a workout. Map my journey from here onwards after I recover from the flu" (angry) | Dumped a **training schedule** + "hit your steps today" (to a sick, angry client) | Acknowledge the anger + the flu, hold rest, then map the forward progression — no schedule |
| 3 | a 0:38 video | **No reply at all** | Always acknowledge; attempt analysis or ask for a clearer clip |
| 4 | (general chat) emotional shares | **Generic** empathy | Reference the client's real numbers/streak/today — presence, not platitude |

## Appendix B — what changed this week (partial mitigations, not the cure)
- Sick-flow now falls through to the listening layer for substantive messages (bare check-ins still templated, and no longer verbatim-repeating).
- The live client snapshot is now fed into the fallback agents (less generic).
- Tone + number-free delivery are now wired into normal conversation, not just logging.
- Parallel-tool-call bug fixed in both model paths.
- A global AI-spend watchdog added.

These reduce specific symptoms. **They do not replace the need for the structural decision in §6.**

---

*This document is a candid internal diagnostic prepared to solicit outside help. It is intentionally unflattering about the current state because the goal is a fix, not reassurance.*
