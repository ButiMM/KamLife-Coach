# KamLife / Coach K — Foundation Audit

**Base audited:** `main` @ `0fb644a` (22 Sep 2026). Audit only — no product code was changed.
**Method:** code reading with file:line evidence, plus **execution**: real tester messages replayed through the real front door (`processTextAsync → handleMessage → sendFinal → transport`) on real PostgreSQL built from the committed migrations, with the production normalizer **on**, replaying the **recorded** production `gpt-4o-mini` rewrites from `script/fixtures/normalizer-corpus.json`. Every other model call was stubbed with a visible marker, so each trace shows exactly where a live model would have spoken. The rig lived in the git-ignored `tmp/` and was never committed.

**Limit that matters:** this container has no production database or Railway credentials. I could not query live `chat_history`. The real tester failures below come from the repo's own recorded evidence — GitHub issues #63, #92, #93, #111, #113, #127 and #234, `DEFECTS.md`, and the 10 recorded production normalizer outputs. The ones marked **REPRODUCES** were re-executed on current `main`.

---

## 0. VERDICT — **ROTTEN**

**The architecture cannot deliver a coach that remembers a client across months. No amount of patching fixes that, because what is missing is not a connection. It is the foundation the connections would attach to.**

There is no place where "what this client has told us" is written down and kept. A fact a client states plainly is, in the ordinary case, stored nowhere. Six turns later it is absent from the prompt the model receives. After 90 days the only near-complete record of the conversation is deleted by design. What the client *means* is decided by first-match-wins regexes spread across a ~20-stage handler pipeline, in front of which sits a model that rewrites the client's words so the regexes can match them — followed by about ten more regexes to undo the model's mistakes. What the client *hears* can be written by any of 418 authors, and a decision ladder that remembers nothing of its own past appends the same instruction to every reply.

Those are three of the four load-bearing parts of a conversational coach: memory, understanding and voice. The fourth, verification, is a 54,000-line deterministic harness that runs with the model switched off, so it cannot see the class of failure testers report.

**Confidence: high (~80%).** The structural facts are measured and re-executed. What I could not observe is what the live model says on the paths that reach it (§7), and that cannot rescue the verdict: in the decisive memory trace the fact is absent from the model's input, so even a perfect model could not have answered.

### The three facts that carry the verdict

1. **Memory is structurally absent, not buggy.** A client said *"I'm training for the Comrades marathon in June and my knee gets sore on long runs."* Nothing was stored: `injuries`, `life_context`, `dream_goal` and `profile_notes` stayed null, and `client_understanding.keyFacts` stayed empty. The reply to it was *"one thing today: Stand on a scale."* Six turns later she asked *"Given everything I've told you, how should I plan my training this week?"* The prompt actually sent to the model was **47,177 characters and contained neither "Comrades", "marathon" nor "knee"** (Trace 2). Durable memory is six regex-extracted columns (`memory.ts:464-600`). Conversational memory is the last 4, 5 or 6 rows, depending on which of three code paths answers (`memory.ts:253-259`, `live.ts:413-417`, `gpt.ts:1101-1107`). The only near-complete event log is purged at 90 days (`admin-turns.ts:77,143`).

2. **Nothing owns user state or meaning, and patching does not converge.** The `users` row has **185 Drizzle `update(users)` sites plus 9 raw-SQL `UPDATE users` across 38 files**, plus about 40 writers to a free-text `profile_notes` column used as a regex-edited key-value store. Meaning is decided by **441 named regexes and 29 message-deciders** (`script/check-architecture.ts:65,902`), a count that *rose* from 309 on 6 August. On 25 August #63 diagnosed this and chose "keep the architecture, targeted consolidation." Since then: **77 merged PRs, 308 commits, server grown from ~66k to 74.8k lines — and #63's own reported failure still reproduces verbatim.** It now also **silently deletes the client's logged lunch**, and the deletion is absent from the forensic ledger (Trace 1).

3. **The merge gate is blind to what testers experience.** Every gating CI job runs with the model offline. The production front door (the normalizer) is forced **off in 58 harness files**. The real-model gauntlet and model drill run nightly and gate nothing, and `reality-test` is manual-dispatch only. The entire test surface contains **10 real recorded client messages** against 54,385 lines of synthetic harness written by the same agents writing the fixes. Green CI measures whether the author's hypothesis holds on a stubbed model — which is why eight months of green builds sit next to "it doesn't know anything."

### What to rebuild, what to keep

| Rebuild — the core model is wrong | Keep — sound, reusable |
|---|---|
| **State:** an immutable inbound-event log (raw text, `occurred_at` separate from `recorded_at`, source id) with facts as events and the day ledger and profile as *projections*. Retire the god-row and the `profile_notes` token store. | SA food database, portions and swaps (`foods.ts`, `food-swaps.ts`) — the content is good |
| **Understanding:** one structured interpretation per message (schema-constrained model over raw text + retrieved context) that emits facts, questions and intents. It replaces the regex router *and* the rewriting normalizer. | Programme and exercise content (`programme.ts`, exercise library) |
| **Context assembly:** a budgeted retrieval over the event log — profile facts, open loops, relevant past statements — rather than "last N rows". | PayFast ITN validation (`payments.ts:75-170`) — correct |
| **Voice:** one composer per turn, with memory of what the coach already said and asked. | Outbound delivery owner, reply hygiene, 63016 template recovery (`scheduler/shared.ts`) |
| **Verification:** a pre-merge replay of real anonymised conversations, graded on stored truth and reply, with the live model. | Crisis detection and medication-dosing refusal (deterministic, run before the model) |
| | `sast.ts` day utilities, the template registry, the scheduler shell, and the `turn_ledger` / Coach Health *concepts* (stop purging raw input) |

**The correct next step is a rebuild plan, not another cut** (§8). Separately, several P0s below — payments, opt-out, data deletion, safety routing — cause harm today regardless of the rebuild and should be stopped immediately.

---

## 1. Why eight months produced this

This is the root cause, not a list.

**The product was assembled as a keyword-routed command bot and then asked to be a coach with memory.** The origin is on disk. `attached_assets/` holds the specs that built it — `Pasted--In-server-routes-ts-add-these-SA-life-scenario-handler_1771659986553.txt` (21 Feb 2026), *"In server/routes.ts add these handlers after existing…"*, *"…find the getKamLifeFoodReply function…"*. Each capability was a handler pasted in front of or behind the others. That shape — match the text, a handler owns the reply, a model catches the leftovers — is still the shape today: `routes.ts:131-1083`, about 20 stages, first match wins.

**Every tester complaint since has had the same anatomy:** a message the router did not anticipate, or a fact no store holds. The repo's response has been the same each time — another handler, regex or "brake", and a synthetic test proving the patch. The regex governor is a timeline of this. It records `regexLiterals` 309 → 441, with multi-paragraph justifications for each raise (`check-architecture.ts:276-525`). The normalizer block is ten brakes stacked to stop a model damaging the client's words before the regexes read them (`routes.ts:502-740`). The fixes are real, and each one is locally correct.

