# KamLife Coach — Status & Direction for Third-Party Review

**Date:** 2026-07-16
**For:** independent reviewers (architecture + Meta/WhatsApp compliance)
**From:** the build team
**One-line ask:** we are balancing two opposite risks — Meta rejecting us, and
shipping a robotic/generic product. Please pressure-test both. Details below.

---

## 1. What this product must be (the bar we hold ourselves to)
A WhatsApp coach for everyday South Africans — many low-income, low-literacy,
voice-first, speaking Zulu, Xhosa, Sotho, Tswana, Afrikaans, code-switching
mid-sentence. It must feel like **one trusted human coach** that:

- understands **any** message — messy text or a voice note, in any of those languages;
- logs food, steps, and workouts from any phrasing, **including "yesterday"**, without error;
- keeps someone in a calorie deficit **or** surplus and **auto-adjusts** as their weight moves;
- scans a menu photo, fixes a grocery list;
- takes a 100kg person to 60kg, or 50kg to 70kg of muscle, **without harming their health**;
- keeps them accountable and **retained for six months** — township or suburb — at **R199/month**.

The product is **trust**, not cleverness. Target quality: **90%+**, because our users
*will* put it through the wringer. No friction. No generic pamphlets.

---

## 2. The core problem we found (and have now fixed at the root)
The original system was **architecturally inverted**: it decided what to *do*
(keyword → template) *before* it understood what the user *meant*. Hundreds of
hardcoded templates each raced to grab a message; the AI "coach" ran **last**, so
it only ever saw leftovers. That is why the product felt generic and why fixing
it had become an endless game of disabling templates one at a time.

**The fix (shipped): the inversion.** The Meaning Engine ("Coach K") is now the
**front door**. Conversation — questions, feelings, advice, myths, any SA
language — goes to Coach K *first*. Only **actions** (logging, data lookups,
commands, health/safety, billing) stay on deterministic rails, because there
being *exact* matters more than being warm. One tested rule
(`mustStayDeterministic`) decides which is which, biased so a food/step log can
**never** be lost to the AI.

This is the model both the architecture reviews and the "definitive build
document" converged on: **AI owns judgement; deterministic code owns actions.**

---

## 3. How this balances the two fears

### Meta / WhatsApp approval
- **Coach K is domain-locked.** A Domain Boundary Gate keeps it strictly a health
  coach — it warmly declines general-assistant requests (essays, code, politics).
  It is not "ChatGPT with muscles," which is what gets bots flagged.
- **Deterministic execution for anything consequential** (logging, payments,
  safety) — auditable, not a black box.
- **Safety rails**: a crisis handler (SADAG/Lifeline) runs before anything else;
  sick/injury guards; no medical claims or diagnosis.
- **Positioning (business-side)**: disclosed as an automated coach ("Coach K,
  part of your KamLife experience"), never impersonating a human or another AI.
  Compliance depends on **both** product behaviour **and** how the business is
  presented — website, onboarding copy, privacy policy, approved message
  templates, opt-in language, and the actual conversations must all read as one
  thing: a fitness coaching service. The practical test (per review): if someone
  from Meta watched ten real Coach K conversations, would they conclude "fitness
  coach," not "general AI assistant"? The Domain Gate supports that; the copy
  must match it. **These items are business/legal work, tracked separately.**
- **POPIA (SA data protection)**: user data is stored per-client and deletion is
  supported; the onboarding POPIA-consent step already runs in the pipeline. A
  formal privacy policy + data-handling review is a pre-launch business task.

### Product quality (not robotic/generic)
- Coach K understands *before* it acts, acknowledges feeling before advice, and
  never dumps a template wall.
- Multilingual and voice-first by design (SA-English transcript cleaner; the
  engine reads SA languages natively).
- Remembers the person across conversations (durable memory, now guaranteed to
  persist on every deploy).

**The whole point is that these two are not in tension here:** a disciplined,
in-lane, safety-first coach is *both* more likely to pass Meta *and* a better
product. We are not trading one for the other.

---

## 4. Reversibility & safety (how we avoid blowing up production)
Everything is flag-gated and fail-open:
- `ENGINE_LIVE` — master switch for Coach K. Off → the entire old system runs. No deploy needed.
- `DOMAIN_GUARD`, `SA_CLEAN` — independent off-switches.
- Every AI path returns the deterministic fallback on any error. Nothing can *only* break.

---

## 5. The 15-day plan to launch
| Phase | Days | What | Status |
|---|---|---|---|
| 1 — The Flow | 1–4 | Invert the pipeline: Coach K is the front door; deterministic only for actions | ✅ done |
| 2 — The Hands | 4–8 | Give Coach K tools to *act*: log food/steps/workouts from any phrasing, any language, incl. "yesterday" | ⏭ next |
| 3 — Language & Voice | 8–11 | Hard battery: logging + coaching in Zulu/Xhosa/Sotho/Tswana/Afrikaans, text + voice, must pass before launch | pending |
| 4 — Results Engine | 11–13 | Auto-adjust deficit/surplus on weight trend; menu scan; grocery-list fix; safe-math verification | pending |
| 5 — Retention, Safety, Meta | 13–15 | Human accountability nudges; safety verification; Meta positioning; final language battery | pending |
| **Closed beta** | after 5 | **20–50 real users; measure outcomes** (retention, adherence, weight trend) **before public launch** | added per review |

**Verification discipline:** each phase is proven against a real-language test
battery *before* the founder sees it — we do not ship a screenshot to be
disproven. And per both reviews, we do **not** go from Phase 5 straight to
public launch: a closed beta with real users, with outcomes measured, is the
gate. Real users expose what no document can.

**Two items the reviews correctly flagged as missing, now tracked:**
1. **Health-outcome & retention metrics (Law 17).** Conversation scores
   (trust/warmth) are not enough — investors and we care about *outcomes*. A
   dashboard tracking weekly check-in completion, workout adherence, meal-log
   consistency, average weight change, retention at 30/90/180 days, response
   latency, and human-escalation rate. Instrumented before the closed beta.
2. **Inference decay (Law 5).** Facts persist; *inferences* (mood, frustration,
   readiness) must expire (24–48h) and be re-derived each message, so the coach
   is never stuck on a stale assumption ("still treating them as anxious weeks
   later"). Scheduled into Phase 3/5.

**One boundary we hold forever (per Reviewer 1):** the Meaning Engine never
computes calories, protein, macros, dates, weights, or unit conversions — those
live in deterministic code, permanently. The engine decides; code calculates.

---

## 6. What we specifically want reviewers to challenge
1. **Meta:** given the positioning in §3, is there any remaining flag risk —
   health claims, disclosure, data/POPIA, messaging-window/opt-in rules?
2. **The `mustStayDeterministic` boundary (§2):** is "AI owns conversation,
   deterministic owns actions" the right cut for a *logging-critical* product,
   or should more (or less) stay deterministic?
3. **Phase 2 risk:** giving the engine logging tools is the one place a bug loses
   or double-writes a food log. Is delegation-to-existing-validated-loggers
   (engine decides, deterministic executes) the safest pattern, or is there a
   better one?
4. **Retention:** what would you measure at 30/60/90 days to know it's actually
   changing behaviour, not just conversation quality?

*This reflects the state of `main` at the date above. Every claim maps to code
that is inspectable; happy to walk any reviewer through it.*
