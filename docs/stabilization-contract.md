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

- [x] **Live-brain battery in the loop** _(shipped 2026-07-14; ticks fully after the
      first prod night run)_: cases moved to server/drill-cases.ts (shared by the
      manual CLI and prod), extended with the 10–13 July failures (sick-state memory,
      repeat-flu acknowledgement, third-person sickness, not-eaten-today contradiction,
      improvised dumbbell workout, circular demo instructions), run nightly at 03:00
      SAST by scheduler job runDrillNightly — failures WhatsApp the founder with the
      case names, results land in ops telemetry. The battery GROWS with every future
      screenshot — a tester failure that isn't in the battery within 24h is a
      process violation.
- [x] **Onboarding data-capture verification** _(shipped 2026-07-14)_:
      script/onboarding-e2e.ts drives three complete scripted signups through the
      real handleMessage pipeline (male gym, female home with height-estimate path,
      walk-only with weight-typed-alone), asserting every state transition, every
      captured field, and formula-exact calorie/protein/steps targets. In the npm
      test chain → runs in CI on every push. First run caught three REAL capture
      bugs: "68kg" alone stored as height 6'8" (203cm), "172cm" typed at the height
      prompt overwriting weight to 172kg, and completeOnboarding computing targets
      from stale (null) training experience — an advanced client got beginner
      calories. All three fixed with the regression pinned in the same commit.
- [x] **Video path verified** _(shipped 2026-07-14; ticks fully on the CI strict
      run)_: script/video-path-verify.ts builds REAL 10s/30s/60s clips with the same
      ffmpeg binary production uses, runs them through the real extractVideoFrames
      at both frame budgets (6 form-check / 8 workout-save), asserts frames exist,
      are valid JPEGs, and land in time; corrupt/empty buffers must degrade to []
      not throw; and every failure branch in the media handler must carry its
      fallback reply. In the npm test chain (strict on CI). Bonus hardening: the
      ffmpeg-static package can resolve while its postinstall-downloaded BINARY is
      missing — video-frames.ts now screams at boot instead of degrading every
      video silently forever, and the verify script fails a strict build on it.
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