**Correct local fixes do not converge here, because the thing they repair is not local.** "The coach forgot" is not a missing connection between two components. It is the absence of a component: no log of what the client said, no owner of what is true about them, and no reader that assembles it for the decision. Each cut restores one connection for one phrasing. The next phrasing takes a different path through 29 deciders and 418 authors and misses it again.

**The verification apparatus made this invisible.** CI is green because it tests the code the author imagined, against a stubbed model, with the production front door off. The governors freeze counts — file sizes, regexes, "mouths" — which turns engineering effort into accounting: moving code between files to satisfy a budget, justifying each increase in prose. The process around it (cut → exact-SHA review → per-job CI → merge) is rigorous about *local provable correctness* and has no measure of *whether testers are better off*.

**I am part of this pattern.** In this session I built and merged C14, C15, C17 and the C17 evening cut. Each was reproduced, graded and red-on-revert proven. Each repaired one lost connection. None changed the foundation, and the audit replays show the tester experience is not materially different for it. That is not an argument that the cuts were wrong. It is the evidence that this method, applied to this core, does not converge.

---

## 2. Replayed failures

### 2.1 Twenty-four real failures and their root causes

Sources: #63 (tester thread, 25 Aug), #92/#93/#111/#113 (live trace, 28 Aug), #127 (founder/tester), #234 (founder live turn, 8 Sep), `DEFECTS.md` (tester thread, 27 Jul), and the recorded production normalizer corpus. "Status" is on current `main`.

| # | Client said → coach did | Source | Status on `0fb644a` | Root cause |
|---|---|---|---|---|
| 1 | "No I moved yesterdays workout to today" → "rest today, hit it fresh tomorrow" | #63 | FIXED (replayed) | B |
| 2 | "My dinner is the same as the last meal" → logged *yesterday's* dinner | #63 | FIXED (replayed) | B |
| 3 | "No I'm just fine with this meal" → "I didn't catch that one" | #63 | **REPRODUCES — and deletes her lunch** (Trace 1) | B |
| 4 | "My steps are 10k today" → "Get a 20-minute walk in today" | #63 | FIXED (replayed) | C |
| 5 | Bonolo, 3 days in one message → ~7,700 kcal on one day | #63 | **PARTIAL** — days now right, but each day collapses into one mislabelled row (Trace 4) | A |
| 6 | Raw Twilio Sandbox text in the chat | #63 | Config, not code (#63 §9) | Infra |
| 7 | "I had a pear" → normalizer "I had a pear for breakfast" | #234 | Addressed in C9; not replayed (not in corpus) | B |
| 8 | "Work is stressing me out and I ate takeaways again tonight" → recorded normalizer rewrite **deletes the stress** | corpus | **PARTIAL** — the fidelity gate now keeps raw text, but the reply asks for the food twice and gives canned empathy | C |
| 9 | "I had a burger and chips last night, I feel like I ruined everything" → five-sentence lecture | corpus | **REPRODUCES as bad advice** — logged, then *"Stand on a scale this morning"* to a client in shame | C |
| 10 | Weight-trend question → a "hold" *and* "Scale is going up — keep fuelling" in one reply | #92 | Not replayed; #92 claims fixed | C |
| 11 | Weigh-in → automatic protein instruction | #93 | Not replayed | C |
| 12 | "Session 25" and "first full training week" in the same conversation | #113 | Not replayed | A |
| 13 | Plate "3 eggs + pap / 2 thighs + veg" → client: "Do better." | #111 | Not replayed | C |
| 14 | "~1g protein left / ~700 kcal left" from stale cached totals | #127 | Not replayed; cached `users.today*` columns still exist (`schema.ts:131-133`) | A |
| 15 | Coach could not see what was eaten today → suggested lunch again for dinner | DEFECTS | Claimed fixed | A |
| 16 | "Day 0 / send baseline photos" to a months-old client | DEFECTS | Claimed fixed | A |
| 17 | Past-tense "I was sick" flipped a recovered client back into sick mode | DEFECTS | Claimed fixed | A |
| 18 | Yesterday's water shown as today's | DEFECTS | Claimed fixed | A |
| 19 | "Rice" → "Brown rice", "Tin fish" → "Pilchards in tomato sauce" | DEFECTS | Claimed fixed | B |
| 20 | "Teach me" → "Swaps for Peach" (fuzzy match) | DEFECTS | Claimed fixed | B |
| 21 | "Still room for a full dinner" in the reply that *logged* dinner | DEFECTS | Claimed fixed | C |
| 22 | Explicit meal log answered with a restaurant menu, three times | DEFECTS | Claimed fixed | B |
| 23 | "I need more help" → thrown into programme setup | DEFECTS | Claimed fixed | B |
| 24 | "That's the protein box ticked. 16g more to go today." | DEFECTS | Claimed fixed | C |

Current-main probes of the same mechanisms, not tester-reported but run the same way:
- **"Just finished dinner, pap and wors"** → the swap handler, "rice, samp, or potatoes instead"; **the dinner is never logged**, at any hour.
- **An ordinary 4-message day** → "Stand on a scale…" ends all four replies.
- **The Comrades/knee statement** → stored nowhere, absent from the model six turns later (Trace 2).

### 2.2 Three root causes explain 23 of the 24

- **A — STATE: nothing owns what the client told us (7).** No event log. Facts live in a ~100-column god-row with 194 writers, cached aggregates beside the ledgers they summarise, a free-text token store, in-process maps wiped on every deploy, and model-written narratives. When two stores disagree, whichever one a given handler happens to read wins.
- **B — MEANING: surface-form routing plus a rewriting model (8).** First-match-wins regexes decide what a message *is* before anything understands it. A leading "No" makes a decline a food correction. "Finished" makes a dinner report a substitution request. "Calorie target" makes a pregnancy question a totals lookup. A model rewrites raw text to fit the regexes, and brakes try to catch its damage.
- **C — VOICE: no single composer and no memory of its own coaching (8).** Handlers write fragments, the decision ladder appends a move, and nothing knows the coach already said it. Hence contradictions, double-asks, and the same instruction on every message.

**That is the whole roadmap.** Fix A, B and C at the foundation and nearly every item above closes as a class, instead of one phrasing at a time.

### 2.3 Full traces

#### Trace 1 — "No I'm just fine with this meal" deletes the client's lunch (#63, reproduced)

Real clock, real PostgreSQL. Turn 1 at 20:43 SAST: *"I had pap and chicken for lunch"*.

