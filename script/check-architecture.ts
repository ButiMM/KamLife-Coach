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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Frozen 2026-07-30. LOWER THESE AS THINGS COLLAPSE. NEVER RAISE ONE.
// A raise is not a merge conflict to resolve — it is the moment to stop and ask why.
const BUDGET = {
  modules: 234,
  handlerFiles: 29,
  cronRegistrations: 27,
  /** Files that run a regex against the client's message — i.e. that hold an opinion on meaning. */
  messageDeciders: 30,
  /** `looksLikeX` predicates: hand-written guesses at intent. */
  looksLikePredicates: 20,
  /** Named regex literals across the server. The 333 the founder was shown. */
  regexLiterals: 315,
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
  authorshipPoints: 419,
  twilioCallSites: 18,
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
  "server/handlers/meal-repeat.ts": "guarded",
  "server/handlers/food-commands.ts": "guarded",
  "server/handlers/food-context.ts": "guarded",
  "server/handlers/food-log-mgmt.ts": "guarded",
  "server/handlers/media.ts": "guarded",
  "server/handlers/workout.ts": "guarded",
  "server/handlers/water.ts": "guarded",
  "server/handlers/sick-flow.ts": "guarded",
  "server/handlers/lifecycle.ts": "guarded",
  "server/routes.ts": "guarded",
  "server/handlers/safety.ts": "must-act",
  "server/handlers/pain-triage.ts": "must-act",
  "server/onboarding.ts": "must-act",
  "server/handlers/reminders-handler.ts": "must-act",
  "server/gpt.ts": "bookkeeping",
  "server/handlers/gpt-block.ts": "bookkeeping",
  "server/understanding/live.ts": "bookkeeping",
  "server/handlers/numbers-literacy.ts": "bookkeeping",
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
  ["server/drill-cases.ts", "test fixtures"],
  ["server/self-check.ts", "boot diagnostics for the founder"],
  ["server/whatsapp-templates.ts", "Meta-approved template bodies — Meta owns this copy, not us"],
  ["server/data-export.ts", "POPIA export — a legal record, deliberately verbatim"],
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
      const m = /^\s*return \[?[`"](.*)$/.exec(line);
      if (m && isProse(m[1])) n++;
    }
  }
  return n;
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
  regexLiterals: all.join("\n").match(/= \/[^/\n]{10,}\/[gimsuy]*/g)?.length || 0,
  authorshipPoints: countClientFacingMouths(files),
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
