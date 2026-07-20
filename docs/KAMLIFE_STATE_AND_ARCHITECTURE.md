# KamLife Coach — State, Architecture & Direction
### A briefing for external technical & product review
**Prepared:** 2026-07-21  ·  **Stage:** Pre-launch, private beta  ·  **Platform:** WhatsApp (Twilio) · Node/TypeScript · PostgreSQL · Railway

---

## 0. How to read this document

This is an **honest internal briefing**, not a pitch. It states what is genuinely built and working, what is half-built, and what is missing — so an external reviewer can pressure-test our decisions before we commit the launch sprint. The last section (§9) contains the **specific questions** we most need answered this week.

A second-party "Master Directive" was recently drafted for us (Redis UCSO, BullMQ, vector memory, Stokvel squads, self-hosted TTS, "delete 210 templates"). §8 is our honest, line-by-line engineering response to it: what we've already built, what's worth taking, and what we believe is premature or dangerous for our stage. **We want the reviewer to adjudicate §8.**

---

## 1. What KamLife is

KamLife Coach is a **WhatsApp-native AI fitness & nutrition coach for the South African mass market** — low-to-middle income, often low-literacy, price-sensitive users on R199/month. It is not an app you download; it is a coach you text (or send a voice note / photo). The whole product lives inside a WhatsApp thread.

**Who it's for.** People underserved by global fitness apps: someone eating pap and morogo on a R100/week budget, training at a commercial gym or at home with nothing, sending a voice note in mixed English/isiZulu, who will churn the moment the coach feels robotic, shaming, or absent.

