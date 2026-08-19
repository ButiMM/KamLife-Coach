/**
 * THE INVERSION — "what must stay deterministic?" (the load-bearing rule).
 *
 * The rebuild's golden rule: Coach K (the Meaning Engine) understands EVERY message first.
 * The only things that must NOT go to Coach K are ACTIONS — where being exact matters more
 * than being warm: logging, data lookups, transactions, payments, and safety. Those stay on
 * deterministic rails. Everything else — questions, feelings, advice, myths, "what do I eat
 * while I'm sick", any language — is conversation, and conversation is Coach K's.
 *
 * This is the inverse of gating templates one by one: instead of listing the 50 advisory
 * templates to DISABLE, we list the FEW action-shapes that must stay deterministic, and
 * route everything else to the engine. Get this list right and the whack-a-mole ends.
 *
 * SAFETY BIAS: a false "stays deterministic" only means the old handler answers (what
 * happens today). A false "goes to engine" could drop a food/step log — unforgivable. So
 * when a message looks even partly like an action/log/command, we keep it deterministic.
 * The deterministic handlers themselves still decide whether they actually claim it; this
 * only decides whether Coach K gets FIRST crack or the deterministic pipeline does.
 */

import { looksLikeComebackQuestion, isReturnFromSicknessQuestion } from "../utils";
import { isDespairNotAQuestion } from "../despair";

// Actions / commands / data / transactions / health-safety / billing — the deterministic
// keepers. NOT the advisory templates (plate method, myth-busters, meal timing) — those are
// conversation and belong to Coach K.
const DETERMINISTIC_ACTION = new RegExp([
  // ── data corrections & log management (2026-07-16: engine PROMISED a deletion it
  //    cannot perform — these must reach the deterministic food-log-mgmt commands) ──
  "\\b(remove|delete|undo|scrap|erase)\\b.{0,30}\\b(meal|food|log|breakfast|lunch|dinner|supper|snack|entry|that|last)\\b",
  "double.?logg?ed", "logged (it |that )?(twice|again|double)", "\\bduplicate\\b", "\\breset today\\b",
  "\\bmy meals\\b", "what (did|have) i (eat|eaten|logg?ed)", "show me today'?s? (food|meals?)", "\\b(meal|food) log\\b",
  // ── data displays / lookups (need the real DB, which Coach K can't read) ──
  "\\bstats?\\b", "\\bmy progress\\b", "how am i doing", "\\bprogress\\b",
  // weight forecast / trajectory — deterministic energy math, never the LLM (Law 4)
  "\\bforecast\\b", "\\btrajector\\w*\\b", "\\bprojection\\b", "on track (for|to)",
  "will i (lose|gain|drop|pick up)", "how much (weight )?(will|am|would) i",
  "weight\\s*(?:chart|graph|trend|history|journey)", "\\bmy workouts?\\b", "workout\\s*(?:history|diary)",
  "\\bachievements?\\b", "\\bbadges?\\b", "\\bcalendar\\b", "\\bconsistency\\b", "\\bstreak\\b",
  "\\bmonthly report\\b", "\\bmy numbers\\b",
  // ── explicit commands ──
  "\\bmenu\\b", "shopping\\s*list", "\\bgroceries\\b", "\\bgrocery\\b", "\\bportions?\\b",
  "\\bfact\\b", "daily tip", "did you know", "\\breferral\\b", "\\bchallenge\\b",
  "\\btoday'?s? (?:workout|session)\\b", "\\bmy workout\\b", "\\bfull (?:plan|programme|program)\\b",
  "\\bdemo\\b", "how to do", "\\bshow me\\b.*(?:exercise|move)",
  // exercise demos by NAME (2026-07-16 live: 'show me a shoulder press' bounced twice) —
  // the deterministic EXERCISE_DEMO owns these, with GIFs and form cues
  "\\b(?:show|see|watch|demonstrate)\\b.{0,24}\\b(?:press|squat|deadlift|curl|row|raise|lunge|plank|push.?up|pull.?up|extension|fly|kick.?back|pulldown|thrust|dip|crunch|rdl)\\b",
  // ── transactions (mood score, fasting timer, NPS) ──
  "\\b(?:mood|stress|feeling)\\s*\\d\\b", "\\b(?:mood|stress)\\s*\\d\\s*(?:/|out of)\\s*(?:5|10)",
  "start(?:ed|ing)?\\s*(?:my\\s*)?fast", "broke\\s*(?:my\\s*)?fast", "end(?:ed|ing)?\\s*(?:my\\s*)?fast",
  // ── health / safety (must stay on the deterministic safety rails) ──
  "\\bsupplements?\\b", "\\bcreatine\\b", "protein powder", "\\bwhey\\b", "\\bbcaa\\b",
  "\\binjur(?:y|ed|ies)\\b", "\\bsharp pain\\b", "\\bstabbing\\b", "\\bpulled (?:a )?muscle\\b",
  "\\bperiod\\b", "\\bmenstru", "\\bpms\\b", "\\bcycle\\b",
  // ── retroactive training reports (2026-08-04 live, by voice: "Yesterday I did have a
  //    session. I did the session for yesterday. Can you just mark it." The engine took it
  //    and answered with a step count. workout.ts has owned backdated sessions since
  //    2026-07 and was never called — a client told the coach he trained and was ignored,
  //    which is the single thing this product cannot do.) ──
  "\\b(?:yesterday|last night)\\b.{0,40}\\b(?:session|workout|train(?:ed|ing)?|gym)\\b",
  "\\b(?:session|workout|train(?:ed|ing)?|gym)\\b.{0,40}\\b(?:yesterday|last night)\\b",
  // ── delivery preferences (2026-08-04 live: "talk to me" reached the engine, which has no
  //    action for it, so it re-sent its previous reply verbatim and the toggle never fired.
  //    These are SETTINGS — they change how the coach speaks, and only the deterministic
  //    handlers can write the preference. Anchored where the phrase could otherwise appear
  //    inside real feeling ("I just need someone to talk to me"). ──
  "^\\s*(?:please\\s+)?talk to me\\b", "^\\s*(?:text only|no voice)\\b", "\\bvoice ?notes?\\b",
  "show me the (?:numbers|calories|macros)", "\\bkeep it simple\\b",
  // ── billing / account ──
  "\\bpay\\b", "\\bcancel\\b", "\\bsubscri", "\\bunsubscribe\\b", "\\bpause\\b", "\\bresume\\b",
  "\\breactivate\\b", "\\brefund\\b", "\\bupgrade\\b", "\\bprice\\b", "\\bbilling\\b",
].join("|"), "i");

