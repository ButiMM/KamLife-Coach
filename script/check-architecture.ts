/**
 * ARCHITECTURE GOVERNOR — the build fails when the codebase gets more complicated.
 *
 * (2026-07-30, founder: "you will tell the builder don't do this, don't do that. Then after a
 * few commits, they will forget. How do we make it impossible?")
 *
 * He is right, and every previous answer to this was a sentence in a document. Sentences are
 * forgotten in three commits. A red build is never forgotten.
 *
 * This freezes the shape of the system, not its behaviour. Behaviour is what the other 1,357
 * tests are for. This asks one question no test suite asks: IS THERE MORE OF EVERYTHING THAN
 * THERE WAS YESTERDAY?
 *
 * Because that is the actual disease. 60,656 lines, 333 pattern lists, 30 files each deciding
 * what a message means, three separate paths that can answer a client. Nobody chose that. It
 * accumulated, one locally-reasonable fix at a time, because nothing in the build ever said no.
 *
 * THE RULE: every number below may FALL. None may RISE. When one falls, this fails too — and
 * tells you to lower the budget, so the win is locked in and can never quietly leak back. Same
 * measure-freeze-migrate contract as check-file-sizes, check-sast and check-names.
 *
 * Run: npx tsx script/check-architecture.ts   (wired into `npm test`)
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
// ESM: a static import, not require(). This repo has already lost 23 tests to require() inside an
// ES module — they threw at load and reported nothing.
import { DOMAIN_OWNERS, NON_CLAIMANTS, STATE_OWNERS } from "./domain-owners";
import { join } from "node:path";

// Frozen 2026-07-30. LOWER THESE AS THINGS COLLAPSE. NEVER RAISE ONE.
// A raise is not a merge conflict to resolve — it is the moment to stop and ask why.
const BUDGET = {
  modules: 239,
  handlerFiles: 29,
  cronRegistrations: 26,
  /** Files that run a regex against the client's message — i.e. that hold an opinion on meaning. */
  messageDeciders: 32,
  /** `looksLikeX` predicates: hand-written guesses at intent. */
  looksLikePredicates: 21,
  /**
   * Named regex literals across the server. The 333 the founder was shown.
   *
   * DELIBERATELY NOT RAISED, 2026-08-17, and this counter currently reports 320 against 318 — so
   * this guard is RED ON PURPOSE. Raising it would encode a false positive.
   *
   * The re-entry migration moved two patterns out of early-commands.ts and into reentry.ts. Two
   * definitions became one. The counter reported +2 because the ORIGINALS were written as
   *     const isProfileUpdateMsg =
   *       /\b(train(ing)?…)/i.test(m);
   * and the match below requires `= /` on ONE line (`[^/\n]` cannot cross a newline). The
   * canonical replacements are single-line, so they are counted and their predecessors never were.
   *     reported +2   ·   actual -1
   *
   * Measured across the merge: 318 -> 320 counted, 63 -> 62 invisible. There are ~381 real
   * patterns, not 318 — roughly 17% of this metric's own subject is unseen, which is why it cannot
   * currently support a precise decision about regex growth. That blind spot is also how the
   * duplicate re-entry regexes sat unnoticed long enough to need a migration.
   *
   * FOLLOW-UP, explicit and owned: repair the matcher to see multi-line assignments and re-baseline
   * to the true figure in one deliberate commit. Until then this red line is the marker, and it is
   * the ONLY thing in this guard that is red — one red line means something, four never did.
   */
  regexLiterals: 449,
  /**
   * GUARD #13 — see unreachableExports above. Sixty-two capabilities cannot be reached by a
   * client message today. This budget is deliberately set THREE BELOW that, so this guard is RED
   * on the commit that introduces it and goes green only when the multi-day attribution owner —
   * attributeMultiDayReport, resolveRecentSituation, classifySituationMessage — is wired into the
   * live path. A guard that arrives already satisfied teaches nothing.
   *
   * The remaining 42 are declared debt, not permission. The largest block is the scheduler
   * jobs that are exported and never registered; whether the product wants a Monday check-in or
   * a plateau nudge is a product decision, and this number is where that decision gets made
   * rather than forgotten. LOWER THIS as capabilities are wired or deleted. Never raise it.
   */
  unreachableCapabilities: 42,
  /**
   * GUARD #14 — see unclassifiedSenders above. Six proactive senders still choose their own
   * behavioural instruction: monday's weigh-in reminder and diet-break restore, programme's weekly
   * check-in and plateau ladder, business's supplement nudge, onboarding's step-sync catch-up.
   *
   * Set to the measured figure, and it may only FALL. Two of the six are waiting on P0-7 (one pace
   * owner) rather than on wiring — naming that here is what stops it being rediscovered in a
   * transcript. The senders classified RECOGNITION, RESOURCE and OPERATIONAL are not in this
   * number because they carry no next-move instruction at all; that is a decision recorded per
   * job in the register, not an exemption anyone can take silently.
   */
  localDecisionSenders: 6,
  /**
   * GUARD #15 — see directLedgerReads above. Client-facing reads of weight_logs that do not go
   * through getWeightTruth, and therefore cannot honour do_not_mention.
   *
   * MEASURED 26 on main@266a8c2b, 15 after this cut. The eleven that went are every surface that
   * SPOKE A FIGURE without asking: the model context (client-snapshot, gpt.ts x2), the plateau
   * nudge, monthly photo day, the "not seeing results" stats line, the three client-asked commands
   * in misc-commands (which now say WHY they may answer, rather than answering by never checking),
   * and one dead duplicate in macro-card-attach that nothing called.
   *
   * The fifteen that remain are deliberately still here, and they are not the same kind of thing:
   *
   *   6  read only `loggedAt` — "is a trend assertable", "when did they last weigh" — and quote
   *      nothing. response-gate, one-action-command, understanding/live, chat-log, monday x2.
   *      They come home when trend-usability gets an owner, which is P0-7.
   *   6  monday and weekly already apply the rule themselves (mentionsForbidden, in-file). Moving
   *      them is consolidation, not a behaviour fix, and mixing the two in one PR is how a
   *      behavioural claim gets buried in a refactor.
   *   2  scheduler/shared.ts — loadProactiveState, which feeds chooseAction, and chooseAction has
   *      carried its own scaleIsOffLimits gate since Cut 7.
   *   1  business.ts runAutoCalAdjust — a target computation, not a sentence.
   *
   * LOWER THIS as each of those lands. Never raise it.
   */
  directWeightReads: 15,
  /**
   * GUARD #16 — see handRolledDayBuckets above. SQL that decides which SAST day a ledger row
   * belongs to, written somewhere other than the owner.
   *
   * MEASURED 7 on main@86f1c1e1, 5 after this cut. FOUR different spellings of one rule:
   *
   *   early-commands.ts   ×2   DATE(logged_at + INTERVAL '2 hours')                   correct
   *   food-scanner.ts     ×2   to_char(logged_at + interval '2 hours', 'YYYY-MM-DD')  correct
   *   one-action-cmd.ts   ×1   DATE(logged_at AT TIME ZONE 'UTC' + INTERVAL …)        correct
   *   gpt.ts              ×2   DATE(logged_at)                                        WRONG — UTC
   *
   * The two wrong ones are gone; they take the bucket from sastDayBucketSql now. The five that
   * remain are CORRECT TODAY and are still counted, deliberately. Four correct copies of a rule is
   * exactly the state this repo was in when the fifth was written as DATE(logged_at) and nobody
   * noticed for months — and it is the state client-snapshot.ts was fixed out of in August without
   * the rule itself ever getting a home.
   *
   * LOWER THIS by moving them onto the owner. Never raise it.
   */
  handRolledDayBuckets: 5,
  /**
   * GUARD #9 — AUTHORSHIP POINTS (2026-08-04). Every `return "…"` in server/ is a place
   * something other than the engine can put words in front of a client.
   *
   * Guard #8 made tools silent by type. It could not reach handlers, cards, schedulers or
   * onboarding — 532 of these, counted for the first time today after the founder said the
   * one thing that mattered: "you're telling me about a patch, we can't even do a simple
   * thing." He was right that it felt endless, and the reason was that nobody had ever
   * counted. Mouths were killed by discovery — one screenshot, one patch, one more tomorrow.
   *
   * This number is now FROZEN. It can fall and it can never rise, so the long tail can only
   * shrink and a new mouth is a build failure rather than next week's screenshot. Report it
   * with [GUARD8] daily: those two numbers are the whole truth about authorship.
   */
  authorshipPoints: 420,
  twilioCallSites: 16,
};


/**
 * ACTION FILES — every file that BOTH matches on the client's message AND writes to the database
 * is classified here, or the build fails.
 *
 * (2026-07-30.) The worst defect of the day was not a missing rule: the founder photographed a
 * machine in his gym, asked "Do I have this in my workout today?", and got a bodyweight session
 * because the substring "i have this" matched an ownership pattern. isAskingNotReporting already
 * answered that correctly. Nobody called it. Two more of the same were found by counting rather
 * than testing — a question could log a meal, and a question could log a beer.
 *
 * A bare count was the first version of this and it was too weak: it let a file look compliant
 * because the guard's NAME appeared in a comment. So each file is now declared.
 *
 *   "guarded" — calls one of the ask/negation/future guards before it acts.
 *   "must-act" — acts whatever the phrasing, on purpose. Safety and triage cannot wait for
 *                grammar, and onboarding is a state machine where a question IS the input.
 *   "bookkeeping" — writes accounting or conversation state, never the client's plan.
 *   "AT RISK" — a real mutation of the client's plan that no guard protects yet. This is the
 *               backlog, and it is named rather than counted so nobody has to rediscover it.
 */
