# KamLife — Open Defect Ledger

**This file exists because the founder was doing the tracking.** Every failure seen in a
screenshot or a live thread is written here BEFORE any fix starts, and it is only struck out
when the fix is built, wired, tested and pushed. If a defect is not in this file, it is not
being worked on — and if it is here and open, nobody gets to say "it's fixed."

Rule: **enumerate every failure in a thread before fixing any of them.**

_Last updated: 2026-07-28_

---

## OPEN — from the 2026-07-27 conversation thread

| # | Defect | Evidence | Class |
|---|--------|----------|-------|
| D6 | Two engines coexist; old brain emits malformed text ("3 meals (breakfast and lunch)", literal asterisks, truncated sentences) | 12:45 thread | Migration incomplete — highest risk item |

_D1/D2/D3 were all in one thread and were fixed together, not one at a time — that is the
rule this file exists to enforce._

## CLOSED — 2026-07-28 (review mail)

- ✅ **The global monthly rand ceiling degraded service for everyone.** All four reviewers
  called it backwards in the same words — heavy users hit a global cap first, and heavy users
  are the ones you most need to keep. It now ALERTS the founder; margin is held by the
  per-client daily caps, which are predictable and identical for everyone.
- ✅ **The malformed-output guard triggered silently.** It now counts every decision and
  reports through the *audit* command, with the reviewer's 5% escalation line committed in
  code: past it, finishing the engine migration outranks any new feature (D6).
- ✅ **The card made the client do work.** The loudest corner said "+795 cal" — a number
  already in the text reply, answering a question nobody asked. It now carries a verdict
  (On track / Over today / Perfect day), read from the same rows the bars are drawn from.
- ✅ **The card gave the same instruction twice** ("Get protein into your next two meals" over
  "62g protein to go"). Repetition is now detected by subject, and the footer changes job
  rather than vanishing: the band gives the action, the footer gives the reason.
- ✅ **Nothing in the product was shareable.** Milestone days (streaks, whole kilos lost,
  session counts) now get an achievement card instead of a receipt — one number, one line,
  the wordmark and the address. Deliberately scarce: a card for every meal is wallpaper.
- ✅ **Full-size phone photos went to vision.** Downscaled to 1024px once, at the download, so
  every reader below gets the cheap image. Fail-open.
- ✅ **The voice guard contradicted its own copy** — it passed 16MB (about two hours) while
  telling clients to keep it under 90 seconds. Both now say three minutes.
- ✅ **Naming a condition out loud missed the clinical branch.** "I've been diagnosed with an
  eating disorder" matched *been diagnosed* and landed on own_illness — answered with "rest up,
  you'll be back". Found by the new crisis liability test, which also pins that a crisis reply
  contains no coaching vocabulary and that a quit moment never receives a helpline.
- ✅ **The scheduler recorded every job's duration and nothing read it.** Overdue and slow are
  both reported on the *audit* command, with the cadence derived from each job's own cron
  expression so it cannot drift from the schedule.
- ✅ **POPIA had erasure but no access.** *export my data* returns the client's whole record as
  text in the thread — never a hosted link to somebody's weight history. Also the cheapest
  hedge against living inside Meta's app.
- ✅ **A client who opted into numbers could get none.** The card is fail-open; when it failed,
  a *numbers:full* client's food log carried no figures anywhere. Found by the new day-one
  journey test, which drives a real signed-up client through the real pipeline.

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
- ✅ **D4** — routine proactive nudges now yield to recent friction (12h quiet window); critical
  billing/safety messages are untouched
- ✅ **D7** — training adapts to state like food already did: sick = no session, recovering /
  14-day gap = 60% load and a set dropped, and the printed set counts are rewritten so the sheet
  can never contradict the instruction above it
- ✅ **D11** — monthly rand ceiling on total AI spend (`AI_MONTHLY_CEILING_ZAR`); past it the
  expensive ops degrade while every deterministic thing keeps working
- ✅ **D13** — "the rice was white not brown" now rewrites the log instead of reaching the engine
  as a deletion
- ✅ **D14** — "What?" is a reaction to the last reply, not a request for the sitemap
- ✅ **D15** — missed-session days are named only when unambiguous; today's weekday is never
  listed as missed, and older misses are counted rather than mis-named
- ✅ **D12 (compliance)** — the prompt claimed "20 years of real coaching experience" with
  clinical populations, and gave medication instructions ("Metformin causes nausea without food
  — time it correctly", "Take ARVs with food"). Removed, condition notes reframed as ordinary
  healthy-eating guidance with the condition deferred to the client's doctor, and a
  MEDICATION_TIMING rule added to the verifier so no prompt edit can reintroduce it.
- ✅ **D8** — the card now leads with YOUR NEXT MOVE: one instruction, in food, no numbers needed
  to understand it. The bars stay underneath. The founder's open question was how to serve both
  the people who count calories and the majority who don't; the answer is ORDERING, not a setting
  — no one picks a mode, the layman reads one line and stops, the tracker reads on.
- ✅ **D10** — the band between a bad week and a crisis had nothing in it. Sustained low mood,
  drinking instead of eating and disordered eating now get an honest boundary and a real referral
  (SADAG), never deeper therapy from a fitness coach. Disordered eating pauses the numbers.
- ✅ **D5** — engagement instrumentation. Text *engagement* (or `npm run audit:engagement`):
  who is slipping right now, the drop-off curve (still logging at day 1/3/7/14/30, with
  too-new clients excluded from the denominator rather than counted as churned), and — the
  reason it exists — **what the coach said last to everyone who then went quiet**.
- ✅ **Landing page compliance.** It promised drug-food interaction handling and
  condition-specific nutrition safety, badged itself "Diabetes-friendly", and made a diagnosis
  someone's identity. All removed and reframed to welcome-first ("Your doctor told you to lose
  weight — we help you actually do it"), with a scope notice in the footer. A unit test reads
  the page source so the claims cannot return.
- ✅ **The founder was the regression suite.** `server/audit/reply-defects.ts` scans real
  replies for 10 known failure patterns; `npm run audit:replies` or text *audit* to the bot.
  Its tests replay the exact screenshots from 2026-07-27 — if a detector stops catching its
  own screenshot, the auditor has silently stopped working.

## CORRECTED — I had this wrong

- ❌ **D9 "Coverage: 838 foods / 18 restaurants — data grind" was NOT a defect.** The founder
  challenged it against the review log and was right. Review #2's guard is explicit:
  *"Undeniable-in-the-lane means deeper, not wider"*, and the invest list says
  *"SA-food photo recognition **accuracy** (fixed cost, doesn't scale with users — where trust
  is won or lost)"* — accuracy, not item count.

  The evidence from 2026-07-27 says the same thing. Not one food failure that day was a missing
  food. All three were matching/naming failures on foods already in the database ("Rice" →
  "Brown rice", "Tin fish" → "Pilchards in tomato sauce"), and **"Teach" → "Peach" is proof that
  more entries would make things worse**, not better — every added item is another fuzzy
  collision with ordinary speech.

  Replaced with a measurement instead of an argument: the auditor now counts
  `food-not-in-database` (replies where the coach correctly said "I could not price X"). If that
  number is high, coverage is real; if it's near zero, adding foods is pure risk. Run *audit*.

## NOT DEFECTS — checked and confirmed working

- Voice/TTS costs: reserved for milestones only, per-client daily cap, killswitch, cost tracking
- Sick nutrition advice IS goal-aware (muscle_gain vs everyone else)
- Deploys reach production (verified via `version`)