// A REPORTED NUMBER — a log, and only a log. Split out of the list above on 2026-07-31
// after this went live: Kam asked, by voice, "I used to do 10,000, now you've pulled it to
// 6,000 — what's the rationale, how does it help my goal?" The old list matched
// `steps.*\d{3,5}`, declared it deterministic, and the engine never saw it. A template
// answered instead: "let me put it simply" followed by nothing simple, then "stand on a
// scale". He asked WHY his target moved and was told to weigh himself.
// A number a client REPORTS is a log. The same number inside a QUESTION is conversation,
// and conversation is the coach's. The deterministic logger keeps its own question guard,
// so a genuine log is still never lost.
const REPORTED_NUMBER = new RegExp([
  "\\b\\d{3,5}\\s*steps?\\b", "\\bsteps?\\b.*\\b\\d{3,5}\\b", "\\b\\d+(?:\\.\\d+)?\\s*(?:kg|kgs|kilos?)\\b",
  "\\b\\d+(?:\\.\\d+)?\\s*(?:l|litres?|liters?|ml|glasses?|cups?)\\b.*water|water.*\\b\\d",
  "\\blog\\b", "\\btrack\\b", "\\brecord\\b", "\\bweigh(?:ed|t)?\\s*in\\b",
].join("|"), "i");

/**
 * True → this message is an ACTION/command/data/transaction/safety/billing and must stay on
 * the deterministic pipeline (Coach K does not get it). False → it's conversation; Coach K
 * owns it. Biased toward "true" (keep deterministic) so a log is never lost to the engine.
 */