const ACTION_FILES: Record<string, "guarded" | "must-act" | "bookkeeping" | "AT RISK"> = {
  // meal-repeat.ts and food-commands.ts were here until Cut A. Both held their own meal INSERT —
  // the repeat door copied a previous row, the alcohol door wrote its own — so both were
  // independent authorities on "a new eating event happened". Both now hand rows to
  // commitFoodLog and write nothing themselves, which is the whole point of the cut: this list
  // shrinking is what convergence looks like from the governor's side.
  // food-context.ts was here until commitFoodLog — the write door — moved to server/day-ledger.ts.
  // It now parses and decides and hands rows to that one owner; it writes nothing itself.
  "server/handlers/food-log-mgmt.ts": "guarded",
  "server/handlers/media.ts": "guarded",
  "server/handlers/workout.ts": "guarded",
  "server/handlers/water.ts": "guarded",
  "server/handlers/lifecycle.ts": "guarded",
  "server/routes.ts": "guarded",
  // 2026-08-19, Cut 7/8b. recordClientFacts writes six durable columns off the client's own
  // words, and one of them — injuries — is read by programme.ts to remove exercises from a plan.
  // That is a mutation of the client's plan, so bookkeeping would be a lie. It is "guarded"
  // because detectFacts consults looksLikeQuestion and isFutureIntent before recording, plus an
  // explicit resolution check so "my knee doesn't hurt anymore" cannot train around a healthy
  // knee. mentionsNotDone is deliberately NOT used — it matches "can't", and "can't eat dairy" is
  // the dietary fact rather than its negation; the guards are applied per fact, with reasons, in
  // detectFacts itself. The governor caught this file undeclared and the gap was real.
  "server/memory.ts": "guarded",
  "server/handlers/safety.ts": "must-act",
  "server/handlers/pain-triage.ts": "must-act",
  "server/onboarding.ts": "must-act",
  "server/handlers/reminders-handler.ts": "must-act",
  "server/gpt.ts": "bookkeeping",
  "server/handlers/gpt-block.ts": "bookkeeping",
  "server/understanding/live.ts": "bookkeeping",
  "server/handlers/numbers-literacy.ts": "bookkeeping",
  // 2026-08-07: dropMeals moved here, so this file now writes. It never decides — it takes row
  // ids its caller already resolved (behind that caller's guard), removes them, resyncs the
  // day's accounting columns, and records what left in [MEAL_DROP]. The message-matching half
  // of this file (scanForSAFoods) still only reads. Re-classify the day it decides anything.
  "server/handlers/food-scanner.ts": "bookkeeping",
  // It records the turn — chat_history, the turn ledger, and a safety escalation row when
  // detectEscalation fires. Every write is a record of what happened; none of them changes a
  // target, a programme, or anything else the client's plan is made of. Re-classify the day one
  // of them does.
  "server/handlers/chat-log.ts": "bookkeeping",
  // Named backlog. Each mutates something the client feels, from a message match, with no guard:
  "server/handlers/early-commands.ts": "AT RISK",   // trainingMode, trainingDaysPerWeek, targetWeightKg
  "server/handlers/advice-commands.ts": "AT RISK",  // stepsTarget
  "server/handlers/misc-commands.ts": "AT RISK",    // injuries
};

/** May only fall. Every entry above must be worked to guarded/must-act/bookkeeping. */
const AT_RISK_BUDGET = 3;

/**
 * THE ONLY LEGITIMATE WAY TO RAISE A BUDGET.
 *
 * The original rule was "never raise", which is right in spirit and wrong in mechanism: a rule
 * with no legal exit gets deleted the first time it blocks something that genuinely must ship.
 * Then the governor is gone and nobody notices. So a raise is legal, but it is EXPENSIVE — it
 * must be written down here, dated, with what was tried first, and it is printed on every single
 * run forever. A raise you have to re-read every build is a raise you will want to pay back.
 *
 * The check below makes this mechanical: raise a budget without logging it here and the build
 * fails exactly as if you had never raised it.
 */
