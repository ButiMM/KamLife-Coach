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
import { selectDecisionState, type DecisionEvidence } from "./understanding/state";
// Pure, and it has to be: the verifier owns "may this reach a client" and carries no database or
// model, so the decision can ask it what the client asked us not to say (Cut 8).
import { mentionsForbidden } from "./brain/reply-verifier";

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
  /**
   * They are typing to me RIGHT NOW — this action is going out as a reply, not as a nudge.
   *
   * (2026-07-29 sweep.) Every come_back action is written for someone who is absent: "Just say
   * hi. That's the whole ask today." Sent to a client who has just messaged, it asks for
   * something they have already done, which reads as the coach not registering that they spoke.
   * When this is set the come_back branch is skipped — they came back, that is what this
   * message IS — and they get the next real action instead.
   */
  atKeyboard?: boolean;
  /**
   * What is going on in their life, in their own words — "night shift", "just had a baby",
   * "retrenched". A durable fact from users.life_context (Cut 7), not an inference.
   *
   * This is the difference between a coach and a reminder. Someone three weeks gone with a
   * newborn is not someone who lost interest, and the ask has to say so or the absolution rings
   * hollow. Used ONLY on the come_back rungs — it explains an absence; it does not excuse a
   * protein target, and a prescription that quietly softens because of a life event is the
   * beginning of a coach who stops asking for anything.
   */
  lifeContext?: string | null;
  /**
   * What they asked us to stop bringing up — users.do_not_mention (Cut 7).
   *
   * THE DECISION STANDS DOWN, IT DOES NOT GET FILTERED. A client who said "don't talk about the
   * scale" and is then told to stand on one has been ignored, and stripping that sentence at the
   * mouth afterwards leaves the coach with nothing to say instead of the next real action. The
   * honest fix is to never choose the ask: the ordering below simply continues past it.
   */
  doNotMention?: string | null;
  /**
   * They closed food for today, in their own words. Not a feeling. Not a maybe.
   * eat_more and protein stand down — a coach who heard "I won't eat anymore" and still
   * prescribed a meal is the 19:55 screenshot.
   */
  foodDayClosed?: boolean;
  /**
   * They ruled out training today, in their own words — the twin of foodDayClosed.
   *
   * `trainingDayIsDeclined` has existed since 2026-08-24 and DayState had no field to put its
   * answer in, so the constraint was computed at the reactive door and then discarded: the
   * decision itself never heard it. A client who said "I'm not training today" and is behind for
   * the week still reached rung 8 and was told to get today's session done — by BOTH doors, since
   * the proactive path runs the same ladder. `train` stands down here for the same reason
   * `eat_more` stands down for a closed food day: they told us, and being told is the point.
   *
   * It does not excuse the week. Steps still rank above it, and the week's count is unchanged —
   * this suppresses one instruction for one day, it does not rewrite the record.
   */
  trainingDeclined?: boolean;
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

/**
 * A short clause naming what we know is going on in their life, or "" when we know nothing.
 *
 * Same conservatism as dreamClause: this is free text a client typed, spliced into a sentence at
 * a moment when they already feel bad about being away. Short and clean, or omitted entirely.
 */
