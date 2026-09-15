# C9 + C10 — the complete customer-turn path, from `85d1b73`

**Branch** `fix/c9-meal-date-slot`
**Base** `85d1b73c12219a9c6b694795a2edd17aeb197d8b` (`main`)
**Head — last commit that changes product code** `992c3de904f801c964cfae39c9d3d6ed41dc952d`
(the branch tip is one commit later and carries only this report; the PR names it. Every test
result below was measured on `992c3de`, and the tip changes no file under `server/` or `script/`.)
**Status** IMPLEMENTED — not merged, not deployed.

One branch, one PR, two commits. Nothing merged, nothing force-pushed, no other cut started.

---

## 1. The customer result

One client sentence, at 13:00 SAST. What it did on `85d1b73`, and what it does on this head.

| | `85d1b73` | `992c3de` |
|---|---|---|
| **Client** | `I had a pear. What should I have for dinner tonight?` | same |
| **Stored row — date** | `2026-09-10T18:00Z` (yesterday) | `2026-09-11T11:30Z` (today) |
| **Stored row — slot** | `"dinner"` | `null` |
| **Today's total** | `0 kcal` — the pear had left the day | `103 kcal` |
| **Final WhatsApp body** | *"A pear is a fine snack… **Tell me what you ate today — one line is enough.**"* | *"A pear is a fine snack… **Stand on a scale tomorrow morning, before you eat.**"* |

The client named no day and no meal for the pear. `tonight` and `for dinner` both belong to the
**question** — a meal they have not eaten. Both were read as a report about the pear. The pear
left today's totals, the day read back empty, and the coach answered their dinner question and
then, in the same breath, demanded they log the food it had just written down.

A second client sentence, same head:

| | `85d1b73` | `992c3de` |
|---|---|---|
| **Client** | `What does maintenance calories mean?` | same |
| **Model** | `…holds your weight steady. Noted 👌` | same |
| **Turn wrote** | nothing | nothing |
| **Log line** | `[WRITE_INTEGRITY] blocked a confirmation with no write` | same |
| **Final body** | *"…holds your weight steady. **Noted 👌**"* | *"**I've got that — but I haven't written it down yet, and I won't say I have when I haven't.**"* |

The boundary saw the false confirmation, logged it, counted it, built the honest replacement —
and shipped the original anyway. That is the 21 August handset defect still reaching clients,
past the boundary written to stop it.

---

## 2. What was changed, and where

Five product files. Every change is at an owner that already existed; no handler, composer,
fallback, prompt authority, framework or model was added.

### C9 — `7137bed`

**`server/sast.ts`** (+24 −1) — `parseMealDate` had `tonight` inside the `last night`
alternation, so at **every hour of the day** it resolved to yesterday 20:00. Three other owners
in the same file already say `tonight` means today: `effectiveMealLoggedAt` keeps the day even
inside the 00:00–04:59 window, the forgot/missed gate excludes it alongside `today` and `now`,
and the regex literally named `SAYS_TODAY_RE` contains it. Three to one, and the one was the only
branch that writes a meal's date. The branch comment named `"last night"` alone; `tonight` was
never argued for.

**Removed, not windowed.** `"tonight means yesterday before 04:00 SAST"` would be a *second*
owner of the midnight window, and `effectiveMealLoggedAt` is the first — it already reads that
window and already reads this word. Falling through hands it the question instead of answering it
twice.

**`server/understanding/actions.ts`** (+54 −1) — `explicitMealSlot` read the whole bubble, so a
slot word in a question clause labelled food reported in another. This is **#182 one axis over**,
and the rule is the one #182 already wrote down: a word may only label the eating if it belongs
to the eating. It now composes the floors that already answer this — `clausesOf` plus
`reportedInSomeClause` — rather than adding a third opinion. If any clause reports eating, the
slot comes from those clauses only; if none does, the whole message is matched **exactly as
before**. That fallback is load-bearing: a caption (`"Dinner 🍗"`) names no verb, and `"I had
chicken for dinner, is that ok?"` is one clause the asking floor declines. The change can only
ever *withdraw* a slot claim from words that report no eating; it cannot invent one.

### C10 — `992c3de`

**`server/handlers/chat-log.ts`** (+69 −6) — `reconcileTurnReply` reconciled into `draft` and
then returned `reply` from four exits: not-meaningful, no-user, "nothing was stale", and the
catch. The third is the **ordinary turn**, so this shipped on almost every turn. `reply` is also
the text the verifier never saw — the verifier runs on `draft`.

Two further findings inside the same function, both only visible once the repaired draft actually
shipped:

- The **decision-turn rebuild** recomposes the whole reply from `evidence.situationFrame` — the
  generic frame on a question turn, captured *before* the `numbers:low` delivery strip. Returning
  it answered a dinner question with a frame that never mentions dinner, and put a stripped
  `600 kcal` back into a reply for a client who asked not to see figures. Exits that compose their
  own decision turn now declare it (`decisionComposed`) and the rebuild stands down for them.
- The **write-integrity repair** was overwritten by that rebuild three lines later. It is now held
  and becomes the rebuild's context, so the client gets both halves: the truth about the record,
  and the canonical action.

**`server/handlers/gpt-block.ts`** (+18) — the composing exits declare `decisionComposed`. One
flag read by the one owner that needs it, rather than a second copy of the context.

