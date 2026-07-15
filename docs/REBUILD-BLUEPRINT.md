# KamLife Coach — The Definitive Rebuild Blueprint

**This is the canonical plan. The builder executes against this document.**
Synthesized from four independent expert reviews (two external AI architecture
reviews going back and forth, the internal diagnostic, and a final reconciliation).
The reviews converged independently on the same root cause — that convergence is the
signal. No new features until Phase 0–1 are done.

Context: South African mass market, R199/month, WhatsApp-first, voice-heavy,
low-literacy, high-accountability.

---

## 1. The unanimous diagnosis
The system is **architecturally inverted: it decides what to *do* before it
understands what the user *means*.**

Current pipeline: `Safety → 223 handlers (claiming messages) → tools → brain (fallback) → agents`.
That is a transactional flow — it treats conversation as obstacles to route, not a
relationship to understand. It is why a sick client gets nagged for steps, why "map
my journey" dumps a workout, and why a video gets silence. **The LLM isn't the
problem; the skeleton holding it is.**

## 2. The golden rule
> **Every message must increase Coach K's understanding of the client before it
> increases the amount of code that runs.**

- Understanding first — before action, logging, scheduling, replying.
- Action is a derivative — only after intent + emotional state are understood.
- Reply is last — the coach *thinks* (internal assessment) before it speaks.

## 3. The target architecture — the "Pulse" model
One continuous loop that updates a shared understanding. Stop thinking "handlers."

```
1. RECEIVE (text/voice/video) → immediate ack ("Got it, let me listen…") — kills silence
2. SAFETY TRIAGE (deterministic, inviolate) → crisis/injury/pain → STOP, no LLM
3. MEANING ENGINE (one Brain / one owner):
     a. READ the Unified Understanding
     b. "What is happening? What changed?"
     c. "How does this update my understanding of this client?"
     d. "What does this client need now?" (validation / data / permission / push)
     e. "Given I am Coach K — should I ACT (log/schedule) or just TALK?"
     f. Generate an INTERNAL PLAN (not the reply yet)
4. EXECUTE (only if action required → deterministic tool)
5. GENERATE REPLY (wording/tone/structure from the plan)
6. UPDATE UNDERSTANDING (persist trustworthy state; infer the volatile)
```

### The Unified Understanding (the "cortex") — abstract schema, builder picks storage
```ts
interface UnderstandingState {
  profile: {                       // persistent, updated ~daily
    name: string;
    lifeStory: string;             // ~50-word evolving narrative
    keyFacts: string[];            // injuries, job, family, goals
    preferences: { numberFree: boolean };
  };
  current: {                       // per message
    mood: 'frustrated'|'anxious'|'motivated'|'neutral'|'hopeful';
    healthStatus: 'sick'|'recovering'|'healthy';
    topic: 'recovery'|'nutrition'|'workout'|'life'|'gratitude';
  };
  observations: {                  // the coach's wisdom, over days — the missing piece
    confidenceTrend: 'rising'|'stable'|'falling';
    frustrationLevel: number;      // 1-10
    readinessToPush: 'low'|'medium'|'high';
    trustLevel: number;            // 1-10
  };
  stats: {                         // objective baseline
    streak: number;
    weightDirection: 'up'|'down'|'stable';
    recentProteinAvg: number;
    recentStepAvg: number;
  };
}
```
`observations` is what separates a coach from a chatbot — it lets Coach K reference
the past ("how's the flu?", "remember how good you felt last week?") without a giant
history log.

## 3a. Four structural safeguards (ARMOR — do not skip)
These are non-negotiable implementation details that prevent hidden landmines around
Day 21–30. The 60-day roadmap is only safe with all four in place.

**A. Two AI passes — never let the replier also write the state (the "State Update Trap").**
If the same model both writes the reply AND updates `UnderstandingState`, it will
reverse-engineer the state to justify its own reply (give a harsh push, then
hallucinate "readinessToPush: high" to excuse it). Split into two passes:
1. **Perception pass** (cheap/fast model): raw message + current state → outputs
   ONLY the updated `UnderstandingState` (new mood, frustration, lifeStory delta).
2. **Action pass** (the Orchestrator): raw message + the freshly-updated state →
   Assess → Plan → Reply.
Fact-finding is separated from decision-making, so the reply can't corrupt the state.

**B. A Judge LLM scores shadow mode — build it BEFORE Day 1.**
No human scores 200+ shadow replies/day; that abandons shadow mode within a week.
A judge model (gpt-4o-mini + strict rubric) receives `[client message] + [old reply]
+ [new reply]` and scores 0–10 on **State Adherence** (did it remember the sickness?),
**Intent Accuracy** (did it avoid the workout trap?), **Tone Consistency**. Humans
review ONLY ties and low scores. This makes the "5 consecutive days better" threshold
objective and scales infinitely.

**C. A Prompt Compiler renders state → a ~30-word narrative before injection (protect R199 margin).**
Never dump raw `UnderstandingState` JSON into the prompt every message — it blows the
token budget. A compiler step turns it into a compressed blurb:
`"Bonolo's confidence has dropped over 3 days. She's frustrated and sick — she needs
reassurance, not a push."` (~60% fewer input tokens than the JSON.)

**D. A post-transcription SA-English cleaner sits before the Meaning Engine.**
South Africans code-switch ("Yoh, I'm feeling mos kak today, neh?") and use local
food words (samp, morogo). Generic STT butchers these — and that corrupts the whole
reply (real failure: "samp" → "stamp" → a lecture on the wrong food). After
transcription, pass the raw transcript to a cheap model: *"Clean this South African
English voice transcript — fix local slang (mos, neh, yoh) and SA food words, keep the
emotional tone intact."* The Meaning Engine then gets a clean signal even when STT
produces garbage.

