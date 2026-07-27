# KamLife — Open Defect Ledger

**This file exists because the founder was doing the tracking.** Every failure seen in a
screenshot or a live thread is written here BEFORE any fix starts, and it is only struck out
when the fix is built, wired, tested and pushed. If a defect is not in this file, it is not
being worked on — and if it is here and open, nobody gets to say "it's fixed."

Rule: **enumerate every failure in a thread before fixing any of them.**

_Last updated: 2026-07-27_

---

## OPEN — from the 2026-07-27 conversation thread

| # | Defect | Evidence | Class |
|---|--------|----------|-------|
| D1 | Client said "felt very bad, like I never trained before" after returning from illness — completely ignored | 16:16 thread | **Missing capability** — no concept of how a session felt; nothing captures it |
| D2 | Client said "today was my first day back" → coach replied "Today: Training day — reply workout" | 16:16 thread | **Missing capability** — doesn't know a session already happened today |
| D3 | "Wow" / "Jesus" (frustration AT the bot) answered with therapy-speak about overwhelm | 16:17, 16:18 | **Missing distinction** — no separation between "struggling with life" and "annoyed with the coach" |
| D4 | Proactive messages are state-blind (water nudge minutes after a rage message) | 11:00 thread | Missing capability |
| D5 | No instrumentation — nothing measures where clients disengage | — | Must exist before any cohort |
| D6 | Two engines coexist; old brain emits malformed text ("3 meals (breakfast and lunch)", literal asterisks, truncated sentences) | 12:45 thread | Migration incomplete — highest risk item |
| D7 | Workouts do not adapt to state (sick / returning / deload) — only food targets do | — | Adaptive layer half-covered |
| D8 | Card shows 4 macro bars + raw numbers to a market that doesn't think in calories | Every card | Product design |
| D9 | Coverage: 838 foods / 18 restaurants / 46 menu items | Counted | Data grind |
| D10 | Emotional/human-state coaching is shallow (the "I'm honestly depressed, only had alcohol" case) | Kamogelo thread | Needs product decision + build |
| D11 | No monthly rand ceiling on total AI spend (per-client daily caps exist) | Code audit | Margin guardrail |
| D12 | Meta clinical-language audit not done (coach prompt contains diabetes/hypertension playbooks) | Code audit | Compliance risk |

## CLOSED — 2026-07-27

- ✅ Explicit LOG_MEAL answered with a restaurant menu 3× (`forceLog`)
- ✅ Meal plans generated at 52% of target and shipped with a warning
- ✅ "Day 0 / send baseline photos" to a months-old client
- ✅ "I need more help" threw client into programme setup
- ✅ New-programme request dumped the OLD programme
- ✅ Silent drop of named restaurant meals → now named
- ✅ Silent drop of ANY unrecognised food → now named
- ✅ "South African breakfast from McDonald's" matched nothing
- ✅ Card footer overlap ("KAMLIFEbuild…")
- ✅ Over-target macro bars rendered GREEN
- ✅ Card coaching line was a rotating platitude → now names the real gap
- ✅ Water from a previous day shown as today's
- ✅ Runs/distance screenshots logged nothing (10km = ~800 kcal invisible)
- ✅ Past-tense "I was sick" flipped a recovered client back into sick mode
- ✅ Coach could not see WHAT was eaten today — suggested lunch again for dinner
- ✅ Adaptive target engine — built AND wired (05:45 daily)
- ✅ Reply contract — built, wired, tested (flag: REPLY_CONTRACT=on)

## NOT DEFECTS — checked and confirmed working

- Voice/TTS costs: reserved for milestones only, per-client daily cap, killswitch, cost tracking
- Sick nutrition advice IS goal-aware (muscle_gain vs everyone else)
- Deploys reach production (verified via `version`)