export function mustStayDeterministic(message: string, isQuestion?: boolean): boolean {
  const s = message || "";
  // A reported number is a log; the same number inside a question is conversation. `?` is the
  // fallback signal — routes.ts passes the classifier's verdict, which is what catches a voice
  // transcript that carries no punctuation at all.
  const asking = isQuestion === true || /\?/.test(s);
  // A RETRO FOOD REQUEST BELONGS TO THE ENGINE (2026-08-04 live, by voice: "I want to log my
  // meals for yesterday, not today"). The bare word "log" below made it deterministic, so
  // food-log-mgmt answered — by printing TODAY's log back at him. He asked about yesterday and
  // was shown this morning's photo. The engine owns LOG_MEAL, which already carries a retro
  // field; it was simply never reached. Workouts are excluded: workout.ts owns backdated
  // sessions and has since July, and that path works.
  if (/\b(yesterday|last night|day before)\b/i.test(s)
      && /\b(meal|meals|food|ate|eaten|eating|breakfast|lunch|dinner|supper)\b/i.test(s)
      && !/\b(session|workout|train(?:ed|ing)?|gym)\b/i.test(s)) return false;
  // THE COACH IS IN THE ROOM FOR LOGS NOW (2026-08-04, founder: "I want it to coach").
  // This line used to send every reported number — food, steps, weight, water — straight past
  // the engine to a handler, so the brain holding his voice and their week only ever spoke when
  // someone asked a QUESTION. The moment a client did the thing this product exists for, the
  // coach was routed around and machinery answered with a receipt. That is why it read as a
  // calculator, and it was the last systemic defect.
  //
  // It was defensible when it was written: a model that logs can invent numbers. It is not
  // defensible now. Tools are silent by type (Guard #8) and actionNumberIsClientReported
  // refuses any figure the client did not say — that brake caught "6,000 steps" this morning.
  // The reason for the exclusion was dismantled; the exclusion is now dismantled too.
  void asking;
  // A COMEBACK question has one correct answer — a fixed physiological ramp — so the engine must
  // never take it (2026-07-28 live: it answered "would you like to focus on strength training, or
  // incorporate some running?" to a client who said "tell me how we are going to approach this").
  //
  // TWO DETECTORS FOR ONE IDEA (2026-07-29 live). This checked only looksLikeComebackQuestion,
  // which needs a "back" marker ("first day back", "coming back"). The sick handler used a
  // different, wider one. So "Is this because of my 3 weeks of illness? How do I go about this?"
  // passed both — no back marker for one, no recognised phrasing for the other — and the engine
  // answered a 20-year lifter's comeback with four numbered bullets ending "stay hydrated".
  // Both are asked now, so the narrower can no longer let something through the wider would keep.
  if (looksLikeComebackQuestion(s) || isReturnFromSicknessQuestion(s)) return true;
  // DESPAIR IS DELIBERATELY *NOT* HERE. A first draft added "this isn't working" and "I'm not
  // losing weight", reasoning that both have a right answer already written in the deterministic
  // handlers. The suite rejected it: "i feel like giving up" is asserted to belong to Coach K,
  // whose understand-first Constitution won that exact moment 2.3→9.0 in scoring. Those rewrites
  // are the ENGINE_LIVE=off fallback, which is the revert path, not the live one — and quietly
  // reversing a measured decision to make my own change visible would have been the wrong trade.
  //
  // STATED MEAL REPORT → deterministic food path (2026-08-19 live failure, 3×):
  // ENGINE_LIVE sent "I had a McDonald's South African breakfast with a mocha" to freeform
  // Coach K because "coach is in the room for logs" removed the old log→deterministic rule.
  // The engine did not call LOG_MEAL; it invented "I don't have a meal logged / what did you
  // eat / 1525 kcal". A meal REPORT is a write. Until branded/voice LOG_MEAL is proven under
  // the engine, food-context owns these turns. Questions (? or classifier) still stay with
  // the engine. Retro "yesterday's meals" above already returns false so the engine keeps them.
  if (!/\?/.test(s)
      && /\b(?:i\s+)?(?:ate|eaten|had|having|just\s+had|just\s+ate)\b/i.test(s)
      && /\b(?:breakfast|lunch|dinner|supper|brunch|snack|meal|mcdonald|kfc|nando|spur|steers|wimpy|takeaways?|take\s*away|mocha|pap|chicken|eggs?|food|burger|pizza)\b/i.test(s)
      && !/\b(?:what\s+(?:should|can|do)\s+i\s+eat|ideas?\s+for\s+(?:dinner|lunch)|meal\s+plan)\b/i.test(s)) {
    return true;
  }
  return DETERMINISTIC_ACTION.test(s);
}
