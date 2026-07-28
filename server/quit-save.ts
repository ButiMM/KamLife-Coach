/**
 * THE QUIT MOMENT — "I don't know how I will do this anymore."
 *
 * (2026-07-28. A real client, 09:16, after getting home from work at 1am. The founder answered
 * it by hand, and his answer is the most valuable thing in this product: "You are doing well.
 * You are on track. That's the honest truth. Life happens. It's going to keep happening… The
 * last thing you want is to quit now, then you are in the same situation (even heavier) as
 * today. Or we can continue, and this time next year you're physically a completely new person.
 * This is not about perfection. It's about showing up. For yourself.")
 *
 * The product could not do it. Worse: "I can't do this anymore" was being read as
 * CRISIS_ADJACENT and answered with a mental-health helpline. Handing SADAG's number to someone
 * who is simply exhausted and sick of tracking food is insulting, and it would end the
 * relationship on the spot. Wanting to quit a fitness programme is not a mental health event.
 *
 * This is the difference between churn and a client, so it is deterministic and it is built on
 * REAL numbers. "You're on track" is only worth saying when it is true, so we compute it. When
 * it isn't true we say something else that is — never a compliment the ledger contradicts.
 *
 * Structure, lifted from how the founder actually does it:
 *   1. Normalise the feeling. No therapy voice, no diagnosis.
 *   2. Name the real obstacle they just named (a 1am finish is not laziness).
 *   3. The honest data — their own numbers, good or bad.
 *   4. Life happens, and it will keep happening. Not an excuse; a fact to plan around.
 *   5. The cost of quitting, unflinching: same place next year, probably heavier.
 *   6. The alternative, concrete.
 *   7. Reset the standard: not perfection — showing up.
 *
 * Pure — no DB, no model. Unit-tested.
 */

export interface QuitFacts {
  firstName?: string;
  /** Sessions actually logged. The spine of the honest paragraph. */
  sessions: number;
  /** Weeks since they signed up. */
  weeks: number;
  /** kg change since their first weigh-in. Negative = lost. Undefined = never weighed. */
  weightChangeKg?: number;
  /** Days since their last logged anything — how far gone they already are. */
  daysSinceLog?: number;
  /** Obstacle they named in the same breath, if any ("got home after 1am"). */
  obstacle?: "late_work" | "exhausted" | "money" | "time" | null;
}

/**
 * Are they talking about quitting THE PROGRAMME? Deliberately separate from the life-context
 * crisis path — "I can't go on" is a life statement, "I can't keep doing this" is about us.
 */
