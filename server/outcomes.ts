/**
 * OUTCOMES — the instrument that answers the only question that matters.
 *
 * (2026-07-28.) Until today this system measured engagement exhaustively and results not at all.
 * It could say who was fading, who went quiet, who logged for thirty days. It could not say
 * whether a single person was lighter. A system that only measures engagement will only ever be
 * optimised for engagement — that is how you end up with a product people use faithfully for six
 * months and quit, because it never made them different.
 *
 * THE QUESTION THIS MODULE EXISTS TO ANSWER:
 *   "Of the people who joined eight weeks ago, how many got the thing they came for?"
 *
 * Three deliberate design decisions, each of which the obvious version gets wrong:
 *
 * 1. GOAL SUCCESS, NOT WEIGHT (founder: "not everybody joins to lose weight"). A muscle-gain
 *    client who gained 2kg succeeded. A fat-loss client who gained 2kg did not. Same number,
 *    opposite verdicts. Scoring everyone on the scale would call our best muscle-gain client a
 *    failure and quietly bias the whole product toward one goal.
 *
 * 2. UNMEASURED IS NOT FAILURE — AND NOT SUCCESS. A client with no weigh-in is `unknown`, and
 *    unknown is reported separately, never folded into either side. The cheapest way to fake a
 *    good success rate is to count only the people who bothered to weigh, so coverage is
 *    reported next to the rate, always. A 90% success rate on 20% coverage is not a result; it
 *    is a survivorship bias with a percentage sign on it.
 *
 * 3. SCALE NOISE IS NOT PROGRESS. Body weight swings ~1kg on water alone, so anything inside
 *    ±0.5kg is "no change", not a win we get to claim.
 *
 * Pure — no DB, no clock. The caller gathers rows; this decides what they mean. Unit-tested.
 */

import type { GoalKey } from "./goal-profiles";

/** Below this, the scale is measuring water, not progress. */
export const NOISE_KG = 0.5;

/** The review's early-warning line: under this at week 4+, something in the core loop is wrong. */
export const WEAK_SIGNAL_RATE = 0.3;

/** Coverage under this means we have a measurement problem, not (yet) a results problem. */
export const MIN_COVERAGE = 0.6;

export interface ClientOutcome {
  userId: string;
  /** SAST day key of signup — cohorts are grouped by the week containing it. */
  signupDay: string;
  goal: GoalKey;
  weeksOnProgramme: number;
  /** First and latest weigh-in. Undefined when they never weighed. */
  startWeightKg?: number;
  latestWeightKg?: number;
  weighIns: number;
  /** Distinct days with at least one food log. */
  foodLogDays: number;
  sessions: number;
  /** Signups attributed to this client. The delayed measure of whether it actually worked. */
  referrals: number;
}

export type Verdict = "success" | "no_change" | "wrong_way" | "unknown";

/** kg change since the first weigh-in. Negative = lighter. Undefined when unmeasurable. */
export function weightChangeKg(o: ClientOutcome): number | undefined {
  if (o.weighIns < 2 || o.startWeightKg == null || o.latestWeightKg == null) return undefined;
  return o.latestWeightKg - o.startWeightKg;
}

/** Days on programme, from weeks. Used as the adherence denominator. */
function daysOn(o: ClientOutcome): number {
  return Math.max(1, Math.round(o.weeksOnProgramme * 7));
}

/** Share of days with at least one food log. The honest read on whether they followed anything. */
export function adherence(o: ClientOutcome): number {
  return Math.min(1, o.foodLogDays / daysOn(o));
}

/**
 * DID THIS PERSON GET WHAT THEY CAME FOR?
 *
 * Scored against their OWN stated goal. `unknown` whenever the thing that would settle it was
 * never measured — we do not guess, and we never let an absence count as a win.
 */