const RAISES: Array<{ key: keyof typeof BUDGET; from: number; to: number; date: string; why: string }> = [
  {
    key: "messageDeciders", from: 31, to: 32, date: "2026-09-04",
    why: "RELEASE CLOSURE, AFTER EXACT INVENTORY — the 31-file inventory at the last legitimate "
      + "baseline (c9474132) and the current 32-file inventory differ by one file only: "
      + "server/handlers/chat-log.ts. That file now makes live, distinct message decisions at the "
      + "final turn/history boundary: whether a turn contains enough client information to audit a "
      + "thin reply, and whether a delivery question can be resolved from stored media receipts. "
      + "Both are reached from routes.ts; deleting either loses shipped reconciliation/receipt "
      + "behaviour. TRIED FIRST, and rejected: moving the meaningful-turn question into "
      + "reaction-guard.ts (that owner answers the narrower bare-reaction question and has none of "
      + "the turn evidence), moving receipt resolution into handlers/media.ts (the evidence is chat "
      + "history, not the current upload, and media.ts is already 1549/1550 lines), and renaming the "
      + "local message variable so the matcher stopped seeing it. Those moves either create the "
      + "wrong owner, exceed another governor, or game this one. All 32 current files were listed "
      + "with the matcher and remain live; 32 is the smallest truthful present boundary. FROM HERE "
      + "IT FALLS ONLY. Pay it back when final-turn meaning and receipt evidence can be supplied by "
      + "an existing structured classification without deleting either behaviour.",
  },
  {
    key: "looksLikePredicates", from: 20, to: 21, date: "2026-09-04",
    why: "RELEASE CLOSURE, AFTER EXACT INVENTORY — against the original 20-predicate freeze, "
      + "looksLikeSameMeal was removed while two distinct live boundaries arrived: "
      + "looksLikeBulkIntake (onboarding.ts decides whether one long first message contains a whole "
      + "profile) and looksLikeRecallQuestion (gpt-block.ts routes an explicit memory question to "
      + "grounded stored evidence and never to GPT). Net: 20 - 1 + 2 = 21. Every one of the 21 "
      + "declarations has a production caller; the exact caller inventory was recomputed before "
      + "this entry. TRIED FIRST, and rejected: treating a first-contact profile blob as a messy "
      + "meal/event (parseMessyIntake answers a different lifecycle question), treating recall as "
      + "ordinary model classification/RAG (violates the quote-evidence-or-abstain trust boundary), "
      + "or folding either into the other. Renaming either predicate was also rejected as counter "
      + "evasion. The two questions and owners are irreducible without removing product behaviour, "
      + "so 21 is the smallest truthful current baseline. FROM HERE IT FALLS ONLY.",
  },
  {
    key: "regexLiterals", from: 318, to: 449, date: "2026-08-24",
    why: "NOT A RAISE — A CORRECTED MEASUREMENT, and the follow-up this budget's own comment "
      + "declared owed on 2026-08-17: \"repair the matcher to see multi-line assignments and "
      + "re-baseline to the true figure in one deliberate commit.\" This is that commit. The "
      + "matcher required `= /` on a single line and its `[^/\\n]` class stopped at the first "
      + "slash, so it missed both the multi-line assignment form AND every pattern containing an "
      + "escaped slash. Nothing was added to the codebase to move this number: 377 was what the "
      + "broken matcher could see, 449 is what has been there all along, and the delta is 72 "
      + "patterns that existed before this commit and were never counted. The old note estimated "
      + "~381; the measured figure is 449, because the escaped-slash blind spot was not in that "
      + "estimate. TRIED FIRST, and rejected: leaving the matcher broken and the line red, which "
      + "is what the 2026-08-17 note explicitly refused to accept as a final state — a counter "
      + "that cannot see 16% of its subject cannot support a decision about growth, and a red "
      + "line nobody can act on trains people to ignore the guard. PAID BACK by the same commit: "
      + "server/replit_integrations/{chat,image,batch,audio}/index.ts deleted (four unreferenced "
      + "barrel re-exports; the one apparent importer was a line inside a comment), which returned "
      + "modules from 243 to 239 — GREEN, unraised — and two unreachable functions removed, "
      + "food-naming.assumptionNote (a client-facing mouth nothing called) and "
      + "food-swaps.substituteFor. FROM HERE IT FALLS ONLY. Every pattern this now sees is a real "
      + "pattern, and the honest count is the one worth arguing about.",
  },
  {
    key: "modules", from: 237, to: 239, date: "2026-08-17",
    why: "TWO modules, TWO DISTINCT REASONS — recorded separately because collapsing them into "
      + "\"PR #46 added two files\" would lose the only thing that makes either defensible. "
      + "(1) server/understanding/reentry.ts — the canonical owner of what \"returning\" MEANS. "
      + "Before it, that question was answered in three places from two different clocks, and one "
      + "of them still reads the wrong one (store.ts:38 uses clientUnderstanding.updatedAt, a "
      + "PERSISTENCE timestamp, so a client can be greeted as returning because our own storage "
      + "was last written three days ago). A single owner is the precondition for fixing that. "
      + "(2) server/understanding/reentry-bridge.ts — a deliberate DATA-SOURCE boundary, not a "
      + "convenience wrapper. Its only job is that a consumer hands over a `user` and cannot "
      + "select which timestamp counts as last contact. It has one caller and will still have one "
      + "after P2, because store.ts fires at understanding-LOAD time where there is no client "
      + "message and will call the daysSinceContact primitive instead. One caller does not "
      + "invalidate a boundary whose purpose is to make the wrong field unreachable — architectural "
      + "value is not measured in lines or callers. "
      + "TRIED FIRST, and REJECTED: deleting the bridge to reach 238. That is optimising the score, "
      + "not the architecture, and the caller-count test was actually RUN before the decision "
      + "rather than assumed. PAY THIS BACK if a future reader can show the boundary is unreachable "
      + "by mistake without it — i.e. once nothing in the codebase can name a second last-contact "
      + "field. Evidence: all correctness suites pass on this commit, including 35 resolver and 44 "
      + "bridge assertions, both now wired into the gate.",
  },
  {
    key: "modules", from: 236, to: 237, date: "2026-08-17",
    why: "GLP-1 MEDICATION SAFETY — ONE CAPABILITY, THREE COUPLED DIMENSIONS. server/medication-context.ts (21e8c44) is a new deterministic owner of one question: is this message about medication, and is the request unsafe? Nothing answered that question before — there was no existing owner to extend. Because the answer is derived from the client's own words, the module necessarily (a) is a module, (b) runs regexes against the message so it counts as a message-deciding owner, and (c) names those regexes as constants. modules, messageDeciders and regexLiterals therefore moved TOGETHER in a single commit. They are three measurements of one boundary, not three independent architecture decisions, and the diagnosis that established this walked every one of the 95 commits between 77fe0a7 and c52eac7 to attribute each delta. TRIED FIRST, and REJECTED: folding the detection into brain/reply-verifier.ts, which would couple CLASSIFICATION to ENFORCEMENT and leave the safety detector untestable apart from the gate that consumes it; and into handlers/early-commands.ts, which would make a safety boundary a routing concern. Both would have optimised for the counter instead of the architecture. THE GOVERNOR WAS CORRECTED BEFORE IT WAS RAISED: authorshipPoints also read over budget at 423/420, and those three points were the violation strings in medicationBoundaryViolation() — rewrite REASONS sent to the model and the admin queue, never to a client, traced through all six consumers of `.violation`. reply-verifier.ts is now excluded as the gate it is, and that counter returned to 420/420 by losing false positives rather than by moving a ceiling. Only the three deltas that survived an honest measurement are raised here. NOT PAID BACK BY DELETING SOMETHING ELSE. Compressing an unrelated file to reach 236/30/316 would be cargo-cult accounting; the governor exists to force a conscious account of complexity, and this is that account. Pay it back the day medication safety can be expressed by an owner that already exists. Evidence: all correctness suites pass on this commit, the safety boundary is required by CONSTITUTION law 4, and the whole delta traces to 21e8c44.",
  },
  {
    key: "messageDeciders", from: 30, to: 31, date: "2026-08-17",
    why: "GLP-1 MEDICATION SAFETY — ONE CAPABILITY, THREE COUPLED DIMENSIONS. server/medication-context.ts (21e8c44) is a new deterministic owner of one question: is this message about medication, and is the request unsafe? Nothing answered that question before — there was no existing owner to extend. Because the answer is derived from the client's own words, the module necessarily (a) is a module, (b) runs regexes against the message so it counts as a message-deciding owner, and (c) names those regexes as constants. modules, messageDeciders and regexLiterals therefore moved TOGETHER in a single commit. They are three measurements of one boundary, not three independent architecture decisions, and the diagnosis that established this walked every one of the 95 commits between 77fe0a7 and c52eac7 to attribute each delta. TRIED FIRST, and REJECTED: folding the detection into brain/reply-verifier.ts, which would couple CLASSIFICATION to ENFORCEMENT and leave the safety detector untestable apart from the gate that consumes it; and into handlers/early-commands.ts, which would make a safety boundary a routing concern. Both would have optimised for the counter instead of the architecture. THE GOVERNOR WAS CORRECTED BEFORE IT WAS RAISED: authorshipPoints also read over budget at 423/420, and those three points were the violation strings in medicationBoundaryViolation() — rewrite REASONS sent to the model and the admin queue, never to a client, traced through all six consumers of `.violation`. reply-verifier.ts is now excluded as the gate it is, and that counter returned to 420/420 by losing false positives rather than by moving a ceiling. Only the three deltas that survived an honest measurement are raised here. NOT PAID BACK BY DELETING SOMETHING ELSE. Compressing an unrelated file to reach 236/30/316 would be cargo-cult accounting; the governor exists to force a conscious account of complexity, and this is that account. Pay it back the day medication safety can be expressed by an owner that already exists. Evidence: all correctness suites pass on this commit, the safety boundary is required by CONSTITUTION law 4, and the whole delta traces to 21e8c44.",
  },
  {
    key: "regexLiterals", from: 316, to: 318, date: "2026-08-17",
    why: "GLP-1 MEDICATION SAFETY — ONE CAPABILITY, THREE COUPLED DIMENSIONS. server/medication-context.ts (21e8c44) is a new deterministic owner of one question: is this message about medication, and is the request unsafe? Nothing answered that question before — there was no existing owner to extend. Because the answer is derived from the client's own words, the module necessarily (a) is a module, (b) runs regexes against the message so it counts as a message-deciding owner, and (c) names those regexes as constants. modules, messageDeciders and regexLiterals therefore moved TOGETHER in a single commit. They are three measurements of one boundary, not three independent architecture decisions, and the diagnosis that established this walked every one of the 95 commits between 77fe0a7 and c52eac7 to attribute each delta. TRIED FIRST, and REJECTED: folding the detection into brain/reply-verifier.ts, which would couple CLASSIFICATION to ENFORCEMENT and leave the safety detector untestable apart from the gate that consumes it; and into handlers/early-commands.ts, which would make a safety boundary a routing concern. Both would have optimised for the counter instead of the architecture. THE GOVERNOR WAS CORRECTED BEFORE IT WAS RAISED: authorshipPoints also read over budget at 423/420, and those three points were the violation strings in medicationBoundaryViolation() — rewrite REASONS sent to the model and the admin queue, never to a client, traced through all six consumers of `.violation`. reply-verifier.ts is now excluded as the gate it is, and that counter returned to 420/420 by losing false positives rather than by moving a ceiling. Only the three deltas that survived an honest measurement are raised here. NOT PAID BACK BY DELETING SOMETHING ELSE. Compressing an unrelated file to reach 236/30/316 would be cargo-cult accounting; the governor exists to force a conscious account of complexity, and this is that account. Pay it back the day medication safety can be expressed by an owner that already exists. Evidence: all correctness suites pass on this commit, the safety boundary is required by CONSTITUTION law 4, and the whole delta traces to 21e8c44.",
  },
  {
    key: "modules", from: 235, to: 236, date: "2026-08-12",
    why: "ONE module: server/hunger-evidence.ts, the assembler that joins the nutrition picture "
      + "to the symptom history. The doctrine it serves is the one the prompt audit found "
      + "orphaned — persistent hunger is a signal to INVESTIGATE, not proof that protein is the "
      + "cause — and it cannot be taught to the model before the model can be handed the "
      + "evidence to investigate with. Its whole job is to make «adequate protein, STILL hungry» "
      + "impossible to miss, because that is the case a one-line rule gets confidently wrong for "
      + "exactly the clients who already did what we asked. Tried first, and REJECTED: "
      + "progress-score.ts (pure and semantically close, but it is the beyond-the-scale COMPOSITE "
      + "and a hunger object living under that name is a trap for the next reader), and "
      + "quality-signals.ts (already corrected once this week for exactly this — it stores "
      + "signals, it must not become a second reasoning brain; the governor caught that and was "
      + "right). Tried first, and it worked, so it is NOT in the other numbers: zero regexes, "
      + "zero message deciders, zero client-facing mouths — the file contains no prose at all, "
      + "by design, and a test fails if it grows any. PAY THIS BACK when the second and third "
      + "evidence assemblers arrive (plateau, adherence breakdown): they are the same shape — "
      + "join deterministic evidence, state what it supports, decide nothing — so they belong "
      + "BESIDE this one rather than as three more modules, and that consolidation takes the "
      + "count back down rather than up.",
  },
  {
    key: "modules", from: 234, to: 235, date: "2026-08-10",
    why: "ONE module: server/normalizer-fidelity.ts, the gate that decides whether a normalizer "
      + "rewrite may speak for the client. The Reality Test proved this is not a style question. "
      + "«Actually no, that was yesterday. And it wasn't rice, it was pap. And I had spinach too» "
      + "was rewritten to «i had tin fish, pap, spinach and mixed veggies for lunch yesterday» — "
      + "two foods INVENTED, the correction framing destroyed, and the chicken lost because a "
      + "fresh log has nothing to retain. A second journey lost a question and an admission of "
      + "feeling useless the same way. A rewrite REPLACES the client's words before any handler "
      + "sees them, so an unfaithful one is not a bad guess, it is the message destroyed in "
      + "transit, and nothing downstream can recover what it never received. Tried first, and "
      + "REJECTED: putting it in utils.ts (2 lines of headroom, and utils.ts reaching 1198 lines "
      + "is itself the result of every pure helper going there) and in gpt.ts (28 lines of "
      + "headroom, and the gate must be testable without the model it judges). Tried first, and "
      + "it worked, so it is NOT in the regex number: the emotion test reuses "
      + "carriesFeelingClause and the question test reuses looksLikeQuestion instead of the two "
      + "patterns the first draft of the file carried — regexLiterals is unchanged at 316. PAY "
      + "THIS BACK by moving the SIX inline brakes routes.ts already carries (invented numbers, "
      + "invented goals, retro dates, repeats, historical weights, reasoning-vocabulary totals) "
      + "into this file: they answer the same question in the same place, that migration SHRINKS "
      + "routes.ts and removes patterns from the count, and it was deliberately NOT done in this "
      + "work order because the directive forbids refactoring working code while fixing a "
      + "demonstrated failure.",
  },
  {
    key: "authorshipPoints", from: 419, to: 420, date: "2026-08-10",
    why: "ONE mouth: the confirmation that a meal MOVED to another day. «Actually, that was "
      + "yesterday» had no owner anywhere in the product — it fell past every handler to the "
      + "model, which answered «Sorry Kam, I didn't quite catch that 🙂» and three buttons while "
      + "the meal stayed on the wrong day. Every total, card and weekly average built on that day "
      + "was then wrong, silently and permanently, which is the worst class of defect this "
      + "product has: a number the client cannot tell is lying. A move that does not say what it "
      + "moved is the same mistake as «Removed your last meal ✅» — the reason the wrong-meal bug "
      + "hid for a whole conversation. Tried first, and it worked, so it is NOT in this number: "
      + "the two «I can't trust today's numbers» sentences merged into one owner earlier today "
      + "(that took 420→419, so this raise is net-neutral on the day), the hold replies REPLACED "
      + "the delete-and-ask replies rather than adding to them, and holdForReplacement's "
      + "delimited token was rewritten as a join so it stops reading as a sentence. PAY THIS "
      + "BACK the same way as the raise below: once the engine owns the resolved target and day, "
      + "it writes this confirmation itself from facts and the handler goes silent.",
  },
  {
    key: "regexLiterals", from: 315, to: 316, date: "2026-08-10",
    why: "ONE pattern: MOVE_FRAME, which separates «actually that was yesterday» (move an "
      + "existing entry) from «I had rice yesterday» (a retroactive LOG, which already worked). "
      + "The distinction cannot come from the date words — both sentences carry them — so it has "
      + "to come from the frame. Tried first and rejected: reusing isRetroactiveMeal alone "
      + "(wrong question — it answers «is another day named», which both sentences answer yes "
      + "to, and using it alone would have turned every retro log into a move); and reusing "
      + "parseIdentityCorrection (wrong shape — it requires an «X not Y» pair and this sentence "
      + "has none). Tried and kept: the predicate takes the date answer as an ARGUMENT rather "
      + "than asking a second time, so «which day is this about» still has exactly one owner in "
      + "parseMealDate. PAY THIS BACK by moving the move/log distinction onto the normalizer's "
      + "intent classification, which already reads every message once and would return the "
      + "shape of the correction without a pattern here.",
  },
  {
    key: "regexLiterals", from: 312, to: 315, date: "2026-08-07",
    why: "THREE patterns for the three deterministic defects the live-model gauntlet found at "
      + "04:19, two hours before the founder found the same ones by hand and furious. "
      + "`alsoAsksFood` makes the calorie handler STAND DOWN when a second question rides along "
      + "— «what can I eat at the taxi rank and how many calories do I have left» was answered "
      + "on the calories and the food half was never seen by anything, because a handler that "
      + "returns early makes constitution law 20 impossible for the engine to obey. "
      + "`asksTrolley` separates «what do I buy» from «which shop» — the word Shoprite in his "
      + "message returned eleven sentences of the shop's price directory. `skipStarch` reads "
      + "what he said he already has at home so the R300 goes on protein instead of a second "
      + "bag of rice. Tried first, and it worked, so it is NOT in this number: two of the four "
      + "collapsed into one pattern each (the food-ask and the taxi-rank list; the have-at-home "
      + "extraction and its starch test), and the store qualifier went inline. Rejected "
      + "deliberately: inlining the remaining three to dodge the counter — that is optimising "
      + "for the guard instead of the reader, which is the habit this governor exists to stop. "
      + "PAY THIS BACK by moving all three onto the normalizer's intent classification, which "
      + "already reads every message once and would answer «is this two questions?» without a "
      + "single pattern here.",
  },
  {
    key: "regexLiterals", from: 311, to: 312, date: "2026-08-06",
    why: "ONE pattern: HANDBACK_QUESTION, the closing questions that hand the work back to the "
      + "client. The founder's most-repeated complaint all day — seven replies in a row ending "
      + "«What do you think?», «What's your plan?», «What do you have at home?» — against a "
      + "prompt that has forbidden exactly that since July. That is the lesson of the whole "
      + "rebuild in one line: a rule that lives only in the prompt is a suggestion, and the "
      + "rules holding on his phone tonight are the ones a test enforces. Tried first and "
      + "rejected: reusing looksLikeQuestion (wrong question — it matches every question, and "
      + "rewriting a coach's genuine one would break the voice this sweep protects) and the "
      + "PLATITUDES list (wrong action — platitudes are stripped, a hand-back is REPLACED by "
      + "the computed next move, because a reply that stops dead is worse than one that asks). "
      + "PAY THIS BACK when the engine emits a structured needsInfo flag: the pattern exists "
      + "only because we have to infer from prose whether the model was asking or telling.",
  },
  {
    key: "regexLiterals", from: 309, to: 311, date: "2026-08-06",
    why: "THE WRONG MEAL WAS DELETED, live, on the founder's phone. He said «the bread, eggs, "
      + "avocado, and black coffee are inaccurate. Remove that meal» and the rice-and-beef "
      + "dinner was destroyed instead — the day fell by exactly the 470 kcal of an entry he "
      + "never named. Two patterns pay for that: `saysReferent` recognises «that meal» as "
      + "pointing at foods named EARLIER in the sentence (every existing targeting branch reads "
      + "only what follows the verb, which is why all of them missed it), and `isUseless` "
      + "replaces a length-only rule that was replacing correct short replies with a form — "
      + "«Had an Apple» came back as «Type the meal like this». Tried first, and it worked, so it "
      + "is NOT in this number: the removal-keyword test now reuses hasMgmtKeyword instead of a "
      + "second copy, the ambiguous-match case falls through to the numbered-list branch that "
      + "already owns that answer, and the useless/acknowledges pair collapsed to one test. "
      + "PAY THIS BACK by moving referent resolution onto the normalizer, which already reads "
      + "every message once and could hand the handler a resolved target instead of a pronoun.",
  },
  {
    key: "authorshipPoints", from: 420, to: 421, date: "2026-08-06",
    why: "ONE mouth: the confirmation that names WHICH meal was removed. A deletion that does not "
      + "say what it deleted is how the wrong-meal bug stayed invisible for a whole conversation "
      + "— «Removed your last meal ✅» was true and useless. PAY THIS BACK with the same move as "
      + "the raise above: once the engine owns the resolved target it can write this sentence "
      + "itself, from facts, and the handler goes silent.",
  },
  {
    key: "messageDeciders", from: 29, to: 30, date: "2026-08-05",
    why: "Shopping substitutions — 'they didn't have chicken at the shop'. This is a DIFFERENT "
      + "question from the goal-swap table ('fried chicken is worse for you, grill it'), and it "
      + "is the one clients actually ask: the shelf was empty, what does the same job. Before "
      + "this it was answered by food-log-mgmt with «I don't see \"chicken at the shop\" in "
      + "today's food log» — a client telling us what the shop was out of, told their own log "
      + "disagrees. Tried first: extending the existing swap table (wrong answer — it returns a "
      + "HEALTH verdict, not an availability one) and the swap-ask regex (wrong shape — no "
      + "'instead of' in 'they didn't have it'). The two detections share ONE owner: food-log-mgmt "
      + "stands down by calling into the same predicate, not its own copy. PAY THIS BACK by "
      + "merging the availability check into the normalizer's intent classification, which "
      + "already reads every message once and would need no second decider.",
  },
  {
    // PAID BACK THE SAME DAY. The cut-now list (leaderboard, badges, buddy system,
    // challenge-a-friend, fasting tracker, daily fact) removed 13 mouths, so the budget is
    // now 430 — ten BELOW the 440 this raise started from. Kept on the record rather than
    // deleted: a raise that vanishes once it is convenient teaches nothing, and the next
    // person should see both that it was taken and that it was settled.
    key: "authorshipPoints", from: 440, to: 443, date: "2026-08-06",
    why: "[SETTLED 2026-08-06 — budget now 420] THREE new mouths, both for features that legally or clinically cannot be silent. "
      + "(1) server/food-swaps.ts +1 — productVerdict answers 'can I eat this?' from the "
      + "nutrition label. (2) server/onboarding.ts +2 — the ASK_BODY_PHOTOS branch, which is "
      + "what finally makes onboarding-physique.ts REACHABLE: that module has existed since "
      + "17 July and nothing in the product ever set the state, so the day-zero read that "
      + "stops a client who needs a surplus being put on a deficit had never run for a human "
      + "being. The branch is a skip confirmation and a wait line, and a client who types "
      + "'ok' was previously stranded with no path forward. Tried first, and it worked, so it "
      + "is NOT in this number: the compact overload line collapsed two returns into one; the "
      + "photo-delete branch stands down with null instead of repeating 'no account found'; "
      + "the decline list moved to a Set so it stopped being counted as prose; and the whole "
      + "path sweep in the same session DELETED far more client-facing text than this adds "
      + "(the workout done-reply alone went from three paragraphs to one line). The count "
      + "still rises because the sweep SHORTENED strings rather than removing return sites. "
      + "PAY THIS BACK by moving both to the one brain: the two onboarding lines are exactly "
      + "the short conversational turn writeReplyAfterTools already writes better, and "
      + "productVerdict should return ToolFacts and let the engine say the sentence — which "
      + "is what Guard #8 asks for and would take all three back off this number.",
  },
  {
    key: "regexLiterals", from: 333, to: 330, date: "2026-07-30",
    why: "Provenance gate — the coach may not assert a fact it cannot trace to a stored row. "
      + "5 patterns to recognise the 3 claim kinds that have actually shipped as defects "
      + "(weight trend, meal eaten, calorie target). Tried first: merged 2 patterns into 1 with "
      + "lookaheads, searched for dead regex constants (none) and exact duplicates (none). "
      + "PAY THIS BACK by moving claim recognition onto the meaning engine's structured output, "
      + "which already parses these three things and needs no patterns at all. "
      + "+1 later the same day: the platitude strip needed a fragment test after it was caught "
      + "DELETING COACHING ('Complete your workout' died with 'listen to your body'). Shipping "
      + "a reply-eating bug to save a regex would have been the wrong trade.",
  },
];

