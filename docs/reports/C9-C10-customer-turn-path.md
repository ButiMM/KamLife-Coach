# C9 + C10 — the complete customer-turn path, from `85d1b73`

**Branch** `fix/c9-meal-date-slot` · **Base** `85d1b73` · **PR** #250
**Head — last commit that changes product code** `cbaef0bf5ba19d605b9d0ed50796f538c754f9b3`
**Status** IMPLEMENTED — not merged, not deployed.

Seven product files, four new test files, five existing suites touched. No handler, composer,
fallback, prompt authority, framework, dashboard, taxonomy or model was added. No governor budget
was raised. Every change sits at an owner that already existed.

---

## 1. The customer result

### The named journey

| | `85d1b73` | this branch |
|---|---|---|
| **Client** | `I had a pear. What should I have for dinner tonight?` | same |
| Stored date | `2026-09-10T18:00Z` (yesterday) | `2026-09-11T11:30Z` (today) |
| Stored slot | `"dinner"` | `null` |
| Today's total | `0 kcal` — the pear had left the day | `103 kcal` |
| Final body | *"A pear is a fine snack… **Tell me what you ate today.**"* | *"A pear is a fine snack… **Stand on a scale tomorrow morning, before you eat.**"* |

The client named no day and no meal for the pear. `tonight` and `for dinner` both belong to the
**question**. Both were read as a report about the pear, so it left today's totals, the day read
back empty, and the coach answered the dinner question and then demanded they log the food it had
just written down.

### Five more client-visible defects, all on the same turn path

| Client sends | `85d1b73` | this branch |
|---|---|---|
| `What does maintenance calories mean?` (model says "Noted 👌", turn wrote nothing) | *"…**Noted 👌**"* | *"**I haven't written it down yet, and I won't say I have when I haven't.**"* |
| `ngiyabonga` | *"one thing today: **Stand on a scale this morning**"* | *"Sho."* |
| `zzqq flurblewump gribbet` | *"one thing today: Tell me what you ate today"* | *"I didn't quite catch that 🙂"* + 3 buttons |
| `What should I have for dinner tonight?` (no food) | *"**Got it — you ate something.** Tell me the items…"* | the question is answered |
| a zero-calorie day (black coffee, water) | *"Tell me what you ate today"* | counted as logged |

Plus a **live flake**: `"Noted."` is one of seven gratitude acks and trips the write-integrity
vocabulary, so roughly one client in seven who said thank you got *"I've got that — but I haven't
written it down yet, and I won't say I have when I haven't."* A confession to a thank-you.

---

## 2. What changed, and where

### C9 — `7137bed`

**`server/sast.ts`** (+24 −1) — `parseMealDate` had `tonight` inside the `last night` alternation,
so at **every hour** it resolved to yesterday 20:00. Three owners in that same file already say
`tonight` means today: `effectiveMealLoggedAt`, the forgot/missed gate, and the regex literally
named `SAYS_TODAY_RE`. Removed, not windowed — a 04:00 rule would be a *second* owner of the
midnight window, and `effectiveMealLoggedAt` is the first.

**`server/understanding/actions.ts`** (+54 −1) — `explicitMealSlot` read the whole bubble, so a slot
word in a question clause labelled food reported in another. This is **#182 one axis over**; it now
composes `clausesOf` + `reportedInSomeClause`. When no clause reports eating, behaviour is
byte-identical to before, so captions and *"I had chicken for dinner, is that ok?"* are untouched.
It can only ever *withdraw* a slot claim, never invent one.

### C10 — `992c3de`, `95da7c5`, `16362d8`, `2f1c44c`, `cbaef0b`

**`server/handlers/chat-log.ts`** (+92 −7) — `reconcileTurnReply` reconciled into `draft` and
returned `reply` from four exits, one of which is the ordinary turn. `reply` is also the text the
verifier never saw. Two further findings inside the same function, both visible only once the
repaired draft shipped: the decision rebuild was a **second mouth** recomposing from a stale
pre-delivery frame, and it **overwrote the write-integrity repair** three lines after it was built.
The rule also now skips acknowledgement-only turns — a turn that instructs nothing asserts nothing
about the record.

**`server/handlers/gpt-block.ts`** (+36) — the composing exits declare `decisionComposed` so the
rebuild stands down instead of saying the same sentence a second way. The clarify exit and the
gratitude ack now set `conversationalOnly`, the flag their four siblings already set.

**`server/handlers/lifecycle.ts`** (+23) — the under-eating warning is an unprompted observation
that `return`s, so it ended the turn and the question went unanswered. Its regexes are satisfied by
`had` and `dinner` — both in the **question**. Gated on `looksLikeQuestion`.

**`server/handlers/food-context.ts`** (+13 −2) — the last-resort gate states its premise out loud
("clear 'I had … meal'") and never checked it. Gated on `reportedInSomeClause`.

