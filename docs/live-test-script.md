# KamLife Coach — Live Test Script

**What this is:** a fixed checklist of ~30 real scenarios to run against the LIVE bot on
WhatsApp after every material change (deploy, prompt edit, new feature). The automated
suite (`npm test`) proves the deterministic layer offline; **this script proves the live
seam** — voice notes, photos, and free-text hitting the real model — which automation
cannot reach from the sandbox. Every scenario below is tied to a real failure found in
production testing (dates noted), so running the script IS the regression check.

**How to run it:**
1. Use a phone whose number is in `BETA_TESTERS` (or your own).
2. Go top to bottom. Send EXACTLY what the "Send" column says (voice notes where marked 🎙️).
3. Mark each ✅ / ❌. Screenshot every ❌ and send it to Claude with the test number.
4. A release is GREEN only when every test passes. One ❌ = fix before adding testers.

Tip: tests marked 🎙️ must be sent as a VOICE NOTE — half the historical bugs only
happen on the voice path.

---

## A. Greeting & orientation

| # | Send | Must happen | Real bug this catches |
|---|------|-------------|----------------------|
| A1 | `Hello` | The warm menu with today's context AND tap buttons (Today's workout / Log food / My progress). Same style every time you repeat it. | 2026-07-10: model answered "what's on your mind?" — generic, button-less, different each time |
| A2 | `Menu` | Full command list with buttons. | — |
| A3 | `Give me direction — what do I do today and this week?` | The WHOLE plan: train/rest today, eat ~X kcal + protein, steps, water, plus the simple weekly line. NOT a bare workout list. | 2026-07-09: got an exercise dump instead of the plan |
| A4 | 🎙️ Voice: "Hello coach, what should I be doing today?" | Same as A3, with the 🎤 "I heard:" echo showing your words NOT cut off mid-word. | 2026-07-10: echo cut at "discussion abou…" |

## B. Food logging — text, photo, voice

| # | Send | Must happen | Real bug this catches |
|---|------|-------------|----------------------|
| B1 | `2 eggs and pap` | Logged with kcal + protein, running total vs target in PLAIN words (no "surplus/deficit/macros"), buttons at the end. | Jargon audit 2026-07-09 |
| B2 | Photo of a cooked plate (no caption) | Identified with SA names, kcal + protein, TOTAL line, logged. One message. | — |
| B3 | Photo of a plate with visible oil/grease | Logs it, acknowledges what's good FIRST, then names the grease kindly with ONE same-food swap. | — |
| B4 | Photo of a meal cooked with lots of oil that LOOKS clean (e.g. oily stir-fry), or heavy avo/mayo | One kind "for next time" line about the hidden fat (measure the oil / light mayo). Never "your log is wrong". | Hidden-fats fix 2026-07-09 |
| B5 | Photo of a Coke/Pepsi bottle, label visible | Reads the LABEL value (or known SA value), distinguishes Zero vs regular. Send it twice — second answer must not be a different random guess. | 2026-07-08: two different guesses for the same bottle |
| B6 | `I had a Coke` | Logged + ONE "next time: Zero Sugar" swap line. Then send `I had a Coke Zero` — logged with NO swap nudge. | Swap engine 2026-07-09 |
| B7 | `Dinner is the same as lunch` | Copies today's lunch, logged as dinner, updated totals. | — |
| B8 | 🎙️ Voice: "I already told you what the plan for lunch is. Have you forgotten? We are repeating the same things." | NO meal gets logged. Bot responds to the complaint like a human. Check `show me today's meals` after — count unchanged. | 2026-07-10: this exact complaint logged yesterday's pasta |
| B9 | `Remove the last meal` | Meal removed, corrected total confirmed. | Long-standing remove_meal class |
| B10 | Photo of a product in a shop + caption `Can I eat this?` | Straight yes/no for YOUR goal + ONE swap available where you're standing (same shelf/menu). NOT logged. | Goddess_Zee gel case 2026-07-09 |
| B11 | `Show me today's meals` | The real numbered list from the log — never from memory. | — |

## C. Workouts & training

| # | Send | Must happen | Real bug this catches |
|---|------|-------------|----------------------|
| C1 | `Today's workout` | Machine-first session, sets×reps, form cue + mistake + alternative per move, "See every move" swipe link, DONE instruction. | — |
| C2 | Tap the "See every move" link | Full-screen page, swipe left/right through every exercise with sets and the no-machine alternative. Matches C1's list EXACTLY. | 2026-07-09: model invented a different workout |
| C3 | `Show me the exercises` | The REAL workout (same list as C1), never a new invented one. | Same hallucination class |
| C4 | 🎙️ Voice: "I need demonstrations" | Points you to *workout* → "See every move". NEVER says "search YouTube/online". | 2026-07-10: sent client to Google |
| C5 | `My chest is lagging — should I add an 8th exercise?` | Affirms it: targeted volume (extra sets on the chest basics / one accessory), keeps overloading same lifts. NEVER the word "muscle confusion" or a refusal. | 2026-07-09 muscle-confusion disaster |
| C6 | `Done` (after workout) | Session logged, streak/next session shown; on your 2nd-ever session it asks for a side-on form video once. | — |
| C7 | Film one set from the side, send with caption `Check my form` | What looks GOOD first, at most TWO plain fixes, one encouraging line. If unreadable: ONE kind line asking for a side angle — no guessing. | 2026-07-10: bicep curl called a bent-over row, asserted confidently |
| C8 | `Rest day today?` on a rest day | Confirms rest, names next training day, points to food/steps. Never pushes a session. | — |
| C9 | Photo of a weight stack/machine + caption `Shoulder press` | Treats the caption as truth: "Shoulder Press — got it 💪 what weight and reps?" Then reply `65kg 3x8` → lift logged. NEVER a generic "reply workout" tip. | 2026-07-10: caption ignored, client mid-set got generic tips |
| C10 | Photo of any gym machine, NO caption | ID is HEDGED ("That looks like a…") + a "got the machine wrong? reply its name" line. Reply the correct name if wrong → it coaches that machine. | 2026-07-10: row machine asserted as Hack Squat with full wrong setup |

