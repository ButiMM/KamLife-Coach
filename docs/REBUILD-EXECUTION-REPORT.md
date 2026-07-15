# KamLife Coach — Rebuild Execution Report

**Purpose:** an honest, auditable account of what was built against
`docs/REBUILD-BLUEPRINT.md`, how, and where it lives in the code — so an
independent reviewer can verify it. Written for a technical third party.

**Status date:** 2026-07-15
**Branch / deploy:** `main`, auto-deploys to Railway on push.
**Headline:** the full architecture from the blueprint is implemented, wired,
and verified by the offline suites. It runs **behind flags** (`ENGINE_LIVE`,
`SHADOW_ENGINE`) so it is reversible. On the objective replay scorecard the new
engine beats production **6.6 vs 4.6 / 10, winning 65 % head-to-head** over 60
real conversations. It is **not yet** flipped to 100 % — the blueprint requires
"5 consecutive winning days" before that, and that clock is the remaining gate.

---

## 0. How to verify this report
All commands run from the repo root:
```
npm run check           # TypeScript: 0 errors
npx tsx script/unit-tests.ts        # 360/360 pass (incl. new engine + refusal tests)
npm run test:routing                # 257/257 — every message routes correctly
npx tsx script/check-file-sizes.ts  # file-size guard: all OK
```
On WhatsApp, the founder number can text `replay` to get the live scorecard,
and every engine reply is tagged (`· 🧠 new engine ·` / `· old brain ·` /
`· gpt fallback ·`) on the founder number only.

---

## 1. The diagnosis we were executing against
The blueprint's unanimous finding: the system was **architecturally inverted** —
it decided what to *do* (keyword → handler → tool) before it understood what the
client *meant*. That is why a sick client got nagged for steps, "map my journey"
dumped a workout, and a video got silence.

The fix is not more handlers. It is one **Meaning Engine** that understands
first, with the deterministic layer thinned to **safety + transactions +
commands only**. Everything below serves that.

---

## 2. Component-by-component: blueprint item → implementation → file

### The "Pulse" loop (blueprint §3)
`Receive → Safety → Meaning Engine (read understanding → assess → decide act-or-talk → reply) → execute-if-needed → update understanding.`

| Blueprint element | Implementation | File(s) |
|---|---|---|
| **Unified Understanding ("cortex")** — profile / current / observations / stats | `UnderstandingState` interface + `defaultUnderstanding` | `server/understanding/state.ts` |
| **Trust gate** — never persist an LLM's unvalidated state; clamp enums/ranges | `coerceUnderstanding` (whitelists moods/health/topic, clamps 1–10 fields); `persistableUnderstanding` (only profile + observations persist; volatile & stats never) | `server/understanding/state.ts` |
| **Storage** — read/write service per client | `loadUnderstanding` / `saveUnderstanding`, upsert of the durable subset, **fail-open** | `server/understanding/store.ts`, table `client_understanding` in `shared/schema.ts` |
| **Migration-free prior** — seed understanding from existing profile/snapshot | `seedUnderstanding` | `server/understanding/seed.ts` |

### Safeguard A — two AI passes (never let the replier write the state)
- **Perception pass** (cheap model) reads message + prior → outputs **only** the
  updated state. It captures *evidence* ("goes quiet when pushed"), not
  interpretation. — `server/understanding/perception.ts`
- **Orchestrator** (the Meaning Engine) reads the freshly-updated state and
  writes the reply. It **cannot** write state. — `server/understanding/meaning-engine.ts`
This split is the "State Update Trap" defence from the blueprint.

### Safeguard B — the Judge (built before shadow, as required)
- `judgeReply` scores a reply 0–10 on **State Adherence / Intent Accuracy /
  Tone Fit**, and does an A/B compare of candidate vs production, flagging ties
  and low scores for human review. — `server/eval/judge.ts`
- Shared evaluation path used by both shadow and replay: `evaluateTurn`
  (seed → engine → judge). — `server/eval/evaluate.ts`

