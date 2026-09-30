# The 48 rows against the promise (#507): DRAFT for founder and CTO sign-off

The promise (CTO orders, 29 Sep) is four capabilities: **1 help me now**, **2 know my situation**,
**3 help me follow through**, **4 show it's working**. Each `docs/COVERAGE.md` row is marked:

- **Promise (n)**: needed for capability n.
- **Trust/Ops**: safety, billing, deletion, support or platform. Needed whatever the promise.
- **Not needed now**: no new work. What exists keeps running until a switch deletes it; nothing new is built for it.

Where one row holds two different things, it is split (A7, A16, B4). Nothing here changes code. Once signed off, `QUEUE.md` drops the "Not needed now" rows and `COVERAGE.md` gains the mark.

## A. What the client says

| Row | What | Mark | Why (one line) |
|---|---|---|---|
| A1 | Log food in words | Promise (2) | The day's food is most of "my situation"; everything in capability 4 is computed from it. |
| A2 | Correct / remove a named meal | Promise (2) | A record the client can't fix is a record they stop trusting. |
| A3 | Photo of food / label / menu | Promise (2) | The lowest-effort log on a phone. It already exists; it switches after wave 2. |
| A4 | Voice note, any language | Promise (1, 2) | Many clients speak rather than type. Transcription exists and re-enters as text. |
| A5 | Steps, screenshots, health sync | Promise (2, 4) | A cheap daily signal of movement. The sync webhook exists. |
| A6 | Water, sleep | Not needed now | Water logging is busywork. Sleep matters only as something said (A13), not as a tracker. |
| A7a | Weight, weigh-in | Promise (4) | The number most clients mean by "is it working". |
| A7b | Body / progress photos, physique analysis | Not needed now | Vision cost and body-image risk, and it's not needed to show progress. |
| A8 | Workout done, lifts, "show my workout" | Promise (3, 4) | The plan to follow, and the evidence it was followed. |
| A9 | Equipment / form check from photo or video | Not needed now | Vision cost, injury liability, and rare. |
| A10 | "What should I eat tonight", swaps, grocery, restaurants | Promise (1) | The most common "help me now" question. |
| A11 | Coaching talk: stress, shame, plateaus | Promise (1) | The coaching itself. |
| A12 | Goal change, targets, "am I on track" | Promise (1, 4) | Answering "am I on track" is capability 4 on request. |
| A13 | Remembering what they said | Promise (2) | Capability 2 itself: the one client record. |
| A14 | Reminders | Promise (3) | A client-set reminder is the smallest follow-through there is. |
| A15 | Sick / injured pause, pain triage | Trust/Ops + Promise (2) | Red-flag pain is a safety floor. Being sick changes what we ask of them. |
| A16a | Stats, streaks, "how was my week" | Promise (4) | Showing it's working, from real numbers. |
| A16b | NPS, supplements, motivation quotes | Not needed now | No capability needs them; the unscheduled NPS and supplement jobs were deleted in #504. |
| A17 | Off-topic (CV, crypto, homework) | Trust/Ops | A scope floor: non-clinical, and fitness only. |
| A18 | Mixed languages, SA slang | Promise (all) | A requirement on every Promise row, not a row to build alone. Each Promise row needs a non-English case. |
| A19 | Promises and follow-through ("I'll train Thursday") | Promise (3) | Capability 3's core. Spec first (#508); no code until sign-off. |

## B. What the coach sends first