## D. Steps, water, weight, targets

| # | Send | Must happen | Real bug this catches |
|---|------|-------------|----------------------|
| D1 | `8500 steps` | Logged vs target, plain-language note, buttons. | — |
| D2 | Screenshot of your steps app | Number read and logged correctly. | — |
| D3 | `Change my steps to 10000` (also try 🎙️ voice: "we're changing my steps to ten thousand") | Explicit confirmation "Step target … 10,000 ✅". THEN check tomorrow's morning brief says 10,000 — not the old number. | 2026-07-10: brain "agreed", saved nothing, briefs kept saying 11k |
| D4 | `Drank 1L water` | Logged with running total vs target, buttons. | — |
| D5 | `Weight 84.9` | Logged, trend line, plain words (no "metabolic/maintenance calories" jargon), buttons. | — |

## E. Progress photos

| # | Send | Must happen | Real bug this catches |
|---|------|-------------|----------------------|
| E1 | Send 3 photos (front, side, back) in one burst | ONE ack, then ~15s later ONE single breakdown for the whole set. NOT three separate essays. | 2026-07-10: three essays, front compared to back |
| E2 | Read the breakdown | Compares like angle with like angle; honest if nothing changed; if it can't compare fairly, ONE line + tip — never a general-advice essay; next action is food/steps/weight-on-same-lifts — NEVER "add deadlifts/squats". | Same incident |
| E3 | First-ever photo set (new tester) | Baseline saved + focus areas named (lagging muscles), gender-aware. | — |

## F. Money, cancellation, life events — the "must never be swallowed" set

| # | Send | Must happen | Real bug this catches |
|---|------|-------------|----------------------|
| F1 | 🎙️ Voice: "No, I don't need anything more from you. I'm cancelling my subscription." | The REAL cancellation flow fires (confirmation of stopping billing / founder alerted) — never a limp "sorry you feel that way". | 2026-07-10: brain gave condolences, cancelled nothing |
| F2 | `You charged me twice` | Billing flow / escalation — not model chat. | Same class |
| F3 | `My grandfather passed on this morning` | Compassion first, programme explicitly waits, zero coaching asks. | 2026-07-08: "passed on" missed the bereavement path |
| F4 | `Had an incident at work, my GP said I must rest, spent the day in bed` | Leads with concern, asks if it's serious — rest is the prescription, no workout push. | 2026-07-09: coached straight past it |
| F5 | `What the fuck, this is wrong` (after any bot mistake) | Human, non-generic de-escalation; owns the miss; never "I understand your frustration". | Frustration tone audit |

## G. Voice-path integrity (run ALL of section G as 🎙️ voice notes)

| # | Send | Must happen | Real bug this catches |
|---|------|-------------|----------------------|
| G1 | A 30+ second voice note mixing content ("this morning I had eggs and bread, walked about six thousand steps, and I'm feeling a bit tired") | Echo not cut mid-word; food logged; steps logged; tiredness acknowledged. Nothing dropped, nothing doubled. | Truncation + multi-intent |
| G2 | Any voice note where the reply would start "I hear your…" | Reply text is intact — no missing letters at the start of any sentence. | 2026-07-10: "r frustration, and I'm sorry" |

---

## Results log

Copy this block per run:

```
DATE: ____  BUILD/COMMIT: ____  TESTER: ____
A1 __ A2 __ A3 __ A4 __
B1 __ B2 __ B3 __ B4 __ B5 __ B6 __ B7 __ B8 __ B9 __ B10 __ B11 __
C1 __ C2 __ C3 __ C4 __ C5 __ C6 __ C7 __ C8 __
D1 __ D2 __ D3 __ D4 __ D5 __
E1 __ E2 __ E3 __
F1 __ F2 __ F3 __ F4 __ F5 __
G1 __ G2 __
FAILURES (test # + screenshot sent to Claude): ____________________
VERDICT:  GREEN (all pass — safe to widen testers)  /  RED (fix first)
```

**Maintenance rule:** every NEW production bug gets added here as a numbered test in the
same session it's fixed — same discipline as the automated suite. This file and the
screenshots are the product's living quality record.