**`server/handlers/lifecycle.ts`** (+23) — the under-eating warning is an *unprompted observation*
that `return`s, so on a first-match-wins pipeline above the Coach it ended the turn and the
client's question was never answered. Its two regexes are satisfied by `had` and `dinner` — both
of which are in the **question**. Gated on `looksLikeQuestion`, the owner `routes.ts` already
consults to decide the Coach mouth owns a turn.

> **This was dormant, not absent.** Before C9 the pear was written to yesterday, so today read
> 0 kcal and the branch could not fire. Correcting the date is what surfaced it. "The acceptance
> went red after a fix" and "the fix broke something" are different things, and this is the first.

---

## 3. Tests

### New

| File | What it grades |
|---|---|
| `script/pg-meal-date-slot-acceptance.ts` (422 lines, **32 assertions**) | Stored row's SAST day and `meal_label`, and the post-transport body. Clock frozen at pinned SAST hours. |
| `script/red-on-revert-c9-meal-date-slot.sh` (**6/6**) | The date word, the clause scoping, the eating vocabulary, the floors, plus an opposite-defect control. |
| `script/pg-turn-reply-integrity-acceptance.ts` (414 lines, **41 assertions**) | The function's RETURN VALUE, the post-transport body, the stored rows, date and slot read separately, and the mouth's own constant. |
| `script/red-on-revert-c10-turn-reply-integrity.sh` (**5/5**) | The ordinary exit, the held repair, the second mouth, the flag it reads, and the under-eating owner. |

Both acceptances and both harnesses are registered in `script/pg-acceptance-runner.ts`, so they
run in CI's `pg-acceptance` job rather than only on a developer's machine.

### The controls you named

| Case | Result |
|---|---|
| `I had a pear. What should I have for dinner tonight?` | today / slot `null` |
| `I ate dinner last night` | yesterday / dinner |
| `I ate dinner tonight` | today / dinner |
| `I had a pear for dinner` | today / dinner |
| Final reply answers the dinner question, does not ask for a re-log | passes |
| Genuine dinner (`I had pap for dinner`) | today / dinner, real reply |
| Last-night dinner (`I ate pap for dinner last night`) | yesterday / dinner, client told "yesterday" |
| Unanswered question (mouth returns a failure sentence) | client told; **no** canonical action appended |

### Independence of instruments

Date, slot, stored facts, final body and return value are five separate reads. The return value
comes from `handleMessage` (the `inTurn` wrapper, so it *is* `reconcileTurnReply`'s output); the
body comes from `shadow_replies` after the delivery owner. Sections 1–5 read them from **separate
turns** so neither can be an artefact of the other, and section 6 then asserts they agree — a fix
that repaired the return value while the transport shipped something else would otherwise pass
every other check and still be the defect.

**No fixture-generated answers and no circular graders.** The model stub never supplies a string
that is then grepped as evidence the product is *correct*; where the mouth's text is asserted, the
claim is that the product did not *discard* it. Every claim about what the product decided is made
against the deterministic canonical action. Both acceptances open with a section that validates
their detectors against labelled sentences before any case uses them — the re-log detector against
10, the write-claim and order detectors against 8 — because a detector that cannot fire would make
the central section green by construction.

### Existing suites on this head

`tsc --noEmit` clean · `unit-tests` 1063/1063 · all 8 governors OK (`architecture`, `file-sizes`,
`names`, `sast`, `reach`, `schema-safety`, `pricing`, `prompt-integrity`) — no budget raised.

`pg-final-response-owner-acceptance` (#92) and `pg-meal-slot-truth-acceptance` (Cut 2) both GREEN.
**#92's acceptance went red mid-cut and the cause is recorded rather than smoothed over:** C9's
corrected date made the under-eating branch reachable, which swallowed the question the #92 suite
exists to protect. It was isolated by bisecting to `7137bed` and confirming `85d1b73` green in a
worktree, then fixed at the lifecycle owner — not by weakening an assertion.

---

## 4. Remaining limits — stated, not buried

1. **One revert case is not claimed.** A sixth C10 seam was written for the not-meaningful exit
   and stayed GREEN under revert. Measured, not assumed: on every qualifying message tried
   (`hmm ok then`, `eish`, `cool cool`) the composed decision turn replaces the model's text
   before that exit is reached, so no repair is observable there to lose. The no-user exit needs a
   user row that vanishes mid-turn; the catch needs the ledger reads to throw. Those three lines
   are corrected for consistency and are **not** claimed as guarded. The harness records why.

2. **A separate defect found and NOT fixed here.** A bare question with no food —
   `What should I have for dinner tonight?` — is answered by the food logger:
   *"Got it — you ate something. Tell me the items in one line…"*. Same failure class (a question
   read as a report), different owner, and present on `85d1b73` too. It is outside the named
   journey and is left for its own cut rather than widened into this one.

3. **The live model and the live voice path have not been replayed.** Every acceptance stubs the
   mouth. The voice path cannot run offline: `assertSafeMediaUrl` requires an https allow-listed
   host and transcription needs the network.

4. **`ENGINE_LIVE` is `off` in all acceptances.** The `decisionComposed` interaction with an
   engine-live turn is reasoned about in the code comments and is exercised only on the
   gpt-block path here.

5. **Production on `85d1b73` is still unverified**, and this head is not deployed. Deployment and
   the deployed replay need whoever holds Railway access.

6. **`#92 / C10` is a customer journey, not a merged PR.** This branch closes the pear/date/slot
   chain and the `reconcileTurnReply` owner. It does not claim the journey is closed until the
   deployed replay exists.