**`server/understanding/live.ts`** (+38 −3) — `loggedToday: truth.today.kcal > 0` made the day's
**total** the test for whether the client had logged. Read **twice** on the same call, by the ladder
and by the investigation gate; fixing only the first left the defect exactly where it was. Both now
read one value from `truth.today.meals`.

---

## 3. Tests

| File | Grades |
|---|---|
| `script/pg-meal-date-slot-acceptance.ts` (422) | stored SAST day, `meal_label`, post-transport body |
| `script/red-on-revert-c9-meal-date-slot.sh` | **6/6** seams |
| `script/pg-turn-reply-integrity-acceptance.ts` (486) | return value, body, stored rows, date, slot |
| `script/red-on-revert-c10-turn-reply-integrity.sh` | **5/5** seams |

All four registered in `pg-acceptance-runner.ts`, so CI runs them.

**Named controls all pass:** `I ate dinner last night` → yesterday/dinner · `I ate dinner tonight`
→ today/dinner · `I had a pear for dinner` → today/dinner · genuine dinner · last-night dinner · an
unanswered question gets no invented action · a turn that reports *and* asks is still answered.

**Independence.** Date, slot, stored facts, final body and return value are five separate reads.
The return value comes from `handleMessage` (the `inTurn` wrapper, so it *is* `reconcileTurnReply`'s
output); the body from `shadow_replies` after the delivery owner. They are read from **separate
turns**, then asserted to agree — a fix that repaired the return value while the transport shipped
something else would otherwise pass everything else and still be the defect.

**No fixture-generated answers, no circular graders.** The stub never supplies a string then grepped
as evidence the product is *correct*; where the mouth's text is asserted the claim is that the
product did not *discard* it. Both acceptances validate their detectors against labelled sentences
before any case uses them.

---

## 4. Every suite that went red during this cut

Five. Each isolated against `85d1b73` in a worktree first, so "my change" is measured, not assumed.
**None was fixed by weakening an assertion.**

1. **`final-response-owner` (#92), during C9.** C9's corrected date made lifecycle's under-eating
   branch reachable, and it swallowed the question that suite protects. Fixed at the lifecycle owner.

2. **`interaction-truth`, after C10 — a real client-visible regression.** Gibberish lost its
   "didn't quite catch that" and its three buttons. Fixed at the clarify exit.

3. **`npm test` (routing-audit, gap-tests, production-parity), after C10.** One class: early exits
   that answer without instructing never declared themselves. Also exposed the 1-in-7 `"Noted."`
   flake.

4. **`final-response-reverts` case 8 — not a regression.** It reverted gpt-block's strip and stayed
   **green**, because C10 made the *second* stripper live: the boundary this codebase calls "the one
   place every reply crosses" was inert, and is now load-bearing. Re-aimed at both strippers, with
   the reason recorded in the harness.

5. **`thin-evidence`, after the `loggedToday` fix — my own defect.** `turnAlreadyWrote("food")`
   cannot tell a write *for today* from a retro catch-up, so a three-day catch-up marked today as
   logged and the client's catch-up ended in a bare receipt with no question — the #203 dead end,
   reopened. Signal removed; `truth.today.meals` already covers writes for today by definition.

**Three source-reading controls were re-anchored, not relaxed** — including one that was *right* to
fire: my first cut put `draft` in the situation slot, and production-parity's "Eggs tonight" control
caught the shape even though that value happened to be product-authored.

---

## 5. Remaining limits — stated, not buried

1. **One revert case is deliberately not claimed.** A sixth C10 seam (the not-meaningful exit) stayed
   green under revert; measured on `hmm ok then`, `eish`, `cool cool`. Those lines are corrected for
   consistency and are *not* claimed as guarded. The harness records why.
2. **Live model and live voice path not replayed.** Every acceptance stubs the mouth; the voice path
   cannot run offline (`assertSafeMediaUrl` needs an allow-listed https host; transcription needs
   the network).
3. **`ENGINE_LIVE` is off** in all acceptances. The `decisionComposed` interaction with an
   engine-live turn is reasoned about in comments and exercised only on the gpt-block path.
4. **`NORMALIZER` is off** in all acceptances.
5. **Production on `85d1b73` is unverified** and this head is not deployed.
6. **`#92 / C10` is a customer journey, not a merged PR.** This closes the pear/date/slot chain, the
   `reconcileTurnReply` owner, and five more defects on the same path. It does not claim the journey
   is closed until the deployed replay exists.

### Two process failures of mine, recorded because they cost time

- I backgrounded the full inventory and kept editing. Its revert harnesses restore `server/`
  wholesale, so they clobbered uncommitted edits twice and left stray mutations in three files.
- I piped a harness run through `head`, which sent SIGPIPE and killed it before its restore trap,
  leaving `explicitMealSlot` short-circuited in the working tree.

Neither reached a commit. Both were avoidable: do not edit while a revert harness runs, and never
pipe one through `head`.
