# Coverage map: the whole product, one row per capability

## THE WHOLE LIST: status of every row on `main`, 12 Oct 2026 (CTO). Read this first, every day.

This table is the single list. Every row of the map below, every Codex and Grok finding, every open issue and every tester complaint is in it, and nothing lives only in a chat. The CTO's daily morning run walks every line and updates the **Status** column. The builder's week (#391, items A–L) is the lines that aren't **Proven**.

**Status words:**
- **Proven**: a tester or the trace shows it on `main`.
- **Built**: merged, but no live proof yet.
- **Open**: still broken or not built.
- **Frozen**: a founder decision not to build it now.

**CI note:** `main` was red from 7 Oct 22:37 (#619) to 12 Oct 14:03 (#632, merged). Nothing could merge for four days. The daily run now checks `main`'s own CI first.

### A. What the client sends
| Row | What testers need | Status | What's left | Where | Week |
|---|---|---|---|---|---|
| A1 | A meal in words is logged (any language, any phrasing) | Built (#593, #597, #618, #619); trace proves the writes with a stub model | Correction plus new meal in one message (#624, PR #631 has 2 Codex P1s); same meal, same calories (#326); receipt cut to 300 chars in the coach's context (#532); live proof | #624 #326 #532 | B, I |
| A2 | Corrections ("Hayi, it was rice") | Built (#621, #604) | #624 (mixed correction plus meal) | #624 | B |
| A3 | Food photo | Built (#605, #613, #615) | Live proof on the founder's phone: a plate and black coffee | #596 | I |
| A4 | Voice note in any language | Open: the real audio path is not proven | Prove the real Twilio audio path, isiZulu and Setswana | #330 | G |
| A5 | Steps, distance screenshot | Built (steps proven in trace) | Screenshot path not proven | — | B |
| A6 | Water, sleep | Water built; sleep has no new-coach action | Sleep via the coach | — | B |
| A7 | Weigh-in; progress photos | Weigh-in built (#594, #620) | Progress photos have no action | — | B |
| A8 | Workout done, show today's workout | Built (#618, #623) | "My knee hurt" changes the next plan: not proven (old programme card ignores the record, #568) | #568 | C, L |
| A9 | Equipment and form check | Frozen (founder, 30 Sep; files deleted #551) | — | — | — |
| A10 | What to eat, swaps, restaurants | Built (new coach) | Restaurant card and early commands still answer before the coach | #568 | C |
| A11 | Coaching talk: stress, shame, plateaus | Built (new coach) | Live quality only via the 07:00 worst-five (D7) | — | I |
| A12 | Goal change, "am I on track" | Partly old (`misc-commands`) | SET_GOAL through the coach with confirm; trace case | #568 | C |
| A13 | **Memory**: uses what they told it | Built: facts stored and read every turn (Codex verified). **Open: "forget X" can't retire a fact (#636, Codex 12 Oct)** | Old doors don't read it (#568); facts inside other messages (L2); "fine now" and "forget X" (L3); live proof (L4); 9 old stores still exist (D2) | #568 | **L** |
| A14 | Reminders | Built (#537) | — | — | — |
| A15 | Sick or injured pause, pain | Old `sick-flow` | Through the coach; trace case | — | B |
| A16 | Stats, "how was my week" | Built (new coach, from the ledger) | — | — | I |
| A17 | Off-topic redirect | Built | A coaching word vetoes a real off-topic ask | #354 | D |
| A18 | SA languages everywhere | Built (11 gate cases, isiXhosa in trace) | Live proof per language | — | I |
| A19 | Promises followed up | Built (#545, #564, #629) | Shame filter on the reply after a miss | #563 | D |

### B. What the coach sends first (**proactive**)
| Row | What testers need | Status | What's left | Where | Week |
|---|---|---|---|---|---|
| B1 | Morning message, useful, never generic | Built, one coaching check-in a day | Due-day morning plus evening (Grok 6): verify | #563 | F |
| B2 | Evening | Built | "They trained but logged no food, evening says silent" (Grok 4): verify fixed | #563 | F |
| B3 | Monday weigh-in | Built | Ask recorded before it's delivered | #297 | B |
| B4 | Weekly true story | Scheduled (#517) | In the coach's words, from the record | — | F |
| B5 | Programme advance | Old | Coach's words | #319 | F |
| B6 | Welcome back after silence | Built, not proven | Trace case | #319 | F |
| B7 | Reminders fire | Built | — | — | — |
| B8 | Monthly narrative | Retired (#511) | — | — | — |
| B9 | Onboarding catch-ups | Old | Coach's words | — | F |
| B10 | Voice broadcasts (ElevenLabs) | Unknown if on | Check: off unless the founder wants it (cost) | — | H |
| B11 | Outside 24h: approved template or nothing | Open: generic template substitution still reachable (Codex R7) | No generic substitute; check-in template SID approved (founder) | #327 #415 | F, J |
| B12 | Opt-out on every path | Built | — | — | — |
| — | Every scheduled send through one owner | Open | — | #319 | F |

### C. Money, trust, safety
| Row | What testers need | Status | What's left | Where | Week |
|---|---|---|---|---|---|
| C1 | Signup: three natural questions, no "reply 1/2/3" | **Open: still numeric menus** (Codex) | Natural onboarding; keep consent and age gates | — | E |
| C2 | Pay: R199, one clear message | Price built (#576, #617) | Payment welcome is five bubbles (Codex) | — | E |
| C3 | Cancel and refund do what they say | Built (#617) | An owed refund or unconfirmed cancel shows every morning | #572 | E |
| C4 | Delete my data | Built | Failed backups never expire (R8) | #611, PR #625 | H |
| C5 | Under 18 | Built (#574) | — | — | — |
| C6 | Pregnancy, ED, crisis, medication | Built (#579, #617, #629) | "Can I take an antibiotic…" phrasing; nutrition direction with no professional | #353 #329 | D |
| C7 | Founder alerted | Built | Dashboard key strength (founder) | #417 | J |
| C8 | Referrals | Old | Coach's words | — | E |

### D. Foundation, cost and quality
| Row | Need | Status | What's left | Where | Week |
|---|---|---|---|---|---|
| D1 | One door: only floors and the coach answer | Open: old doors still answer talk | Inventory and delete | #568 | C |
| D2 | One client record | Partly (D2b #565) | `memory.ts` (904 lines) and other stores | #568 | C |
| D3 | One schema | Open | — | #343 | H |
| D4 | Backups restore-tested | Built | R8 (above) | #611 | H |
| D5 | Stale docs | Open | Archive | #331 | H |
| D7 | **Coach Health**: every live turn scored, worst five to the founder at 07:00 | Built (#573, #584) | One-tap "bad reply" flag from testers | #360 | K |
| D8 | **Cost**: every model call counted and capped | Open: the new coach's and photo calls aren't counted | PR #626, then my daily cost-per-client line | #570 PR #626 | H |
| D9 | Dead code | Open: 8 files, 4,068 lines; server 71k vs 64.5k checkpoint | Delete with #568 | #568 | C |
| D10 | Admin pages | Unchecked | Check escalations and finance pages | — | H |
| D11 | CI can't spend production's AI budget | Built | — | — | — |
| D12 | **Retention**: still here at 14 and 30 days | **Open: not measured anywhere** | One number in the 07:00 report | #423 | F |
| — | Pending answers survive a redeploy | Open | — | #322 | C |
| — | Tests fail after midnight | Open | — | #404 | A |
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
| Daily market, competitor and pricing check | CTO daily run | — | — |

### The never-see list (TESTER-EXPERIENCE), checked in every 07:00 worst-five and every Codex journey
"Reply 1/2/3" menus (**open: C1**) · a receipt as the whole reply · "log a meal" nags · invented facts · generic "checking in" (**open: B11**) · two contradicting messages (**open: C2's five bubbles**) · a shopping list on cancel · asked again for something already told (A13) · a weight-loss target when pregnant (built).

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