export function goalVerdict(o: ClientOutcome): Verdict {
  const change = weightChangeKg(o);

  switch (o.goal) {
    case "fat_loss":
      if (change === undefined) return "unknown";
      if (change <= -NOISE_KG) return "success";
      return change >= NOISE_KG ? "wrong_way" : "no_change";

    case "muscle_gain":
      if (change === undefined) return "unknown";
      if (change >= NOISE_KG) return "success";
      return change <= -NOISE_KG ? "wrong_way" : "no_change";

    // Recomposition deliberately does NOT score on the scale — the whole point is that weight
    // stays put while the body changes. Consistent training is the measurable proxy we have.
    case "recomposition": {
      if (o.sessions === 0 && o.weeksOnProgramme >= 2) return "wrong_way";
      if (o.weeksOnProgramme < 2) return "unknown";
      const perWeek = o.sessions / o.weeksOnProgramme;
      return perWeek >= 2 ? "success" : perWeek >= 1 ? "no_change" : "wrong_way";
    }

    // "Become active again", "eat properly", a doctor's nudge after a diagnosis. The goal is the
    // habit itself, so adherence IS the outcome rather than a proxy for it.
    case "general":
    case "health_condition": {
      if (o.weeksOnProgramme < 2) return "unknown";
      const a = adherence(o);
      return a >= 0.5 ? "success" : a >= 0.25 ? "no_change" : "wrong_way";
    }
  }
  return "unknown";
}

