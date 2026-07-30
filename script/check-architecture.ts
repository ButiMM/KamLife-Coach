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
  modules: 253,
  handlerFiles: 30,
  cronRegistrations: 68,
  /** Files that run a regex against the client's message — i.e. that hold an opinion on meaning. */
  messageDeciders: 30,
  /** `looksLikeX` predicates: hand-written guesses at intent. */
  looksLikePredicates: 20,
  /** Named regex literals across the server. The 333 the founder was shown. */
  regexLiterals: 338,
};

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
    key: "regexLiterals", from: 333, to: 338, date: "2026-07-30",
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
const FROZEN = { modules: 253, handlerFiles: 30, cronRegistrations: 68, messageDeciders: 30, looksLikePredicates: 20, regexLiterals: 333 };
for (const [key, frozen] of Object.entries(FROZEN) as Array<[keyof typeof BUDGET, number]>) {
  if (BUDGET[key] <= frozen) continue;
  const logged = RAISES.filter(r => r.key === key).sort((a, b) => a.to - b.to).pop();
  if (!logged || logged.to !== BUDGET[key]) {
    problems.push(`  ✗ BUDGET.${key} is ${BUDGET[key]}, above the frozen ${frozen}, with no matching entry in RAISES.`);
    problems.push(`    Add one — dated, saying what you tried first and how it gets paid back — or put the budget back.`);
  }
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
console.log(`  ${ONE_OWNER.length} questions have exactly one owner.`);
// Printed on EVERY green run, on purpose. A debt you are reminded of is a debt you repay.
for (const r of RAISES) {
  console.log(`  ⚠ debt: ${r.key} raised ${r.from}→${r.to} on ${r.date}. ${r.why}`);
}
