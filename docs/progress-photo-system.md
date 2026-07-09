# Progress-Photo System — Design Spec (drafted 2026-07-09)

## Why
Two problems this solves, both raised from real bot tests:
1. **The bot can't see a lagging body part.** A client can *tell* it ("my chest is
   behind"), but the coach has no way to actually assess a physique or target the weak
   point in the programme. The bot even admitted "we can't change the programme here."
2. **No visual progress record.** Scale + logs miss recomposition. A photo every month
   is the truest "is this working?" signal a coach has.

## The vision (Kam, 2026-07-09)
- **Mandatory 3 photos at onboarding**: front, side, back.
- **Monthly re-shoot** of the same 3, proactively prompted.
- **Analyse them** to spot lagging vs dominant areas — *gender-aware* (females typically
  glutes/hamstrings/shoulders; males chest/back/shoulders/arms), but always the body
  part the client actually shows/names.
- **Adjust the programme's emphasis** toward the lagging areas (more targeted volume on
  the basics that hit them), never random variety.

## Hard constraints (do NOT skip)
- **`server/onboarding.ts` is a never-touch-blind file.** Mandatory photos change the
  first impression and the onboarding state machine — this needs a full read of
  `completeOnboarding()` and its state transitions before a single edit.
- **POPIA / privacy.** Body photos are sensitive personal data. Explicit consent at
  capture, a stated retention window, secure storage (NOT public URLs), and a delete
  path that removes them with the rest of the client's data (`safety.ts` deletion flow
  already exists — photos must be included). The privacy page + POPIA handler must be
  updated to name photo storage.
- **Storage.** Twilio media URLs expire; photos must be copied to our own store
  (the R2 bucket already used for DB backups is a candidate) with per-client keys.
- **Cost / frationless.** Vision analysis per photo is an OpenAI call — gate it (monthly,
  not every message). Keep the capture flow to 3 taps, no lecture.
- **Gender-aware but not presumptuous.** Coach the body part shown/named; use the
  gender prior only to break ties, never to override what the client says.

## STATUS (2026-07-09)
Most of this shipped. What existed already: capture (incl. front/side/back album),
base64 storage, deletion (POPIA cascade), a Day-0 prompt, and a baseline-vs-new
COMPARISON analysis. Added this session:
- ✅ **Baseline physique read → lagging vs dominant muscles** (`server/physique-analysis.ts`,
  hooked in `media.ts`, stored on the profile, fed to the brain snapshot). The crown jewel.
- ✅ **Monthly re-shoot job** (`jobs/progress-photo.ts`, 10:30am SAST, self-gates on 30d).
- ✅ **Day-0 prompt now asks for all three angles.**
- ✅ **The coaching advice is wired**: the brain snapshot carries the lagging read and the
  training rule prescribes targeted volume for it — so the coach already tells a client
  exactly which muscle to add volume to, from the real photo read. This IS the programme
  responding to how they look, via the coach's mouth (which is how Kam does it manually).

REMAINING — **Phase 3 below only**: the *deterministic printed programme* auto-adding sets
to the lagging muscle's lifts. Deliberately NOT rushed — see the note under Phase 3.

## Phasing (build in this order — each ships independently)
**Phase 1 — Capture + store + monthly prompt** (no analysis yet)
- Onboarding asks for front/side/back (with consent copy). Store to our own bucket.
- A `progressPhotos` table (userId, angle, url, takenAt).
- A monthly scheduler job prompts the re-shoot; store the new set.
- Deletion flow includes photos. Privacy/POPIA copy updated.
- Value even alone: the client has a visual record; the coach can eyeball it.

**Phase 2 — Analysis**
- On a completed set, one vision call assesses the physique → structured output:
  `{ dominant: [...], lagging: [...], notes }`, gender-aware. Store on the CIP.
- Feeds the brain snapshot so the coach can reference it ("your back's coming along,
  chest is still the lagging one — here's the volume tweak").

**Phase 3 — Programme adjustment** (NOT built — build carefully, not fast)
- The programme engine gains a "bias" input: add N targeted sets to the basics that hit
  the lagging muscle, within the basics-only philosophy. Deterministic — code adjusts off
  the stored `laggingAreas`, the model never mutates the programme (standing law).
- Why it's deferred: `buildDayWorkout` / `getCurrentDayExercises` render EVERY client's
  workout. A bug here breaks training for everyone at once. It needs: (1) a pure, tested
  slug→muscle-group map, (2) a set-bump that respects phase/week set schemes and basics-
  only, (3) a cap so a client with 3 lagging areas isn't handed a 90-minute session, (4)
  golden tests that the core programme output is unchanged for clients with no lagging read.
  That's a focused build with the programme engine fully in view — worth doing right.
- Interim value already delivered: the coach prescribes the lagging-muscle volume verbally
  from the snapshot, so the client gets the correct guidance today without the engine change.

## Open questions for Kam
- Onboarding: hard-block until all 3 photos are in, or allow "skip for now" with a nudge?
- Retention window for photos (30/90 days? until deletion)?
- Monthly cadence exact day/time, and does a missed month re-prompt or wait?
