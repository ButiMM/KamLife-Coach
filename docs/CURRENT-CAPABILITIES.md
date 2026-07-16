# KamLife Coach — Current Capabilities (Auditable)

**Date:** 2026-07-16 · **Rule:** if a claim can't be verified by a test, an
endpoint, or a live console run, it doesn't belong in this document.
**Companion docs:** `WHAT-IT-DOES-FOR-EVERYONE.md` (vision), `STATUS-FOR-REVIEW.md` (review brief).

## Corrections to the 2026-07-16 third-party review (with evidence)
The review marked several items "not yet built." Four of those are **built and
verifiable** — the reviewer did not have console access:

| Review claim | Reality | Evidence |
|---|---|---|
| "Auto-adjustment not yet built (Phase 4)" | **Built and live for months** — 3-week weight-trend engine: fat-loss plateau (−100 kcal, protein up), losing-too-fast/GLP-1 guard (+150 kcal), muscle-gain wrong-direction & plateau bumps; gender-aware floors (1300F/1500M) | `server/scheduler/jobs/business.ts` (runAutoCalAdjust) |
| "'Yesterday' logging not yet built" | **Built and proven live** — retro-date parsing with hallucination brakes | Live battery 13/13 incl. "Ngidle inkukhu nerayisi **izolo**" → chicken+rice **yesterday**; `parseMealDate` + brakes in `routes.ts` |
| "Multilingual unverified" | **Verified live in production console** | `multilingual-battery.ts` run 2026-07-16: **13/13 passed** (isiZulu, isiXhosa, Sesotho, Afrikaans; question-guard + no-invented-numbers held) |
| "Photo analysis not built" | **Built** — baseline physique analysis (lagging areas), progress comparison, form-check from video/photo, food/menu photo scanning, step-screenshot OCR | `physique-analysis.ts`, `handlers/media.ts`, `form-check-prompt.ts` |

## ✅ Built and verified (live today)
- **Conversational engine as front door** (`ENGINE_LIVE=on`, global — all clients): understand-before-act, acknowledge-first, Constitution (incl. medical-claims ban), sick + low-mood guards, Domain Gate, memory with inference decay. *Evidence: replay scorecard 6.6 vs 4.6 (65% wins); live screenshots (sick-aware step reply, comeback plan).*
- **Logging by talking — text & voice, multilingual**: food (incl. portions), steps, weight, water, workout done; "yesterday" handling; meal-copy ("dinner same as lunch" — incl. honest refusal when lunch isn't logged). *Evidence: 13/13 live battery; 2026-07-16 tester screenshots.*
- **Compound messages**: food + water in one voice note both log (fixed 2026-07-16 from live fumble; unit-tested). Spoken amounts ("one litre") parse.
- **Onboarding** (POPIA → plan): adaptive, one question at a time; age-block <18; equipment/injury/budget/schedule/female-postpartum aware. *Evidence: onboarding-e2e suite, 3 flows.*
- **Auto-adjustment** every 3 weeks (see table above).
- **Voice pipeline**: instant ack, ElevenLabs→Whisper fallback, SA-transcript cleaner with refusal hard-floor, 0% silence on any media type. *Evidence: media fallbacks in `media.ts`; unit tests.*
- **Safety**: crisis (SADAG + coach page), injury/pain triage, sick-flow, supplement week-gate with safety exception.
- **Ops**: north-star metrics; **health-outcomes endpoint** (`/api/admin/outcomes`: goal-direction %, adherence, 30/90/180d retention, escalation rate); nightly drill canary (leak-risk vs client-safe); killswitches (`ENGINE_LIVE`, `DOMAIN_GUARD`, `SA_CLEAN`, `NORMALIZER`, `PROACTIVE_PAUSED`), all fail-open.

## ⚠️ In verification (works, still earning trust)
- Engine-as-front-door at scale: winning on replay + live tags; accumulating the "5 winning days" / tester evidence.
- Multilingual breadth beyond the 13 battery cases (Setswana/Xitsonga examples thinner; word-number brake is English-only — spelled-out isiZulu numbers fail SAFE to "not logged").

## 🔵 Not built (honest)
- Outcome dashboards populated with real cohort data (endpoint exists; needs testers).
- Closed-beta measurement cycle (20–50 users) — the launch gate.
- Formal typed inference-expiry structs & versioned per-decision audit log (behaviourally covered by decay + logging; exact frozen-doc schema deferred).
- POPIA privacy-policy/business copy review (consent step is live; legal copy is founder-side).

*Every path above is inspectable in the repo. Run: `npm test` (offline suites),
`npx tsx script/multilingual-battery.ts` and `npx tsx script/drill-battery.ts`
(live model, Railway shell).*
