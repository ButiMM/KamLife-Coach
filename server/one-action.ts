/**
 * THE ONE ACTION — what this specific person should do today, and nothing else.
 *
 * (2026-07-28, founder: "What is the single thing Coach K should make this person do today that
 * gives the highest probability of succeeding? One recommendation. One action. One win.")
 *
 * This is the coaching. Everything else in the codebase — the ledger, the cards, the memory, the
 * routing — is scaffolding around this decision, and until now the decision was never made. The
 * product could tell you what you ate and how you were tracking. It could not tell you what to do.
 *
 * Read against the value equation (Dream Outcome × Likelihood) / (Time Delay × Effort):
 *
 *   EFFORT ↓  — they stop deciding. Deciding is the most expensive thing we ask of a client, and
 *               it is the thing they are worst at when tired. One instruction, already chosen.
 *   DREAM ↑   — phrased against THEIR OWN WORDS. We ask every client for their three-month dream
 *               at signup, store it, and then coach in grams of protein for the next twelve
 *               weeks. The numerator was sitting in the database, unused.
 *   TIME ↓    — every day contains a win tied to the dream, instead of the first win being weeks
 *               away on a scale.
 *
 * ORDERING IS THE WHOLE DESIGN. The actions are ranked by what actually decides whether this
 * person succeeds, not by what is easy to compute. Someone who has gone silent does not need a
 * protein tip; they need to come back. Someone who never weighs cannot be shown progress, so the
 * scale outranks the food. Someone who is sick should be told to rest — the right action is
 * sometimes to do nothing, and a coach who cannot say that is just a nagging app.
 *
 * Pure — no DB, no model. Unit-tested.
 */

import type { GoalKey } from "./goal-profiles";

export interface DayState {
  firstName?: string;
  goal: GoalKey;
  /** Their three-month dream, in their own words, from onboarding. */
  dreamGoal?: string | null;
  /** What they said would get in the way. Decides WHICH action is realistic for them. */
  biggestStruggle?: string | null;
  weeksOnProgramme: number;
  /** Days since they logged anything at all. 0 = today. */
  daysSinceAnyLog: number;
  /** Days since their last weigh-in; null when they have never weighed. */
  daysSinceWeighIn: number | null;
  loggedToday: boolean;
  /** Today's totals as a share of target, 0..1+. */
  proteinPct: number;
  caloriePct: number;
  sessionsThisWeek: number;
  sessionsTarget: number;
  stepsToday: number;
  stepsTarget: number;
  sick?: boolean;
  /** SAST hour, 0–23 — a "log your dinner" nudge at 9am is noise. */
  hour: number;
}

export type ActionKind =
  | "come_back" | "rest" | "weigh" | "protein" | "eat_more"
  | "log" | "walk" | "train" | "hold";

export interface OneAction {
  kind: ActionKind;
  /** The instruction. Verb first. Never a number they have to interpret. */
  todo: string;
  /** Why it matters — in their language, tied to the dream when we have one. */
  why: string;
}

// ── WHAT GETS IN THEIR WAY ───────────────────────────────────────────────────────────────────
// Free text from onboarding, mapped to the few shapes that change what we should ask for. A
// client who told us they get home at 10pm must never be told to meal-prep; being ignored after
// answering the question is worse than never being asked.

export type Struggle = "time" | "money" | "motivation" | "knowledge" | "consistency" | null;

export function readStruggle(text?: string | null): Struggle {
  const s = (text || "").toLowerCase();
  if (!s.trim()) return null;
  // NO TRAILING \b ON A STEM. `\bmotivat\b` can never match "motivation" — there is no word
  // boundary in the middle of a word. The same mistake shipped earlier in this codebase as
  // `\bexhaust\b` against "exhausted". Stems are anchored at the START only.
  if (/\b(?:time|busy|late|shift|work|hour|kid|schedule|rush)/.test(s)) return "time";
  if (/\b(?:money|afford|expensive|budget|cheap|broke|cost|price|pricey)/.test(s)) return "money";
  if (/\b(?:motivat|lazy|give up|giving up|quit|discipline|willpower|mood|bored)/.test(s)) return "motivation";
  if (/\b(?:know|understand|confus|clue|where to start|what to eat|portion)/.test(s)) return "knowledge";
  if (/\b(?:consisten|keep going|stick|routine|habit|fall off|fell off)/.test(s)) return "consistency";
  return null;
}

