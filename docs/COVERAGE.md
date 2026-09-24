# Coverage map: the whole product, one row per capability

**Status:** DRAFT by the builder for the CTO (#391), 24 Sep. Once the CTO agrees it, this is the single map.
- The queue is derived from its rows.
- A message family switches to the new core only when its row is complete.
- Every "owner today" cites the file that owns it on `main`.

**Why this exists.** The replay gate (#298) is a net of **past failures**: 38 seen cases plus 12 held out. It is not a spec of the product. We drove the gate and a narrow harm list while most of the product had no row anywhere. The founder had to find that. This map is how we stop building into a narrow gap.

## How to read a row

| column | meaning |
|---|---|
| **Owner today** | the file(s) that answer or act for this capability on `main` now |
| **New core must** | `reply`: the composer only. `action`: understand emits a validated `CoachAction` (`understanding/actions.ts`), the executor (`understanding/executor.ts`) performs it, then compose. `proactive`: a scheduled send goes through the same writer. `floor`: a deterministic rule in code in front of the model; never left to the model |
| **Gate** | seen case ids in `script/replay-cases.ts`. **0** means nothing grades it |
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
| A1 | Log food in words ("pap and chicken for lunch") | `handlers/food-context.ts`, `food-commands.ts`, `referent-log.ts`, `meal-repeat.ts`, meaning engine | action `LOG_MEAL` | finished-dinner, a-pear, dinner-same-as-last-meal, three-days-one-message, steps-10k, same-as-lunch-same-calories, portion-size-changes-calories | none | food-commands, food-context, meal-repeat, referent-log |
| A2 | Correct / remove a named meal ("hayi, it was chicken") | `food-log-mgmt.ts`, `food-context.ts` | action (missing: `CORRECT_MEAL` naming the meal) | decline-deletes-lunch, normaliser-j5-correction, hayi-correction, negated-multiword-food | none | food-log-mgmt |
| A3 | Photo of food / label / menu | `handlers/media.ts`, `food-scanner.ts`, `food-vision-prompt.ts` | action from the image (the shadow skips media today) | **0** | none | — |
| A4 | Voice note (any language) | `routes/whatsapp.ts` → transcription → re-enters as text | same as its text family | **0** (#330) | none | — |
| A5 | Steps, distance screenshot, health sync | `steps.ts`, `distance-log.ts`, `routes/health-sync.ts` | action `LOG_STEPS` | steps-10k | none | — |
| A6 | Water, sleep | `water.ts`, `sleep.ts` | action `LOG_WATER`; sleep has none | **0** | none | water, sleep |
| A7 | Weight, weigh-in, body/progress photos | `weight.ts`, `media.ts`, `physique-analysis.ts`, `weight-context.ts` | action `LOG_WEIGHT`; photos have none | **0** | none | — |
| A8 | Workout done / lifts / "show my workout" | `handlers/workout.ts`, `workout-state.ts` | action (`SHOW_WORKOUT` exists; logging is missing) | moved-workout, knee-hurt-on-run | none | — |
| A9 | Equipment / form check from photo or video | `equipment-vision.ts`, `form-check-prompt.ts`, `video-frames.ts` | reply from the image | **0** | none | — |
| A10 | "What should I eat tonight", swaps, grocery, restaurants, street food | `gpt-block.ts`, `food-swaps.ts`, `grocery-*.ts`, `restaurants.ts`, `street-food.ts`, `shopping-lists.ts` | reply (from facts and targets) | what-to-eat-tonight, no-fish-remembered | none | gpt-block, advice-commands |
| A11 | Coaching talk: stress, shame, plateaus, "I need more help" | `gpt-block.ts` (askCoachK), meaning engine | reply | shame-after-takeaway, stress-and-takeaways, need-more-help | none | gpt-block |
| A12 | Goal change, targets, "am I on track" | `misc-commands.ts`, `adaptive-targets.ts`, `targets.ts` | action (missing: `SET_GOAL`) | **0** | none | misc-commands |
| A13 | Remembering what they said (injury, race, pregnancy, dislikes) | 9 stores (see D2); `core/client-record.ts` is the one kept | facts via `applyFacts` | comrades-knee-memory, third-party-pregnancy, no-fish-remembered | none | the 8 other stores |
| A14 | Reminders | `reminders-handler.ts`, `reminders.ts` | action `SET_REMINDER` | **0** | none | — |
| A15 | Sick / injured pause, pain triage | `sick-flow.ts`, `pain-triage.ts` | action `SET_SICK`/`END_SICK` + floor for red-flag pain | knee-hurt-on-run | none | sick-flow |
| A16 | Stats, streaks, NPS, supplements, motivation, "how was my week" | `misc-commands.ts`, `numbers-literacy.ts`, `report-card.ts`, `week-card.ts` | reply from real numbers | how-was-my-week | none | misc-commands, numbers-literacy |
| A17 | Off-topic (CV, crypto, homework) | `understanding/domain-guard.ts`, scope (#345) | floor | business-plan-for-gym, cv-skipped-gym-control | none | — |
| A18 | Mixed languages: Setswana, isiZulu, isiXhosa, Sesotho, Afrikaans, SA slang | normaliser, `sa-transcript.ts`, `voice-language.ts` | every row above | hayi-correction only | none | — |

## B. Messages the coach starts (proactive): **none of this is graded**

| # | Capability | Owner today | New core must | Gate | Live |
|---|---|---|---|---|---|
| B1 | Morning message | `scheduler/jobs/morning.ts`, `morning-message.ts` | proactive via one writer (#319) | **0** | none |
| B2 | Evening "what happened today" | `jobs/evening.ts` | proactive | **0** | none |
| B3 | Monday weigh-in | `jobs/monday.ts` | proactive | **0** | none |
| B4 | Weekly report, shopping-list card | `jobs/weekly.ts`, `weekly-recap.ts` | proactive (journey 7) | how-was-my-week (inbound only) | none |
| B5 | Programme advance / today's workout | `jobs/programme.ts`, `programme.ts` | proactive | **0** | none |
| B6 | Re-engagement / back after a week | `morning.ts` (A/B), `engagement.ts` | proactive | back-after-a-week (inbound only) | none |
| B7 | Reminders firing | `jobs/reminders.ts` | proactive | **0** | none |
| B8 | Monthly narrative, CIP update | `jobs/narrative.ts`, `jobs/cip-update.ts` | retire into the record, or proactive | **0** | none |
| B9 | Onboarding catch-ups | `jobs/onboarding.ts` | proactive | **0** | none |
| B10 | Voice broadcasts, recaps (ElevenLabs) | `routes/voice-broadcast.ts`, `tts.ts` | proactive | **0** | none |
| B11 | The WhatsApp 24-hour window; templates outside it | `whatsapp-templates.ts`, `outbound-authority.ts` | floor | **0** (#327) | none |
| B12 | Opt-out honoured on every send path | `outbound-authority.ts` | floor | opt-out-natural-language, opt-out-with-diagnosis | none |

## C. Money, account, trust

| # | Capability | Owner today | New core must | Gate | Live |
|---|---|---|---|---|---|
| C1 | Signup, first day, onboarding questions | `onboarding*.ts` (6 files) | action + reply (the gate has no shadow score for it today) | first-day-no-forms, minor-onboarding | none |
| C2 | Pay, pay link, failed payment, grace | `routes/payments.ts`, `jobs/business.ts`, `conversion.ts` | floor + reply | **0** | none |
| C3 | Cancel, save menu, refund guarantee | `lifecycle.ts`, `payments.ts` | floor + action (missing: `CANCEL`, `REFUND`) | cancel-stops-billing | none |
| C4 | Delete my data (POPIA) | `handlers/safety.ts`, `data-export.ts` | floor | popia-delete | none |
| C5 | Under 18 | `onboarding.ts` | floor | minor-onboarding, age-nine-mid-conversation | none |
| C6 | Pregnancy, eating disorders, medication, crisis | `safety-detection.ts`, `medication-context.ts`, `crisis-reply.ts`, `despair.ts` | floor | pregnancy-target, purging-disclosure, insulin-omission, insulin-double, antibiotic-choice, antibiotics-train-control | none |
| C7 | Escalation to the founder | `chat-log.ts`, the escalations table | floor | **0** (asserted inside some cases) | dashboard only |
| C8 | Referrals, QR joins | `onboarding-referral.ts`, `join-qr.ts` | action | **0** | none |

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