const QUIT_RE = /\b(?:i\s+)?(?:don'?t|do not)\s+know\s+(?:how|if)\s+(?:i(?:'?ll| will| can)?)\s+(?:do|keep|carry|manage|continue|go on with)\s+(?:this|it)\b|\bcan'?t\s+(?:keep\s+)?(?:doing|do)\s+this\s+any\s?more\b|\bi\s+(?:want|need)\s+to\s+(?:quit|stop|give up)\b|\bthinking\s+of\s+(?:quitting|stopping|giving up)\b|\bready\s+to\s+give\s+up\b|\bi'?m\s+(?:about\s+to\s+)?(?:quit|done with this|giving up)\b|\bthis\s+is\s+(?:too\s+much|not\s+working)\s+for\s+me\b|\bmaybe\s+this\s+(?:isn'?t|is not)\s+for\s+me\b/i;

// Genuine life-crisis language belongs to life-context, not here.
const LIFE_NOT_PROGRAMME = /\b(?:can'?t\s+go\s+on|no\s+point\s+(?:in\s+)?living|end\s+it|hurt\s+myself|nothing\s+matters|want\s+to\s+die)\b/i;

export function looksLikeQuitMoment(message: string): boolean {
  const s = message || "";
  if (LIFE_NOT_PROGRAMME.test(s)) return false;
  return QUIT_RE.test(s);
}

/** The obstacle they named, so the reply can answer the real thing. */
export function readObstacle(message: string): QuitFacts["obstacle"] {
  const s = message || "";
  if (/\b(?:got\s+home|finished|knocked\s+off|working)\s+(?:after|at|past|till|until)\s*\d{1,2}\s*(?:am|pm|:\d{2})?\b|\bnight\s+shift\b|\bwork(?:ing|ed)?\s+(?:late|till late|until late)\b/i.test(s)) return "late_work";
  if (/\b(?:exhaust(?:ed|ion)?|so tired|no energy|drained|running on empty)\b/i.test(s)) return "exhausted";
  if (/\b(?:no money|can'?t afford|too expensive|broke)\b/i.test(s)) return "money";
  if (/\b(?:no time|don'?t have time|too busy)\b/i.test(s)) return "time";
  return null;
}

const OBSTACLE_LINE: Record<NonNullable<QuitFacts["obstacle"]>, string> = {
  late_work: "Getting home after 1am and still thinking about this at all says something about you. That's not someone who's slacking — that's someone running out of hours in the day.",
  exhausted: "You're not being lazy, you're tired. Those are different things and they need different answers.",
  money: "Money makes this harder and anyone who says otherwise has never had to choose. We work with what you've actually got.",
  time: "It's not that you don't care — there's genuinely no room in your day. So we make the plan fit the day you have, not the one you don't.",
};

/**
 * The honest paragraph. This is the part that must never be a compliment their own log
 * contradicts — so it branches on what actually happened.
 */
function honestRead(f: QuitFacts): string {
  const { sessions, weeks } = f;
  const lost = typeof f.weightChangeKg === "number" && f.weightChangeKg <= -0.5
    ? ` You're down *${Math.abs(f.weightChangeKg).toFixed(1)}kg* since you started — that already happened, and quitting doesn't un-happen it.`
    : "";

  if (sessions >= 8) {
    return `Here's the honest truth, not a pep talk: *${sessions} sessions* over ${weeks} week${weeks === 1 ? "" : "s"}. That is doing well. That is on track.${lost}`;
  }
  if (sessions >= 3) {
    return `Honest read: *${sessions} sessions* in ${weeks} week${weeks === 1 ? "" : "s"}. Not perfect — but it's not nothing, and it's more than the version of you who never started.${lost}`;
  }
  if (sessions >= 1) {
    return `You've got *${sessions} session${sessions === 1 ? "" : "s"}* down. It's early and it's shaky, and that is exactly what week one looks like for everybody.${lost}`;
  }
  return `You haven't got sessions on the board yet — so there's nothing to lose by starting small this week.${lost}`;
}

/**
 * The reply. Long on purpose: this is the one moment that earns length, because it is the
 * conversation that decides whether someone is still here in a month.
 */
export function quitSaveReply(f: QuitFacts): string {
  const fn = f.firstName ? `${f.firstName}, ` : "";
  const obstacle = f.obstacle ? `\n\n${OBSTACLE_LINE[f.obstacle]}` : "";

  return `${fn}that's a fair thing to feel, and most people feel it around now. It's more a mental game than a physical one — this is the part where it's decided.${obstacle}

${honestRead(f)}

Life happens. It's going to keep happening — that's not a reason to stop, it's the thing we plan around. Bad weeks are part of the plan, not a failure of it.

*Here's the honest choice:* stop now, and a year from today you're in the same place — probably heavier, definitely no further. Keep going, even badly, and this time next year you're a different person physically. That's the whole difference.

This was never about perfection. Nobody's perfect. It's about showing up — for yourself.

*So don't quit. Shrink it.* This week: no targets, no catching up. One walk and one proper meal a day. That's it. Tell me when you've done one and I'll take it from there.`;
}

/**
 * A far shorter version for someone who has ALREADY gone quiet — they didn't ask, we noticed.
 * Wall-of-text at a person who stopped replying is how you get blocked.
 */
export function silentQuitNudge(f: QuitFacts): string {
  const fn = f.firstName ? `${f.firstName}, ` : "";
  const days = f.daysSinceLog ?? 0;
  const banked = f.sessions > 0 ? ` You've got *${f.sessions} sessions* banked — those don't expire.` : "";
  return `${fn}it's been ${days} days. No lecture, nothing to explain.${banked}\n\nMost people disappear at exactly this point and never come back, and it's almost never because it got too hard — it's because they thought they'd blown it. You haven't.\n\nOne walk or one logged meal today and you're back in it. Nothing to catch up.`;
}