export function lifeClause(life?: string | null): string {
  const raw = (life || "").replace(/[*_`~\n\r]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (raw.length < 3 || raw.length > 40) return "";
  if (!/^[a-z0-9 ,'-]+$/.test(raw)) return "";
  // The few we can phrase naturally. Anything else is stated flatly rather than guessed at.
  if (/newborn|new baby|just had a baby/.test(raw)) return "with a newborn in the house";
  if (/night shift/.test(raw)) return "on night shifts";
  if (/retrenched|laid off|lost my job/.test(raw)) return "with work the way it is";
  if (/new job/.test(raw)) return "with the new job";
  if (/divorce|breakup/.test(raw)) return "with everything going on at home";
  if (/exams|studying/.test(raw)) return "with exams on";
  if (/moved/.test(raw)) return "in the middle of a move";
  return "";
}

/** The "why" line — their dream when we have it, an honest general reason when we don't. */
function why(base: string, dream?: string | null): string {
  const d = dreamClause(dream);
  return d ? `${base} That's what gets you to *${d}*.` : base;
}

// ── THE TWO MEASUREMENT ASKS ─────────────────────────────────────────────────────────────────
// Named because they are reached from two places now: the ordered decision below, and the verdict
// enforcement further down, which downgrades a prescription it cannot justify into the measurement
// that WOULD justify it. One copy of the wording, so the two can never drift.

function askToLog(dream?: string | null): OneAction {
  return {
    kind: "log",
    todo: "Tell me what you ate today — one line is enough.",
    why: why("I can't coach a day I can't see.", dream),
  };
}

function holdAction(dream?: string | null): OneAction {
  return {
    kind: "hold",
    todo: "Nothing new today. Do exactly what you did yesterday.",
    why: why("This is the part that works. Boring and repeated beats clever and occasional.", dream),
  };
}

function askToWeigh(dream?: string | null, neverWeighed = false): OneAction {
  return {
    kind: "weigh",
    todo: "Stand on a scale this morning, before you eat.",
    why: why(
      neverWeighed
        ? "It's one number and it's the only way either of us sees this working."
        : "It's been a while — one number today and I can show you what's actually happening.",
      dream,
    ),
  };
}

// ── THE DECISION ─────────────────────────────────────────────────────────────────────────────

const LATE = 17; // from 5pm, "log today" and "get a walk in" start to make sense

/**
 * Latest explicit constraint, TRAINING side: they said they are not training this SAST day.
 *
 * The twin of foodDayIsClosed, and named the same way for the same reason — it is a DayState
 * input, not a new routing predicate. It exists because routes.ts had a DEFERRAL detector
 * ("I'll do it later") and nothing owned a REFUSAL. So on 24 August:
 *
 *   "no I'm not training today"          → a full Foundation Phase programme
 *   "I'm training tomorrow not today"    → "Week 5 — Next Session (Day 1)"
 *
 * Both were answered with today's session, post-workout nutrition and "Send DONE", over an
 * explicit refusal. The deferral matcher needed a first-person FUTURE verb and a later-time
 * word, so a plain negation of today matched none of it.
 *
 * Two shapes, both statements of fact about today — a QUESTION ("can I train tomorrow instead?")
 * is a request, not a constraint, and must be answered rather than silently recorded as a
 * decision the client did not make:
 *
 *   refusal      a negation of training, scoped to today
 *   displacement training named for a later day AND today explicitly excluded
 *
 * The inverse must survive untouched: "I trained today" is a REPORT and is still written as
 * today's session — that is why completion words disqualify.
 */
/**
 * IS THE CLIENT TRAINING TODAY? ONE READER (2026-08-25).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE HANDSET FAILURE THIS EXISTS TO STOP
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 *   Coach:  [today's session] … Done 💪 | Too hard — modify | Skip today
 *   Client: "No I moved yesterdays workout to today"
 *   Coach:  "Kam, no stress — rest today, hit it fresh tomorrow 💪"
 *
 * He answered our own button menu, told us he was training, and we told him to rest. The old
 * matcher saw "No" … "workout" … "today" and called it a refusal — because MOVED INTO TODAY was
 * a shape none of the readers represented.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHY A CLASSIFIER AND NOT ANOTHER BOOLEAN
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Six places decided this question independently and each held a different piece of it:
 *
 *   one-action     trainingDayIsDeclined   refusal
 *   routes         _isWorkoutRefusal       called the owner and DISCARDED the result
 *   routes         _isWorkoutMoveRequest   "can I shift it?"
 *   routes         _isWorkoutDeferral      "I'll do it later"
 *   lifecycle      isRestDayMsg            rest day
 *   lifecycle      isMissedWorkout         reported a past miss
 *   workout        hasMissWord             don't retro-log a miss as a completion
 *
 * Every one of them is a partial answer to "is this client training today". Kept apart, a fix to
 * any single one reaches none of the others — which is precisely why this defect kept returning
 * after each patch. One reader returns the whole answer; the callers keep their own actions.
 *
 * ORDER IS THE WHOLE DESIGN. `moved_to_today` is tested BEFORE `declined`, because the sentence
 * that broke carries both signals and only one of them is what he meant.
 *
 * HONEST BOUND: this is still pattern matching, and pattern matching has an unbounded failure
 * surface — a phrasing nobody thought of will get through. What it no longer has is SIX surfaces.
 * The next step is for the classifier to lead and this to be the narrow safety net beneath it.
 */
export type TrainingDayRead =
  | "declined"        // not training today, in their own words
  | "moved_to_today"  // another day's session pulled INTO today — they ARE training
  | "move_request"    // asking permission to shift it
  | "deferred"        // stating they will do it later
  | "missed"          // reporting a session that did not happen
  | "none";

export function readTrainingDay(text: string): TrainingDayRead {
  const t = String(text || "");
  if (!t.trim()) return "none";
  // The vocabulary this question is asked in. REST_SHAPE is the half lifecycle's isRestDayMsg
  // held and this owner did not: "rest day", "day off", "recovery day" name the same decision
  // without ever using a training word.
  const TRAINING = /(?:train(?:ing)?|workout|work\s*out|session|gym|exercis(?:e|ing))/i;
  const REST_SHAPE = /\b(?:rest\s+day|day\s+off|off\s+day|recovery\s+day|active\s+recovery|taking\s+a\s+rest|rest\s+today|off\s+today)\b/i;
  if (REST_SHAPE.test(t) && !/\?/.test(t)) return "declined";
  if (!TRAINING.test(t)) return "none";

  // 1. MOVED INTO TODAY — they are training, whatever else the sentence contains. This must
  //    outrank the refusal test: "No I moved yesterdays workout to today" satisfies both.
  if (/\b(?:moved?|moving|shifted?|swapped?|pushed|bumped|brought)\b[^.!?]{0,40}?\b(?:to|into|for)\s+(?:today|now|this\s+(?:morning|afternoon|evening))\b/i.test(t)
      || /\b(?:doing|i'?m\s+doing|did)\b[^.!?]{0,40}?\b(?:yesterday'?s|monday'?s|tuesday'?s|wednesday'?s|thursday'?s|friday'?s|saturday'?s|sunday'?s|missed|skipped)\b[^.!?]{0,30}?\b(?:today|now)\b/i.test(t)) {
    return "moved_to_today";
  }

  // 2. ASKING PERMISSION TO SHIFT IT. Modal + first person, and not a request to SEE it.
  if (/^\s*(?:can|could|may|should|is\s+it\s+ok\s+(?:if\s+)?)\s*i\b/i.test(t.trim())
      && /\b(?:tomorrow|later|tonight|this\s+evening|after\s+work|next\s+week|another\s+day|a\s+different\s+day|2moro|2morrow)\b/i.test(t)
      && !/\b(?:show|send|see|view|what'?s|what\s+is|give\s+me)\b/i.test(t)
      && !/\b(?:tomorrow|next\s+week)'?s\s+(?:workout|work\s*out|session|training)\b/i.test(t)) {
    return "move_request";
  }

  if (trainingDayIsDeclined(t)) return "declined";

  // 3. STATING A LATER PLAN — a deferral is a plan, not a constraint on today.
  if (!t.includes("?")
      && /\b(?:i'?ll|i\s+will|i'?m\s+going\s+to|i\s+am\s+going\s+to|gonna|going\s+to|plann?ing\s+(?:to|on)|plan\s+to)\b/i.test(t)
      && /\b(?:tomorrow|later|tonight|this\s+evening|after\s+work|in\s+the\s+morning|next\s+week|2moro|2morrow)\b/i.test(t)
      && !/\b(?:done|finished|completed|already\s+did|just\s+did|did\s+my|smashed|crushed)\b/i.test(t)) {
    return "deferred";
  }

  // 4. A SESSION THAT DID NOT HAPPEN. Past tense, and not a negated cessation ("didn't skip").
  if (!/\b(?:not|never|didn'?t|don'?t)\b[^.!?]{0,20}?\b(?:skip|skipping|skipped|miss|missing|missed)\b/i.test(t)
      && (/\b(?:missed|skipped|couldn'?t|could\s+not|didn'?t\s+(?:make|get|train|go))\b/i.test(t)
          // "I didn't do my workout" — a negation anywhere near the training word. Absorbed from
          // workout.ts's hasMissWord, which had this reach and this owner did not.
          || /\b(?:didn'?t|did\s+not|couldn'?t|won'?t|will\s+not|haven'?t|hasn'?t)\b[^.!?]{0,40}?(?:train|workout|work\s*out|session|gym|exercis)/i.test(t))) {
    return "missed";
  }
  return "none";
}

export function trainingDayIsDeclined(text: string): boolean {
  const t = String(text || "");
  if (!t.trim()) return false;
  // MOVED INTO TODAY IS NOT A REFUSAL. Checked here too, because this function is the DayState
  // input and is called directly by the decision — it must not read "I moved it to today" as a
  // constraint against training just because readTrainingDay happens to be the richer door.
  if (/\b(?:moved?|moving|shifted?|swapped?|pushed|bumped|brought)\b[^.!?]{0,40}?\b(?:to|into|for)\s+(?:today|now|this\s+(?:morning|afternoon|evening))\b/i.test(t)) return false;
  // A REQUEST IS INTERROGATIVE-LED; A TAG QUESTION IS STILL A STATEMENT (2026-08-24, own review).
  // Excluding every "?" made "I'm not training today, ok?" not a refusal — two characters away
  // from the live failure this owner exists to stop. The distinction is grammar: "Can I train
  // tomorrow instead?" opens with a modal and asks permission; "I'm not training today, ok?"
  // opens with the client stating what they are doing. When it is genuinely unclear, refusing to
  // dump a session is the safe direction — the costly error is printing a workout over a refusal.
  if (/^\s*(?:can|could|should|shall|may|do|does|did|is|are|was|were|will|would|what|why|how|when|which|who)\b/i.test(t)
      && t.includes("?")) return false;
  // A report of a session that happened is never a refusal of one.
  if (/\b(?:done|finished|completed|already\s+did|just\s+did|did\s+my|smashed|crushed|trained)\b/i.test(t)) return false;
  // A NEGATED CESSATION IS AN AFFIRMATION — the twin of the "can't stop eating" guard above.
  // "I didn't skip the gym today" and "I never skip a session today" say they DID train, and the
  // negation + skip words sit in the same alternation as a genuine refusal. Found by adversarial
  // probe, not by a screenshot: marking a completed session as declined is the worse direction.
  if (/\b(?:not|never|no\s+way|didn'?t|don'?t|doesn'?t|won'?t|wouldn'?t|isn'?t|ain'?t|couldn'?t)\b[^.!?]{0,20}?\b(?:skip|skipping|skipped|miss|missing|missed)\b/i.test(t)) return false;
  const trainingToday =
    /\b(?:not|no|won'?t|will\s+not|can'?t|cannot|skipping|skip|missing)\b[^.!?]{0,40}?\b(?:train(?:ing)?|workout|work\s*out|session|gym|exercis(?:e|ing))\b[^.!?]{0,30}?\btoday\b/i.test(t)
    || /\b(?:train(?:ing)?|workout|work\s*out|session|gym|exercis(?:e|ing))\b[^.!?]{0,30}?\b(?:not|no)\b[^.!?]{0,15}?\btoday\b/i.test(t);
  if (trainingToday) return true;
  // "tomorrow instead" / "tomorrow not today" — a later day named AND today displaced.
  return /\b(?:tomorrow|next\s+week|2moro|2morrow)\b/i.test(t)
    && /\b(?:train(?:ing)?|workout|work\s*out|session|gym|exercis(?:e|ing))\b/i.test(t)
    && /\b(?:instead|not\s+today|rather\s+than\s+today)\b/i.test(t);
}

/**
 * Latest explicit constraint: they closed food for this SAST day.
 * Named without looksLike* so it is not a new routing predicate; it is a DayState input.
 */
export function foodDayIsClosed(text: string): boolean {
  const t = String(text || "");
  if (!t.trim()) return false;
  if (/\b(?:won'?t|will not|not (?:going to|gonna)|can'?t|cannot)\s+(?:be able to\s+)?eat(?:\s+anymore)?\b/i.test(t)) return true;
  if (/\bno more food\b/i.test(t)) return true;
  // A STATED CESSATION OF EATING, COMPOSED RATHER THAN LISTED (2026-08-24).
  //
  // "I think I'm going to stop eating today" and "I'm not eating anymore today" are the same
  // constraint as "done eating" and neither was recognised, so carriesFeelingClause claimed them
  // on "i think i" and the client's latest explicit constraint became FEELING_ACK instead of
  // reaching chooseAction. This is (a way of saying no-more) + (the act of eating) + (a marker
  // that it applies to the rest of THIS day), which is the shape, not a set of sentences.
  //
  // The closure marker must follow the verb IMMEDIATELY: "not eating anymore today" closes the
  // day, "not eating junk today" is a food choice and must not.
  // THE CESSATION MUST APPLY TO EATING ITSELF (2026-08-24). "I'm done eating badly" and "I'm done
  // eating junk" are about the MANNER and the OBJECT of eating — the client is still eating. The
  // bare `done eating` clause this replaces read both as a closed food day. So the verb must be
  // followed by the end of the clause or by a marker that scopes it in TIME; an adverb or a food
  // noun after it means they described how they eat, not that they have stopped.
  if (!/\b(?:can'?t|cannot|couldn'?t|struggle(?:s|d)? to|unable to)\s+(?:stop|quit)\s+eating\b/i.test(t)
      // "ANYTHING ELSE" IS A QUANTITY, NOT AN OBJECT (2026-08-25, found while building the P0-4b
      // acceptance fixture). "I'm not eating anything else today" is the plainest possible closure
      // and it fell through, because the marker after the verb was a noun phrase rather than a
      // time word. It is admitted only in the `else`/`more` forms — those mean NOTHING FURTHER.
      // A bare `anything` stays out, so "not eating anything fried today" is still a food choice.
      && /\b(?:not|no longer|done|finished|stop|stopping|quit|quitting)\s+(?:going\s+to\s+|gonna\s+)?eat(?:ing)?(?=\s*(?:$|[.!?,;])|\s+(?:anymore|any\s+more|again|today|tonight|(?:any|no)\s*thing\s+(?:else|more)|for\s+(?:the\s+)?(?:rest\s+of\s+the\s+)?(?:day|today|night|evening)|for\s+now|until\s+tomorrow)\b)/i.test(t)) return true;
  if (/\b(?:just|only)\s+(?:going to |gonna )?(?:have )?(?:alcohol|drinks|zero[- ]calorie)/i.test(t)) return true;
  if (/\b(?:alcohol|zero[- ]calorie drinks).{0,60}(?:today|tonight|the rest of the day)\b/i.test(t)) return true;
  return false;
}

export function chooseAction(s: DayState): OneAction {
  const struggle = readStruggle(s.biggestStruggle);
  const isBulk = s.goal === "muscle_gain";

  // 1. NOTHING ELSE MATTERS IF THEY ARE GONE. A protein tip to someone who vanished four days
  //    ago is a coach talking to an empty room.
  //    Unless they are on the other end of the line as this is written — see atKeyboard.
  if (s.daysSinceAnyLog >= 3 && !s.atKeyboard) {
    // SILENCE ESCALATES (2026-07-29). Three days away and six weeks away used to get the same
    // sentence. They are not the same person: someone gone three days needs a nudge, someone
    // gone six weeks has usually decided they failed and is embarrassed to come back. The longer
    // they have been gone, the smaller the ask and the more explicit the absolution.
    const weeks = Math.floor(s.daysSinceAnyLog / 7);
    // WE KNOW WHY THEY'RE GONE (2026-08-19, Cut 7). A durable fact, stated back plainly and once.
    // "No judgement" from a coach who does not know about the newborn is a form letter; naming it
    // is the whole difference. Kept to a clause — this is acknowledgement, not a conversation
    // about their life, and it never changes what we ask for.
    const because = lifeClause(s.lifeContext);
    if (weeks >= 4) {
      return {
        kind: "come_back",
        todo: "Just say hi. That's the whole ask today.",
        why: why(`It's been about ${weeks === 4 ? "a month" : `${weeks} weeks`}${because ? `, and ${because} that makes complete sense` : ""} — you haven't blown anything — that's the story people tell themselves and it stops them coming back. Your numbers are exactly where you left them.`, s.dreamGoal),
      };
    }
    if (weeks >= 1) {
      return {
        kind: "come_back",
        todo: struggle === "time" ? "Tell me one thing you ate this week." : "Log one meal today. Any meal.",
        why: why(`No catching up, no starting over${because ? `, especially ${because}` : ""}. One meal puts you straight back in.`, s.dreamGoal),
      };
    }
    return {
      kind: "come_back",
      todo: struggle === "time"
        ? "Log one thing today — even just what you had for lunch"
        : "Log one meal today. Any meal.",
      why: why(`Nothing resets and nothing is lost${because ? ` — ${because}, a few quiet days is nothing` : " — you pick up exactly where you left off"}.`, s.dreamGoal),
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
  const scaleIsOffLimits = mentionsForbidden("weight scale weigh", s.doNotMention);
  if (!scaleIsOffLimits && ((neverWeighed && s.weeksOnProgramme >= 1) || (s.daysSinceWeighIn !== null && s.daysSinceWeighIn >= 10))) {
    return askToWeigh(s.dreamGoal, neverWeighed);
  }

  // 4. UNDER-FUELLED ON A BULK. Nothing else works if they aren't eating.
  // Closed food day wins: they told us the next meal is not happening.
  if (isBulk && s.loggedToday && s.caloriePct < 0.6 && s.hour >= LATE && !s.foodDayClosed) {
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
  if (s.loggedToday && s.proteinPct < 0.6 && !s.foodDayClosed) {
    // AFTER 20:00 THE INSTRUCTION FACES TOMORROW (absorbed 2026-08-21 from the deleted second
    // constitution, theNextMove, which had this rule and this reason: "a to-do at 21:00 proves
    // the coach is not reading the clock the client is living in"). Collapsing two ladders into
    // one must not lose what the deleted one knew — "make your next meal a protein one" sent at
    // nine at night is an instruction nobody can act on.
    const closingTheDay = s.hour >= 20;
    return {
      kind: "protein",
      todo: closingTheDay
        ? "Start tomorrow with protein — eggs, amasi or tin fish at breakfast."
        : struggle === "time"
        ? "Make your next meal a protein one — tin fish, eggs or amasi. Two minutes."
        : struggle === "money"
        ? "Get protein into your next meal — eggs, pilchards or sugar beans."
        : "Make your next meal a proper protein meal.",
      why: why(
        isBulk ? "Protein is the part your body actually builds with."
          // The cut reason names the scale, which is the one thing this client asked us to drop.
          // A different true sentence, not a filtered one — the mouth gate only guards the
          // reactive path, and this line goes out in a proactive brief that never passes it.
          : scaleIsOffLimits ? "Protein is what protects your muscle while everything else changes."
          : "Protein is what keeps the weight you lose off your muscle instead of your strength.",
        s.dreamGoal,
      ),
    };
  }

  // 6. NOTHING LOGGED AND THE DAY IS NEARLY OVER.
  if (!s.loggedToday && s.hour >= LATE) return askToLog(s.dreamGoal);

  // 7. STEPS. The easiest win there is, and the one most people can actually do on a bad day.
  if (s.stepsTarget > 0 && s.stepsToday < s.stepsTarget * 0.5 && s.hour >= 12) {
    return {
      kind: "walk",
      todo: struggle === "time" ? "Get a 15-minute walk in today — that's all." : "Get a 20-minute walk in today.",
      why: why("It's the cheapest thing you can do that still counts.", s.dreamGoal),
    };
  }

  // 8. TRAINING, behind for the week — unless they already ruled today out.
  if (s.sessionsTarget > 0 && s.sessionsThisWeek < s.sessionsTarget && !s.trainingDeclined) {
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
  return holdAction(s.dreamGoal);
}

// ── THE PROACTIVE DECISION OWNER ─────────────────────────────────────────────────────────────
//
// (2026-08-18, Issue #49 step 4.) chooseAction was already the ordered decision — silence first,
// rest is a real action, hold when nothing needs changing. It was reached from a command almost
// nobody types, and from ONE line inside a 474-line morning job that made all its other decisions
// itself. That job was the second coach.
//
// This makes the decision reachable from the canonical proactive snapshot, and pairs it with the
// verdict vocabulary the REACTIVE path already uses — selectDecisionState in
// understanding/state.ts, CONTINUE / CHANGE / INVESTIGATE / REFER against evidence sufficiency.
// One vocabulary for both paths, so "the coach decided to investigate" means the same thing
// whether the client spoke first or we did. Deliberately NOT a second set of verdicts.
//
// Pure: the projection and the decision. Nothing here reads a database or calls a model.

/** The fields of the canonical ProactiveState this decision needs. Named structurally rather than
 *  imported, for the same reason adaptiveInputFrom is: scheduler/shared.ts pulls in the database
 *  and Twilio, and this module must stay callable from a test with neither. */
export interface ProactiveStateForDecision {
  name: string;
  goalType: string;
  health: { sick: boolean };
  food: { loggedDays7d: number | null; daysSinceAnyLog: number | null };
  workout: { sessionsLast7d: number; sessionsThisWeek?: number };
  steps: { avg7d: number | null };
  weight: { daysSinceWeighIn: number | null; trendUsable: boolean };
  today: { kcal: number; protein: number; steps: number; logged: boolean; hour: number };
  evidence: { foodSufficient: boolean; weightSufficient: boolean };
}

export interface ProactiveProfile {
  dreamGoal?: string | null;
  biggestStruggle?: string | null;
  /** users.do_not_mention — carried so the decision never chooses an ask they asked us to drop. */
  doNotMention?: string | null;
  /** users.life_context — a durable fact (Cut 7), carried so the come_back rungs can name it. */
  lifeContext?: string | null;
  weeksOnProgramme: number;
  sessionsTarget: number;
  calorieTarget: number;
  proteinTarget: number;
  stepsTarget: number;
}

/**
 * ProactiveState → DayState. The one projection.
 *
 * `daysSinceAnyLog: null` means NEVER LOGGED, and it becomes 99 — a long silence, which routes to
 * "come back" rather than to a protein tip about a day that does not exist. That mapping was
 * already in buildDayState; it is stated here so both callers cannot disagree about it.
 */
export function dayStateFrom(
  s: ProactiveStateForDecision, p: ProactiveProfile,
  opts?: { atKeyboard?: boolean; hour?: number; foodDayClosed?: boolean; trainingDeclined?: boolean },
): DayState {
  return {
    firstName: s.name,
    goal: (s.goalType as GoalKey) || ("general" as GoalKey),
    dreamGoal: p.dreamGoal,
    biggestStruggle: p.biggestStruggle,
    weeksOnProgramme: p.weeksOnProgramme,
    daysSinceAnyLog: s.food.daysSinceAnyLog ?? 99,
    daysSinceWeighIn: s.weight.daysSinceWeighIn,
    loggedToday: s.today.logged,
    // A target of zero means "not set", and dividing by it would make every client look starved.
    // 1 = "at target", i.e. nothing to say — the same fail-safe buildDayState used.
    proteinPct: p.proteinTarget > 0 ? s.today.protein / p.proteinTarget : 1,
    caloriePct: p.calorieTarget > 0 ? s.today.kcal / p.calorieTarget : 1,
    sessionsThisWeek: s.workout.sessionsThisWeek ?? s.workout.sessionsLast7d,
    sessionsTarget: p.sessionsTarget,
    stepsToday: s.today.steps,
    stepsTarget: p.stepsTarget,
    sick: s.health.sick,
    lifeContext: p.lifeContext,
    doNotMention: p.doNotMention,
    hour: opts?.hour ?? s.today.hour,
    atKeyboard: opts?.atKeyboard,
    foodDayClosed: opts?.foodDayClosed,
    trainingDeclined: opts?.trainingDeclined,
  };
}

export interface ProactiveDecision {
  /**
   * Same vocabulary as the reactive path.
   *
   * NOT YET ENFORCED, and saying so here rather than letting it be discovered: `state` and
   * `action` can currently disagree. A real problem with insufficient evidence and no useful
   * question to ask returns CONTINUE while `line` still carries an instruction — so the coach
   * says "carry on" internally and tells the client to change something. Today the verdict is
   * recorded and logged; it does not yet gate what goes out. Making CONTINUE and INVESTIGATE
   * binding on the outbound message is the next step, and it is a behaviour change that needs
   * its own measurement — not something to slip in under a refactor.
   */
  state: "CONTINUE" | "CHANGE" | "INVESTIGATE" | "REFER";
  evidence: "sufficient" | "insufficient";
  action: OneAction;
  /** Rendered instruction + reason, ready to place in a message. "" when the verdict is CONTINUE
   *  and the action is `hold` — nothing to add is a legitimate outcome, not a gap to fill. */
  line: string;
}

/**
 * WHICH ACTIONS ARE A CHANGE, and which are only a question.
 *
 * `hold` is CONTINUE by definition. `come_back`, `log` and `weigh` do not change the plan — they
 * ask for the measurement that would let us decide, which is precisely INVESTIGATE. Everything
 * else alters what the client does today, and may only be said on sufficient evidence.
 */
const INVESTIGATIVE: ReadonlySet<ActionKind> = new Set<ActionKind>(["come_back", "log", "weigh"]);
const PRESCRIPTIVE: ReadonlySet<ActionKind> = new Set<ActionKind>(["protein", "walk", "train", "eat_more", "rest"]);

/**
 * THE POLICY BOUNDARY, EXPORTED (2026-08-21).
 *
 * `chooseAction` is the one decision function, but a single function name does not make a single
 * decision CONTRACT. Two callers reached it without the evidence gate — morning's degraded
 * fallback and the reactive weekly answer — so the same function was being fed different policy
 * depending on who called it. That is two policies wearing one name.
 *
 * The contract is one line: A PRESCRIPTION REQUIRES EVIDENCE. Where a caller cannot run the full
 * gate (no ProactiveState to build), it applies this instead, and gets the same answer the gate
 * would have given: an unevidenced prescription is downgraded to the measurement that would
 * justify one, or held.
 */
/**
 * THE ONE ACTION LINE (2026-08-21). The behavioural instruction, rendered from the canonical
 * decision, in the coach's voice — and the ONLY place a decision turn's instruction is composed.
 *
 * It is a separate line, not a sentence folded into prose, for a reason that is architectural
 * rather than cosmetic: a decision turn must carry EXACTLY ONE instruction, and one line that
 * code owns is countable. Prose the model wrote is not.
 *
 * No new vocabulary — `todo` is what chooseAction already produces, in the voice it already has.
 * This only decides that it stands alone.
 */
export function renderActionLine(todo: string): string {
  const t = String(todo || "").trim();
  return t ? `*${t.replace(/\s*[.!]\s*$/, "")}*` : "";
}

/**
 * THE DECISION-TURN MOUTH (2026-08-23). Context from structured situation, action from
 * chooseAction. The model body is not an input — that is the whole point. Concatenating GPT
 * prose in front of the action line is the architecture the reviewer disproved ("Eggs tonight."
 * sitting above PROTEIN).
 */
export function composeDecisionTurn(situationFrame: string, actionLine: string): string {
  const ctx = String(situationFrame || "").trim();
  const action = String(actionLine || "").trim();
  if (!action) return ctx;
  if (!ctx) return action;
  return `${ctx}\n\n${action}`;
}

export function underPolicy(action: OneAction, opts: { evidenced: boolean; dreamGoal?: string | null }): OneAction {
  if (!PRESCRIPTIVE.has(action.kind) || opts.evidenced) return action;
  return holdAction(opts.dreamGoal);
}

/**
 * ILLNESS IS ITS OWN EVIDENCE (2026-08-18, verdict enforcement pass).
 *
 * Measured on the traced client set: a durably sick client came back CONTINUE / insufficient /
 * "Rest today" — a prescription under a verdict that says carry on. The message was RIGHT; the
 * evidence model was wrong. Sufficiency was computed only from the food and weight ledgers, and a
 * sick client has neither, so illness — which is directly observed durable state, not an inference
 * from thin data — read as "we cannot tell". Rest is the best-founded instruction the coach ever
 * gives. It is sufficient by construction.
 *
 * Silence is the same kind of fact: `come_back` follows from an observed absence, not a guess.
 */
function evidenceFor(s: ProactiveStateForDecision, kind: ActionKind): DecisionEvidence {
  if (kind === "rest") return "sufficient";
  if (INVESTIGATIVE.has(kind)) return "insufficient";
  return s.evidence.foodSufficient || s.evidence.weightSufficient ? "sufficient" : "insufficient";
}

export function decideProactive(
  s: ProactiveStateForDecision, p: ProactiveProfile,
  opts?: { atKeyboard?: boolean; hour?: number; foodDayClosed?: boolean; trainingDeclined?: boolean },
): ProactiveDecision {
  let action = chooseAction(dayStateFrom(s, p, opts));
  let evidence = evidenceFor(s, action.kind);

  // ── THE VERDICT IS BINDING ─────────────────────────────────────────────────────────────────
  // Until now it was advisory: recorded, logged, and ignored by the message. Measured on the
  // traced client set, one client in six got a plan change under a verdict that did not support
  // one — the sparse-log client, whose protein "looks" low across two logged days in seven. Two
  // days is not evidence; acting on it is how the product invented the over-target accusation in
  // the first place, one layer up.
  //
  // A prescription under insufficient evidence is DOWNGRADED to the measurement that would make
  // the evidence sufficient — which is exactly what INVESTIGATE means: the minimum useful
  // question, and no intervention dressed up as settled. The client still hears something useful,
  // and it is something we can stand behind.
  //
  // ASK FOR WHAT IS ACTUALLY MISSING. The first version of this downgrade sent "Tell me what you
  // ate today" to a client who HAD logged today — their seven-day record was thin, not their
  // morning — which is handing the work back for something they had just done, the exact failure
  // Law 22 exists to prevent. Caught by re-running the trace on the sparse-log client, whose
  // fixture logs today.
  if (PRESCRIPTIVE.has(action.kind) && evidence === "insufficient") {
    const canAskForFood = !s.evidence.foodSufficient && !s.today.logged;
    // Weighing again the day after they weighed tells us nothing a trend needs. Never weighed, or
    // three days stale, is a real gap worth one ask.
    const staleWeight = s.weight.daysSinceWeighIn === null || s.weight.daysSinceWeighIn >= 3;
    // …and not if they asked us to leave the scale alone. The downgrade exists to ask for the
    // measurement that would justify a prescription; when that measurement is off limits, the
    // honest outcome is the same one it already reaches when there is nothing useful to ask.
    const canAskForWeight = !s.evidence.weightSufficient && staleWeight
      && !mentionsForbidden("weight scale weigh", p.doNotMention);
    action = canAskForFood ? askToLog(p.dreamGoal)
      : canAskForWeight ? askToWeigh(p.dreamGoal, s.weight.daysSinceWeighIn === null)
      // Nothing useful to ask and nothing we can justify prescribing. Silence is the honest
      // outcome, and it is a legitimate one — least intervention, not a gap to fill.
      : holdAction(p.dreamGoal);
    evidence = evidenceFor(s, action.kind);
  }

  const investigating = INVESTIGATIVE.has(action.kind);
  const state = selectDecisionState({
    meaningfulProblem: action.kind !== "hold",
    evidence,
    hasMinimumUsefulQuestion: investigating,
  });

  // The invariant this pass exists to establish. Cheap, and it fails loudly in a scheduled job's
  // log rather than quietly in a client's WhatsApp.
  if (PRESCRIPTIVE.has(action.kind) && state !== "CHANGE" && state !== "REFER") {
    console.error(`[DECISION] INVARIANT BROKEN: ${state} carrying prescription "${action.kind}"`);
  }

  return {
    state, evidence, action,
    line: action.kind === "hold" ? "" : `*${action.todo}*\n\n_${action.why}_`,
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