/**
 * ONE OWNER PER QUESTION. Each entry is a question the product must answer exactly once.
 * `owner` is the only file allowed to define it; everyone else imports.
 *
 * These are not hypothetical — every one was a real defect on 29 July, where two files answered
 * the same question differently and a client fell down the gap between them.
 */
const ONE_OWNER: Array<{ question: string; owner: string; definedBy: RegExp }> = [
  { question: "is this an ask, not a report?", owner: "server/utils.ts", definedBy: /export function isAskingNotReporting/ },
  { question: "is this despair?", owner: "server/despair.ts", definedBy: /export function saysNotWorking/ },
  { question: "what counts as a platitude?", owner: "server/reply-hygiene.ts", definedBy: /export const PLATITUDES/ },
  { question: "which name do we call them?", owner: "server/utils.ts", definedBy: /export function getDisplayName/ },
  { question: "when is a SAST day?", owner: "server/sast.ts", definedBy: /export function sastDayKey/ },
  // Added 30 July: the replay harness kept its OWN list of what stays deterministic, drifted from
  // the router's, and graded the engine on messages production never sends it.
  { question: "what stays deterministic?", owner: "server/understanding/action-router.ts", definedBy: /export function mustStayDeterministic/ },
  // Added 30 July: this rule lived INLINE in the nightly adaptive job, reachable by nobody else.
  // So the job could correctly refuse to compute a trend while a reply asserted one from the same
  // weigh-ins — which is exactly what the founder was sent on a morning he had been ill for three
  // weeks. One owner, two callers: the job and the provenance gate.
  { question: "is a weight trend usable?", owner: "server/adaptive-targets.ts", definedBy: /export function weightTrendUsable/ },
  { question: "may the coach assert this?", owner: "server/verifiers/response-gate.ts", definedBy: /export function applyProvenance/ },
  // Added 30 July: derived inline in programme.ts, reachable by nobody, and reading `user.notes`
  // when the column is `profileNotes`. So the session header said "60% of your old weights" while
  // the lift block under it said "aim 127.5kg" — one message, 21 days into a layoff.
  { question: "what training state is this client in?", owner: "server/adaptive-training.ts", definedBy: /export function trainingStateFromUser/ },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}


