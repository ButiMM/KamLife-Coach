/**
 * SESSION REPORT — a training session described in ordinary words.
 *
 * (2026-07-27 live thread, two failures in ONE message.) A client wrote that today was
 * his first day back at the gym after being sick and that it "felt very bad, like I never
 * trained before". Three things had to be true for that to land, and none were:
 *
 *   1. `isDone` only matches terse forms ("done", "workout done") — anchored ^…$, so a
 *      sentence never reaches it. Nothing was logged.
 *   2. The retroactive path requires an explicit past day ("yesterday", "on Monday") —
 *      "today" was deliberately excluded. Nothing was logged.
 *   3. `classifyWorkoutFeedback` has no notion of a session that felt BAD (only too
 *      hard / too easy / just right), and its recency gate demands a WORKOUT_* intent in
 *      the last 6h — which never exists for someone who just trains and then tells you.
 *
 * Net effect: the session vanished, the feeling was ignored, and minutes later the coach
 * told him "Training day — reply *workout*" for a session he had already done.
 *
 * This module reads the sentence the way a human coach would: did you train today, how
 * did it go, and is this a comeback? Pure — no DB, no clock, no model. Unit-tested.
 */

export type SessionFeel = "bad" | "hard" | "fine" | "strong";

export interface SessionReport {
  /** They are telling us a session HAPPENED today (past tense, not a plan). */
  trainedToday: boolean;
  /** How it went, when they said. Null when they only reported the fact. */
  feel: SessionFeel | null;
  /** First session back after illness or a layoff — changes the coaching completely. */
  returning: boolean;
}

// Past-tense training report. "I'm training today" is deliberately absent — present
// continuous reads as a plan, and isFutureIntent at the call site catches the rest.
const TRAINED_PAST =
  /\b(?:i\s+)?(?:trained|trained\s+today|worked\s+out|trained\s+again)\b/i;
const WENT_TO_GYM =
  /\b(?:went|been|got\s+back)\s+(?:to\s+|from\s+)?(?:the\s+)?(?:gym|training|session)\b|\bhit\s+the\s+gym\b|\bwas\s+at\s+(?:the\s+)?gym\b/i;
const DID_SESSION =
  /\b(?:did|finished|completed|smashed|pushed\s+through)\s+(?:my\s+|the\s+|a\s+|today.?s\s+)?(?:workout|session|training|gym|legs?|leg\s+day|upper(?:\s+body)?|lower(?:\s+body)?|chest|back|push|pull|cardio|arms?|shoulders?)\b/i;
const FIRST_DAY_BACK =
  /\b(?:first|1st)\s+(?:day|session|workout|time)\s+back\b|\bback\s+(?:in|at)\s+(?:the\s+)?gym\b|\bback\s+to\s+training\b/i;

// "Today" in the widest sense a client means it — including a bare report with no time
// word at all ("just finished my session"), which always means now.
const TODAY_REF = /\b(today|this\s+morning|this\s+afternoon|this\s+evening|tonight|just\s+now|earlier(?:\s+today)?|a\s+moment\s+ago)\b/i;
const JUST_NOW = /\b(?:just|finally)\s+(?:got\s+back|finished|done|did|came\s+back|left)\b/i;