export interface CohortSummary {
  label: string;
  /** Everyone in the cohort who has reached the week mark. */
  n: number;
  /** Of those, how many we could actually score. */
  measured: number;
  /** measured / n — report this NEXT TO the rate, always. */
  coverage: number;
  success: number;
  noChange: number;
  wrongWay: number;
  /** success / measured. Meaningless without coverage beside it. */
  successRate: number;
  /** Median kg change among those with two weigh-ins. */
  medianChangeKg: number | null;
  /** Mean share of days with a food log. */
  adherenceRate: number;
  /** Share who logged a weigh-in at all — the input-quality number. */
  weighInRate: number;
  /** Referrals per client. The delayed, honest measure of whether it worked. */
  referralRate: number;
  /** True when this cohort is old enough to judge and the signal is bad. */
  weakSignal: boolean;
  /** True when the problem is missing measurement rather than missing results. */
  blindSpot: boolean;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Summarise everyone who has reached `atWeeks` on the programme. Clients younger than that are
 * excluded rather than counted as failures — judging a two-week-old client at eight weeks is
 * how you talk yourself out of a product that works.
 */
export function summariseCohort(all: ClientOutcome[], atWeeks: number, label = `week ${atWeeks}`): CohortSummary {
  const eligible = all.filter(o => o.weeksOnProgramme >= atWeeks);
  const verdicts = eligible.map(goalVerdict);
  const measured = verdicts.filter(v => v !== "unknown").length;
  const success = verdicts.filter(v => v === "success").length;
  const noChange = verdicts.filter(v => v === "no_change").length;
  const wrongWay = verdicts.filter(v => v === "wrong_way").length;
  const changes = eligible.map(weightChangeKg).filter((c): c is number => c !== undefined);
  const n = eligible.length;
  const coverage = n > 0 ? measured / n : 0;
  const successRate = measured > 0 ? success / measured : 0;

  return {
    label, n, measured, coverage, success, noChange, wrongWay, successRate,
    medianChangeKg: median(changes),
    adherenceRate: n > 0 ? eligible.reduce((s, o) => s + adherence(o), 0) / n : 0,
    weighInRate: n > 0 ? eligible.filter(o => o.weighIns > 0).length / n : 0,
    referralRate: n > 0 ? eligible.reduce((s, o) => s + o.referrals, 0) / n : 0,
    // Only cry wolf on a real sample. Three people is an anecdote, not a signal.
    weakSignal: atWeeks >= 4 && measured >= 5 && successRate < WEAK_SIGNAL_RATE,
    blindSpot: n >= 5 && coverage < MIN_COVERAGE,
  };
}

/** Per-goal breakdown — this is what tells you the product works for one goal and not another. */
export function byGoal(all: ClientOutcome[], atWeeks: number): CohortSummary[] {
  const goals = [...new Set(all.map(o => o.goal))];
  return goals
    .map(g => summariseCohort(all.filter(o => o.goal === g), atWeeks, g))
    .filter(s => s.n > 0)
    .sort((a, b) => b.n - a.n);
}

const GOAL_WORDS: Record<string, string> = {
  fat_loss: "Fat loss", muscle_gain: "Muscle gain", recomposition: "Recomposition",
  general: "General health", health_condition: "Health condition",
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The founder-facing report, textable over WhatsApp. Written to be readable on a phone at 6am,
 * and written so a bad number is impossible to misread as a good one.
 */
export function formatOutcomesReport(all: ClientOutcome[], atWeeks = 8): string {
  if (all.length === 0) return "📊 *Outcomes*\n\nNo clients on the books yet.";

  const c = summariseCohort(all, atWeeks);
  if (c.n === 0) {
    const oldest = Math.max(...all.map(o => o.weeksOnProgramme));
    return `📊 *Outcomes*\n\nNobody has reached *week ${atWeeks}* yet — the oldest client is ${oldest} week${oldest === 1 ? "" : "s"} in.\n\nAsk again then. Judging a ${oldest}-week client at week ${atWeeks} would only tell you they haven't finished.`;
  }

  const head = `📊 *Outcomes — week ${atWeeks}+*\n\n*${c.success} of ${c.measured}* clients got what they came for (*${pct(c.successRate)}*).`;

  // Coverage sits directly under the rate, on purpose. The two are meaningless apart.
  const cover = `\n\n_Measured ${c.measured} of ${c.n} (${pct(c.coverage)}). The other ${c.n - c.measured} never gave us anything to judge._`;

  const detail = `\n\n• On the way: *${c.success}*\n• No change: *${c.noChange}*\n• Wrong direction: *${c.wrongWay}*`
    + (c.medianChangeKg !== null ? `\n• Median weight change: *${c.medianChangeKg > 0 ? "+" : ""}${c.medianChangeKg.toFixed(1)}kg*` : "")
    + `\n• Followed the plan: *${pct(c.adherenceRate)}* of days\n• Weighed at all: *${pct(c.weighInRate)}*\n• Referrals per client: *${c.referralRate.toFixed(2)}*`;

  const goals = byGoal(all, atWeeks);
  const goalLines = goals.length > 1
    ? `\n\n*By goal:*\n${goals.map(g => `• ${GOAL_WORDS[g.label] || g.label}: ${g.success}/${g.measured} (${pct(g.successRate)}) of ${g.n}`).join("\n")}`
    : "";

  // The verdict line. Blindness first — you cannot conclude anything about results from a
  // sample you mostly failed to measure, and saying "results are bad" would be a lie.
  let verdict: string;
  if (c.blindSpot) {
    verdict = `\n\n⚠️ *You are flying blind.* Only ${pct(c.coverage)} of this cohort has a measurement. Fix the weigh-in rate before drawing a single conclusion about whether the coaching works — right now the honest answer is "we don't know".`;
  } else if (c.weakSignal) {
    verdict = `\n\n🚨 *The signal is weak.* Under ${pct(WEAK_SIGNAL_RATE)} of measured clients are getting the result they joined for. Stop feature work and stop spending on acquisition. Something in the targets, the programme or the coaching is not doing its job — and finding it is now the only priority.`;
  } else if (c.successRate >= 0.6) {
    verdict = `\n\n✅ *This works.* ${pct(c.successRate)} of measured clients got what they came for. That is the sentence you can put in front of a stranger — and the one worth spending money to repeat.`;
  } else {
    verdict = `\n\n*Mixed.* It works for some and not others. The by-goal split above is where to look — a product that works for one goal and fails another is a scoping problem, not a coaching problem.`;
  }

  return head + cover + detail + goalLines + verdict;
}