/**
 * GUARD #9, RECALIBRATED (2026-08-04, founder's call: "redefine the proxy, don't chase the raw
 * number"). It counted every `return "…"` in server/ and shared/, which meant `return "snack";`
 * and a prompt fragment scored the same as a sentence sent to a human. Driving THAT number to
 * the floor would have meant deleting non-client-facing code to satisfy a meter.
 *
 * It now counts what the rule was always about: PROSE, on a path a CLIENT can read.
 *
 * Be straight about what the recalibration did and did not do — 526 raw became 440 client-facing.
 * It moved 86. The remaining 440 are real mouths and the number is not an artefact: onboarding
 * 51, misc-commands 36, media 34, lifecycle 24, food-log-mgmt 21. Slice 4b is a genuine teardown,
 * not a measurement problem.
 *
 * Exclusions are DECLARED, never inferred, so hiding a mouth costs a visible edit with a reason.
 */
const NOT_CLIENT_FACING: Array<[string, string]> = [
  ["server/routes/admin", "admin console — the founder reads these, no client can"],
  ["server/routes/dashboard", "the web dashboard he runs the business on"],
  ["server/routes/coach", "coach-facing tooling"],
  ["server/audit/", "instruments that measure replies; they never send one"],
  ["server/coach-prompt.ts", "prompt text sent to the MODEL, not to a person"],
  ["server/brain/coach-brain.ts", "ditto — the system prompt"],
  ["server/handlers/food-vision-prompt.ts", "ditto"],
  ["server/form-check-prompt.ts", "ditto"],
  ["server/verifiers/", "gates that inspect a draft; their strings are reasons, not replies"],
  // SAME PRINCIPLE, DIFFERENT DIRECTORY (2026-08-17). reply-verifier.ts is a gate — it inspects a
  // draft and returns the REASON the draft is wrong — but it lives in server/brain/, so the
  // "server/verifiers/" prefix above never reached it. Its three prose returns are the medication
  // violation reasons added in 904d1bf, and every consumer of `.violation` was traced before this
  // entry was written: console.log (meaning-engine:306), a system message to the MODEL asking for a
  // rewrite (meaning-engine:313, gpt:1182), console.warn (gpt:1175), and captureQualitySignal into
  // the founder's admin queue (gpt:1176). routes.ts reads only `.ok`. NO path sends one to a client.
  // Excluded by FILE, not by "server/brain/" — coach-brain.ts is already listed separately and other
  // files in that directory may hold real mouths.
  ["server/brain/reply-verifier.ts", "a gate, not a mouth — its strings are rewrite reasons sent to the model and the admin queue"],
  ["server/drill-cases.ts", "test fixtures"],
  ["server/self-check.ts", "boot diagnostics for the founder"],
  ["server/whatsapp-templates.ts", "Meta-approved template bodies — Meta owns this copy, not us"],
  ["server/data-export.ts", "POPIA export — a legal record, deliberately verbatim"],
];

/**
 * Exact returned literals that the prose-shaped matcher sees but that do not return prose.
 *
 * These are line-level rather than file-level exclusions: a future client-facing return in any
 * of these files must still count. Each value has one traced machine consumer and cannot reach a
 * delivery door as text.
 */
