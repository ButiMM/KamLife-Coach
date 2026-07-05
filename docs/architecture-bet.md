# Architecture Bet — model-as-brain, code-as-guardrail

_Scoping + recommendation. Written 2026-07-05. Decision owner: Kam._

## The decision in one line

Keep the ~12,700-line deterministic keyword pipeline as the bot's **intelligence**,
or flip to a **tool-calling model as the brain**, with deterministic code demoted to
**guardrails** (safety, billing, data-write validation) + **tools** (the DB writers)?

**Recommendation: flip — but incrementally, via strangler-fig, gated by the existing
eval harness. Not a rewrite. Prove it with one measured pilot domain first.**

## Why the ground shifted (the maze was right in 2023, not now)

The deterministic-first pipeline was the correct GPT-4-era call. No prompt caching
existed, the ~15-25K-token coach prompt cost full price on every call, so you built a
maze to avoid calling GPT. Three things broke that logic:

1. **Prompt caching.** The static prefix (`COACH_K_SYSTEM` + `SCENARIO_GUIDE`, already
   authored as a cached prefix) now costs ~10% on repeat calls. The single biggest
   reason to avoid GPT is gone.
2. **Cheap strong models.** A mini-tier model in 2026 does intent + reliable
   tool-calling at a fraction of GPT-4-era cost.
3. **You already pay per message.** `classifyIntent` (gpt-4o-mini) fires on _every_
   message at entry (`routes.ts:127`, unless `NORMALIZER=off`). The maze runs _after_
   it — so the maze never saved the classification cost, only the larger gpt-4o reply,
   which is now cache-cheap.

Meanwhile the maze's cost is fixed and large: **~12,700 LOC of handlers**, and the
entire "intent-blind routing disease" we spent this whole session patching
(QUESTION/NEGATION gates, keyword whack-a-mole) is the _symptom of hand-building intent
understanding in keywords_.

## The two architectures

| | Today (maze-as-brain) | Proposed (model-as-brain) |
|---|---|---|
| Understands intent | keyword regex across ~15 handler stages | the model, natively |
| Routing | first handler whose keywords match wins | model decides + calls a tool |
| Side effects | handler writes to DB on a keyword match | model calls a tool; **guardrail validates** before the write |
| "Is this a question / a miss?" | hand-built QUESTION + NEGATION gates | model knows; guardrail double-checks irreversible calls |
| Cost driver | per-msg mini classify + gpt-4o reply on fallback | per-msg one tool-calling model call (cached prefix) |
| Bug surface | ~12,700 LOC, grows per edge case | tools + guardrails; shrinks per domain migrated |

## Cost (honest — confirm against your actual OpenAI invoice)

Expressed per message so you can plug in your real rates. Assume a mini-tier brain,
cached static prefix at ~10%, ~15-25K cached system tokens, ~2K fresh
(message + context + tool schemas), ~300 output.

- **Model-as-brain ≈ R0.02-0.05 / message** ≈ **R4-10 / user / month** at ~200
  messages. Comfortably inside R199 margin.
- **Today ≈** per-message mini classify (~R0.004) on 100% of messages **plus** a
  gpt-4o reply (cache-cheap but still the dominant line item) on the fallback share.

Net: at 2026 prices with caching, model-as-brain is **roughly cost-neutral to cheaper**
than the maze + gpt-4o fallback — while deleting the 12,700-LOC bug surface. The cost
objection that justified the maze has largely evaporated. _The pilot measures this for
real; do not commit on my estimate._

## The killer argument (beyond cost)

The flip **structurally cures the disease.** A model understands "is this a question?"
and "did they say they did NOT do it?" natively — so there is no keyword handler
blindly taking a side effect, and the QUESTION/NEGATION gates stop being necessary
(they become tool-call validation instead). We spent this entire session
hand-approximating what the model does for free.

## Migration — strangler-fig, not rewrite

**Keep (these are your reliable core → they become guardrails + tools):**
- Safety pre-filter (crisis / medical / injection) — stays first, deterministic.
- Billing / subscription / POPIA — stays deterministic. Irreversible; never
  model-controlled.
- The DB write functions (log food / workout / steps / weight, remove meal) — become
  **tools** the brain calls.
- The eval harness (unit / routing / safety / golden) — your migration safety net.

**Replace incrementally:**
1. Build a tool-calling brain behind a flag (`MODEL_BRAIN=pilot`); tools = existing DB
   writers; every irreversible tool call runs the same guardrail checks
   (`looksLikeQuestion` / `mentionsNotDone` become tool-call validators).
2. Pilot **one** domain: recommend **workout Q&A + logging** — highest bug density this
   session, bounded tool set, low blast radius.
3. Route only that domain to the brain; everything else stays on the maze. Compare on
   the test battery + measure real cost per message.
4. Expand domain-by-domain only while evals stay green and cost holds. Retire each
   maze handler as its domain flips. The pipeline shrinks; the guardrails stay.

## Risks + mitigations

- **Wrong / hallucinated tool call** → validate every irreversible call (the gates we
  built, now as tool-call guards); require confirmation before goal flips + payments.
- **Cost variance** → cheap brain + caching + the per-user call cap
  (`checkGptRateLimit`) already exists.
- **Latency** → acceptable for async WhatsApp.
- **Regression** → strangler-fig + flag + eval harness; roll back one domain instantly.

## What I recommend

1. Approve the **direction** (model-as-brain, code-as-guardrail).
2. I build the **workout-domain pilot** behind `MODEL_BRAIN=pilot`, validated by
   guardrails, measured against the eval battery + real per-message cost.
3. Decide expansion on the pilot's numbers, not this estimate.

**Do NOT:** big-bang rewrite; put billing/safety intelligence in the model; remove the
eval harness. Those three are what keep the bet safe.
