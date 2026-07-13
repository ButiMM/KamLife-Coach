# Stabilization Contract — no new features until this bar is met

_2026-07-13. Declared after tester round 3. The product is FROZEN for features.
Everything below is verifiable — no "feels ready", only checkboxes._

## The honest map: rock vs sand

**Rock (verified, enforced):**
- The deterministic layer: 332 unit / 193 routing / 160 gap / 77 safety / 50 food-scanner
  checks, tsc + full suite enforced by CI on every push.
- The architecture (as of 2026-07-13): deterministic handlers outrank the model,
  product-wide. The brain is the last resort before the fallback.
- The nets: target sanity (calories/protein, daily, escalates), steps/programme bounds,
  never-silent guarantee, running-total plausibility, water/step-burn single-source.

**Sand (the real remaining foundation risk):**
1. **Conversation quality — UNMEASURED.** The brain's actual words — the thing every
   tester touches in every message — has ONE harness (script/drill-battery.ts): manual,
   needs a key, frozen at the 5–6 July failure cases, not in CI, not fed with any of
   this week's tester failures. The deterministic layer has 800+ growing checks; the
   conversational layer has a stale script. This is why every tester round "surprises" us.
2. **Input-data capture.** Bonolo's wrong calories came from profile data that was
   missing/wrong at computation time. The net now corrects survivors daily, but the
   CAPTURE (fast-track onboarding, profile updates) is not yet verified end-to-end.
3. **Media processing depth.** The 38s form-video failed silently (now never-silent,
   but the processing itself is unverified for long videos / large files).

## Why the circles happened (named, so it can't repeat)

Every tester scandal was **layer-3 (conversation) leaking through layer-1 (routing)
holes.** Each screenshot got a routing patch; the conversation layer itself stayed
unmeasured, so the next unpatched phrasing leaked again → circles. Layer 1 is now
closed structurally (handlers outrank the brain). The remaining work is making layer 3
measurable and layer 2 verified.

## The bar ("solid") — reopen features only when ALL boxes tick

- [ ] **Live-brain battery in the loop:** drill-battery extended with EVERY tester
      failure from 10–13 July (improvised workout, generic meal plan, circular
      demo instructions, "All of them" chat spiral), run automatically in production
      nightly (the prod key is already there), failures escalated to the founder
      dashboard like any other escalation. The battery GROWS with every future
      screenshot — a tester failure that isn't in the battery within 24h is a
      process violation.
- [ ] **Onboarding data-capture verification:** one scripted end-to-end signup per
      flow (full + fast-track) on the sandbox, asserting gender/age/height/goal all
      land in the DB and targets match the formula for that profile. Run before
      widening testers.
- [ ] **Video path verified:** a 10s, 30s and 60s video each produce either a real
      form-check or the graceful fallback — never silence (guarantee already live;
      verify the real replies).
- [ ] **Churn-shape reviewed with real data** (endpoint is live) and the dominant
      bucket named — so post-freeze work is aimed by data.
- [ ] **Tester green run:** one full pass of docs/live-test-script.md by a real tester
      with zero "what is this" screenshots.

## Freeze rules

1. No new features, no new proactive messages, no new prompts — refinement and
   verification only.
2. Every tester screenshot → root-cause class (routing / data / conversation / media)
   BEFORE any fix. The fix must close the CLASS (net, structural order, battery case),
   not the phrasing.
3. Every fix lands with its regression check in the same commit.