## 4. Critical pragmatism (avoid over-correction)
"Delete 170 templates tomorrow" and "flip `MODEL_BRAIN=ON` immediately" are reckless.
**Shadow-mode first, incremental always.**

- **Shadow mode (weeks 1–2):** current system replies live; the new Meaning Engine
  processes silently and logs its reply. Compare daily against a humanity rubric
  (understood intent? referenced sick state? avoided generic empathy?). Proceed only
  when the new system beats the old for **5 consecutive days**.
- **Template demotion (incremental):** sort templates by volume; route the top
  conversational intents to the Meaning Engine first; expand once flawless; archive
  the long tail last. Never nuke billing/safety edge cases in one commit.
- **Persist only what you can trust.** If the LLM writes "mood" inconsistently the
  state becomes toxic — validate every state write; infer volatile fields per message.

## 5. Do / Don't (consolidated)
| Do | Don't |
|---|---|
| Build a **Meaning Engine** — one place raw text becomes understanding | Build a mini-model **router** that classifies intent before the brain — let the brain understand |
| Write a **thinking** prompt — assess before replying | Ask only for **words** — get the assessment first |
| **Guarantee a reply** — wrap everything; silence is the enemy | **Trust state blindly** — validate LLM updates |
| Use **shadow traffic** | **Flip a flag** as a deploy strategy |
| Optimize for **predictability/consistency** | Optimize for "wow"/humanity that hallucinates |
| **Async voice** — instant ack + background processing | **Sync-block** on voice → WhatsApp timeouts |

## 6. Market-specific "why"
- **R199 margin:** cheap models for routine understanding, expensive only for
  crisis/emotional moments. The Meaning Engine must be efficient.
- **Low-literacy / voice-first:** solid transcription (incl. SA vocabulary — samp,
  morogo, pap, pilchards), plain-language replies, no jargon.
- **kJ vs calories:** SA labels are kJ; `numberFree` defaults **true**, only off if the
  client explicitly asks for numbers.
- **Accountability > information:** this market pays for a push. Remember the sickness,
  remember the motivation. That's why `observations` (confidence trend, frustration,
  readiness) are non-negotiable.

## 7. Success metrics — measure conversational health, not routing
- **State adherence:** does the reply reference health/mood/recent topic? (0–100)
- **Silence rate: 0%.** Always reply.
- **Clarification rate:** when ambiguous, ask ONE question instead of guessing
  ("map my journey" → "your workout plan, or your weight-loss timeline?").
- **Retention lift:** do clients on the new engine stay longer? (the real R199 test)

## 8. The 60-day roadmap
- **Before Day 1 — build the Judge (safeguard B):** the automated scorer must exist
  before shadow mode starts, or shadow mode dies in a week.
- **Days 1–10 — Observability & shadow:** dual-write; new engine processes silently;
  the **Judge** scores every pair daily (humans review only flags); identify top 20
  conversational templates.
- **Days 11–20 — Understanding State (two passes, safeguard A):** implement the schema
  (abstract interface; Postgres + cache); a read/write service per client; **only
  persist validated fields.** Split into a cheap **Perception pass** (writes state)
  and the **Orchestrator** (reads state, replies) — the replier never writes state.
- **Days 21–30 — the "think" prompt + Prompt Compiler (safeguard C):** rewrite the
  orchestrator prompt (Assess → Plan → Act only if explicitly asked → Reply); add the
  compiler that renders state → a ~30-word blurb before injection; dry-run 100
  historical conversations.
- **Days 31–40 — incremental rollout:** redirect the top 20 intents to the engine;
  keep long-tail + better templates (e.g. "Logged ✅").
- **Days 41–50 — async voice & video:** instant ack → queue → transcribe →
  **SA-English cleaner (safeguard D)** → engine → final reply. 0% silence on media.
- **Days 51–60 — the flip & archive:** expand engine to 100% of conversation; archive
  conversational templates (keep safety, payments, logging confirmations).

## 9. The paradigm
Not a bug problem — a paradigm shift from **pattern-matching** ("what handler matches
this keyword?") to **understanding** ("what is happening to this person?"). If a
ticket says "add a template for X" and X is conversational, the answer is: the
orchestrator handles it; only transactions stay deterministic.

**Build the pulse. Let the coach think.** The market doesn't care about the LLM
version — they care that the coach remembers they were sick, doesn't nag them for
steps, and pushes them when they need it. That is the product.

---

## Phase 0 — what the builder is doing FIRST (safe, now, fixes live failures)
These are unanimous, low-risk, and do not require the rewrite. They fix exactly what
testers hit this week:
1. **Brain: understand before act / tool-restraint** — never fire an action tool
   (workout, programme, log) unless the client explicitly asked for that action;
   open-ended/reflective/emotional → reflect, answer, or ask ONE question. *(fixes
   "map my journey" → workout)*
2. **Brain: respect active health state** — if the client mentions being sick/
   recovering, never push training/steps/schedule; lead with care. *(fixes the
   flu-patient step-nag)*
3. **Guaranteed reply** — no message of any type returns silence. *(fixes silent video)*
4. **Async voice ack** — instant "listening…", process in background.

*Canonical as of 2026-07-15. Supersedes any earlier parallel rebuild notes.*
