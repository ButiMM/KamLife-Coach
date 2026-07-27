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
| D4 | Proactive messages are state-blind (water nudge minutes after a rage message) | 11:00 thread; **again 18:36** | Missing capability |
| D13 | "It was X not Y" (identity correction) has NO handler — "The rice was white not brown" reached the engine, which tried to DELETE the meal; the destructive bouncer vetoed it and replied "nothing removed" to someone who never asked to remove anything | 18:29 | **Missing capability** |
| D14 | "What?" / bare confusion returns the full help-menu dump instead of answering | 18:36 | Re-onboarding reflex |
| D15 | Missed-session list contradicts itself: "You missed Thursday + Friday + Monday + Tuesday. Monday is still a training day" — Monday is both missed and available, and today IS Monday | 18:36 | Date logic |
| D5 | No instrumentation — nothing measures where clients *disengage* (the reply auditor now catches defective replies; engagement/drop-off is still unmeasured) | — | Narrowed, still open |
| D6 | Two engines coexist; old brain emits malformed text ("3 meals (breakfast and lunch)", literal asterisks, truncated sentences) | 12:45 thread | Migration incomplete — highest risk item |
| D7 | Workouts do not adapt to state (sick / returning / deload) — only food targets do | — | Adaptive layer half-covered |
| D8 | Card shows 4 macro bars + raw numbers to a market that doesn't think in calories | Every card | Product design |
| D9 | Coverage: 838 foods / 18 restaurants / 46 menu items | Counted | Data grind |
| D10 | Emotional/human-state coaching is shallow (the "I'm honestly depressed, only had alcohol" case) | Kamogelo thread | Needs product decision + build |
| D11 | No monthly rand ceiling on total AI spend (per-client daily caps exist) | Code audit | Margin guardrail |
| D12 | Meta clinical-language audit not done (coach prompt contains diabetes/hypertension playbooks) | Code audit | Compliance risk |

_D1/D2/D3 were all in one thread and were fixed together, not one at a time — that is the
rule this file exists to enforce._

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
- ✅ **D1** — a session that felt BAD had no representation at all; now read, answered and remembered
- ✅ **D2** — a session described in prose ("today was my first day back") logged nothing, so
  the coach told them to train again; it now goes through the same door as "done"
- ✅ **D3** — "Wow" / "Jesus" answered with therapy-speak; a bare reaction carries no life
  content, so a feelings diagnosis is now rejected in code rather than banned in a prompt
- ✅ Logger invented food the client never said ("Rice"→"Brown rice", "Tin fish"→"Pilchards in
  tomato sauce"). The "don't rename the client's food" rule already existed — for Diet Coke
  only. Now general: entry supplies the numbers, the client's words supply the name.
- ✅ "That's the protein box ticked. 16g more to go today." — completion phrases were in the
  random opener pool regardless of whether the day was actually complete
- ✅ "Still room for a full dinner" in the reply that LOGGED dinner — the meal label was on
  that very message; the wording just never looked at it
- ✅ **"Teach me" → "Swaps for Peach"** — two existing guards, neither applied at that call
  site: "can't eat" fired the swap trigger though "can't eat ANYMORE" means full, not fussy;
  and `scanForSAFoods` ran fuzzy, so "Teach" matched "Peach" at edit distance 1
- ✅ "Can't eat anymore today, what does that mean for my goal?" had no handler at all — the
  chronic under-eating path needs "I only eat once a day" phrasing. Now answered from the
  client's real numbers.
- ✅ **The founder was the regression suite.** `server/audit/reply-defects.ts` scans real
  replies for 10 known failure patterns; `npm run audit:replies` or text *audit* to the bot.
  Its tests replay the exact screenshots from 2026-07-27 — if a detector stops catching its
  own screenshot, the auditor has silently stopped working.

## NOT DEFECTS — checked and confirmed working

- Voice/TTS costs: reserved for milestones only, per-client daily cap, killswitch, cost tracking
- Sick nutrition advice IS goal-aware (muscle_gain vs everyone else)
- Deploys reach production (verified via `version`)
