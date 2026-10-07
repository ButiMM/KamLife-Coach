# Tester trace, Wed 7 Oct 2026, 03:00 SAST (CTO)

**Why:** a tester said "it doesn't log meals, it doesn't remember anything, it doesn't do anything."

**How:** 34 ordinary messages went through the production front door (`handleMessage`) on `main` `196f1e8`, against real PostgreSQL. The model was offline, so deterministic routing and every database write are real, and turns that need the model show the offline stub. Script: `script/tester-trace.ts`. Fictional clients only.

## Root causes, ranked by how many testers hit them

### 1. A meal the old keyword gate doesn't catch is never logged unless you're on an allowlist [harm, A1]
- **"Kota from the spaza", "skipped breakfast, coffee only", "Ndidle ipapa nenyama" (isiXhosa: I ate pap and meat):** none writes a meal row. The food scanner *does* recognise every one of these foods (Kota, Coffee, Pap). The turn just never reaches the writer, because the old food gate needs an English eating phrase.
- **What happens next:** the new coach reads them correctly as LOG_MEAL, but `wave1Turn` refuses any turn that needs a write (`server/core/coach.ts:231-260`). The only path that can execute a LOG_MEAL is the old meaning engine, and only when all three hold:
  - `ENGINE_LIVE=on`;
  - `ENGINE_ACTIONS=on`;
  - the client is the coach, or listed in `BETA_TESTERS`, or `ENGINE_ACTIONS_ALL=on` (`server/routes.ts:1059`, `server/understanding/live.ts:312-330`).
- **Result:** the founder can see meals logged while testers get a reply and no log. "It doesn't log meals."
- **Fix:** the new coach's validated LOG_MEAL (and LOG_STEPS / LOG_WEIGHT / LOG_WORKOUT) goes through the existing `executeAction` → `mealTool` → scanner writer, **for every client**, when no writer took the turn. A vague amount gets the executor's existing confirm question. Delete the cohort gate.

### 2. "I weigh 87kg today" overwrites the goal weight and celebrates reaching it [harm, A7]
- **With no goal weight, and with a goal weight of 75kg:** the reply is "🏆 you hit 87kg — that's the goal, done", and `target_weight_kg` becomes 87 (`server/handlers/weight.ts:279-298` reads a target that this same turn just set).
- **Result:** every weigh-in risks a false "goal reached" and a goal-transition menu.
- **Fix:** a weigh-in never writes `target_weight_kg`. Find the writer that does. Goal reached needs a goal the client set.

### 3. "I don't eat fish" makes the client vegetarian [harm, A13]
- **Reply:** "updated to *vegetarian*. I'll keep it meat-free from now on." It stores `diet:vegetarian`.
- **Result:** a fish exclusion removes all meat. "It doesn't remember", or remembers wrong.
- **Fix:** an exclusion is stored as that exclusion (a `preference` fact, "no fish"), never mapped to a diet type.

### 4. A meal report that names a restaurant gets a menu card instead of a log [harm, A1]
- **Message:** "just finished 2 pieces of KFC and a small chips". The reply is the "KFC — Coach K Pick" ordering card, and no meal row is written.
- **For contrast:** "just had KFC…" logs. So "finished" isn't an eating verb to the gate.
- **Fix:** the restaurant card answers only a question or plan ("what should I get at KFC"), never a past-tense report. With #1 fixed, the new coach catches whatever the gate misses.

### 5. Multi-meal receipts are garbled [core, A1]
- **Message:** "for lunch I had rice and chicken and for supper I had samp and beans". Both rows are written, but the reply reads `Got it — *Lunch, Chicken and rice and *Supper. 👌`: broken bold, and samp and beans never named.

### 6. A canned line is stapled onto logs [core, D1]
- **Example:** "Stand on a scale tomorrow morning, before you eat." It goes after a food log and after a step log, the same line, from the old next-move ladder.
- **Result:** "It doesn't do anything" reads as "it says the same robotic thing".
- **Fix:** after-log turns carry only the new coach's words. The next-move ladder belongs to the scheduled message, once a day.

### 7. Old doors answer without the client record [core, A13/D1]
- **Example:** "What workout should I do today?" from a client who said "I have a bad knee". The old programme card answers before the new coach. It never reads the record, so the knee isn't considered. The same holds for every early door (`docs/mouths.json`: 54).
- **Fix:** #568. Every talk door goes to the new coach, and only floors and fixed cards remain.

## What works (don't break it)
- The SA food scanner recognises kota, pap, magwinya, amagwinya, umngqusho, mogodu, chicken feet, morogo, KFC, Steers and Nando's.
- Steps, workouts and reminders log.
- "Do you remember what I told you about my knee?" quotes it back verbatim.
- Daily totals add up.

## Not answerable offline
What the model says on talk turns: "how am I doing", "what should I eat tonight", "I'm struggling". That's measured in production by D7 (#573, the worst five daily).