### Safeguard C — the Prompt Compiler (protect the R199 margin)
- `compileStateBlurb` renders the state to a tight ~30-word narrative (not raw
  JSON) — **zero extra model tokens**. Health always wins (sick → "hold rest, no
  steps"). — `server/understanding/compiler.ts`

### Safeguard D — the SA-English transcript cleaner
- `cleanSATranscript` repairs SA slang + food words STT mangles ("samp" not
  "stamp") between transcription and the engine; killswitch `SA_CLEAN=off`;
  fail-open. — `server/understanding/sa-transcript.ts`
- **Hardened 2026-07-15** after a live failure (see §5): a model refusal, a
  runaway rewrite, or a rewrite that drops >60 % of the speaker's words is
  rejected and the raw transcript is kept. Refusal detection is a precise,
  dependency-free matcher with its own unit tests. — `server/understanding/refusal.ts`

### The "think" prompt + Coach K's Constitution (blueprint §3, Days 21–30)
- **CONSTITUTION** — 8 immutable laws injected above everything, so one identity
  behaves consistently (understand first; never guess; remember the person;
  safety first; reduce shame; consistency over perfection; plain SA language, no
  numbers unless asked; **acknowledge the feeling before advising**).
- **THINK_HEADER** — Assess → Need → Act-only-if-asked → Reply-in-two-moves
  (acknowledge, then respond; never open with numbers/sets).
- **Hard deterministic guards** injected into the prompt: a **sick/recovering**
  guard and a **low-mood/mental-health** guard (the latter preserves the SADAG
  crisis line 0800 567 567 when moving emotional support to the engine).
- `pickModel` routes emotional/pushback/long messages to gpt-4o, routine chat to
  gpt-4o-mini (margin). — all in `server/understanding/meaning-engine.ts`

### Shadow mode + replay (blueprint §4, Days 1–10 & 21–30)
- **Shadow** (`SHADOW_ENGINE=on`, fire-and-forget): the new engine processes
  live traffic silently, evolves + saves state, and captures a quality signal on
  any Judge flag — no client impact. — `server/understanding/shadow.ts`
- **Replay** dry-runs real historical conversations through the engine, threads
  understanding per conversation, and has the Judge score new vs production —
  returning an objective scorecard. Runnable from the shell **or** by texting
  `replay`. Turns that stay deterministic (safety/transactions/commands) are
  excluded so the engine is graded only on its real territory. —
  `server/eval/replay.ts`, `script/replay-harness.ts`

### Incremental rollout (Days 31–40)
Conversational advisory handlers now **defer to the engine when `ENGINE_LIVE=on`**
and remain the fallback when off. Redirected: frustration, progress / "how am I
doing" (×3 duplicate handlers killed), motivation/struggle, braai & social-event
food, SA holiday meal guides, meal-timing, general stress/mood support,
intermittent-fasting advice, and conversational tails in lifecycle / early-
commands / food-context. — `server/routes.ts`, `server/handlers/*.ts`

**Deliberately kept deterministic** (this is the blueprint's split, not an
oversight): all data-display (weight trend, stats, reports, calendar, workout
history, "what should I eat next" which reads today's *remaining* macros),
transactions (logging, NPS, challenge join, fast start/stop, mood-score log),
safety (crisis, injury, pain triage, supplement week-gate + dosing/side-effect
questions, period/cycle), and commands (fact/tip).

### Async voice & video — 0 % silence (Days 41–50, Phase 0 #3/#4)
- **Instant voice ack** "🎤 Coach K is listening…" fired before processing. —
  `server/routes/whatsapp.ts:426`
- **Voice** transcription tries ElevenLabs Scribe → Whisper (3 attempts, quality
  signals, garble guard) → SA cleaner → **refusal hard-floor** → engine/coach
  reply; every error path returns a helpful message, never silence. —
  `server/handlers/media.ts`
- **Video** (form-check and forwarded workout videos): instant ack, async frame
  extraction + analysis, guaranteed follow-up (fallback on every branch).
- **Unhandled media type** still returns guidance — no silent drop.

### The flip mechanism (Days 51–60)
- `ENGINE_LIVE=on` routes genuine conversation to the Meaning Engine via
  `runMeaningEngineLive` (snapshot → load understanding → engine → persist →
  safety gate → sanitize → number-free strip → log), with the deterministic
  handlers deferring. Fully reversible: `ENGINE_LIVE=off` restores the old path.
  — `server/understanding/live.ts`, `server/routes.ts`
- **Archiving the demoted templates is intentionally NOT done yet.** The
  blueprint says archive last, only when the engine is flawless; until then the
  templates are the fail-open fallback. Deleting them now would remove the
  safety net.

---

## 3. Verification status (what is proven vs pending)

| Item | Status | Evidence |
|---|---|---|
| TypeScript compiles clean | ✅ | `npm run check` = 0 errors |
| Deterministic routing intact | ✅ | routing-audit 257/257 |
| Unit logic (state trust-gate, compiler, refusal) | ✅ | unit-tests 360/360 |
| Engine beats production on real data | ✅ | replay 6.6 vs 4.6, wins 65 % (60 convos) |
| 0 % silence on media | ✅ | every media path returns a reply (§2) |
| Emotional support keeps SADAG safety net | ✅ | low-mood guard + upstream crisis handler |
| "5 consecutive winning days" before full flip | ⏳ pending | requires days of live shadow/replay data |
| Template archive (Days 51–60) | ⏳ deferred by design | kept as fallback until flip proven |

---

## 4. Reversibility & safety controls (killswitches)
- `ENGINE_LIVE=off` — engine off, old pipeline serves everything.
- `SHADOW_ENGINE=off` — stop silent shadow processing.
- `SA_CLEAN=off` — transcripts skip the cleaner entirely.
- `NORMALIZER=off` — front-door intent normalizer off.
- `PROACTIVE_PAUSED=true` — global proactive-message killswitch.
Every engine/LLM path is **fail-open**: on any error it returns null and the
existing pipeline handles the message. No single failure can cause silence.

---

## 5. Honest account of a live failure and the fix (full transparency)
On 2026-07-15 testing, **every voice note** replied as if the client had said
"I'm sorry, but I can't assist with that." Root cause: the SA cleaner (safeguard
D) runs each transcript through gpt-4o-mini; on angry/profane test notes the
model **refused**, and the cleaner's only guard caught *empty* or *over-long*
output — a short refusal passed through and **replaced the real transcript**,
which was then echoed and coached on.

Fix (committed, pushed, tested): the cleaner now keeps the raw transcript unless
the output is a faithful light clean (rejects refusals, runaway rewrites, and
>60 %-word-drop rewrites); a **hard floor** in the voice pipeline discards any
refusal-shaped transcript from *any* step and asks the client to resend/type;
and unit tests lock both directions (refusals caught, genuine SA speech —
apologies, "can't do that exercise", code-switching — never discarded).

**Lesson recorded:** LLM-in-the-loop steps cannot be fully proven by offline
suites; each now has a deterministic hard floor beneath it, and live testing
remains the real acceptance gate.

---

## 6. What a reviewer should scrutinise next
1. The "5 winning days" threshold — is the replay/shadow sample representative
   enough to justify the flip? (We recommend accumulating daily scorecards.)
2. Perception-pass state quality over time — does `observations` (confidence
   trend, frustration, trust) stay trustworthy across many messages?
3. Token cost per conversation under `ENGINE_LIVE=on` vs the R199 margin.
4. Coverage of the deterministic/engine split — any conversational intent still
   trapped by a keyword handler, or any transaction wrongly handed to the engine.

*This report reflects the state of `main` at the stated date. It is generated
from the code, not aspiration; every file path above is real and inspectable.*
