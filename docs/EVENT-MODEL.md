# THE EVENT MODEL — one message, N events

**Shipped 2026-08-16.** Killswitch: `FOOD_EVENTS=off` in Railway.

The frozen work order, in one line:

```
message → N events → grouped corrections → trusted retrieval → correct aggregates → one final response
```

---

## What was actually wrong

A message was an event. `"2 eggs and pap for breakfast, chicken and rice for lunch"` produced
**one** `meal_logs` row: every food merged, labelled with whichever slot was named first,
stamped with one time.

The segmentation was not missing — it has existed for months. It only ever shaped the **reply**.
So the product SAID "breakfast … lunch …" and STORED a single blob called breakfast, and every
consequence flows from that gap between what it says and what it keeps:

- `remove my lunch` cannot find a lunch inside a row called breakfast;
- a correction lands on whatever was written last, which after a split is a coin toss;
- the diary reads one line for two meals;
- anything per-slot is unanswerable from the data.

Two more failures were found while building it, and they are in the boundary below:
a correction **inside** the logging message, and non-food content **inside** a food dump.

## What it is now

| Stage | Where it lives | Rule |
|---|---|---|
| message → N events | `planEventWrites` (`food-identity-correction.ts`), called from the scanner path | a labelled segment carrying food is an event; below two, nothing changes |
| grouped corrections (in-message) | `netMessageFoods` / `netEventFoods` | a food the client withdraws in the same breath is netted **before** the write |
| grouped corrections (next turn) | `pickCorrectionTargets` + `recordEventGroup` | the fix lands on the event that HOLDS the food; a bare move takes the whole group |
| trusted retrieval | `food-log-mgmt.ts` | candidates are read from the rows, and matched against the items those rows actually hold |
| correct aggregates | the day ledger, unchanged | the day is the sum of its events — asserted against the rows, not the cache |
| one final response | `food-context.ts`, unchanged | N events still produce ONE reply. Law 15 forbids a receipt, so it is not a per-slot breakdown either |

**No new table.** `meal_logs` has been one row per event since it was written; nothing ever wrote
the second row. **No meal-slot taxonomy**: the label is whatever word the client used, passed
through unchanged. **No new test framework, no prompt rewrite, no dashboard work.**

## The acceptance boundary

Nine cases, all at the ROW level, in `script/acceptance-hold.ts` (§9) — the reply was never the
thing that was wrong. Run with a real database:

```
DATABASE_URL=postgresql://… npx tsx script/acceptance-hold.ts
```

| # | Case | State |
|---|---|---|
| 9.1 | two meals in one message are two rows, each with the slot the client named | ✅ verified |
| 9.2 | the day total is the sum of the events, nothing double-counted | ✅ verified |
| 9.3 | one final response, accounting for both events | ✅ verified |
| 9.4 | **intra-message correction** — the withdrawn food is never written | ✅ verified |
| 9.5 | **non-food content in a food dump** — no phantom item, no request to price their back | ✅ verified |
| 9.6 | a correction lands on the event holding the food; the other event is untouched | ✅ verified |
| 9.7 | a bare move takes the whole group — both events, or two days are wrong at once | ✅ verified |
| 9.8 | an ordinary single meal is unchanged: one row, the client's sentence, its confirmation | ✅ verified |
| — | the seven pre-existing acceptance cases (§P0.1, §5, the hold, WO2, fix 3, §6, 6, 7, 8) | ✅ still green |

**Verified how.** 2026-08-16, against a real PostgreSQL instance through the real
`handleMessage` pipeline: **82/82**. The same harness on the pre-change code scores **72/82** —
the ten failures are the defects above, so these tests can fail, which is the only reason to
trust that they passed. Plus `npm test` (1,019 unit + 316 routing + the guards) and
`npm run gauntlet` (fully green, all five slices).

Not verified by any of this: the coaching **voice** on a split log. That needs a real model and
belongs to `script/reality-test.ts`, which is a different test and is reported separately.

## The two the investigation found last

**Intra-message correction.** *"I had rice and chicken for lunch, actually not rice, it was pap"*
is one turn. The scanner reads left to right and finds rice, chicken AND pap; the correction
machinery only ever looked at a message that FOLLOWED a log. All three were written, and the day
was ~260 kcal wrong before it began — the silent kind of wrong, which nobody can see to complain
about. It is netted before the write, so nothing is inserted and then repaired.

The first draft of that netting ate the chicken: the food table resolves "rice and chicken" to a
single combo dish, so a name filter removed both foods — the identical defect `applyCorrection`
was written to fix one turn earlier. It now delegates to `applyCorrection` rather than keeping a
second copy of the composition rule. **That failure was found by running the harness against a
real database, not by reading the code.**

**Non-food content inside a food dump.** *"…and my back is sore and I didn't sleep"* is not an
unpriced ingredient. "back" and "sore" are not in the notice's NOISE list, so the leftover
vocabulary was audited as menu items and the client was asked whether it was fried or grilled —
answering the half of their message that mattered most with a request to itemise it.
`plateClausesOnly` is now the one owner of "which half of this message is about the plate", read
by both the unpriced-food notice and the supplement model. A clause is dropped only when it is
positively recognised as body-or-life talk, and a caller-supplied veto keeps any clause that
really does carry food ("so tired I ate a whole pizza").

## Deliberately NOT done

- **The multi-day catch-up path stores no items** (`items: []`). Recorded in `docs/BACKLOG.md`
  as EVT-1, not fixed: those rows are already one per day, the fix changes their carb/fat numbers
  from estimated to measured, and no case in the boundary demonstrates it. Adjudicate it on its
  own merits rather than folding it into this work order.
- **Reply ownership for a food dump that carries feeling but no question.** Today the turn ends
  at the food confirmation unless the message also asks something (`routes.ts`, WO2). Changing
  that is a routing decision with a double-log risk, and it is a prompt/routing question, not an
  Event Model one.
- **Meal-slot taxonomy, a new event table, a dashboard read of per-event data.** Out of scope by
  instruction, and none of them is needed for the boundary above.
