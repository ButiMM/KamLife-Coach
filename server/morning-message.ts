/**
 * THE MORNING MESSAGE — one composer, pure, dependency-free, unit-tested.
 *
 * (2026-08-18, Issue #49 step 5. Was morning-closing.ts, which owned one line of this.)
 *
 * WHAT THIS REPLACES. scheduler/jobs/morning.ts composed the brief inline across roughly a dozen
 * independent narrative branches: seven day-of-week openers, eleven programme-day milestones,
 * three streak lines, a five-way trajectory prefix, a five-branch protein narrative with its own
 * fourteen-day worst-meal-slot analysis and vegan/vegetarian variants, eight workout-milestone
 * strings, a steps receipt, and a closing line. Each was locally reasonable. Together they were a
 * second coach with its own opinions about protein and steps — the same two levers the decision
 * owner had already decided on, arrived at by different reasoning, in the same message.
 *
 * THE RULE APPLIED HERE. A narrative branch survives only if it does something the decision does
 * not. Recognition survives: a streak, a milestone, a session count are things the client EARNED
 * and the decision has no way to say. Prescription does not survive: the moment a branch tells the
 * client what to do about protein or steps, it is competing with decideProactive, and the loser is
 * the client who gets two instructions before breakfast.
 *
 * WHAT STILL IS NOT TRUE HERE, said plainly rather than left to be found: the constitution in
 * understanding/meaning-engine.ts — two sentences, one next move, no receipts, no calorie figures
 * unless asked, acknowledge first — governs REACTIVE replies. Nothing enforces it on a proactive
 * message; the only outbound gate is a template-leak check. This composer narrows the message
 * toward those laws (one prescription, one observation) but it does not yet obey them, and it is
 * not the place to unilaterally rewrite the product's morning voice. That is the enforcement pass.
 *
 * ORIGINAL NOTE, still true of morningClosingLine:
 *
 * The absence-framed lines ("Good to have you back", "just reply Hi and we go from
 * there") assume the client lapsed and returned. They must NEVER fire for someone
 * actively engaged (a live food streak) — a daily logger never left, and telling them
 * "welcome back" over a 19-day streak is the 2026-07-19 live incident. The engaged
 * closings also make no "session today" push, so they stay honest on a rest day.
 */

export type MorningTrajectory = "ON_A_RUN" | "ON_TRACK" | "RECOVERING" | "STRUGGLING" | "DISENGAGED";

export function morningClosingLine(
  trajectory: MorningTrajectory,
  ctx: { activelyEngaged: boolean; completedSessions28: number },
): string {
  const { activelyEngaged, completedSessions28 } = ctx;
  switch (trajectory) {
    case "ON_A_RUN":
      return `\n\n_You're ${completedSessions28} sessions in over 4 weeks. Don't give this up — most people are nowhere near this._`;
    case "ON_TRACK":
      return ``;
    case "RECOVERING":
      return activelyEngaged
        ? `\n\n_You're logging every day — that consistency is exactly what changes bodies. Keep the chain going._`
        : `\n\n_Good to have you back. One day at a time — this week counts._`;
    case "STRUGGLING":
      return `\n\n_${completedSessions28} sessions in 4 weeks — let's get one in today. Just one. Reply 1 and I'll send it._`;
    case "DISENGAGED":
      return activelyEngaged
        ? `\n\n_Logging your food every single day — that's the hard habit, and it's yours. When you're ready to train, reply 1._`
        : `\n\n_No sessions in 28 days. Today is not about intensity — just reply Hi and we go from there._`;
  }
}

// ── THE COMPOSER ─────────────────────────────────────────────────────────────────────────────