1. **Front door.** `routes.ts:153` fires the classifier (one `gpt-4o-mini` call). The food scanner matches "Chicken and pap". A meal row is inserted (600 kcal, `lunch`), and the ledger records `INSERT meal kcal=600`.
2. **Reply delivered:** *"Got it — Chicken and pap. 👌 / Pap and chicken — good protein. **Add spinach or butternut on the side** to hit your micronutrients. / Stand on a scale…"*
3. **Recorded in `chat_history`:** `message_out = "Got it — Chicken and pap. 👌"`. **The vegetable suggestion — the thing she is about to answer — was never recorded.** The repo already knows this: `memory.ts:250-252` notes that handler paths populated chat_history "with a receipt/draft before the final reply was settled."

Turn 2: *"No I'm just fine with this meal"*.

4. `food-context.ts:265` — `CORRECTION_PREFIX` `/^(no[,!\s]+|…)/` matches the leading **"No "**.
5. `food-context.ts:277` — `hasFoodTriggerAfterPrefix` matches the word **"meal"**. So `isFoodCorrection = true` (`:279`).
6. `food-context.ts:304-308` — selects the newest `FOOD_LOG` chat row today. `:312-322` finds the meal row within ±2 minutes of that row's timestamp.
7. `food-context.ts:330-335`, in a transaction: re-tags the turn-1 chat row `FOOD_LOG_CORRECTED`, then **`tx.delete(mealLogs)` — her lunch is gone.** `:337-342` recomputes the cached totals on the user row.
8. `captureFriction("correction")` (`food-context.ts:284`) records this as *client* friction — the system's own misroute, logged against the client.
9. The remaining text, stored as `"i'm just fine with this meal"` with **her "No" deleted from the record of what she said**, reaches the under-eating handler.
10. **Reply delivered:** *"Only 600 kcal by this time of day, Bonolo — that is too low. Eating too little is not aggressive fat loss…"* — scolding her with the number it had just erased.
11. **Forensic record:** `turn_ledger.mutations = null`. **The deletion is invisible to the only audit trail.**

At 13:30 on a frozen clock the same path ends at `lifecycle.ts:1536`, *"I didn't catch that one — what was it, roughly?"*, which is #63's exact report. The deletion is independent of the hour. Any "No …" reply containing "meal", "had", "lunch" and similar, sent shortly after a food log, erases that log.

**First divergence:** `food-context.ts:265+277` — a regex decides that a decline is a correction. **Root cause B, compounded by A:** the record neither kept what the coach suggested nor what the client said.

#### Trace 2 — the coach cannot remember what it was told this morning

1. 08:30 — *"Just so you know, I'm training for the Comrades marathon in June and my knee gets sore on long runs."*
2. `memory.ts:464` `detectFacts` returns `{}`, verified directly — even for the bare sentence "my knee gets sore on long runs". The reason is `memory.ts:567-568`: "sore" counts only if the sentence also contains one of *sharp, stab, shooting, can't, weeks, days, since, still, again, killing*. The marathon goal matches no field at all. The six typed facts are the whole durable vocabulary; bereavement ("my mom passed away last month") also returns `{}`.
3. The perception model — the only other channel that could capture it — **did not run on this turn.** It runs only on the meaning-engine path, which was reached at turn 7. Even when it runs, its `keyFacts` are discarded and rebuilt from the `users` row every turn (`understanding/store.ts:47-48`).
4. **Reply delivered:** *"Bonolo — one thing today: Stand on a scale this morning, before you eat. It's one number and it's the only way either of us sees this working."*
5. Five ordinary logs follow (breakfast, lunch, steps, dinner, a banana). Each reply ends with the same weigh instruction.
6. 20:30 — *"Given everything I've told you, how should I plan my training this week?"* goes to the meaning engine (`routes.ts:1063`). `live.ts:413-426` `recentTurns` reads the **last 5 `chat_history` rows**, truncated to 400/500 characters.
7. **Captured model request:** 10 messages, 47,177 characters. `"Comrades"`: absent. `"knee"`: absent. `"marathon"`: absent.
8. **Reply delivered:** *"one thing today: Stand on a scale tomorrow morning."*

**First divergence:** step 2 — there is nowhere to put the fact. **Root cause A.** No prompt change fixes this: the information is not in the input.

#### Trace 3 — a pregnancy question answered with a weight-loss target

1. *"I'm 14 weeks pregnant, what should my calorie target be?"*
2. `early-commands.ts:220` — `/\b(daily calories|calorie target|…)\b/` matches **"calorie target"**. The totals branch claims the turn.
3. `early-commands.ts:306` — **reply delivered:** *"Bonolo Tester, all 2700 kcal — nothing logged yet today."* No `chat_history` row is written for this turn.
4. **After** the reply, `logChat` → `detectEscalation` (`chat-log.ts:8`, rule at `safety-detection.ts:58`) creates a "medical / high" escalation for the founder. The client already has her fat-loss target.

**First divergence:** `early-commands.ts:220` — surface-form routing ahead of the safety question. **Root cause B.** The safety detector exists, but it is wired to the *after-the-fact* path.

#### Trace 4 — Bonolo's three days (partially fixed; the architecture's limit)

1. The recorded **real** normalizer output (corpus) rewrote her message to *"i had pap and chicken, eggs and bread for breakfast and rice with beef stew for dinner **yesterday**"* — two days deleted and Monday relabelled. That is the original 7,700 kcal mechanism, now proven with recorded output rather than reconstructed.
2. Current `main`: `routes.ts:664` multi-day brake → *"multi-DAY note is never rewritten; raw text proceeds"*. The fix works.
3. `food-context.ts:799-833` builds **one row per day**. `mealLabel: explicitMealSlot(p.raw)` (`:832`) labels the whole day with the first meal word found. Stored: Monday 08:00 `breakfast` **1,576 kcal (breakfast *and* dinner)**, Tuesday 12:00 unlabelled, Wednesday 12:00 unlabelled. The event times are fabricated.
4. **Reply delivered:** the three-day summary, then *"Stand on a scale tomorrow morning, before you eat."* Nothing about a pattern of 2,566 kcal against a 2,700 target, or the burger-and-chips day.

**First divergence:** step 3 — `meal_logs` has no concept of a meal event separate from a row, and one timestamp serves as both event time and record time (`schema.ts:210-242`). **Root cause A.**

#### Trace 5 — "Just finished dinner, pap and wors" is never logged

1. `early-commands.ts:113-114` — the goal-swap table declines.
2. `early-commands.ts:122-124` — `answerUnavailable` (written for "the chicken was finished, is mince OK?") reads "finished … pap" as *pap unavailable* and claims the turn.
3. **Reply delivered:** *"No stress — rice, samp, or potatoes instead. Same job on the plate. 👌"* Tagged `SUBSTITUTION`. `meal_logs` empty. Same result at 00:30 and 20:30.

**First divergence:** `early-commands.ts:122` — first-match regex precedence. **Root cause B.**

#### Trace 6 — a purging disclosure answered "what was it, roughly?"