// ── THEIR OWN WORDS ──────────────────────────────────────────────────────────────────────────

/**
 * A short, safe clause built from the client's own dream text, or "" when it can't be used well.
 *
 * Deliberately conservative. This is free text a client typed months ago; splicing a rambling or
 * oddly-punctuated sentence into a coaching line reads worse than saying nothing, and a quote
 * that lands wrong on a bad day does real damage. Short and clean, or omitted.
 */
export function dreamClause(dream?: string | null): string {
  const raw = (dream || "").replace(/[*_`~\n\r]+/g, " ").replace(/\s+/g, " ").trim();
  if (raw.length < 8 || raw.length > 70) return "";
  if (/[<>{}[\]|\\]/.test(raw)) return "";              // anything that isn't a sentence
  if (!/[a-z]{3}/i.test(raw)) return "";                 // not actual words
  const cleaned = raw.replace(/[.!?]+$/, "");
  return cleaned.toLowerCase();
}

/** The "why" line — their dream when we have it, an honest general reason when we don't. */
function why(base: string, dream?: string | null): string {
  const d = dreamClause(dream);
  return d ? `${base} That's what gets you to *${d}*.` : base;
}

// ── THE DECISION ─────────────────────────────────────────────────────────────────────────────

const LATE = 17; // from 5pm, "log today" and "get a walk in" start to make sense

export function chooseAction(s: DayState): OneAction {
  const struggle = readStruggle(s.biggestStruggle);
  const isBulk = s.goal === "muscle_gain";

  // 1. NOTHING ELSE MATTERS IF THEY ARE GONE. A protein tip to someone who vanished four days
  //    ago is a coach talking to an empty room.
  if (s.daysSinceAnyLog >= 3) {
    // SILENCE ESCALATES (2026-07-29). Three days away and six weeks away used to get the same
    // sentence. They are not the same person: someone gone three days needs a nudge, someone
    // gone six weeks has usually decided they failed and is embarrassed to come back. The longer
    // they have been gone, the smaller the ask and the more explicit the absolution.
    const weeks = Math.floor(s.daysSinceAnyLog / 7);
    if (weeks >= 4) {
      return {
        kind: "come_back",
        todo: "Just say hi. That's the whole ask today.",
        why: why(`It's been about ${weeks === 4 ? "a month" : `${weeks} weeks`}, and you haven't blown anything — that's the story people tell themselves and it stops them coming back. Your numbers are exactly where you left them.`, s.dreamGoal),
      };
    }
    if (weeks >= 1) {
      return {
        kind: "come_back",
        todo: struggle === "time" ? "Tell me one thing you ate this week." : "Log one meal today. Any meal.",
        why: why("No catching up, no starting over. One meal puts you straight back in.", s.dreamGoal),
      };
    }
    return {
      kind: "come_back",
      todo: struggle === "time"
        ? "Log one thing today — even just what you had for lunch"
        : "Log one meal today. Any meal.",
      why: why("Nothing resets and nothing is lost — you pick up exactly where you left off.", s.dreamGoal),
    };
  }

  // 2. THE RIGHT ACTION IS SOMETIMES NOTHING. A coach who can't say "rest" is a nagging app.
  if (s.sick) {
    return {
      kind: "rest",
      todo: "Rest today. No training, no targets.",
      why: "You don't lose progress in a few days off — you lose it by training through illness and being out for two weeks.",
    };
  }

  // 3. THEY CANNOT SEE PROGRESS THEY NEVER MEASURED. This also fixes the blind spot in our own
  //    outcomes data — a client with no weigh-in is one we can never prove we helped.
  const neverWeighed = s.daysSinceWeighIn === null;
  if ((neverWeighed && s.weeksOnProgramme >= 1) || (s.daysSinceWeighIn !== null && s.daysSinceWeighIn >= 10)) {
    return {
      kind: "weigh",
      todo: "Stand on a scale this morning, before you eat.",
      why: why(
        neverWeighed
          ? "It's one number and it's the only way either of us sees this working."
          : "It's been a while — one number today and I can show you what's actually happening.",
        s.dreamGoal,
      ),
    };
  }

  // 4. UNDER-FUELLED ON A BULK. Nothing else works if they aren't eating.
  if (isBulk && s.loggedToday && s.caloriePct < 0.6 && s.hour >= LATE) {
    return {
      kind: "eat_more",
      todo: struggle === "money"
        ? "Add one more proper meal today — eggs, bread and peanut butter does it."
        : "Add one more proper meal today.",
      why: why("You can't build on food you didn't eat.", s.dreamGoal),
    };
  }

  // 5. PROTEIN. The single highest-leverage nutrition action for BOTH goals — it protects muscle
  //    on a cut and builds it on a bulk — so it outranks everything else about food.
  if (s.loggedToday && s.proteinPct < 0.6) {
    return {
      kind: "protein",
      todo: struggle === "time"
        ? "Make your next meal a protein one — tin fish, eggs or amasi. Two minutes."
        : struggle === "money"
        ? "Get protein into your next meal — eggs, pilchards or sugar beans."
        : "Make your next meal a proper protein meal.",
      why: why(
        isBulk ? "Protein is the part your body actually builds with." : "Protein is what keeps the weight you lose off your muscle instead of your strength.",
        s.dreamGoal,
      ),
    };
  }

  // 6. NOTHING LOGGED AND THE DAY IS NEARLY OVER.
  if (!s.loggedToday && s.hour >= LATE) {
    return {
      kind: "log",
      todo: "Tell me what you ate today — one line is enough.",
      why: why("I can't coach a day I can't see.", s.dreamGoal),
    };
  }

  // 7. STEPS. The easiest win there is, and the one most people can actually do on a bad day.
  if (s.stepsTarget > 0 && s.stepsToday < s.stepsTarget * 0.5 && s.hour >= 12) {
    return {
      kind: "walk",
      todo: struggle === "time" ? "Get a 15-minute walk in today — that's all." : "Get a 20-minute walk in today.",
      why: why("It's the cheapest thing you can do that still counts.", s.dreamGoal),
    };
  }

  // 8. TRAINING, behind for the week.
  if (s.sessionsTarget > 0 && s.sessionsThisWeek < s.sessionsTarget) {
    const left = s.sessionsTarget - s.sessionsThisWeek;
    return {
      kind: "train",
      todo: struggle === "motivation"
        ? "Do today's session. Even a bad one counts."
        : "Get today's session done.",
      why: why(`${left} more this week and you've done the whole plan.`, s.dreamGoal),
    };
  }

  // 9. EVERYTHING IS ON TRACK. Say so and ask for nothing — a coach who always has a note to add
  //    teaches you that you can never actually be doing well.
  return {
    kind: "hold",
    todo: "Nothing new today. Do exactly what you did yesterday.",
    why: why("This is the part that works. Boring and repeated beats clever and occasional.", s.dreamGoal),
  };
}

/**
 * The whole message. Two lines, on purpose — this is the answer to "it should feel easy", and a
 * paragraph would undo it. The instruction leads; the reason follows and can be ignored.
 */
export function formatOneAction(a: OneAction, firstName?: string): string {
  const fn = (firstName || "").trim();
  return `${fn ? fn + " — o" : "O"}ne thing today:\n\n*${a.todo}*\n\n_${a.why}_`;
}
