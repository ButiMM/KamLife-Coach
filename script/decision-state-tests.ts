import { isCoachingDecisionState, selectDecisionState } from "../server/understanding/state";

type Case = {
  name: string;
  input: Parameters<typeof selectDecisionState>[0];
  expected: "CONTINUE" | "CHANGE" | "INVESTIGATE" | "REFER";
};

const cases: Case[] = [
  {
    name: "on-track client continues without novelty",
    input: { meaningfulProblem: false, evidence: "sufficient" },
    expected: "CONTINUE",
  },
  {
    name: "evidence-backed problem changes one lever",
    input: { meaningfulProblem: true, evidence: "sufficient" },
    expected: "CHANGE",
  },
  {
    name: "problem plus insufficient evidence asks the minimum useful question",
    input: { meaningfulProblem: true, evidence: "insufficient", hasMinimumUsefulQuestion: true },
    expected: "INVESTIGATE",
  },
  {
    name: "insufficient evidence without a useful question does not invent a change",
    input: { meaningfulProblem: true, evidence: "insufficient", hasMinimumUsefulQuestion: false },
    expected: "CONTINUE",
  },
  {
    name: "safety/referral outranks every coaching intervention",
    input: { meaningfulProblem: true, evidence: "sufficient", requiresReferral: true },
    expected: "REFER",
  },
  {
    name: "missing evidence alone is not a problem",
    input: { meaningfulProblem: false, evidence: "insufficient", hasMinimumUsefulQuestion: true },
    expected: "CONTINUE",
  },
];

for (const c of cases) {
  const actual = selectDecisionState(c.input);
  if (actual !== c.expected) {
    throw new Error(`${c.name}: expected ${c.expected}, got ${actual}`);
  }
  if (!isCoachingDecisionState(actual)) {
    throw new Error(`${c.name}: returned value is not a canonical decision state`);
  }
}

console.log(`decision-state-tests: ${cases.length}/${cases.length} passed`);