1. *"I've been making myself throw up after dinner so the calories don't count"*.
2. No deterministic disordered-eating detector exists: no pattern anywhere in `server/` for throw up, purge or vomit-after-eating as self-harm. `detectEscalation` has none either.
3. `lifecycle.ts:1499` — `hasLogTrigger` matches **"dinner"**. The scanner finds no food, and it is not a question, so `seemsFoodLogAttempt` is true (`:1516`).
4. `lifecycle.ts:1534-1536` — **reply delivered:** *"I didn't catch that one — what was it, roughly?"*
5. The only disordered-eating handling in the codebase is prompt text in `gpt-block.ts:160`, reached only if nothing earlier claims the turn. `DEFECTS.md` D10 claims disordered eating "gets an honest boundary and a real referral". **Contradicted.**

**First divergence:** `lifecycle.ts:1499/1516`. **Root cause B.**

---

## 3. P0 findings

### [P0] There is no memory: stated facts are stored nowhere and leave the model's context within one session
**Where:** `server/memory.ts:464-600` (`detectFacts`, the whole durable vocabulary), `:567-568`; `server/understanding/live.ts:413-426` (5 rows); `server/gpt.ts:1099-1114` (6 rows, coach replies cut to 300 chars); `server/memory.ts:248-288` (4 turns); `server/routes/admin-turns.ts:77,139-150` (90-day purge); `server/memory.ts:193-208` (embeddings off by default)
**What the code actually does:** Durable memory is six regex-extracted columns plus a model-written 400-character `lifeStory` that is not linked to any source message. Anything else the client says survives only while it sits in the last 4–6 chat rows, whose length depends on which of three code paths answers. `chat_history` stores handler receipts rather than delivered replies. The only near-complete record of inputs (`turn_ledger`) exists since 10 Aug and is deleted after 90 days.
**Why it matters, in business terms:** This is the tester complaint "it doesn't remember anything", and it is architectural. A months-long coaching relationship is impossible when the system forgets a sore knee by the evening.
**Fix:** Rebuild (§8): an immutable inbound-event log, facts as events with source ids, and budgeted retrieval into every model call. Stop purging raw inputs (turn_ledger retention) now — one line at `admin-turns.ts:77`, pending a POPIA-compliant retention decision.
**Effort:** L
**Confidence:** high (executed, Trace 2)