export interface MorningInputs {
  firstName: string;
  /** Prepended by the target sanity audit when it corrected a stored target. Not ours to decide. */
  targetFixLine: string;
  /** Programme-day milestone. Earned recognition on eleven specific days — the decision cannot
   *  say "you have been here a month", so it survives. */
  identityLine: string;
  /** Streaks the client built. Recognition, not instruction. */
  streakLine: string;
  /** Nth-session recognition. Same reason. */
  workoutLine: string;
  /** ONE honest observation about yesterday. Was five branches plus a fourteen-day worst-slot
   *  analysis that ended in its own protein instruction. */
  yesterdayLine: string;
  /** Today's plan — the targets and whether it is a training day. This is the plan, not a
   *  receipt: it is what the client is being asked to do, not a readback of what they did. */
  todayLines: string[];
  /** Trajectory-driven sign-off. */
  closingLine: string;
  /** The ONE next move, from decideProactive. "" when the verdict is CONTINUE and nothing needs
   *  changing — then the ordinary breakfast question is the right ask. */
  decisionLine: string;
  /** Fallback ask when the decision has nothing to add. */
  breakfastAsk: string;
  /** The adaptive job's reason, when it moved targets this morning. */
  adaptLine: string;
  /** Sick clients get the short form: care, and nothing to do. */
  sickYesterday: boolean;
}

/**
 * ONE path to the message. Every morning send that reaches a fully-briefed client comes through
 * here, so the order of the parts is decided once instead of at each of the branches that used to
 * assemble their own.
 *
 * Order is deliberate: who they are and what they did (recognition), then what happened
 * yesterday, then today's plan with any target change explained beside the numbers it changed,
 * then ONE thing to do. The instruction goes last because it is the part they act on.
 *
 * ONE BUBBLE. `\n\n---\n\n` splits into separate WhatsApp messages, separately billed, and this
 * is the biggest daily fan-out in the product.
 */
export function composeMorning(i: MorningInputs): string {
  const greeting = `Morning ${i.firstName}.`;

  // SICK: care, and no asks. A client who was ill yesterday is not given targets, a streak
  // report, or an instruction — the right action is sometimes nothing, and a brief that pushes
  // through illness is the nagging app we are not building.
  if (i.sickYesterday) {
    return join([
      `${greeting} Hope you're feeling better. When you're ready, just say Hi and we pick up from where you left off.`,
      i.adaptLine,
    ]);
  }

  const opening = [greeting, i.identityLine, i.streakLine, i.workoutLine, i.yesterdayLine]
    .map(s => (s || "").trim()).filter(Boolean).join(" ");

  const today = i.todayLines.filter(Boolean).join("\n");
  // The adapt reason sits WITH the numbers it changed. Below the ask it would leave the client
  // reading a moved target with the explanation further down the message.
  const todayBlock = today ? (i.adaptLine ? `${today}\n\n${i.adaptLine}` : today) : i.adaptLine;

  return join([
    i.targetFixLine ? i.targetFixLine.trim() + " " + opening : opening,
    todayBlock,
    i.closingLine.trim(),
    i.decisionLine || i.breakfastAsk,
  ]);
}

const join = (parts: string[]) => parts.map(p => (p || "").trim()).filter(Boolean).join("\n\n");

/**
 * The one observation about yesterday.
 *
 * WHAT THIS RETIRED. The old branch tree ended by naming the client's chronically weakest meal
 * slot from fourteen days of data and prescribing a fix for it ("Your dinners average only 22g
 * protein — tonight: lead dinner with 200g chicken…"). That is a coaching instruction, produced
 * by a completely different analysis from the one decideProactive runs, in the same message as
 * decideProactive's instruction. The client could be told to fix dinner AND to get a walk in AND
 * to log breakfast, by three parts of one message that had never met.
 *
 * So this observes and stops. If protein is genuinely the thing to fix, the decision owner says
 * so — it already ranks protein above steps and training for exactly that reason.
 *
 * `numbersLow` clients get no figures at all, which is the existing numbers-mode contract.
 */
export function yesterdayObservation(
  o: { foodLogged: boolean; proteinLogged: number; proteinTarget: number; numbersLow: boolean },
): string {
  if (!o.foodLogged) return `No food logged yesterday — today starts now.`;
  if (o.proteinLogged <= 0) return `Food was logged yesterday but protein wasn't tracked.`;
  const hit = o.proteinTarget > 0 && o.proteinLogged >= o.proteinTarget * 0.9;
  if (o.numbersLow) {
    return hit
      ? `Great protein yesterday — that's the muscle looked after. 💪`
      : `A little short on protein yesterday.`;
  }
  return hit
    ? `${o.proteinLogged}g protein logged yesterday — target hit.`
    : `${o.proteinLogged}g protein logged yesterday, against a ${o.proteinTarget}g target.`;
}