**What makes it different (the moat):**
- **Deeply South African.** Understands SA foods (pap, samp, vetkoek, chakalaka, amagwinya), SA restaurant chains (Nando's, KFC, Shisa Nyama), SA life (load-shedding, month-end, taxi commutes, funerals, stokvels), and coaches within a real budget.
- **Coach, not calculator.** No calorie-counting homework, no food scales. The client just says what they ate; the system does the numbers silently. Hand-portion method, not grams.
- **Judgment + empathy, not templates.** The AI ("Coach K") is the front door; it reads the client's real situation and responds like a human coach who remembers them.

**What we wanted it to be** — and are converging on — is a coach that is *smart, warm, proactive, and never amnesiac*: it remembers you're sick until Monday, nudges you the night before, never tells a grieving or ill client to "hit their steps," and answers what you actually asked rather than firing the nearest template.

---

## 2. Where we are (launch readiness)

**Live and working** (deployed on Railway, in private beta with real testers):
- Onboarding → profile → goal-aware targets (Mifflin-St Jeor, gender-aware safety floors).
- Food logging via SA food database, GPT fallback, and photo vision — numbers computed deterministically, never guessed by the LLM.
- Deterministic workout programme delivery with progressive overload, form cues, and exercise media.
- Step / water / weight logging, weekly weigh-in ritual, 3-week auto-calorie-adjust with safety floors.
- Progress photos + physique analysis (lagging body-part read), form-check from video/photo.
- Proactive scheduler: morning brief, evening accountability, comeback protocol, streak-at-risk, retention interventions, referral rewards (idempotent via PayFast webhook), Monday rituals.
- Safety: crisis/medical hard-stop (SADAG, chest-pain, emergency) that **bypasses the LLM entirely and runs first**; POPIA consent captured conversationally and logged.
- Billing: PayFast subscription + SMS critical-alert fallback.

**The honest state:** the *capability surface is broad and largely built*. The remaining work is **not more features — it is reliability of judgment**: making sure the right brain answers the right message every time. That "final few percent" is what recent testing screenshots exposed (see §7).

---

## 3. The core architecture — "The Inversion"

The original system decided *what to do* (keyword → template) **before** it understood *what the user meant*. That produced the failure the founder rightly hates: a keyword hijacks the message and the coach answers something the client never asked.

We inverted it. The governing law now:

> **The AI (Coach K) owns judgment, empathy, context, strategy — it is the front door.**
> **Deterministic code owns actions, safety, transactions, logging — the exact, auditable rails.**

### 3.1 The pipeline (request → reply)

Every inbound WhatsApp message flows through an ordered pipeline (`server/routes.ts`). Simplified:

```
Safety/crisis guards  →  Onboarding  →  POPIA  →  Subscription
   →  Normalizer (classifyIntent, gpt-4o-mini, rewrites messy phrasing)
   →  Reminders  →  Early-commands (the deterministic "keyword wall")
   →  Media (image/audio)  →  ENGINE FRONT DOOR (Coach K / meaning-engine)
   →  Misc / Lifecycle  →  Engine tail  →  GPT fallback
```

The load-bearing idea: **`mustStayDeterministic(m)`** is the boundary. Transactions and exact commands (logging a meal, a weight number, `workout`, billing, safety) stay on deterministic rails so a log can never be lost to an improvising LLM. **Everything else — genuine conversation, questions, feelings, strategy — flows to the brain.**

### 3.2 Why not "delete all templates and let the brain do everything"?

We tried brain-first-for-*everything* on 2026-07-13 and **reverted it**: the model improvised over real commands (a bare "Workout" got a hallucinated session instead of the client's actual programme). The correct, hard-won model is:

- **Deterministic owns:** exact commands, mechanical state, and **facts that must be accurate** (calorie numbers, the client's real programme, restaurant macros). An LLM guessing "520 kcal" is worse than useless.
- **The brain owns:** judgment. Advice, empathy, strategy, "what should I do about X."

The disease is not "templates exist"; it is **judgment handlers living in the deterministic layer and firing on keywords**. Our ongoing work is shrinking those — gating judgment handlers behind the engine so the brain gets the message, while keeping the mechanical/factual ones deterministic. (This nuance matters enormously for §8's "delete 210 templates" recommendation.)

### 3.3 Feature flags (all reversible in Railway)
- `ENGINE_LIVE` — brain is the conversational front door for non-`mustStayDeterministic` messages.
- `ENGINE_ACTIONS` (off/shadow/on) — whether the brain may emit structured actions.
- `SHADOW_ENGINE` — score the new engine against production replies without affecting the client.
- `NORMALIZER`, `PROACTIVE_PAUSED` (global killswitch), `MODEL_BRAIN`.

Every risky change is flag-gated and instantly revertible.

---

## 4. Memory & state (the anti-amnesia layer)

The reviewer's second party correctly identified **amnesia** as the root cause of bad empathy. We address it with several concrete stores, injected into the coach's context:

- **Client snapshot** (`server/brain/client-snapshot.ts`) — assembled per turn: goal, targets, recent logs, streaks, and a **REMEMBERED DATES** block (`back_on:`, `sick_until:`, `paused_until:`) that tells the brain to reference those dates, never re-ask, and never push training before them.
- **Client Intelligence Profile** (`clientIntelligenceProfiles`) — a durable narrative ("what you've learned about this client over time"), now wired into the live engine's context.
- **Client understanding** (`client_understanding`) — the engine's cross-session cortex (durable subset of understanding state).
- **Structured logs** — meals, steps, weight, workouts (numeric columns, not regex over chat text).

### 4.1 Reminders & temporal memory (just built)
The founder's sharpest recent demand: *when a sick client says "the doctor says I can go back Monday," the system must anchor that to a real date and **remind them the night before** — so we never go silent and lose them.*

Built this session:
- A **user-set reminder system** end-to-end: a deterministic SAST time-parser ("at 8pm", "tomorrow", "in 2 hours", "Monday"), a `reminders` table, a **per-minute scheduler** that fires due reminders, plus set / list / cancel and a brain `SET_REMINDER` action. (`server/reminders*.ts`, `server/handlers/reminders-handler.ts`, `server/scheduler/jobs/reminders.ts`.)
- Return dates are already captured (`back_on:`) and honoured by the brain.

**The remaining gap (named honestly):** the loop isn't fully closed yet — capturing "back on Monday" does not *yet* auto-schedule the night-before proactive nudge. The infrastructure now exists to close it in one wiring step (auto-create a reminder from a captured return date); it is the top of the next-work list.

---

## 5. Deterministic action execution (the "hands")

When the brain decides to *do* something, it emits a typed `CoachAction`; a deterministic executor performs it (`server/understanding/executor.ts`). Safeguards on the contract, not the LLM:
- **Confidence gate** (`CONFIDENCE_TO_EXECUTE = 0.75`) — an uncertain state-write is confirmed, not silently written.
- **Idempotency fingerprint** — a retry / redelivery / replay can never double-write (or double-schedule a reminder).
- **Law: the LLM never touches the database.** It hands *text* (e.g. the food said); the deterministic scanner owns the numbers.
- **Dry-run/shadow** — the executor can decide + report without writing, so we can score it against real history safely.

---

## 6. Infrastructure & engineering discipline

- **Stack:** TypeScript / Node / Express; PostgreSQL + Drizzle ORM; Twilio WhatsApp; OpenAI (gpt-4o / gpt-4o-mini); deployed on Railway. Migrations run idempotently on startup (`CREATE TABLE IF NOT EXISTS`), so schema ships without manual steps.
- **Test gates (run before every push):** `tsc` typecheck; a **per-file line-size budget** (hard cap, never raised — forces extraction over bloat); **~500 unit tests**; a **routing audit** (276 scenarios asserting each message reaches the right handler); plus `drill-battery.ts` and `multilingual-battery.ts` for behavioural regression.
- **Shadow evaluation** — the new engine is scored against production replies before it's trusted with a cohort.

This discipline is real and is the reason we can move fast without regressing.

---

## 7. Known gaps — "the final few percent" (from live testing screenshots)

These are the failures real testers surfaced. They are **judgment-routing bugs**, not missing features:

1. **Tool over-firing (the #1 issue).** A strategy question — *"let's talk about incorporating running without killing my gym progress"* (a voice note) — was answered with a **full Week-1 workout dump**. The coach ignored the actual question and fired the nearest template. Same disease: *"I'm going on vacation, adjust my groceries"* → a dumbbell workout. **The fix is an "intent bouncer": a broad/strategic/emotional message must be forbidden from firing action templates.** (One instance — the holiday→workout hijack — is already fixed and locked with a test; the class needs the general guard.)
2. **The silence trap.** Twilio webhooks time out ~15s; heavy vision/audio can exceed that → the client gets *nothing*. Silence is a churn event. Needs an **immediate acknowledgement + asynchronous processing** pattern.
3. **Temporal reminder loop not fully closed** (see §4.1) — capture the return date → schedule the night-before nudge.
4. **Margin exposure at scale.** At R199/month, unmanaged OpenAI/voice costs threaten unit economics beyond ~10k users. We have a normalizer on gpt-4o-mini; we do not yet have a formal cost-routing policy.

---

## 8. Honest response to the second-party "Master Directive"

The external directive is directionally strong and shares our core thesis (the Inversion). Our engineering assessment, so the reviewer can adjudicate:

### 8.1 Already built (they recommend building it — we have it)
| Directive item | Our status |
|---|---|
| The Inversion (AI = front door) | **Built** — `ENGINE_LIVE`, meaning-engine |
| `mustStayDeterministic` boundary | **Built** |
| Confidence gate (act if confident, else 1 question) | **Built** at 0.75 (they propose 0.85 — open question, §9) |
| Action idempotency | **Built** |
| Reminder tool ("kills the I-Can't pattern") | **Built this week** |
| SA food / budget context (Spaza, pap, R100/week) | **Built** (coach prompt + SA food DB); restaurant engine added this week |
| Resilience / comeback without shame | **Built** (comeback protocol, streak-at-risk) |
| Medical hard-stop / SADAG / POPIA | **Built** — runs first, bypasses LLM |
| Temporal anchor (default to today, `parseMealDate`) | **Built** |
| Voice normalization / summarizer wedge | **Partly built** (normalizer on gpt-4o-mini) |
| Auto-cal-adjust with gender floors + GLP-1 guard | **Built** (1200F / 1500M / 1800 breastfeeding) |
| Shadow mode for retiring templates | **Built** (`SHADOW_ENGINE`) |

### 8.2 Worth taking (real value, not yet built) — our recommended priority
1. **The Intent Bouncer** — directly fixes the live #1 bug (running→workout dump). Cheap, high-value. **Do first.** Open question: prompt-level vs a code-level guard that strips action tools for broad/emotional intents (we lean code-level — more reliable).
2. **Zero-silence async pattern** — immediate ACK + background processing for media. Real fix for a real churn bug. Open question: does this justify introducing Redis/BullMQ now, or can we do it on existing infra (a lightweight job table + worker) pre-launch?
3. **A formal cost-routing policy ("traffic-cop")** — we already classify on mini; formalize mini-vs-4o routing to protect the R199 margin. **Do before scale, not necessarily before launch.**
4. **A lightweight reply-safety evaluator** — a cheap check that a draft never tells a sick/grieving client to train. Valuable, but adds latency/cost per message; pilot it on *risky* messages only, not all.

### 8.3 Premature or risky for our stage (our honest pushback)
- **"Delete 210 templates immediately."** ⚠️ **Dangerous for our codebase.** Many of our "templates" are not conversational filler — they are *accurate data handlers* (calorie math, the client's real programme, restaurant macros, safety scripts). Mass-deleting them would regress accuracy and re-introduce the exact hallucination we reverted on 2026-07-13. Correct approach: **shadow + selective retirement of the *judgment* templates only**, which we are already doing. Keep every mechanical/factual/safety handler.
- **Redis UCSO / full BullMQ / pgvector / Pinecone.** The *idea* (inject unified state every call; async processing) is right; the *heavy infra* is premature at <150k users pre-launch. Postgres JSONB + in-memory covers UCSO today; a simple job table can cover async before we adopt Redis.
- **Self-hosted TTS (XTTS on RunPod), EskomSePush integration, Stokvel squads.** Genuinely good ideas, but each adds an external dependency or a large build. **Post-launch**, sequenced by retention ROI — not in the launch sprint.

**Summary of our position:** take the *Intent Bouncer* and *zero-silence* patterns now; formalize *cost-routing* before scale; **do not** mass-delete handlers or adopt Redis/vector infra before launch.

---

## 9. Specific questions for the reviewer (to unblock this week)

1. **Intent Bouncer:** For our failure modes (strategy/emotional message → template dump), is a **code-level tool-stripping interceptor** more reliable than a prompt-level rule, or do we need both? What's the minimum that provably kills the running→workout-dump class?
2. **Zero-silence:** On Twilio + Railway, pre-launch, what is the **minimum viable** async pattern (immediate ACK + background worker) that guarantees no silence **without** introducing Redis/BullMQ yet? At what user count does Redis/BullMQ become justified?
3. **Confidence gate:** Is **0.75** right for a low-literacy audience that phrases things loosely, or does **0.85** (fewer wrong auto-actions, more clarifying questions) fit better? What's the retention trade-off of an extra question vs a wrong action?
4. **Template strategy:** Do you agree that mass template deletion is unsafe **given that many of our templates are accurate data/safety handlers, not conversational filler** — and that shadow-retirement of *judgment* handlers only is the correct path?
5. **Margins:** At R199/month and our expected message mix, what is the realistic per-user monthly API cost, and does a mini-vs-4o traffic-cop close it — or do we need voice cost caps / cheaper TTS before launch?
6. **Killer-feature sequencing:** Of the SA-moat features (Spaza navigator, life-proof auto-pivot, resilience streak, Stokvel squads), which has the highest **launch-window** retention ROI, and which are safely post-launch?
7. **The temporal loop:** Any risk you see in auto-scheduling a night-before "you're back tomorrow" nudge off a captured return date (double-sends, timezone, the client who never confirms)?

---

## 10. One-line summary

**The foundation is built and disciplined; the product is broad and South-African-deep. The remaining launch work is not features — it is guaranteeing the right brain answers the right message (the Intent Bouncer), never going silent (async), and never going amnesiac (closing the temporal-reminder loop). We want the review to stress-test §8 and answer §9 so we can execute a focused, not a sprawling, sprint.**