const NOT_CLIENT_FACING_RETURNS: Array<[string, RegExp, string]> = [
  [
    "server/index.ts",
    /^\s*return \["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "EAI_AGAIN"\]\.includes\(code\)/,
    "isConnectionError returns a boolean to startup classification; the error-code literals are never returned",
  ],
  [
    "server/health-state.ts",
    /^\s*return `sick_since:\$\{sickSince\} \| sick_until:\$\{sickUntil\} \| paused_until:\$\{sickUntil\}`/,
    "holdTokens is consumed only by openHold's profileNotes persistence write",
  ],
  [
    "server/once-daily.ts",
    /^\s*return `\$\{userId\}\|\$\{key\}\|\$\{day\}`/,
    "cacheKey is consumed only by the private dedupe Set and database claim",
  ],
  [
    "server/food-swaps.ts",
    /^\s*return `\$\{kept\.slice\(0, -1\)\.join\(", "\)\}, or \$\{kept\[kept\.length - 1\]\}`/,
    "allowedAlternatives joins a list of food names into a NOUN PHRASE that its two callers embed "
      + "in their own sentence; the ', or ' reads as prose to isProse but this function never "
      + "addresses the client and returns no sentence of its own (#177)",
  ],
];

/** A returned literal is a MOUTH when it is a sentence, not a token or an enum value. */
function isProse(literal: string): boolean {
  const words = literal.split(/[\s${}]+/).filter(w => w.length > 1).length;
  return words >= 4 || literal.length >= 30;
}

function countClientFacingMouths(files: string[]): number {
  let n = 0;
  for (const f of files) {
    if (NOT_CLIENT_FACING.some(([prefix]) => f.startsWith(prefix))) continue;
    for (const line of readFileSync(f, "utf-8").split("\n")) {
      if (NOT_CLIENT_FACING_RETURNS.some(([file, returned]) => f === file && returned.test(line))) continue;
      const m = /^\s*return \[?[`"](.*)$/.exec(line);
      if (m && isProse(m[1])) n++;
    }
  }
  return n;
}

/**
 * GUARD #13 — REACHABILITY (2026-08-25).
 *
 * THE DEFECT THIS EXISTS TO STOP, measured on main@0950344d: `attributeMultiDayReport` — the
 * multi-day attribution merged in PR #52 and described as a shipped product slice — had EIGHT
 * test references and ZERO production callers. A client message could not reach it. The suite was
 * green because the suite tests the library, not the pipeline.
 *
 * It was not an isolated mistake. `journeyMustKeepFacts` was written for the multi-intent failure
 * and sat with no callers until 24 August. A `sessionsTarget` wiring added on 24 August was
 * unreachable and was deleted when its own negative control refused to fail. And 21 of the 44
 * scheduler jobs in this repo are exported and never registered with cron — half the proactive
 * surface, including plateau detection, injury follow-up and the weekly check-in.
 *
 * That is the six-month loop in one sentence: correct owners were built, and nothing checked that
 * the live path could reach them. So the founder's handset became the first integration test, the
 * old behaviour was blamed on the architecture, and another layer was added.
 *
 * A capability is not implemented because it is written, and not shipped because it is tested. It
 * is shipped when a client message can reach it.
 *
 * WHAT COUNTS AS REACHABLE: referenced by another server/shared module, used inside its own file,
 * or named as a string (dynamic dispatch). `_`-prefixed exports are test seams by convention and
 * are exempt. HONEST BOUND: only `export function` declarations are examined — an unreachable
 * `export const fn = () => …` is not yet seen. That is a detector gap, not a licence.
 */
function unreachableExports(prod: string[], probes: string[]): Array<{ file: string; name: string; tested: boolean }> {
  const src = prod.map(f => [f, readFileSync(f, "utf-8")] as const);
  const blob = src.map(([, s]) => s).join("\n");
  const probeSrc = probes.map(f => readFileSync(f, "utf-8"));
  const out: Array<{ file: string; name: string; tested: boolean }> = [];
  for (const [f, s] of src) {
    for (const m of s.matchAll(/^export (?:async )?function (\w+)/gm)) {
      const name = m[1];
      if (name.startsWith("_")) continue;
      const word = new RegExp(`\\b${name}\\b`);
      if (src.some(([g, t]) => g !== f && word.test(t))) continue;      // another module calls it
      if ((s.match(new RegExp(`\\b${name}\\b`, "g")) || []).length > 1) continue;  // used in-file
      if (new RegExp(`["'\`]${name}["'\`]`).test(blob)) continue;      // dispatched by name
      out.push({ file: f, name, tested: probeSrc.some(t => word.test(t)) });
    }
  }
  return out;
}

/**
 * GUARD #14 — EVERY PROACTIVE SENDER IS CLASSIFIED (2026-08-25, P0-4b).
 *
 * THE DEFECT THIS EXISTS TO STOP, measured on main@d005081: eleven of fourteen sending files ran
 * their own action ladder — 32 sends deciding what the client should do next, from the ledger
 * alone, with no knowledge of the decision owner or of anything the client had said that day.
 * Nobody decided that; each one was a locally-reasonable addition and there was nothing that had
 * to be updated when a twelfth appeared.
 *
 * This is the thing that has to be updated. A new cron that talks to a client is a product
 * decision about what the coach is allowed to say, and it does not compile past this guard until
 * somebody makes it: CANONICAL (the instruction comes from chooseAction), RECOGNITION (it asks
 * for nothing), RESOURCE (it delivers an artefact), OPERATIONAL (it is not coaching), or
 * LEGACY_LOCAL (it still decides locally, and is counted as debt below).
 *
 * READ STATICALLY ON PURPOSE. Importing the register would pull in the scheduler, the database
 * and the Twilio client to answer a question about a declaration. The subject of this guard IS
 * the declaration, so reading the source is reading the subject — unlike a behavioural claim,
 * where a source match proves nothing.
 */
function unclassifiedSenders(): { missing: string[]; legacy: number } {
  const register = readFileSync("server/scheduler/proactive-decision.ts", "utf-8");
  const declared = new Set([...register.matchAll(/\bjob:\s*"(\w+)"/g)].map(m => m[1]));
  const legacy = [...register.matchAll(/cls:\s*"LEGACY_LOCAL"/g)].length;
  const missing: string[] = [];
  for (const f of readdirSync("server/scheduler/jobs").filter(n => n.endsWith(".ts"))) {
    const src = readFileSync(`server/scheduler/jobs/${f}`, "utf-8");
    // Split at each exported job entry point; a segment that sends is a sender.
    const marks = [...src.matchAll(/^export (?:async )?function (\w+)/gm)];
    for (let i = 0; i < marks.length; i++) {
      const body = src.slice(marks[i].index!, marks[i + 1]?.index ?? src.length);
      if (!/\bsendWhatsApp(?:Buttons)?\s*\(/.test(body)) continue;
      if (!declared.has(marks[i][1])) missing.push(`${marks[i][1]}  server/scheduler/jobs/${f}`);
    }
  }
  return { missing, legacy };
}

/**
 * GUARD #15 — THE LEDGER HAS OWNERS, AND THE CLIENT PATH USES THEM (2026-08-25, P0-5).
 *
 * THE DEFECT THIS EXISTS TO STOP, measured on main@266a8c2b: `users.do_not_mention` is the client
 * saying "stop bringing up my weight". Exactly ONE reader on the client path honoured it —
 * getProgressTruth. Four others read weight_logs directly and spoke the figure with no check:
 * the model's context (twice, one of them under "Quote these figures EXACTLY as written"), the
 * plateau nudge, and monthly photo day. The reactive mouth's strip is a last resort that only
 * covers reactive TEXT — not a proactive send, and not a rendered card.
 *
 * That is the same shape as every other defect in this repo's last six months: a correct owner
 * exists, and the surfaces that speak simply do not go through it. So the number of direct reads
 * is not a tidiness metric — it is the count of places where a client-facing claim is made without
 * the rule that governs it. It may only FALL, and it falls one DOMAIN at a time.
 *
 * SCOPE, stated so it cannot drift: files that compose something a client sees. Excluded by
 * declaration and not by accident — the owner itself, the domain WRITERS (a handler that inserts
 * a weigh-in must address the table), admin and dashboard routes, and storage/audit tooling, none
 * of which are the coach speaking. server/handlers/safety.ts is excluded DELIBERATELY and
 * permanently: a rapid-loss check that stands down because the client asked us not to discuss the
 * scale is the one place where honouring that request would be dangerous.
 */
const LEDGER_OWNER_FILES = ["server/day-ledger.ts", "server/day-ledger-core.ts"];
const DOMAIN_WRITERS: Record<string, string[]> = {
  weight: ["server/handlers/weight.ts", "server/handlers/safety.ts"],
};
function directLedgerReads(table: string, writers: string[]): string[] {
  const clientPath = files.filter(f =>
    (f.startsWith("server/handlers/") || f.startsWith("server/brain/") || f.startsWith("server/scheduler/")
      || f.startsWith("server/understanding/") || f.startsWith("server/verifiers/")
      || f === "server/gpt.ts" || f === "server/macro-card-attach.ts")
    && !LEDGER_OWNER_FILES.includes(f) && !writers.includes(f));
  const hits: string[] = [];
  for (const f of clientPath) {
    const n = (readFileSync(f, "utf-8").match(new RegExp(`from\\(${table}\\)`, "g")) || []).length;
    for (let i = 0; i < n; i++) hits.push(f);
  }
  return hits;
}

/**
 * GUARD #16 — ONE DAY BOUNDARY, INCLUDING IN SQL (2026-08-25, P0-5 · food).
 *
 * `sastDayKey` has owned "which SAST day is this" in TypeScript since the SAST cut. A query that
 * GROUPs BY day asks the same question in SQL, and TypeScript ownership does not reach it — so
 * three different answers grew, measured on main@86f1c1e1:
 *
 *   early-commands   DATE(logged_at + INTERVAL '2 hours')          SAST
 *   food-scanner     to_char(logged_at + interval '2 hours', …)    SAST
 *   gpt.ts (×2)      DATE(logged_at)                               UTC   ← wrong
 *
 * South Africa is UTC+2, no DST, so the UTC form pulls a supper logged after 22:00 UTC — midnight
 * SAST — back into the previous day. Two SAST days merge into one, changing the daily totals and
 * the divisor they are averaged over. The Coach was handed "avg 120g, target hit" for a client the
 * owner scores at "avg 60g, target missed".
 *
 * This is the SECOND time the same bug has been fixed: client-snapshot.ts carries a comment dated
 * 2026-08-13 describing it exactly. Fixing the site and not the rule is what let it survive in
 * gpt.ts, so the rule now has one home — sastDayBucketSql in day-ledger.ts — and this refuses a
 * second spelling of it.
 *
 * SCOPE: SQL day-bucketing over a LEDGER table, in files that speak to a client. The owner is
 * exempt because it is the definition. A bare `DATE(...)` on any other expression is not matched —
 * this guard is about the ledger's day boundary, not about SQL style.
 */
const DAY_BUCKET_SQL = /(?:DATE|to_char|date_trunc)\s*\(\s*\$\{(?:mealLogs|stepLogs|workoutLogs|weightLogs)\./gi;
function handRolledDayBuckets(): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f === "server/day-ledger.ts" || f === "server/day-ledger-core.ts") continue;
    const clientFacing = f.startsWith("server/handlers/") || f.startsWith("server/brain/")
      || f.startsWith("server/scheduler/") || f.startsWith("server/understanding/")
      || f.startsWith("server/verifiers/") || f === "server/gpt.ts";
    if (!clientFacing) continue;
    const src = readFileSync(f, "utf-8").split("\n");
    src.forEach((ln, i) => {
      if (new RegExp(DAY_BUCKET_SQL.source, "i").test(ln)) out.push(`${f}:${i + 1}  ${ln.trim().slice(0, 88)}`);
    });
  }
  return out;
}

const files = [...walk("server"), ...walk("shared")];
const read = (f: string) => readFileSync(f, "utf-8");
const all = files.map(read);

const actual = {
  modules: files.length,
  handlerFiles: readdirSync("server/handlers").filter(f => f.endsWith(".ts")).length,
  cronRegistrations: all.join("\n").match(/cron\.schedule\(|schedule\("/g)?.length || 0,
  messageDeciders: all.filter(s => /\.test\(m\)/.test(s)).length,
  looksLikePredicates: new Set(all.join("\n").match(/function looksLike[A-Za-z]*/g) || []).size,
  // MATCHER REPAIRED 2026-08-24 — the follow-up this guard's own note declared owed. It had TWO
  // blind spots: `= /` had to be on ONE line, so the multi-line form
  //     const isProfileUpdateMsg =
  //       /\b(train(ing)?…)/i.test(m);
  // was invisible; and `[^/\n]` stopped at the first slash, so any pattern containing an ESCAPED
  // slash (`\/\s*day\b`) was missed too. 377 counted, 449 actually present — 16% of this
  // metric's own subject was unseen, which is how duplicate patterns sat unnoticed long enough to
  // need a migration. The budget below is re-baselined to the true figure ONCE, in this commit,
  // and can only fall from here.
  regexLiterals: all.join("\n").match(/=\s*\/(?:[^/\\\n]|\\.){10,}\/[gimsuy]*/g)?.length || 0,
  authorshipPoints: countClientFacingMouths(files),
  /** Exported capabilities no client message can reach. See GUARD #13. */
  unreachableCapabilities: unreachableExports(files, walk("script")).length,
  /** Proactive senders still running their own action ladder. See GUARD #14. */
  localDecisionSenders: unclassifiedSenders().legacy,
  /** Client-facing reads of weight_logs that bypass getWeightTruth. See GUARD #15. */
  directWeightReads: directLedgerReads("weightLogs", DOMAIN_WRITERS.weight).length,
  /** Hand-rolled SQL day buckets over a ledger table. See GUARD #16. */
  handRolledDayBuckets: handRolledDayBuckets().length,
  // EVERY PLACE THAT TALKS TO TWILIO DIRECTLY (2026-08-05).
  //
  // Twilio is a reseller of Meta's WhatsApp API, not the destination — OUTSTANDING.md has
  // said "Meta Business API the day CIPC clears" since it was written. Moving is a decision
  // if the SDK is called from one place and a migration if it is called from nineteen.
  //
  // Frozen here so it can only FALL. scheduler/shared.ts already owns the real adapter —
  // sendOneWhatsApp, with the retries, the circuit breaker and the SMS fallback. The work is
  // migrating the other sites onto it, and this number is how that work is measured.
  twilioCallSites: all.join("\n").match(/messages\s*\.\s*create\s*\(/g)?.length || 0,
  _unusedActionCount: files.filter(f => {
    const src = read(f);
    if (!/db\s*\.\s*(insert|update)\s*\(/.test(src)) return false;      // does it act?
    if (!/\.test\((?:m|message|lower)\b/.test(src)) return false;        // on the message?
    // A CALL, not a mention. The first version matched the name anywhere, so writing the guard's
    // name in a COMMENT marked the file compliant — which it duly did for a file whose import was
    // missing and which did not even compile. A guard you can satisfy by talking about it is not
    // a guard; that is the whole disease this file exists to stop.
    return !/(?:isAskingNotReporting|isFutureIntent|mentionsNotDone|looksLikeQuestion|aboutSomeoneElse)\s*\(/.test(src);
  }).length,
};

const problems: string[] = [];
const wins: string[] = [];

for (const [key, budget] of Object.entries(BUDGET) as Array<[keyof typeof BUDGET, number]>) {
  const now = actual[key];
  if (now > budget) {
    problems.push(`  ✗ ${key}: ${now} — budget ${budget}. Something got MORE complicated.`);
  } else if (now < budget) {
    wins.push(`  ↓ ${key}: ${now} (budget ${budget}) — lower BUDGET.${key} to ${now} to lock this in.`);
  }
}

// A budget above its original frozen value must have a logged, dated reason. This is what stops
// "just bump it by one" from being the path of least resistance.
const FROZEN = { modules: 234, handlerFiles: 29, cronRegistrations: 27, messageDeciders: 29, looksLikePredicates: 20, regexLiterals: 333, authorshipPoints: 440, twilioCallSites: 18 };
for (const [key, frozen] of Object.entries(FROZEN) as Array<[keyof typeof BUDGET, number]>) {
  if (BUDGET[key] <= frozen) continue;
  const logged = RAISES.filter(r => r.key === key).sort((a, b) => a.to - b.to).pop();
  if (!logged || logged.to !== BUDGET[key]) {
    problems.push(`  ✗ BUDGET.${key} is ${BUDGET[key]}, above the frozen ${frozen}, with no matching entry in RAISES.`);
    problems.push(`    Add one — dated, saying what you tried first and how it gets paid back — or put the budget back.`);
  }
}

// Every action file is declared, and the AT RISK list may only shrink.
const actionFiles = files.filter(f => {
  const src = read(f);
  return /db\s*\.\s*(insert|update)\s*\(/.test(src) && /\.test\((?:m|message|lower)\b/.test(src);
});
for (const f of actionFiles) {
  if (!(f in ACTION_FILES)) {
    problems.push(`  ✗ ${f} acts on the client's message and writes to the database, undeclared.`);
    problems.push(`    Classify it in ACTION_FILES: guarded / must-act / bookkeeping / AT RISK.`);
  }
}
for (const f of Object.keys(ACTION_FILES)) {
  if (!actionFiles.includes(f)) problems.push(`  ↓ ${f} no longer acts on a message — remove it from ACTION_FILES.`);
}
const atRisk = Object.entries(ACTION_FILES).filter(([, v]) => v === "AT RISK").map(([k]) => k);
if (atRisk.length > AT_RISK_BUDGET) {
  problems.push(`  ✗ ${atRisk.length} files AT RISK — budget ${AT_RISK_BUDGET}. A question can change a client's plan.`);
} else if (atRisk.length < AT_RISK_BUDGET) {
  wins.push(`  ↓ AT RISK: ${atRisk.length} (budget ${AT_RISK_BUDGET}) — lower AT_RISK_BUDGET to ${atRisk.length}.`);
}

// One-owner violations: the question is answered in a file that does not own it.
for (const rule of ONE_OWNER) {
  const owners = files.filter(f => rule.definedBy.test(read(f)));
  if (owners.length === 0) {
    problems.push(`  ✗ nobody owns "${rule.question}" — expected ${rule.owner}`);
  } else if (owners.length > 1 || owners[0] !== rule.owner) {
    problems.push(`  ✗ "${rule.question}" is answered in ${owners.join(", ")} — only ${rule.owner} may.`);
  }
}

// ── CUT A: ONE AUTHORITATIVE ACTIVITY-WRITE DOOR PER FACT ────────────────────────────────────
// New events may have many callers, but only these two owners may materialise them. Corrections
// remain updates/deletes in their existing APIs; this guard only forbids second INSERT authorities.
{
  const live = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
  const canonicalPath = (f: string) => f.replace(/\\/g, "/");
  const serverFiles = files.filter(f => canonicalPath(f).startsWith("server/"));
  const mealBypasses = serverFiles.filter(f => canonicalPath(f) !== "server/day-ledger.ts"
    && /db\s*\.\s*insert\s*\(\s*mealLogs\s*\)/.test(live(read(f))));
  for (const f of mealBypasses) problems.push(`  ✗ [OWNERSHIP] ${f} inserts a new meal outside server/day-ledger.ts commitFoodLog.`);

  const permittedWeightMutators = new Set(["server/handlers/weight.ts", "server/handlers/safety.ts"]);
  const weightBypasses = serverFiles.filter(f => !permittedWeightMutators.has(canonicalPath(f)) && (
    /\.set\s*\(\s*\{[\s\S]{0,600}?\bcurrentWeight\s*:/.test(live(read(f)))
    || /\bset\s*\.\s*currentWeight\s*=/.test(live(read(f)))
  ));
  for (const f of weightBypasses) problems.push(`  ✗ [OWNERSHIP] ${f} mutates currentWeight outside handleWeightLog (safety reset is the only exception).`);

  const cutAContracts: Array<[string, string, RegExp]> = [
    ["GOAL_CHANGE supplementary weight", "server/routes.ts", /handleWeightLog\(phone, user, wt\)/],
    ["onboarding reported weight", "server/onboarding.ts", /handleWeightLog\(phone,[\s\S]{0,160}suppressCustomerLifecycle/],
    ["scale-photo weight", "server/handlers/media.ts", /scaleReply\s*=\s*await handleWeightLog/],
    ["text food lineage", "server/handlers/food-context.ts", /eventGroupId\s*=\s*ctx\.sourceMessageId\s*\|\|\s*randomUUID/],
    ["normal photo lineage", "server/handlers/media.ts", /sourceMessageId:\s*mediaSourceId/],
    ["collage canonical write", "server/handlers/media.ts", /collageCommit\s*=\s*await commitFoodLog/],
    ["album canonical write", "server/handlers/media.ts", /albumCommit\s*=\s*await commitFoodLog/],
    ["meal-repeat canonical write", "server/handlers/meal-repeat.ts", /committed\s*=\s*await commitFoodLog/],
    ["alcohol canonical write", "server/handlers/food-commands.ts", /alcoholCommit\s*=\s*await commitFoodLog/],
    ["permanent source replay key", "server/day-ledger.ts", /eq\(mealLogs\.sourceMessageId, params\.sourceMessageId\)/],
    ["same-message correction API", "server/day-ledger.ts", /planCorrection[\s\S]*applyCorrection/],
    ["held-meal and amendment APIs", "server/day-ledger.ts", /replaceHeldMeal[\s\S]*amendRecentMeal/],
    ["meal relabel API", "server/handlers/food-context.ts", /update\(mealLogs\)\.set\(\{ mealLabel: relabelTo, corrected: true \}\)/],
  ];
  for (const [contract, file, pattern] of cutAContracts) {
    if (!pattern.test(read(file))) problems.push(`  ✗ [OWNERSHIP] CUT A contract missing: ${contract} in ${file}.`);
  }
}

// ── GUARD #10: A SUITE THAT STOPS RUNNING MUST FAIL FROM OUTSIDE ITSELF (2026-08-19) ─────────
//
// script/gap-tests.ts has been broken three times in two days by the same mechanism: an inserted
// test lands above the harness or between the halves of a split comment, esbuild throws a
// TransformError, and NOT ONE of its ~300 tests runs. Each time it reported nothing rather than
// failing, and each time the repair was itself reverted in a merge.
//
// A suite cannot police its own liveness — if it will not parse, nothing inside it executes. So
// the check lives here, in the guard that runs last: every suite in the npm test chain must at
// least parse. Cheap (syntax only, no execution) and it survives a revert of the suite itself.
// THE LIST MOVED, AND SO DID THIS (2026-08-19). `npm test` is no longer an `&&` chain — it is
// script/run-suites.ts, which runs every suite and reports the failures together, because the
// chain stopped at the first red and left fourteen suites, this guard among them, unexecuted.
// The suite list now lives in that file's SUITES array and is read from it here. A guard that
// kept parsing package.json would have quietly checked an empty chain and passed.
{
  const runner = "script/run-suites.ts";
  const chain: string[] = existsSync(runner)
    ? (readFileSync(runner, "utf-8").match(/export const SUITES = \[([\s\S]*?)\]/)?.[1] || "")
        .match(/"([\w-]+)"/g)?.map(q => `${q.replace(/"/g, "")}.ts`) || []
    : [];
  if (chain.length < 20) problems.push(`  ✗ the suite list in ${runner} reads as ${chain.length} suites — the liveness guard is checking almost nothing.`);
  for (const file of [...new Set(chain)]) {
    const path = `script/${file}`;
    if (!existsSync(path)) { problems.push(`  ✗ the suite list names ${path}, which does not exist.`); continue; }
    const r = spawnSync("npx", ["esbuild", path, "--log-level=error", "--outfile=/dev/null"], { encoding: "utf-8" });
    if (r.status !== 0) {
      problems.push(`  ✗ ${path} DOES NOT PARSE — every test in it silently stops running.`);
      problems.push(`    ${String(r.stderr || "").split("\n").filter(Boolean)[0] || "syntax error"}`);
    }
  }
}

// ── GUARD #11: ONE OWNER PER CUSTOMER QUESTION (2026-08-20) ──────────────────────────────────
//
// Every other guard in this file counts FILES. This one counts DOORS, because the failure that
// earned it was invisible to file counting: `report-card` consolidated perfectly onto
// getProgressTruth while `misc-commands` kept answering "my progress" from four `users` columns,
// and "this week" — a command the product tells clients to type — had no owner at all and fell
// through to the model.
//
// A green module test proved nothing, because the client never types at a module. So: given the
// words a person actually sends, exactly one file may be able to answer, and its numbers must come
// from the declared source.
{
  for (const d of DOMAIN_OWNERS) {
    // COMMENTS ARE NOT CLAIMS. A tombstone recording a handler we DELETED ("this is the SECOND
    // 'how am I doing' handler") named the vocabulary and read as a live second owner. A guard
    // that cries wolf is worse than no guard, because it gets switched off.
    const liveCode = (src: string) => src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    const claimants = files.filter((f, i) => {
      if (NON_CLAIMANTS.some(prefix => f.startsWith(prefix))) return false;
      return d.vocabulary.test(liveCode(all[i]));
    });
    for (const c of claimants) {
      if (d.engineSurface.includes(c)) continue; // proven safe by chain order below
      if (!d.owners.includes(c)) {
        problems.push(`  ✗ [OWNERSHIP] ${c} can answer the "${d.domain}" question, and is not a declared owner.`);
        problems.push(`    Declared: ${d.owners.join(", ")}. Either route through one of those, or`);
        problems.push(`    declare it in script/domain-owners.ts and say why a second owner is correct.`);
      }
    }
    for (const owner of d.owners) {
      if (!existsSync(owner)) { problems.push(`  ✗ "${d.domain}" declares owner ${owner}, which does not exist.`); continue; }
      const src = readFileSync(owner, "utf-8");
      const source = d.truthSource.replace(/^server\//, "").replace(/\.ts$/, "");
      if (!new RegExp(`from "\\.{1,2}(?:/\\.\\.)*/?${source}"|import\\("\\.{1,2}(?:/\\.\\.)*/?${source}"\\)`).test(src)) {
        problems.push(`  ✗ [OWNERSHIP] ${owner} owns "${d.domain}" but does not read ${d.truthSource}.`);
        problems.push(`    An owner that builds its own numbers is the second authority this guard exists to stop.`);
      }
    }
    // THE MODEL MUST NOT BE ABLE TO GET THERE FIRST. "this week" had no owner, so it fell to the
    // engine, which improvised averages and asked the client what they should do next. Ordering is
    // what makes a declared owner an owner rather than a preference.
    if (d.engineSurface.length > 0) {
      const chain = readFileSync("server/routes.ts", "utf-8");
      const engineAt = chain.indexOf("handleGptBlock(");
      for (const owner of d.owners) {
        const handler = `handle${owner.replace(/.*\//, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/\.ts$/, "").replace(/^./, ch => ch.toUpperCase())}(`;
        const at = chain.indexOf(handler);
        if (at < 0) { problems.push(`  ✗ "${d.domain}" owner ${owner} is not called from the handler chain in routes.ts.`); continue; }
        if (engineAt > 0 && at > engineAt) {
          problems.push(`  ✗ [OWNERSHIP] "${d.domain}" owner ${owner} runs AFTER the model in routes.ts — the engine would claim it first.`);
        }
      }
    }
    if (claimants.length === 0) {
      problems.push(`  ✗ [OWNERSHIP] "${d.domain}" has NO claimant. A question the product invites and nobody owns falls to the model.`);
    }
  }
}

// ── GUARD #12: ONE READER PER DURABLE FACT (2026-08-21) ─────────────────────────────────────
//
// GUARD #11 asks who may ANSWER a question. This asks who may READ THE STORED FORM of a fact —
// a different failure, and one #11 cannot see, because every site that parsed sick_until was a
// legitimate reader doing legitimate work. What was illegitimate is that each decided for itself
// what the bytes meant, and five of them decided differently.
//
// Matching the STORAGE SIGNATURE rather than a vocabulary is the whole point: a second reader
// cannot hide behind a synonym, because it still has to parse the same characters.
{
  for (const st of STATE_OWNERS) {
    if (!existsSync(st.owner)) {
      problems.push(`  ✗ "${st.fact}" declares owner ${st.owner}, which does not exist.`);
      continue;
    }
    const trespassers = files.filter((f, i) => {
      if (f === st.owner) return false;
      // Comments may name the storage format — that is documentation, not a second reading.
      const live = all[i].replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
      return st.storageSignature.test(live);
    });
    for (const t of trespassers) {
      problems.push(`  ✗ [OWNERSHIP] ${t} parses the stored form of "${st.fact}" directly.`);
      problems.push(`    Call ${st.accessor} from ${st.owner} instead. ${st.earnedBy}`);
    }
  }
}

// THE OWNERSHIP VERDICT, STATED SEPARATELY (2026-08-21).
//
// The budget counters have been over since before the convergence series began, so this suite is
// permanently red — and a gate that is always red signals nothing, which is the same suite-liveness
// disease documented in script/run-suites.ts. Ownership is the assertion that must stay readable:
// a second claimant introduced tomorrow has to be visible without anyone diffing counter numbers.
//
// This is NOT a budget being raised. The counters still fail the build. They are just no longer
// the only thing printed.
const ownership = problems.filter(p => p.includes("[OWNERSHIP]"));
console.log(ownership.length === 0
  ? "ownership: OK — one owner per declared question, one reader per declared fact"
  : `ownership: ${ownership.length} VIOLATION(S) — a second authority exists`);

// GUARD #14. An unclassified sender is not a budget overrun — it is a product decision nobody
// made, so it names the job and refuses rather than incrementing a number.
const senders = unclassifiedSenders();
if (senders.missing.length > 0) {
  problems.push(`  ✗ ${senders.missing.length} proactive sender(s) talk to a client with no classification in server/scheduler/proactive-decision.ts:`);
  for (const m of senders.missing) problems.push(`      ${m}`);
  problems.push(`      Decide what it is allowed to say: CANONICAL | RECOGNITION | RESOURCE | OPERATIONAL | LEGACY_LOCAL.`);
}

const unreachable = unreachableExports(files, walk("script"));
if (actual.unreachableCapabilities > BUDGET.unreachableCapabilities) {
  problems.push(`  ↳ unreachable capabilities (${unreachable.length}) — no client message can reach these:`);
  for (const u of unreachable.filter(x => x.tested).slice(0, 12)) {
    problems.push(`      ${u.name}  ${u.file}${u.tested ? "   [tested, unshipped]" : ""}`);
  }
}

if (problems.length > 0) {
  console.error("architecture guard: FAILED\n");
  console.error(problems.join("\n"));
  console.error("\nThis is the governor, not a style rule. A rise here is how 60,656 lines happened —");
  console.error("one locally-reasonable addition at a time, with nothing ever saying no.");
  console.error("Do not raise a budget. Consolidate, delete, or give the question one owner.");
  process.exit(1);
}

if (wins.length > 0) {
  console.error("architecture guard: something got SIMPLER — lock it in.\n");
  console.error(wins.join("\n"));
  process.exit(1);
}

console.log(`architecture guard: ${actual.modules} modules, ${actual.regexLiterals} regexes, ${actual.messageDeciders} message deciders, ${actual.cronRegistrations} cron jobs — all at budget.`);
// GUARD #9, printed every run so the shrink is VISIBLE rather than claimed (2026-08-04).
console.log(`twilio: ${actual.twilioCallSites} direct SDK call sites (budget ${BUDGET.twilioCallSites}, frozen — may only fall; the adapter is scheduler/shared.sendOneWhatsApp).`);
console.log(`authorship: ${actual.authorshipPoints} CLIENT-FACING places other than the engine can put words in front of a client (budget ${BUDGET.authorshipPoints}, frozen — this may only fall).`);
console.log(`  ${ONE_OWNER.length} questions have exactly one owner. ${actionFiles.length} action files declared, ${atRisk.length} AT RISK: ${atRisk.map(f => f.split("/").pop()).join(", ")}`);
// Printed on EVERY green run, on purpose. A debt you are reminded of is a debt you repay.
for (const r of RAISES) {
  console.log(`  ⚠ debt: ${r.key} raised ${r.from}→${r.to} on ${r.date}. ${r.why}`);
}