### [P0] User state has no owner — 194 writers, a regex token store, and process-memory state lost on every deploy
**Where:** `shared/schema.ts:21-149` (the ~100-column `users` row, including cached `todayCalories/todayProteinG/todayCaloriesDate` at `:131-133`); 185 `db.update(users)` + 9 raw `UPDATE users` across 38 files; about 40 writes to `profile_notes` across 19 files, e.g. `server/memory.ts:38-50` (`regexp_replace` token edits); `server/understanding/executor.ts:76-95` (pending confirmations in a `Map`); `server/handlers/early-commands.ts:46`
**What the code actually does:** Facts about the client are written from 38 files with no reconciliation. Conversational state is split between a DB column (`awaitingInputType`, 91 sites) and in-process maps. The executor's own comment says a restart sends the client's pending "yes" to "normal understanding" (`executor.ts:78-80`), and every deploy restarts the process.
**Why it matters, in business terms:** Two stores disagreeing (#127's "~1g protein left") and state lost mid-conversation both read to a client as "it doesn't know what we were just talking about."
**Fix:** The rebuild's projection model. Every fact is derived from events by one owner.
**Effort:** L
**Confidence:** high

### [P0] Meaning is decided by first-match regex routing plus a model that rewrites the client's words
**Where:** `server/routes.ts:131-1083` (the pipeline), `:502-740` (normalizer and its ten brakes), `:153-156` (classifier on every text); `script/check-architecture.ts:65,152,902` (441 regexes, 418 client-facing authors, 29 deciders); examples at `food-context.ts:265-279`, `early-commands.ts:122`, `early-commands.ts:220`, `lifecycle.ts:1499-1536`
**What the code actually does:** A message is classified by whichever regex matches first across about 20 stages. Traces 1, 3, 5 and 6 are four different wrong claimants on current `main`.
**Why it matters, in business terms:** "It doesn't know anything" — and it produces data loss and unsafe answers, not just awkward ones.
**Fix:** Rebuild: one structured interpretation step per message, before any handler.
**Effort:** L
**Confidence:** high

### [P0] A plain decline silently deletes the client's food log, invisibly to the audit trail
**Where:** `server/handlers/food-context.ts:265,277,279,304-342`
**What the code actually does:** See Trace 1. "No …" plus a food word within about 2 minutes of a log deletes that meal. `turn_ledger.mutations` records nothing.
**Why it matters, in business terms:** Silent loss of the client's own data, plus a scolding reply built on the erased number. It is invisible to Coach Health because the ledger never saw it.
**Fix:** Now, independent of the rebuild: require a replacement food, or an explicit removal verb, before `food-context.ts:333-335` may delete. Report the delete to the turn mutation recorder.
**Effort:** S
**Confidence:** high (executed)

### [P0] Cancelling does not stop billing; the next charge silently re-activates the client and erases the cancellation
**Where:** `server/handlers/lifecycle.ts:546-561`, `server/routes/payments.ts:176-187`
**What the code actually does:** On "cancel" the user is set inactive, and the client is told *"your recurring billing is being cancelled — you will not be charged again"* (`:561`). The code's own comment (`:552-554`) says this "does not stop the charge". It only WhatsApps the founder, and only if `COACH_ALERT_PHONE` or `ADMIN_PHONE_OVERRIDE` is set (`:555-556`). No call to PayFast's subscription API exists anywhere in `server/`. When PayFast bills next month, the COMPLETE ITN sets `subscriptionStatus: "active"` and **`cancelledAt: null`** (`payments.ts:183-187`).
**Why it matters, in business terms:** Charging people after they cancelled, telling them in writing that you wouldn't, then erasing the evidence. That is chargebacks, consumer-protection exposure and reputational damage in a word-of-mouth market.
**Fix:** Call PayFast's cancel API from the cancel path. Have the COMPLETE ITN refuse to re-activate, and flag for refund, when `cancelledAt` is set and no new signup occurred. Until then, stop saying "you will not be charged again".
**Effort:** M
**Confidence:** high (code). Whether past cancellers were charged: **Needs human answer**.

### [P0] Opt-out is honoured only for the exact word "stop" — and even then not by payment messages
**Where:** `server/handlers/lifecycle.ts:460-466`; `server/scheduler/jobs/business.ts:68-100`; `server/scheduler/shared.ts:432-446`
**What the code actually does:** Verified through the real pipeline. `STOP` → 365-day pause. "Please stop messaging me" → a **7-day** pause, then messages resume. "stop sending me messages", "Unsubscribe me" and "I don't want these messages anymore" → **not recognised; nothing paused** (the last is routed into a retention flow). Opt-out is a regex token in `profile_notes`, checked per job and never at the send boundary. `sendCriticalAlert` checks nothing, and the payment-recovery job never calls `isPaused`.
**Why it matters, in business terms:** Messaging people who asked you to stop drives WhatsApp block and report rates, which is how a Business number loses its quality rating. It is also a POPIA direct-marketing breach.
**Fix:** Recognise opt-out intent broadly, and enforce it in `sendWhatsApp`/`sendCriticalAlert` against a real column, allowing only strictly transactional billing notices.
**Effort:** S–M
**Confidence:** high (executed)

### [P0] Scope is enforced by a fail-open guard on one path; everything else is prompt text
**Where:** `server/understanding/domain-guard.ts:1-17` ("FAIL-OPEN TO ANSWERING"); its only caller is `server/understanding/live.ts:457`
**What the code actually does:** The guard runs only on the meaning-engine path. Of eight off-topic requests tested, two ("Explain how bitcoin works", a Zulu translation) are passed **in-domain by the deterministic fast path with no check at all**. The other six depend on a `gpt-4o-mini` classifier that returns in-domain on any error or timeout. The roughly 15 `askCoachK` entry points reached through other handlers have no scope check, only the system prompt.
**Why it matters, in business terms:** Meta prohibits general-purpose AI assistants on the WhatsApp Business API from 15 January 2026. Scope held only by prompt text is exactly what gets a number banned — and banned means no product.
**Fix:** A deterministic out-of-scope refusal at the front door for every model path. The model decides in-domain; it does not decide out-of-domain by default. Fail *closed* for clearly off-topic shapes.
**Effort:** M
**Confidence:** medium — I could not observe what the live model answers on these paths.

### [P0] Safety routing: pregnancy answered with a fat-loss target; purging answered "what was it?"
**Where:** `server/handlers/early-commands.ts:220,306`; `server/handlers/lifecycle.ts:1499-1536`; `server/handlers/chat-log.ts:8` → `server/safety-detection.ts:58`; `server/handlers/gpt-block.ts:160`
**What the code actually does:** See Traces 3 and 6. Pregnancy detection exists but fires *after* the reply, as an escalation. There is no deterministic detector for purging, compensatory behaviour or insulin omission. Disordered-eating handling is prompt-only.
**Why it matters, in business terms:** The founder holds no dietetics registration. Giving a pregnant client a weight-loss calorie number, and asking someone who is purging what they ate, is the exact liability the product cannot carry.
**Fix:** A deterministic safety pre-router that runs **before** every handler — pregnancy/postpartum, disordered-eating behaviours (purging, laxatives, compensatory exercise, insulin omission), very-low intake with low BMI, under-18 — that stops coaching and refers.
**Effort:** M
**Confidence:** high (executed; deterministic replies)

### [P0] Minors are onboarded and coached on weight loss
**Where:** `server/onboarding.ts:462` (only under-14 is blocked), `:195`; `server/onboarding-intake.ts:111` (ages ≥10 accepted); `server/gpt.ts:178,197`
**What the code actually does:** 14–17-year-olds complete onboarding and receive calorie and protein targets. There is no guardian consent step. An age stated mid-conversation ("I'm 15") is never detected.
**Why it matters, in business terms:** POPIA restricts processing children's personal information without a guardian's consent, and weight-loss coaching of minors by an unregistered provider is a liability headline.
**Fix:** Block under-18 at onboarding, or build guardian consent. Detect stated age and pause.
**Effort:** S
**Confidence:** high (code). Whether any current clients are minors: **Needs human answer**.

### [P0] The merge gate cannot see the failures testers report
**Where:** `.github/workflows/test.yml` (all gating jobs model-offline); 58 harness files set `NORMALIZER=off`; `script/fixtures/normalizer-corpus.json` (10 entries); `coach-voice-gauntlet.yml` and `model-drill.yml` (nightly, non-gating); `reality-test.yml` (manual)
**What the code actually does:** About 100 suites and 54,385 lines of harness assert synthetic cases against a stubbed model. None replays real conversations with the live model before merge.
**Why it matters, in business terms:** It explains the eight months. Green CI has no correlation with tester experience, so every release is a guess and every fix is proven only against its author's hypothesis.
**Fix:** Build first, before the rebuild: a frozen, anonymised replay set of at least 150 real tester turns with human-labelled expected stored truth and acceptable replies, run with the live model as a required check.
**Effort:** M
**Confidence:** high

---

## 4. P1 findings

### [P1] Every reply ends with the same weigh-in instruction, all day, indefinitely
**Where:** `server/one-action.ts:267-280, 605-621`
**What the code actually does:** Rung 3 fires for anyone never weighed (≥1 week on programme) or ≥10 days stale. Nothing records that it was already said. In an ordinary 4-message day, all four replies ended "Stand on a scale…". The 08:30 one came straight after she reported eating breakfast — "this morning, before you eat" was already impossible.
**Why it matters, in business terms:** Scale-avoidant clients — common in this market — get nagged on every message. That is a direct retention cost, and it is the most visible symptom of root cause C.
**Fix:** Remember issued moves per day and per client, with a cooldown. Never say "before you eat" after a food log.
**Effort:** S now; properly solved by the composer rebuild
**Confidence:** high (executed)

### [P1] Multi-meal days collapse into one mislabelled row with a fabricated time
**Where:** `server/handlers/food-context.ts:799-833` (label at `:832`); `shared/schema.ts:210-242`
**What the code actually does:** One row per day, labelled with the first meal word in the whole day's text, stamped at a synthetic 08:00 or 12:00.
**Why it matters, in business terms:** Meal-slot coaching ("what should I have for dinner?") and corrections to a named meal operate on a fiction.
**Fix:** One row per meal event; `occurred_at` separate from `recorded_at`. Part of the rebuild.
**Effort:** M
**Confidence:** high (executed)

### [P1] The conversation record is not what was said
**Where:** `server/handlers/food-context.ts:331`; `server/memory.ts:250-252` (the admission); turns that write no `chat_history` row, e.g. the totals branch at `early-commands.ts:306`
**What the code actually does:** `chat_history` stores handler receipts rather than delivered replies. Later turns re-tag earlier rows. The client's words are stored after stripping (her "No" was deleted). Some turns write nothing. Rows are deleted on "clear food log" (`food-log-mgmt.ts:62`).
**Why it matters, in business terms:** This is the data every model call reads as "the conversation". It is also the only long-lived record, and it contradicts the repo's own rule that "the raw client message is immutable source evidence" (#234).
**Fix:** Append-only inbound and outbound logs holding the raw inbound text and the final delivered body. Part of the rebuild; the delivered-body half exists in `turn_ledger.deliveredBody`.
**Effort:** M
**Confidence:** high

### [P1] The 14-day money-back guarantee is promised, not implemented
**Where:** Promised at `server/handlers/conversion.ts:43,97,115`, `workout.ts:454,832`, `misc-commands.ts:1071-1072`. Implemented as a manual form at `server/handlers/lifecycle.ts:597-600`.
**What the code actually does:** "Refund" sends a form asking the client "what happened" and "how much you want refunded". There is no 14-day eligibility check, no PayFast refund, and no refund state.
**Why it matters, in business terms:** A guarantee made in writing and not honoured automatically is a trust and consumer-protection risk. Making people justify a no-questions refund reads as a dark pattern.
**Fix:** Check eligibility within 14 days of first payment, trigger the PayFast refund, record it.
**Effort:** M
**Confidence:** high

### [P1] Clients who cancelled are told "your payment didn't go through"
**Where:** `server/scheduler/jobs/business.ts:32-58` (expiry sets `cancelledAt`), `:68-100`
**What the code actually does:** Payment lapse and voluntary cancellation are stored identically (`inactive` + `cancelledAt`). The recovery job therefore sends voluntary cancellers "Could be a bank issue… update your payment here" on days 1, 3 and 7, via the critical path, with an SMS fallback and a re-engagement template.
**Why it matters, in business terms:** It tells a person who deliberately left that their payment failed, three times.
**Fix:** Separate status values: `cancelled_by_client`, `payment_failed`, `expired`.
**Effort:** S
**Confidence:** high

### [P1] "Delete my data" says "permanently delete all your data" but keeps eleven tables of it
**Where:** `server/handlers/safety.ts:315-375`
**What the code actually does:** It deletes logs and some tables and anonymises a handful of `users` fields. It **keeps** `turn_ledger` (raw messages and voice transcripts), `client_understanding` (the model-written life story), `client_truth_commits`, `daily_constraints`, `quality_signals` (friction, with message text), `reminders` and `shadow_replies` (both keyed by phone number), `media_jobs`, `gpt_costs`, `payment_events` and `admin_events`. The `users` row keeps diet restrictions, life context, BMI, goals and email.
**Why it matters, in business terms:** A false deletion statement about health data is a POPIA complaint waiting to happen.
**Fix:** Delete or anonymise every table carrying the user id or phone number; add a test that enumerates the schema.
**Effort:** S–M
**Confidence:** high

### [P1] 93% of text messages pay a model call before any handler runs
**Where:** `server/routes.ts:153-156`; `server/gpt.ts:1328-1340` (8 fast-path patterns)
**What the code actually does:** Across all 40 real messages used in this audit, only "done", "workout" and "hi" skipped the `gpt-4o-mini` classifier. "yes", "no", "thanks coach" and "STOP" all paid, whether or not a deterministic handler answered.
**Why it matters, in business terms:** Cost on every turn. The "most turns are free" premise does not hold. I could not find the "316 audited patterns" set in the repo to recompute it (§7), so this is my measured replacement.
**Fix:** Classify only when no deterministic owner claims, or fold classification into the single understanding step.
**Effort:** S
**Confidence:** high on the sample; medium as a traffic share

### [P1] Trial logic survives in live code; the sales pitch omits the guarantee
**Where:** `server/scheduler/jobs/trial.ts` (Day 2/5/7 trial conversion), `server/onboarding.ts:91` ("days left on free trial"), `server/scheduler/jobs/business.ts:171` ("your free trial ended yesterday"), `server/handlers/conversion.ts:49`
**What the code actually does:** Everything is gated by `TRIAL_DAYS` / `TRIALS_ENABLED` defaulting off, but the code, copy and scheduled job remain. The main price reply (`conversion.ts:49`) quotes "A personal trainer charges R250+" and does not mention the 14-day guarantee.
**Why it matters, in business terms:** One environment flag reintroduces a free trial the contract forbids.
**Fix:** Delete the trial paths; put the guarantee in the price reply.
**Effort:** S
**Confidence:** high

### [P1] "Today" after midnight is the new calendar day
**Where:** `server/sast.ts:46`; the step logging path
**What the code actually does:** "walked 9000 steps today" at 01:30 is stored on the *new* day. Wednesday shows no steps; Thursday opens at 9,000, and the keep-the-higher rule then protects the wrong number. A late toast logged "before bed" is stored at 00:30 of the *previous* day — the right day, a fabricated time. 56 hand-rolled `+2h` offsets remain in 26 files, despite `sast.ts:9-20` claiming "one module, one definition of a day".
**Why it matters, in business terms:** Night-shift and late-night clients — named in the product's own scenario guide — get their days scrambled.
**Fix:** A client "day end" (for example 03:00) in the single day resolver; `occurred_at` from language, not the wall clock.
**Effort:** M
**Confidence:** high (executed)

### [P1] Stored facts never expire and carry no provenance
**Where:** `shared/schema.ts:64-72, 98-103`; `server/understanding/perception.ts:38`
**What the code actually does:** `injuries`, `medicalConditions`, `lifeContext`, `workSchedule`, `dietaryRestrictions` and `goalType` have no `asserted_at` or source message. "Night shifts" said in March steers coaching forever. `lifeStory` is rewritten by a model each engine turn with no source link.
**Why it matters, in business terms:** Confidently wrong coaching — the second half of "I never told it that".
**Fix:** Facts as events with timestamps and sources; re-confirm on age.
**Effort:** M (part of the rebuild)
**Confidence:** high

### [P1] An insulin-omission question gets a generic disclaimer
**Where:** the `MEDICAL_DISCLAIMER` path; no deterministic insulin-omission rule exists
**What the code actually does:** "Should I skip my insulin on rest days to cut calories?" receives the standard "I won't advise on your medicine" reply.
**Why it matters, in business terms:** Deliberate insulin omission is a recognised, dangerous weight-control behaviour. It needs an urgent "do not do this — talk to your doctor today", not a brochure.
**Fix:** Add it to the safety pre-router.
**Effort:** S
**Confidence:** high (executed)

---

## 5. P2 / P3 findings

### [P2] Five different calorie floors; one path takes men below the male floor
**Where:** `server/targets.ts:111` (F 1200 / M 1500), `server/targets.ts:149` (F 1400 / M 1600), `server/adaptive-targets.ts:146` (1400, sex-blind), `server/scheduler/jobs/business.ts:448` (F 1300 / M 1500), `server/handlers/weight.ts:446` (1200, sex-blind)
**What the code actually does:** The weigh-in auto-adjust subtracts up to 150 kcal and clamps only at 1200, so a male fat-loss client floored at 1500 elsewhere can be set to about 1350. At least 12 sites across 8 files write targets directly, and the daily adaptive overlay rewrites `calorieTarget` from the baseline each morning, so these writers overwrite each other.
**Why it matters, in business terms:** Which target a client sees depends on which writer ran last.
**Fix:** One target function, one floor table, one writer.
**Effort:** S
**Confidence:** high

### [P2] The whale flag only renders on a dashboard
**Where:** `server/cost-tracking.ts:14-24`; `server/routes/admin-client.ts:121-305`
**What the code actually does:** A client costing more than half their fee is flagged only when someone opens the admin page. Nothing alerts or throttles.
**Why it matters, in business terms:** Margin can erode unseen between dashboard visits.
**Fix:** Push an alert when a client crosses the line.
**Effort:** S
**Confidence:** high

### [P2] The model rate and exchange rate are duplicated outside cost tracking
**Where:** `server/gpt.ts:1143-1145, 1439`
**What the code actually does:** Hard-coded per-token prices and R18.50 per dollar, used for console cost lines.
**Why it matters, in business terms:** Two owners of one number drift apart.
**Fix:** Read from `cost-tracking.ts`.
**Effort:** S
**Confidence:** high

### [P2] `MESSAGE_BUDGET` covers two reply paths out of dozens
**Where:** `server/reply-contract.ts:134`, used only in `meal-plan.ts` and `programme.ts`
**What the code actually does:** Bubble caps apply only to programme (3) and meal-plan (4) replies; every other path splits freely on `---`.
**Why it matters, in business terms:** Bubble count, and with it cost and noise, is unbounded on every other path.
**Fix:** Enforce at the outbound boundary.
**Effort:** S
**Confidence:** high

### [P2] Scheduler jobs load every user into memory
**Where:** e.g. `server/scheduler/jobs/business.ts:70`
**What the code actually does:** `db.select().from(users)` with no filter or pagination.
**Why it matters, in business terms:** Fine at beta size; breaks at 10x.
**Fix:** Filter in SQL.
**Effort:** S
**Confidence:** high

### [P2] Governors drive churn rather than design
**Where:** `script/check-architecture.ts` (multi-paragraph budget-raise justifications), `script/check-file-sizes.ts`
**What the code actually does:** Counts are frozen, so effort goes into moving code to satisfy budgets and justifying each raise in prose.
**Why it matters, in business terms:** Engineering time spent on accounting rather than on the product.
**Fix:** Retire them with the rebuild; measure tester outcomes instead.
**Effort:** S
**Confidence:** medium

### [P3] Dead Replit scaffolding and a second, unrelated chat store
**Where:** `server/index.ts:819`, `server/replit_integrations/`; tables `conversations` and `messages` (`shared/schema.ts:726-744`)
**What the code actually does:** A general-purpose voice-chat endpoint with no system prompt is registered on the production app. It is correctly key-guarded — 503 when unset, timing-safe comparison — so it is **not open**.
**Why it matters, in business terms:** Attack surface and confusion with no product value.
**Fix:** Delete.
**Effort:** S
**Confidence:** high

### [P3] A table created at runtime outside migrations
**Where:** `server/memory.ts:147-168`
**What the code actually does:** The `memories` table is created at boot with raw DDL, bypassing the migration history.
**Why it matters, in business terms:** Schema drift between environments.
**Fix:** Move to a migration, or drop with the embeddings path.
**Effort:** S
**Confidence:** high

### [P3] Two multi-day food owners
**Where:** `server/handlers/food-context.ts:770-845` and `server/backfill.ts` (both consume `attributeMultiDayReport`)
**What the code actually does:** Two components own the same question.
**Why it matters, in business terms:** Another place for fixes to diverge.
**Fix:** One owner, via the rebuild.
**Effort:** S
**Confidence:** medium

### [P3] Stale "single list" documents that contradict each other
**Where:** `DEFECTS.md` (last updated 2026-07-28; *"If a defect is not in this file, it is not being worked on"*), `OUTSTANDING.md` ("the only list", 2026-08-03), `LAUNCH_BLOCKERS.md` (2026-05-23), plus 45 files in `docs/`
**What the code actually does:** Nothing — but these are what people read to learn the product's state.
**Why it matters, in business terms:** Decisions get made from out-of-date claims.
**Fix:** Archive them; keep one live board.
**Effort:** S
**Confidence:** high

### [P3] R199 survives in comments
**Where:** `server/surface.ts:7`, `server/macro-card-attach.ts:490`, `server/tts.ts:35`, `server/scheduler/jobs/weekly.ts:248`
**What the code actually does:** Comments only; nothing client-facing. `conversion.ts:23` matching "r199" in a price-question regex is correct and should stay.
**Why it matters, in business terms:** Misleads readers about the current price.
**Fix:** Update the comments.
**Effort:** S
**Confidence:** high

---

## 6. Clean sections

Checked, and nothing material found:

- **PayFast ITN intake** (`payments.ts:75-170`): passphrase-signed MD5 verification, which refuses to run without a passphrase; merchant id check; amount check (±R5); idempotency on retries. Correct. The defects are in cancellation and re-activation, not intake.
- **Crisis language:** deterministic, before any model, with SADAG and Lifeline numbers (verified: "I don't want to be here anymore" → `CRISIS`).
- **Medication dosing:** metformin and insulin questions are refused deterministically, before any model. The insulin-*omission* wording is the one gap, logged under P1.
- **Secrets:** no live-looking API keys, Twilio SIDs or private keys in tracked files. Only `.env.example` is tracked.
- **Re-entry copy:** no shame language in comeback messages or templates. The restart doctrine was removed from `kamlife_checking_in` in Cut 6, and the come-back rung reads "No catching up, no starting over…".
- **Several #63 failures are genuinely fixed on current main** — the moved workout, "same as the last meal", "10k steps" and the black-coffee correction were all replayed. So is multi-day *day* attribution; the row collapse remains.
- **Cross-user leakage:** none found in the paths examined — per-user maps are keyed by user id or phone, and context queries filter by user. Not exhaustively proven. Confidence medium.
- **The "rescue/reset" wipe** (`lifecycle.ts:403-440`) deletes data only for clients still in early onboarding with none. It is *not* a data-loss path for completed clients. I checked because the keywords looked dangerous.

---

## 7. Needs human answer

1. **Is `ENGINE_LIVE` on in production?** The repo contradicts itself: #63 says off by default, while `advice-commands.ts:6` says "on for every client for weeks". `/health` reports it.
2. **Is `NORMALIZER` on in production, and are testers on the Twilio Sandbox number** (`+1 415 523 8886`)?
3. **Which of the four templates are Meta-approved**, and are their SID variables set? The code references `kamlife_daily_plan`, `kamlife_weekly_check`, `kamlife_payment_failed` and `kamlife_checking_in`.
4. **Are `COACH_ALERT_PHONE`, `TWILIO_SMS_NUMBER` and `PAYFAST_PASSPHRASE` set?** Without the first, cancellations alert no one. Without the last, every ITN is rejected and nobody is ever activated.
5. **Have past cancellers been charged again?** Check PayFast against `admin_events` / `payment_events`.
6. **Are any current clients under 18?**
7. **Are the three CI jobs required status checks** (branch protection)? Not visible from code.
8. **The real production failure distribution.** Pull 30 days of `turn_ledger` + `chat_history` and replay them through the rig used here. This audit could not.
9. **The "316 audited patterns".** No such corpus exists in the repo; "316" appears only as a past `regexLiterals` count in `check-architecture.ts`. Supply the set to recompute. My measured substitute: 37 of 40 real messages paid a model call.
10. **`finance.ts` does not exist.** Where is revenue and unit economics computed today?
11. **What the live model says** on the scope, GLP-1, under-18 and very-low-intake paths. The deterministic layers let these through; the model's actual answer needs a live run.

---

## 8. Fix order

### Definition of done — measured in tester outcomes, not commits

The founder sets final thresholds; these are the proposed bar.

| Measure | How | Target |
|---|---|---|
| **Stored truth** | Frozen replay set of ≥150 real anonymised tester turns, human-labelled | ≥95% of turns store exactly what the client said, on the right day and meal |
| **Recall** | 30 scripted "I told you X" probes at +1, +7 and +30 days, live model | ≥90% correctly recalled at every horizon |
| **No harm** | Same replay set plus the safety probe set | **0** data-loss events, **0** unsafe replies (pregnancy, eating-disorder, minor, medication) |
| **Voice** | Same replay set | **0** repeated identical coaching moves per client-day; **0** contradictions within a reply |
| **Tester friction** | `captureFriction` + corrections per 100 turns, 2-week tester cohort | ≥50% below the pre-rebuild baseline |
| **Tester verdict** | "It remembers me / it knows what I'm doing", 5-point scale | ≥4.0 median |
| **Retention** | Day-14 active loggers in the tester cohort | Above the pre-rebuild baseline |

No item below is "done" until the replay set and the tester cohort move.

### Order

**Stop the bleeding — days, independent of the rebuild:**
1. The decline-deletes-food path (§3; one condition). Effort S.
2. Opt-out: recognise intent broadly, enforce at the send boundary, including payment messages. Effort S–M.
3. Cancellation: call PayFast's cancel API; stop ITN re-activation of cancelled clients; separate cancellation from payment failure; stop the "payment didn't go through" messages to cancellers. Effort M.
4. A safety pre-router *before* the pipeline: pregnancy, eating-disorder behaviours, insulin omission, under-18, very-low intake with low weight. Effort M.
5. Block under-18 onboarding. Effort S.
6. Complete the POPIA deletion. Effort S–M.
7. Stop purging raw inbound text at 90 days until the event log exists; decide a lawful retention period first. Effort S.

**Rebuild — weeks, in this order:**
8. **The evaluation gate first.** Build the replay set and the recall probes, run with the live model as a required check. Nothing below is measurable without it. Effort M.
9. **Event log + projections.** Append-only inbound and outbound messages, raw text, `occurred_at`/`recorded_at`, facts as events. Day ledger and profile become projections with one owner each. Migrate existing rows as legacy events. Effort L.
10. **Understanding layer.** One schema-constrained interpretation per message over raw text plus retrieved context, emitting facts, questions and intents. The regex router and the rewriting normalizer are retired behind it, handler by handler. Effort L.
11. **Context assembly and composer.** A budgeted retrieval into every model call — profile facts, open loops, relevant past statements, the last N days' summary — and one composer that remembers what the coach already said and asked. Effort M–L.
12. **Decommission.** Delete the pipeline stages, regexes and authors the new layers replace, and retire the count governors in favour of the replay gate. Effort M.

**Deliberately not in this order:** new features, new handlers, more governor budgets, and more cuts against the current router. Each is another local fix on a core that does not converge.

---

## 9. Repo map

**Size:** 236 server TS files, 74,825 lines. `shared/` is 1,052 lines of schema plus pricing. `script/` is 151 files, 54,385 lines of harness. 34 tables, 14 committed migrations. 29 handler files, 27 cron registrations, ~55 model call sites.

**Turn path:** Twilio webhook → `server/routes/whatsapp.ts` (`processTextAsync`) → `server/routes.ts` `handleMessage`:
- safety guards `:131`
- classifier fired at entry `:153`
- onboarding / POPIA / subscription gate `:353`
- normalizer and brakes `:502-740`
- FoodLogMgmt `:795`
- training-day `:847`
- reminders `:906`
- EarlyCommands `:949`
- Workout `:964`
- Steps `:970`
- Water `:988`
- FoodContext `:1004`
- Misc `:1046`
- Lifecycle `:1050`
- meaning engine `:1063`
- GPT block `:1083`

then `sendFinal` → `prepareOutbound` → `server/outbound-delivery.ts` → Twilio.

**Where "what we know about the client" lives** — eight or more places, no owner:
- `users`: ~100 columns including cached totals and `profile_notes` tokens (`shared/schema.ts:21-149`)
- the four log tables — meal, step, weight, workout (`:151-242`); `workout_logs` is a boolean plus a timestamp
- `chat_history`: mutable, holds receipts (`:270`)
- `turn_ledger`: raw input, decision, delivered body; 90-day purge (`:298`)
- `client_understanding`: model-written `lifeStory` and observations (`:597`)
- `client_truth_commits` and `daily_constraints`: append-only, narrow (`:612`, `:641`)
- `client_intelligence_profiles`: weekly deterministic narrative, ≤6,000 characters in the prompt (`:780`)
- `memories`: pgvector, runtime-created, embeddings off (`server/memory.ts:147`)
- in-process maps: `server/understanding/executor.ts:82`, `server/handlers/early-commands.ts:46`

**Decision and voice:**
- `server/one-action.ts` — `chooseAction` ladder; rung 3 is the weigh instruction at `:617`
- `server/understanding/live.ts` — `canonicalDecision`, `closeCoachingTurn`, the meaning engine
- `server/gpt.ts` — `askCoachK` `:1018`, `classifyIntent` `:1350`
- `server/coach-prompt.ts` and `server/handlers/gpt-block.ts` — prompt text, including the scenario guide and safety prose

**Proactive:** `server/scheduler/jobs/*.ts` (16 jobs); send boundary `server/scheduler/shared.ts` (`sendWhatsApp`, `sendCriticalAlert`, `claimDailySlot`).
**Money:** `shared/pricing.ts`, `server/pricing-config.ts`, `server/routes/payments.ts`, `server/scheduler/jobs/business.ts`, `server/cost-tracking.ts`.
**Safety:** `server/handlers/safety.ts`, `server/safety-detection.ts` (after-reply escalation), `server/understanding/domain-guard.ts` (fail-open scope), `server/brain/reply-verifier.ts` (output checks).
**Verification:** `script/run-suites.ts` (41 suites), `script/pg-acceptance-runner.ts` (61 PostgreSQL suites + red-on-revert), `script/gauntlet.ts`, `script/check-*.ts` (8 count governors), `.github/workflows/test.yml` (the gate: unit-baseline, test, pg-acceptance — all model-offline).
**Docs:** 45 files in `docs/` plus four root status files, several stale or contradictory (§5).
