# Status log

One line per merged PR: `HH:MM SAST · agent · PR # · what changed · gate before → after · +lines / −lines`.
"gate n/a" until the replay gate (#270, PR #298) records its first live baseline (blocked on the OpenAI key, 401).

23 Sep 13:22 · Claude Code · #277 · Cancelling stops PayFast billing; a charge after cancelling no longer reactivates the client; ITN signature order fixed · gate n/a · +840 / −33
23 Sep 22:59 · Claude Code · #283 · Pregnancy and disordered eating routed before any reply; numbers withheld on both doors; founder alerted · gate n/a · +563 / −25
24 Sep 10:40 · Claude Code · #304 · One sex- and age-aware calorie floor read by every target writer; no man below 1,500 kcal · gate n/a · +309 / −20
24 Sep 10:57 · Claude Code · #285 · Opt-out in the client's own words, honoured on every send path including payments and broadcasts · gate n/a · +591 / −100
24 Sep 12:09 · Claude Code · #307 · "Delete my data" deletes the client row and everything that cascades; billing cancelled first; true copy · gate n/a · +323 / −44
24 Sep 12:09 · Claude Code · #290 · No log-a-meal nags to a present client, no invented absences, weigh-in ask at most weekly, "finished dinner" logs, trial removed · gate n/a · +653 / −484
24 Sep 13:47 · Claude Code · #367 · AI spend cap fails safe: account-wide daily hard ceiling; unreadable spend means "over"; the meaning engine checks the cap · gate n/a · +325 / −47
24 Sep 13:47 · Claude Code · #352 · Dead code deleted: Replit scaffolding and its two tables, 15 unscheduled jobs, 28 UI components, 13 scripts · gate n/a · +78 / −6,737
24 Sep 13:55 · Claude Code · #374 · npm audit 12 → 0 vulnerabilities, lockfile only · gate n/a · +275 / −737
24 Sep 13:56 · Claude Code · #372 · Delivery-status webhook refuses every request without a Twilio token · gate n/a · +73 / −9
24 Sep 14:04 · Claude Code · #298 · Customer replay gate on main: 39 cases, 8 journeys, live model and judge, reply time and cost · gate none → main baseline 3/33 hard failing, journeys 7 / 7.2 / 6.2 / 4.0 / 6.5 / 8 / 5.5 / 7.9 · +1,107 / −0
24 Sep 18:08 · Claude Code · #345 · Scope is enforced in code: off-domain asks declined without a model; a classifier outage does not refuse a client · gate green (no regression vs main) · +366 / −16
24 Sep 18:12 · Claude Code · #305 · Under-18s cannot complete signup; a stated age under 18 closes coaching · gate green (no regression vs main) · +321 / −13
24 Sep 19:13 · Claude Code · #282 · A meal decline deletes nothing; a genuine correction supersedes and is recorded · gate green (no regression vs main) · +584 / −71
24 Sep 19:13 · Claude Code · #377 · Outcomes by move: the founder's "outcomes" text compares clients who got each delivered move with those who did not · gate green · +104 / −3
24 Sep 20:14 · Claude Code · #383 · "4 — Just cancel" cancels: while a cancel answer is pending, the cancel menu owns "1".."4" and "yes" (closes #315) · gate green (no regression vs main) · +236 / −107
24 Sep 20:19 · Claude Code · #356 · The client record: every inbound message stored as sent; typed facts in the client's own voice, validated, superseded on correction; 12-month retention; erased with the client. No model call of its own · gate green (no regression vs main) · +688 / −3
24 Sep 20:24 · Claude Code · #384 · Terms and cancellation pages match the product: no trial, the price and guarantee from the same constants the product uses (closes #303) · gate green (no regression vs main) · +35 / −21
24 Sep 21:00 · Claude Code · #381 · Gate: eleven cases the new core must pass before its families switch (same-meal and portion checks read both rows, after Codex) · gate green · +124 / −0
24 Sep 21:00 · Claude Code · #380 · "Double my insulin tonight" is a dose change; the change word must act on the medicine ("more protein because I'm on insulin" stays coaching) (closes #378) · gate green (no regression vs main) · +15 / −1
24 Sep 21:01 · Claude Code · #385 · The 14-day money-back guarantee end to end: billing cancelled, refund owed recorded with a due date, founder task, the client told the truth (closes #328) · gate green (no regression vs main) · +247 / −9
24 Sep 21:10 · Claude Code · #386 · A minor stopped by the age gate is not billed: PayFast cancel, the truth told either way, urgent founder task when unconfirmed, no reactivation on a later charge (closes #306) · gate green (no regression vs main) · +104 / −14
24 Sep 21:53 · Claude Code · #359 · The new coach in read-only shadow: one understanding call (learns facts for the record) and one composer; never sends; off unless CORE_SHADOW=on · gate green (no regression vs main); head-to-head run 1: new coach ahead on journeys 2–7, journey 8 reply checks 6/10 · +349 / −3
24 Sep 23:25 · Claude Code · #398 · Out of OpenAI credits: the founder is alerted, and clients get an honest line instead of "try again in 30 seconds" (closes #395) · tests green; gate NOT TESTED (no CI credits) · +55 / −8
24 Sep 23:30 · Claude Code · #399 · Gate: the new coach is graded on the actions it proposes, not only on what it says (#391) · tests green; gate NOT TESTED (no CI credits) · +52 / −4
25 Sep 00:16 · Claude Code · #400 · Queue rebuilt from the coverage waves (CTO brief on #391) · docs only · +73 / −57
25 Sep 06:08 · Claude Code · #402 · Out of credits, Codex follow-ups: nested error body, honest client line, WhatsApp-normalised founder alert, retry after a dropped alert · tests green · +29 / −7
25 Sep 06:09 · Claude Code · #403 · Gate: action grading counts actions and checks their food, slot, day and numbers (Codex on #399) · tests green; gate NOT TESTED (no CI credits) · +73 / −22
25 Sep 06:12 · Claude Code · #401 · /health says whether the coach's AI calls succeed; the watch alerts the founder when they fail (closes #397) · tests green · +128 / −1
25 Sep 06:15 · Claude Code · #405 · Tests run at midday SAST whatever the hour: production-parity, log-turn, thin-evidence and food-identity stop failing after midnight (part of #404; meal-decline still clock-sensitive) · tests green · +29 / −0
25 Sep 07:08 · Claude Code · #406 · Gate: wave-1 rows A10, A11, A16, A17 reach five cases each, one per row not in English · tests green · +162 / −5
25 Sep 07:39 · Claude Code · #387 · Gate: a POPIA deletion must also erase the client record and the shadow log (#368) · tests green · +6 / −0
25 Sep 08:23 · Claude Code · #393 · The new coach proposes actions in shadow: recorded, validated, never performed; includes #408 (CORRECT_MEAL, LOG_WORKOUT, SET_GOAL) · tests green; gate NOT RUN (workflow invalid, fixed by #428) · +201 / −9
25 Sep 11:43 · Claude Code · #428 · The replay gate runs again: one env block, and a red test for any invalid workflow · tests green · +17 / −1
25 Sep 12:55 · Claude Code · #430 · The new coach's shadow keeps the scope floor in front (A17) · tests green · +27 / −5
25 Sep 13:59 · Claude Code · #426 · The new coach knows what the client told the old one: client record backfilled from the users profile (#414) · tests green; gate green · +223 / −7
25 Sep 17:16 · Claude Code · #444 · New coach: no reply without understanding (#421); its numbers come from the day ledger (#422) · tests green; gate green · +79 / −7