// A past day reference means the retroactive path owns it, not this one.
const OTHER_DAY = /\b(yesterday|last\s+night|\d+\s+days?\s+ago|two\s+days\s+ago|last\s+week|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

// How the session FELT. "bad" is the one the product had no concept of, and it is the
// single most important one to hear: it is what someone says right before they quit.
const FEEL_BAD =
  /\b(?:felt|feel|feeling|was)\s+(?:so\s+|very\s+|really\s+|absolutely\s+|pretty\s+)?(?:bad|terrible|awful|horrible|rubbish|shit|kak|weak|useless|pathetic|rough|off)\b/i;
const LIKE_A_BEGINNER =
  /\blike\s+i(?:\s+(?:have|had|.?ve|.?d))?\s+(?:never|not)\s+(?:trained|trained\s+before|worked\s+out|lifted)\b|\blike\s+a\s+(?:beginner|newbie|first.?timer)\b|\blike\s+my\s+first\s+(?:day|time|session)\b|\bstarting\s+from\s+(?:zero|scratch|square\s+one)\b/i;
const NO_STRENGTH =
  /\b(?:no|zero|lost\s+(?:all\s+)?(?:my\s+)?)\s*strength\b|\bcouldn.?t\s+(?:lift|finish|do|manage|complete)\b|\bhad\s+nothing\b|\bweak\s+as\b|\bshaky\b|\blight.?headed\b|\bout\s+of\s+breath\b|\bgassed\b/i;
const FEEL_HARD =
  /\b(?:too\s+(?:hard|tough|difficult|much|heavy)|so\s+hard|really\s+hard|brutal|killed\s+me|kicked\s+my|destroyed\s+me|wiped\s+me|struggled)\b/i;
const FEEL_STRONG =
  /\b(?:felt|feel|was)\s+(?:so\s+|really\s+|bloody\s+)?(?:great|strong|amazing|lekker|good|solid|fresh)\b|\b(?:smashed|crushed|nailed)\s+it\b|\bpersonal\s+best\b|\bnew\s+pb\b/i;
const FEEL_FINE = /\b(?:felt|was)\s+(?:ok|okay|alright|fine|not\s+bad)\b/i;

// A comeback: after illness, injury, or simply a stretch of not training.
const RETURNING =
  /\b(?:first|1st)\s+(?:day|session|workout|time)\s+back\b|\bback\s+(?:after|from)\s+(?:being\s+)?(?:sick|ill|the\s+flu|flu|covid|injury|holiday|leave|a\s+break|my\s+break)\b|\bafter\s+(?:being\s+sick|the\s+flu|my\s+illness|weeks?\s+off|months?\s+off|a\s+long\s+break)\b|\bhaven.?t\s+trained\s+(?:in|for)\b|\bfirst\s+(?:workout|session)\s+(?:in|since)\b|\bgetting\s+back\s+into\s+it\b/i;

/**
 * Read a message as "I trained today". Returns null when it isn't one — a plan, a
 * question, a miss, or a session on another day all fall through to their own handlers.
 * The caller still applies isFutureIntent / looksLikeQuestion / mentionsNotDone; those
 * live in utils and this module stays dependency-free so it can be tested in isolation.
 */
export function parseSessionReport(message: string): SessionReport | null {
  const s = (message || "").trim();
  if (!s) return null;
  if (OTHER_DAY.test(s)) return null;

  const didTrain = TRAINED_PAST.test(s) || WENT_TO_GYM.test(s) || DID_SESSION.test(s) || FIRST_DAY_BACK.test(s);
  if (!didTrain) return null;

  // It has to be about TODAY. A bare "just finished my session" counts; "first day back"
  // with no other day named counts too — nobody reports a comeback in the abstract.
  if (!TODAY_REF.test(s) && !JUST_NOW.test(s) && !FIRST_DAY_BACK.test(s)) return null;

  return { trainedToday: true, feel: readFeel(s), returning: RETURNING.test(s) };
}

/** How the session felt, worst-first — "bad" outranks everything, it is the quit signal. */
export function readFeel(message: string): SessionFeel | null {
  const s = message || "";
  if (FEEL_BAD.test(s) || LIKE_A_BEGINNER.test(s) || NO_STRENGTH.test(s)) return "bad";
  if (FEEL_HARD.test(s)) return "hard";
  if (FEEL_STRONG.test(s)) return "strong";
  if (FEEL_FINE.test(s)) return "fine";
  return null;
}

/**
 * The reply. It must do three jobs the failing thread did none of: confirm the session
 * is ON THE BOARD, answer the feeling honestly, and say what happens next session.
 * Short by reply contract — this is a coaching moment, not a physiology lecture.
 */
export function sessionReportReply(r: SessionReport, firstName = "", totalSessions?: number): string {
  const fn = firstName ? `${firstName}, ` : "";
  const tally = totalSessions && totalSessions > 0
    ? ` That's *${totalSessions} session${totalSessions === 1 ? "" : "s"}* logged.`
    : "";
  const logged = `✅ ${fn}logged today's session.${tally}`;

  // The comeback-that-felt-terrible case — the exact message that got ignored.
  if (r.feel === "bad" && r.returning) {
    return `${logged}\n\nFeeling like you've never trained before is *exactly* what a first session back looks like — you lose conditioning in days but strength comes back in weeks, and it comes back faster than it left.\n\nNext session: use *60%* of your old weights and build up over 2–3 weeks. Chasing your old numbers this week is how people get hurt or quit.`;
  }
  if (r.feel === "bad") {
    return `${logged}\n\nA session that felt that bad is information, not failure — usually sleep, food, or stress rather than you going backwards.\n\nNext session: drop the weight *20%* and finish every rep clean. If it still feels like that in two sessions, tell me and we change the programme.`;
  }
  if (r.returning) {
    return `${logged}\n\nFirst one back is the hardest one to start — that's the one that counts.\n\nBuild back over 2–3 weeks: start around *60%* of your old weights and add from there. Don't try to pick up where you left off.`;
  }
  if (r.feel === "hard") {
    return `${logged}\n\nToo hard means we scale it, not that you failed. Next session: drop the weight *10–20%* and nail full clean reps — your body adapts in 2–3 sessions.`;
  }
  if (r.feel === "strong") {
    return `${logged}\n\nThat's your body telling you it has adapted. Next session add *2.5kg* or *1–2 reps* — that's progressive overload, and it's the whole game.`;
  }
  if (r.feel === "fine") {
    return `${logged}\n\nThat's the zone we want — hard but doable. Keep these weights, and push *+1 rep* the moment it starts feeling easy.`;
  }
  return `${logged}\n\nHow did it feel — easy, about right, or too hard? I'll set next session's weights off that.`;
}

/** One-line memory so the next session's coaching knows how this one went. */
export function sessionMemoryLine(r: SessionReport): string {
  const bits = [r.returning ? "first session back after a layoff" : "", r.feel ? `session felt ${r.feel}` : ""]
    .filter(Boolean).join("; ");
  return `Training: ${bits || "session completed"}`;
}