| Row | What | Mark | Why (one line) |
|---|---|---|---|
| B1 | Morning message | Promise (3) | The one daily touch that carries the one action. After 1 Oct it costs money outside 24 h (template). |
| B2 | Evening "what happened today" | Promise (3) | Only as the other half of one daily touch (one proactive a day already). The loop spec (#508) decides morning vs evening. |
| B3 | Monday weigh-in | Promise (4) | The weekly measurement behind "is it working". |
| B4a | Weekly report | Promise (4) | Capability 4, sent. |
| B4b | Shopping-list card on Sunday | Not needed now | A10 answers it when asked; unasked, it's a second paid message. |
| B5 | Programme advance / today's workout | Promise (3) | The plan moves when they've earned it. |
| B6 | Re-engagement, back after a week | Promise (3) | Respectful follow-up when someone drifts. The silence ladder exists and is capped. |
| B7 | Reminders firing | Promise (3) | A14, delivered. |
| B8 | Monthly narrative, CIP update | Not needed now | It duplicates the client record (A13) and the weekly report (B4a). Retire it into them. |
| B9 | Onboarding catch-ups (days 1–7) | Trust/Ops | Activation: it teaches the product's surface, so it belongs with C1. |
| B10 | Voice broadcasts (ElevenLabs) | Not needed now | Extra spend, and no capability needs it. |
| B11 | The 24-hour window; templates outside it | Trust/Ops | The platform rule, and after 1 Oct the cost. |
| B12 | Opt-out on every send path | Trust/Ops | A hard floor. |

## C. Money, the front door, safety

| Row | What | Mark | Why (one line) |
|---|---|---|---|
| C1 | Signup, first day, onboarding | Trust/Ops | The front door. Capability 2 starts with what it collects. |
| C2 | Pay, pay link, failed payment | Trust/Ops | Billing. |
| C3 | Cancel, save menu, refund | Trust/Ops | Billing, and trust: a cancel must stop billing. |
| C4 | Delete my data (POPIA) | Trust/Ops | Legal floor (#342, #499). |
| C5 | Under 18 | Trust/Ops | Legal floor. |
| C6 | Pregnancy, eating disorders, medication, crisis | Trust/Ops | The non-clinical scope: floors, not coaching. |
| C7 | Escalation to the founder | Trust/Ops | Only for safety and billing exceptions: the founder is out of routine delivery. |
| C8 | Referrals, QR joins | Not needed now | Growth, not the promise. Keep what exists; build nothing. |

## D. Foundation

| Row | What | Mark | Why (one line) |
|---|---|---|---|
| D1 | One writer, one sender | Trust/Ops | Platform. One message per reply is also the cost rule. |
| D2 | One record of the client | Promise (2) | What makes capability 2 true instead of nine stores that disagree. |
| D3 | Schema | Trust/Ops | Platform. |
| D4 | Backups | Trust/Ops | Data safety (#342, #499). |
| D5 | Docs that contradict ORDERS | Trust/Ops | Low: archive when touched. |
| D6 | Gate integrity | Trust/Ops | With no paid gate, reduced to held-out cases owned by the CTO. |
| D7 | Live quality | Trust/Ops | The proof gate's raw material. #506 is its first slice. |
| D8 | Cost / latency live | Trust/Ops | Pricing and channel decisions (#506). |
| D9 | Dead code | Trust/Ops | Deleted in each switch. |
| D10 | Web + admin pages | Not needed now | Except the founder-critical admin views (escalations, finance, #506). A member page or app is on the deferred list. |
| D11 | CI never spends production's AI budget | Trust/Ops | Cost floor. |
| D12 | Retention at 14 and 30 days | Trust/Ops | Evidence for the business, read in #506. |

## Totals

51 rows (A1–A19, B1–B12, C1–C8, D1–D12); three are split, so 54 marks.
- **Promise: 23.** A1–A5, A7a, A8, A10–A14, A16a, A18, A19; B1–B3, B4a, B5–B7; D2.
- **Trust/Ops: 22.** A15 (which also serves Promise 2), A17; B9, B11, B12; C1–C7; D1, D3–D9, D11, D12.
- **Not needed now: 9.** A6, A7b, A9, A16b; B4b, B8, B10; C8; D10.

## Decisions this asks for

1. **B1 and B2:** one daily touch or two? This draft leaves it to the loop spec (#508), within the existing one-a-day cap.
2. **B4b:** stop the unasked Sunday shopping list (a second paid message from 1 Oct)?
3. **B8:** retire the monthly narrative into the weekly report and the record?
4. **A7b and A9:** freeze photo and video analysis beyond food (no switch, no new cases)?
