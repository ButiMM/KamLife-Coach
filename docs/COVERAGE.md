# Coverage map: the whole product, one row per capability

## THE WHOLE LIST: status of every row on `main`, 21 Oct 2026 (CTO). Read this first, every day.

This table is the single list. Every row of the map below, every Codex and Grok finding, every open issue and every tester complaint is in it, and nothing lives only in a chat. The CTO's daily morning run walks every line and updates the **Status** column. The builder's week (#391) is the lines that aren't **Proven**.

**Status words:**
- **Proven**: a tester or the trace shows it on `main`.
- **Built**: merged, but no live proof yet.
- **Open**: still broken or not built.
- **Frozen**: a founder decision not to build it now.

**What moved since 15 Oct** (merged 15–20 Oct): #672 #655 #666 #671 #673 #668 #665 #667 #685 #686 #659 #687 #669 #690 #675 #634 #674 #689 #688 #692 #694 #697 #699. `main` is `692f2a0`. Closed as fixed on 21 Oct: #676 (#685), #677 (#686), #678 (#687), #679 (#688), #698 (#699).

**Morning sweep, 21 Oct:**
- **CI:** `npm test` on `main` is 38/38 green locally. `main` has no push CI.
- **Trace:** run with `TRACE_MODEL=stub` against a fresh Postgres. Every message that should write still writes: meals, the two-meal message, "same as lunch", steps, weight, workout, sleep (now written, unlike 15 Oct) and the reminder row. Memory: knee, night shifts and no fish are stored; "fine now" and "forget that" end their facts, and only "no fish" stays active.
- **New from the trace:** a resent meal with anything else in the message gets only the receipt line, so "I have diabetes. Had a kota for lunch" → "Got it — that's already in your log ✅" (#702).
- **Codex safety journey (#606, 21 Oct): six safety floors miss non-English or natural wording, all reproduced by the CTO and filed as [harm]:** isiZulu passive suicidal ideation (#704), a Setswana/Sesotho pregnancy disclosure (#705), "chest went tight, left arm tingling" (#706), Afrikaans purging (#707), an isiXhosa opt-out (#708), and metformin timing (#709). A bare "1,650" gets past the hold check (#710, EDGE). The controls passed: a third-party age of 15 doesn't block the adult, and "medicine ball" is equipment.
- **Codex before today:** there was no #606 task between the 15 Oct pause and today. The PR review on #701 found a real P1 (an outage turn loses a supplement logged beside water). The 15 Oct talk findings still reproduce at source on `692f2a0`: #682 (a "6 days logged" claim passes the verifier; the plateau check sees only 7 days) and #683 (the cousin poem escapes the floor; Afrikaans "Ek is hopeloos" isn't seen as shame).
- **Size:** server is 70,428 lines, against the 64,500 checkpoint.

### A. What the client sends
| Row | What testers need | Status | What's left | Where | Week |
|---|---|---|---|---|---|
| **A1** | A meal in words is logged (any language, any phrasing) | **Proven in trace** (stub model: every meal line writes, including two meals in one message, isiXhosa and "same as lunch"); #686 fixed "same pap but with chicken"; #326 closed | Live proof. A resend plus anything else gets only the receipt line (#702) | #702 | B, I |
| **A2** | Corrections ("Hayi, it was rice") | Built (#621, #604, #631, #650) | Live proof | — | B |
| **A3** | Food photo | Built (#605, #613, #615) | Live proof on the founder's phone: a plate and black coffee | #596 | I |
| **A4** | Voice note in any language | Open: the real audio path is not proven | A stubbed-STT end-to-end case in CI (no paid STT); real audio proven by one isiZulu and one Setswana voice note on the founder's phone | #330 | G |
| **A5** | Steps, distance screenshot | **Proven in trace** (steps) | Screenshot path not proven. Steps saved when the model is down: PR #701 (Codex P1 open) | #701 | B |
| **A6** | Water, sleep | **Sleep proven in trace** (`INSERT sleep hours=5`); #685 fixed "slept badly, taking a break" pausing check-ins | Water not in the trace; floor for outages in PR #701 | #701 | B |
| **A7** | Weigh-in; progress photos | **Weigh-in proven in trace** (`INSERT weight=87kg`) | Progress photos have no action | — | B |
| **A8** | Workout done, show today's workout | **Proven in trace** (session written, alone and beside a meal); #672 fixed the Thursday double session | A stated session in the same sentence as a correction is dropped (#684). "My knee hurt" changes the next plan: not proven | #684 #568 | C, L |
| **A9** | Equipment and form check | Frozen (founder, 30 Sep; files deleted #551) | — | — | — |
| **A10** | What to eat, swaps, restaurants | Built: the new coach answers first (#655; Codex 15 Oct: Spur reaches the coach); on a hold the restaurant guide carries no kcal (#697) | Batch 2: the remaining old food doors | #568 | C |
| **A11** | Coaching talk: stress, shame, plateaus | Built (new coach) | Two-week plateau judged on 7 days (#682, still reproduces 21 Oct) | #682 | I |
| **A12** | Goal change, "am I on track" | Partly old (`misc-commands`; #689 deleted five talk exits there) | SET_GOAL through the coach with confirm; trace case | #568 | C |
| **A13** | **Memory**: uses what they told it | **Store and end proven in trace** (knee, nights, fish stored; "fine now" and "forget" end them) | The reply's use of them is unproven live (L4); a disclosure inside a resend goes unheard (#702); 9 old stores still exist (D2) | #568 #702 | **L** |
| **A14** | Reminders | **Proven in trace** (the reminder row is written, for 15:00 SAST); held outside the window | — | — | — |
| **A15** | Sick or injured pause, pain | Old `sick-flow`; "stop messaging me for 2 weeks" pauses (#692) | Through the coach; trace case; "until the end of the month" pauses 7 days (#693) | #693 | B |
| **A16** | Stats, "how was my week" | Built (new coach, from the ledger) | A wrong logged-day count passes the verifier (#682, still reproduces 21 Oct) | #682 | I |
| **A17** | Off-topic redirect | Built (#657; #688: "medicine ball", a letter about their own training, and a log beside an off-domain ask) | "Write my cousin a birthday poem" still escapes (#683); an off-domain ask that doesn't open the message gets through (#691) | #683 #691 | D |
| **A18** | SA languages everywhere | Built (11 gate cases, isiXhosa in the trace) | Live proof per language; Afrikaans shame ("Ek is hopeloos") skips the shame-safe receipt (#683, still reproduces 21 Oct); the safety floors miss isiZulu, Setswana/Sesotho, Afrikaans and isiXhosa wording (#704, #705, #707, #708) | #683 #704 #705 #707 #708 | I |
| **A19** | Promises followed up | Built (#545, #564, #629, #652) | Shame filter on the reply after a miss | #563 | D |

### B. What the coach sends first (**proactive**)
| Row | What testers need | Status | What's left | Where | Week |
|---|---|---|---|---|---|
| **B1** | Morning message, useful, never generic | Built: one coaching check-in a day; due-day morning yields to the commitment (#652) | Live proof | — | F |
| **B2** | Evening | Built (Codex source-verified 13 Oct) | DB proof in trace | — | F |
| **B3** | Monday weigh-in | Built (#659: the ask is recorded only once delivered) | Live proof on a Monday | — | B |
| **B4** | Weekly true story | Built (#664 numbers from the ledger; #669 ends in the coach's words) | Live proof on a Sunday | — | F |
| **B5** | Programme advance | Old | Coach's words | #319 | F |
| **B6** | Welcome back after silence | Built (#666: the coach is told the gap and what they were working on) | Live proof | — | F |
| **B7** | Reminders fire | Built | — | — | — |
| **B8** | Monthly narrative | Retired (#511) | — | — | — |
| **B9** | Onboarding catch-ups | Built (#665: days 1–3 in the coach's words, from the record) | Live proof with a new tester | — | F |
| **B10** | Voice broadcasts (ElevenLabs) | Unknown if on | Check: off unless the founder wants it (cost) | — | H |
| **B11** | Outside 24h: approved template or nothing | Built (#653) | Check-in template SID approved (founder); the dashboard check-in to quiet clients reaches nobody and shows the wrong reason (#681) | #415 #681 | J |
| **B12** | Opt-out on every path | **Open [harm]:** an isiXhosa opt-out isn't recognised, so scheduled sends continue (#708) | PR #714 is in review (ATTACK: "don't send me the water reminder" opts out of everything) | #708 | **A** |
| — | Every scheduled send through one owner | Open; target changes now go through the guarded send (#671) | The other jobs | #319 | F |

### C. Money, trust, safety
| Row | What testers need | Status | What's left | Where | Week |
|---|---|---|---|---|---|
| **C1** | Signup: three natural questions, no "reply 1/2/3" | Built (#667: signup asks in words; #665: the floors lose their menus) | Live proof with a new tester | — | E |
| **C2** | Pay: R199, one clear message | Built (#576, #617, #662) | Live proof | — | E |
| **C3** | Cancel and refund do what they say | Built (#687: a refund never overwrites the cancel-by-hand task; #690: a cancel inside a sentence reaches the cancel flow; #692: "money back please" reaches the refund flow) | Live proof | — | E |
| **C4** | Delete my data | Built (#625) | — | — | H |
| **C5** | Under 18 | Built (#574) | — | — | — |
| **C6** | Pregnancy, ED, crisis, medication | Built (#579, #617, #629, #656, #658; #688 "medicine ball"; on a hold the coach gets no targets, forecast or restaurant kcal, and no earlier figures: #694, #697, #699) | **Open [harm]** (Codex 21 Oct). Merged 21 Oct: the isiZulu, isiXhosa, Sesotho, Setswana and Afrikaans crisis wording (#712 for #704) and pregnancy wording (#713 for #705). In review: Afrikaans and isiZulu purging (PR #715 for #707; ATTACK: flu is read as purging, "ngemuva" is missed) and metformin timing (PR #716 for #709; ATTACK: "take it slow" is read as timing). Still open: chest and left arm (#706); the medication floor has no SA-language medicine words (#718); the client's own earlier figures on a hold (#700); a bare "1,650" (#710) | #706 #707 #709 #718 #700 #710 | **A** |
| **C7** | Founder alerted | Built | Dashboard key strength (founder) | #417 | J |
| **C8** | Referrals | Built (#663) | The free month can be farmed: refund, reset, duplicate codes (#680) | #680 | E |

### D. Foundation, cost and quality
| Row | Need | Status | What's left | Where | Week |
|---|---|---|---|---|---|
| **D1** | One door: only floors and the coach answer | Partly: no rollback (#655); five talk exits deleted (#689) | The report floor (PR #701, Codex P1 open), then batch 2 one door family per PR, food first | #568 #701 | C |
| **D2** | One client record | Partly (D2b #565) | `memory.ts` and other stores | #568 | C |
| **D3** | One schema | Built (#673: migrations are the only authority) | — | — | H |
| **D4** | Backups restore-tested | Built (#625) | — | #611 | H |
| **D5** | Stale docs | Built (#674: 31 docs archived) | — | — | H |
| **D6** | Gate integrity: PR code never grades itself | Open | Trusted grader; held-out set owned by the CTO or founder | #368 | K |
| **D7** | **Coach Health**: every live turn scored, worst five to the founder at 07:00 | Built (#573, #584) | One-tap "bad reply" flag from testers | #360 | K |
| **D8** | **Cost**: every model call counted and capped | Built (#626, #649) | CTO's daily cost-per-client line from production `gpt_costs` (needs a read of production, which the morning run doesn't have) | #570 | H |
| **D9** | Dead code | Open: server 70,428 lines against the 64.5k checkpoint (71k on 15 Oct) | Delete with #568 batch 2 | #568 | C |
| **D10** | Admin pages | Unchecked | Check the escalations and finance pages | — | H |
| **D11** | CI can't spend production's AI budget | Built | — | — | — |
| **D12** | **Retention**: still here at 14 and 30 days | Built (#668: in the 07:00 founder inbox) | First real numbers once testers pass day 14 | — | F |
| — | Pending answers survive a redeploy | Built (#661) | — | #322 | C |
| — | Tests fail after midnight or on one weekday | Partly: the Thursday red is fixed (#672) | §4f and "step report is acknowledged" depend on the clock; pin the test clock | #404 | A |
| — | Each piece of advice linked to what happened next | Open | — | #369 | K |

### Business and founder
| Item | Status | Where | Week |
|---|---|---|---|
| POPIA Information Officer and privacy policy | Founder | #416 | J |
| Meta template approvals, check-in template SID | Founder | #415 | J |
| Dashboard key | Founder | #417 | J |
| Business registration, PayFast live | Founder | — | J |
| Manual clients vs bot comparison | Next week | #485 | K |
| Twilio vs Meta direct at 20 paying clients | Decided (#493) | #484 | K |
| Daily market, competitor and pricing check | CTO daily run (see #391, 21 Oct) | — | — |

### The never-see list (TESTER-EXPERIENCE), checked in every 07:00 worst-five and every Codex journey
"Reply 1/2/3" menus (built: C1, #667) · a receipt as the whole reply (**open: #702**) · "log a meal" nags · invented facts (**open: #682**, logged-day counts) · generic "checking in" (built: B11, #653) · two contradicting messages (built: B9, #665; C2, #662) · a shopping list on cancel · asked again for something already told (A13) · a weight-loss target when pregnant (built for English disclosures; **open for Setswana/Sesotho, #705**).

---


**Status:** agreed by the founder on 24 Sep night as the map of the whole product (`docs/ORDERS.md` §0). The CTO corrects rows. The builder keeps it current in the same PR that moves a row.
- The queue is derived from its rows.
- A message family switches to the new core only when its row is complete.
- Every "owner today" cites the file that owns it on `main`.

**Why this exists.** The replay gate (#298) is a net of **past failures**: 38 seen cases plus 12 held out. It is not a spec of the product. We drove the gate and a narrow harm list while most of the product had no row anywhere. The founder had to find that. This map is how we stop building into a narrow gap.

## How to read a row

| column | meaning |
|---|---|
| **Owner today** | the file(s) that answer or act for this capability on `main` now |
| **New core must** | `reply`: the composer only. `action`: understand emits a validated `CoachAction` (`understanding/actions.ts`), the executor (`understanding/executor.ts`) performs it, then compose. `proactive`: a scheduled send goes through the same writer. `floor`: a deterministic rule in code in front of the model; never left to the model |
| **Gate** | seen case ids in `script/replay-cases.ts`. **0** means nothing grades it. Every gate run reads this column and prints the per-row scoreboard (cases, hard pass, old-path and new-coach score) in its summary (#433). A `(scheduled)` case grades the message the real job would send |
| **Live** | how we know it works for real testers. Coach Health (#293) today is an hourly sweep only |
| **Retires** | what the switch PR deletes (see `docs/delete-list.txt`) |

A row is **complete** when:
- its "new core must" is built and its gate cases grade the new path's **stored rows and replies**;
- it has at least 5 cases, including one held out and one not in English;
- it has a live metric;
- the new core beats the old on the 3-run average, with zero hard failures.

---

## A. Conversations the client starts (inbound)

| # | Capability | Owner today | New core must | Gate | Live | Retires |
|---|---|---|---|---|---|---|
| A1 | Log food in words ("pap and chicken for lunch") | `handlers/food-context.ts`, `food-commands.ts`, `referent-log.ts`, `meal-repeat.ts`, meaning engine | action `LOG_MEAL` | finished-dinner, a-pear, dinner-same-as-last-meal, three-days-one-message, steps-10k, same-as-lunch-same-calories, portion-size-changes-calories, zulu-uphuthu-lunch, setswana-bogobe-dinner | none | food-commands, food-context, meal-repeat, referent-log |
| A2 | Correct / remove a named meal ("hayi, it was chicken") | `food-log-mgmt.ts`, `food-context.ts` | action `CORRECT_MEAL` (proposed in shadow; executor wiring comes with the switch) | decline-deletes-lunch, normaliser-j5-correction, hayi-correction, negated-multiword-food, afrikaans-rys-nie-pap-nie | none | food-log-mgmt |
| A3 | Photo of food / label / menu | `handlers/media.ts`, `food-scanner.ts`, `food-vision-prompt.ts` | action from the image (the shadow skips media today) | **0** | none | — |
| A4 | Voice note (any language) | `routes/whatsapp.ts` → transcription → re-enters as text | same as its text family | sesotho-voice-eggs-breakfast | none | — |
| A5 | Steps, distance screenshot, health sync | `steps.ts`, `distance-log.ts`, `routes/health-sync.ts` | action `LOG_STEPS` | steps-10k, zulu-steps-8000, afrikaans-12000-tree | none | — |
| A6 | Water, sleep | `water.ts`, `sleep.ts` | action `LOG_WATER`; sleep has none | water-two-litres | none | water, sleep |
| A7 | Weight, weigh-in, body/progress photos | `weight.ts`, `media.ts`, `physique-analysis.ts`, `weight-context.ts` | action `LOG_WEIGHT`; photos have none | weigh-in-in-words | none | — |
| A8 | Workout done / lifts / "show my workout" | `handlers/workout.ts`, `workout-state.ts` | action `SHOW_WORKOUT`, `LOG_WORKOUT` (proposed in shadow) | moved-workout, knee-hurt-on-run, finished-leg-day, skipped-gym-not-done, setswana-gym-yesterday | none | — |
| A9 | Equipment / form check from photo or video | `equipment-vision.ts`, `form-check-prompt.ts`, `video-frames.ts` | reply from the image | **0** | none | — |
| A10 | "What should I eat tonight", swaps, grocery, restaurants, street food | **`core/coach.ts` (wave 1 ON, #445)**; tools: `restaurants.ts`, `food-swaps.ts`, day ledger. Street food, meal plans and pasted lists keep their owners | reply (from facts and targets) | what-to-eat-tonight, no-fish-remembered, swap-white-bread, grocery-on-a-budget, kfc-what-to-order, afrikaans-eggs-bread-cheese, night-shift-what-to-eat | none | gpt-block, advice-commands |
| A11 | Coaching talk: stress, shame, plateaus, "I need more help" | **`core/coach.ts` (wave 1 ON, #445)**; a report inside a feeling hands back to the logger | reply | shame-after-takeaway, stress-and-takeaways, need-more-help, plateau-three-weeks, setswana-tired-of-trying, shop-owner-no-time | none | gpt-block |
| A12 | Goal change, targets, "am I on track" | `misc-commands.ts`, `adaptive-targets.ts`, `targets.ts` | action `SET_GOAL` (proposed in shadow; `lifecycle.ts` confirms first) | building-phase-goal, time-to-cut, should-i-change-goal-question, what-are-my-targets, am-i-on-track, afrikaans-build-muscle-goal | none | misc-commands |
| A13 | Remembering what they said (injury, race, pregnancy, dislikes) | 9 stores (see D2); `core/client-record.ts` is the one kept | facts via `applyFacts`; the old stores backfilled on the first read (#414) | comrades-knee-memory, third-party-pregnancy, no-fish-remembered, old-knee-on-switch-day | none | the 8 other stores |
| A14 | Reminders | `reminders-handler.ts`, `reminders.ts` | action `SET_REMINDER` | remind-me-vitamins | none | — |
| A15 | Sick / injured pause, pain triage | `sick-flow.ts`, `pain-triage.ts` | action `SET_SICK`/`END_SICK` + floor for red-flag pain | knee-hurt-on-run | none | sick-flow |
| A16 | Stats, streaks, NPS, supplements, motivation, "how was my week" | **`core/coach.ts` (wave 1 ON, #445)** from `ledgerNumbers`; explicit card commands (progress, scorecard, targets) keep their cards | reply from real numbers | how-was-my-week, protein-so-far-today, streak-one-day, creatine-question, afrikaans-calories-today, travel-week-how-am-i-doing | none | misc-commands, numbers-literacy |
| A17 | Off-topic (CV, crypto, homework) | `understanding/domain-guard.ts` in front of **`core/coach.ts` (wave 1 ON, #445)** | floor | business-plan-for-gym, cv-skipped-gym-control, crypto-tip, maths-homework, isizulu-write-my-cv, roster-request-offtopic | none | — |
| A18 | Mixed languages: Setswana, isiZulu, isiXhosa, Sesotho, Afrikaans, SA slang | normaliser, `sa-transcript.ts`, `voice-language.ts` | every row above | hayi-correction, afrikaans-eggs-bread-cheese, setswana-tired-of-trying, afrikaans-calories-today, isizulu-write-my-cv, zulu-uphuthu-lunch, setswana-bogobe-dinner, afrikaans-rys-nie-pap-nie, sesotho-voice-eggs-breakfast, zulu-steps-8000, afrikaans-12000-tree, morning-after-a-zulu-day, evening-after-afrikaans-lunch, monday-weigh-in-setswana-client, phase-up-xhosa-client, silence-after-xhosa-week | none | — |

## B. Messages the coach starts (proactive): **none of this is graded**

| # | Capability | Owner today | New core must | Gate | Live |
|---|---|---|---|---|---|
| B1 | Morning message | `scheduler/jobs/morning.ts`, `morning-message.ts` | proactive via one writer (#319) | morning-after-a-logged-day, morning-after-a-zulu-day | none |
| B2 | Evening "what happened today" | `jobs/evening.ts` | proactive | evening-after-lunch-logged, evening-after-afrikaans-lunch | none |
| B3 | Monday weigh-in | `jobs/monday.ts` | proactive | monday-weigh-in, monday-weigh-in-withheld, monday-weigh-in-setswana-client | none |
| B4 | Weekly report, shopping-list card | `jobs/weekly.ts`, `weekly-recap.ts` | proactive (journey 7) | how-was-my-week, weekly-report-with-logs (scheduled) | none |
| B5 | Programme advance / today's workout | `jobs/programme.ts`, `programme.ts` | proactive | phase-up-xhosa-client | none |
| B6 | Re-engagement / back after a week | `morning.ts` (A/B), `engagement.ts` | proactive | back-after-a-week, morning-after-nine-silent-days (scheduled), silence-after-xhosa-week | none |
| B7 | Reminders firing | `jobs/reminders.ts` | proactive | vitamin-reminder-fires (scheduled) | none |
| B8 | Monthly narrative, CIP update | `jobs/cip-update.ts` (the monthly send `jobs/narrative.ts` retired 30 Sep, #511) | retire into the record | **0** | none |
| B9 | Onboarding catch-ups | `jobs/onboarding.ts` | proactive | day-two-of-the-programme (scheduled) | none |
| B10 | Voice broadcasts, recaps (ElevenLabs) | `routes/voice-broadcast.ts`, `tts.ts` | proactive | **0** | none |
| B11 | The WhatsApp 24-hour window; templates outside it | `whatsapp-templates.ts`, `outbound-authority.ts` | floor | **0** (#327) | none |
| B12 | Opt-out honoured on every send path | `outbound-authority.ts` | floor | opt-out-natural-language, opt-out-with-diagnosis, opted-out-gets-no-morning | none |

## C. Money, account, trust

| # | Capability | Owner today | New core must | Gate | Live |
|---|---|---|---|---|---|
| C1 | Signup, first day, onboarding questions | `onboarding*.ts` (6 files) | action + reply (the gate has no shadow score for it today) | first-day-no-forms, minor-onboarding | none |
| C2 | Pay, pay link, failed payment, grace | `routes/payments.ts`, `jobs/business.ts`, `conversion.ts` | floor + reply | how-do-i-pay | none |
| C3 | Cancel, save menu, refund guarantee | `lifecycle.ts`, `payments.ts` | floor + action (missing: `CANCEL`, `REFUND`) | cancel-stops-billing | none |
| C4 | Delete my data (POPIA) | `handlers/safety.ts`, `data-export.ts` | floor | popia-delete | none |
| C5 | Under 18 | `onboarding.ts` | floor | minor-onboarding, age-nine-mid-conversation | none |
| C6 | Pregnancy, eating disorders, medication, crisis | `safety-detection.ts`, `medication-context.ts`, `crisis-reply.ts`, `despair.ts` | floor | pregnancy-target, purging-disclosure, insulin-omission, insulin-double, antibiotic-choice, antibiotics-train-control | none |
| C7 | Escalation to the founder | `chat-log.ts`, the escalations table | floor | fifteen-days-silent-is-flagged (scheduled), asks-for-a-real-person | dashboard only |
| C8 | Referrals, QR joins | `onboarding-referral.ts`, `join-qr.ts` | action | invite-a-friend | none |

## D. Foundation (not client-facing, but everything rests on it)

| # | Area | State on `main` | Owed |
|---|---|---|---|
| D1 | One writer, one sender | 54 exits before the engine, 104 send sites in 34 files, 46 model calls (`docs/mouths.json`) | each switch lowers them; #319 for proactive |
| D2 | One record of the client | 9 stores: `memory.ts`, `users.profile_notes`, `client_understanding` (lifeStory), CIP narrative, `portion-memory.ts`, `held-constraints.ts`, `chat_history`, `client_facts`/`client_events` (kept) | delete each store's writes and reads in its switch PR |
| D3 | Schema | two systems (#343) | one |
| D4 | Backups | never test-restored (#342) | a restore drill + an alert |
| D5 | Docs | contradict ORDERS (#331) | archive |
| D6 | Gate integrity | the held-out set lives in the builder's repo; PR code grades itself (#368) | trusted grader; held-out owned by the CTO/founder |
| D7 | Live quality | the Coach Health hourly sweep exists (`routes/admin-turns.ts`, `pages/coach-health.tsx`); no per-turn score and no digest | #293: score every live turn on the never-see list and its journey, plus a daily digest |
| D8 | Cost / latency live | measured in the gate only; `spend-watchdog.ts` caps spend | per-message cost and reply time on the dashboard |
| D9 | Dead code | `docs/delete-list.txt`: 42 files, no dates | a date per file, tied to its switch |
| D10 | Web + admin | 17 client pages, ~60 admin/dashboard routes; not in any journey | decide which founder-critical pages (escalations, finance) need checks |

---

## What this map says, in one screen

1. **The new core covers A10, A11 and part of A13, in shadow.** Those are the rows where it only has to talk. Everywhere a client expects something **done** (A1–A8, A12, A14–A15, C1–C3, C8), it has no action wired. The action contract and executor already exist in `understanding/`; they must be connected to `understand()`, and the gate must grade the new path's stored rows.
2. **Section B, everything the coach sends first, has no gate case.** Journey 5 is graded on two inbound replies.
3. **Many rows have zero cases:** A3, A4, A6, A7, A9, A12, A14, B1–B11, C2, C7 and C8. Almost nothing is tested outside English.
4. **No row has a live metric.** "Done" in `TESTER-EXPERIENCE.md` is a week of real traffic, which we cannot see yet.

## Proposed order (for the CTO to accept or change)

1. **Gate honesty first:**
   - the per-case new-core column (#389);
   - the stored-state checks run on the new path;
   - the trusted held-out grader (#368).
2. **Wire actions into the core**, starting with A1 and A2 (food, the most-used row), then A5–A8.
3. **Grow the corpus to at least 5 cases per row**, from real tester traffic, with one non-English case per row. Add proactive replay for section B.
4. **Build Coach Health per turn (#293)** in parallel, so live data exists before the first switch.
5. **Switch row by row**, deleting that row's handlers and stores in the same PR. Section C floors stay in code, ahead of the model, permanently.

## D11 (added by the CTO): the cost firewall

| Row | Capability | Today | Must be |
|---|---|---|---|
| D11 | CI and the gate can never spend production's AI budget | On 24 Sep the live-model gate ran on every push of every PR (docs included) and emptied the OpenAI credits. If production shares that account, the live coach fails too. | The gate runs only on PRs labelled `ready`, `switch` or `gate`, never on docs (CTO, 24 Sep). CI uses **its own OpenAI project and key with a hard monthly budget**, separate from production's (founder action, see SYSTEM.md). Cost per gate run is reported. |

## Migration waves: every row, in order, until everything is switched and deleted

This is the whole-product plan. A wave starts when the one before it has switched, and each row inside a wave switches on its own. Every row switches under the same rule: 5+ gate cases for the row, the new core ahead on a 3-run average, zero hard failures, a real attack (Codex, or the CTO when Codex is out), and that row's old files deleted in the same PR.

| Wave | Rows | What it takes | Why this order |
|---|---|---|---|
| **1. Talk** | A10, A11, A16, A17 (with A13 memory feeding them) | reply only, no writes | The new core already does this, and it's where testers complain most (coaching 6.2, memory 4.0) |
| **2. Do** | A1, A2, A5, A6, A7 (words), A8, A12, A14, A15 | validated actions (#393) → `executor.ts` → graded on stored state | The largest share of old handlers; needs actions wired and graded first |
| **3. See and hear** | A3, A4, A7 (photos), A9, A18 | the shadow handles media; gate cases in each language | Needs wave 2's actions; voice re-enters as text |
| **4. Speak first** | B1-B10, B11, B12 | every proactive send through the one writer and sender (#319) | 15 jobs and most of the 104 send sites; needs the record from waves 1-3 |
| **5. Money and front door** | C1, C2, C3, C8 (C4-C7 are floors throughout) | onboarding and billing replies through the composer; floors stay code | Highest-risk wording; done once the core is proven |
| **6. Foundation cleanup** | D2, D3, D4, D5, D9, D10 | the 9 stores collapse to 1, one schema, a restore drill, docs, delete list at 0 | What's left once nothing reads the old stores |

Rows D1, D6, D7, D8 and D11 run alongside every wave.

## Rows added after the Grok review (25 Sep), #423

| Row | Capability | Today | Must be |
|---|---|---|---|
| A19 | Promises and follow-through ("I'll train Thursday", "no takeaways this week") | Neither a fact nor a reminder | The new coach remembers the promise, checks once, kindly, and responds to a miss without shame. 5 cases (wave 1 talk, wave 4 check-in) |
| D12 | Retention: is the client still here after 14 and 30 days? | Not measured anywhere | A live number on the founder's daily digest (#293, #377) |
| C7 (cases) | Escalation to the founder is created **and delivered** | 0 cases | 3 cases, including a visible failure when `COACH_ALERT_PHONE` is unset (#417) |
