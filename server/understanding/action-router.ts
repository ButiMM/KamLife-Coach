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

// Actions / commands / data / transactions / health-safety / billing — the deterministic
// keepers. NOT the advisory templates (plate method, myth-busters, meal timing) — those are
// conversation and belong to Coach K.
const DETERMINISTIC_ACTION = new RegExp([
  // ── data corrections & log management (2026-07-16: engine PROMISED a deletion it
  //    cannot perform — these must reach the deterministic food-log-mgmt commands) ──
  "\\b(remove|delete|undo|scrap|erase)\\b.{0,30}\\b(meal|food|log|breakfast|lunch|dinner|supper|snack|entry|that|last)\\b",
  "double.?logg?ed", "logged (it |that )?(twice|again|double)", "\\bduplicate\\b", "\\breset today\\b",
  "\\bmy meals\\b", "what (did|have) i (eat|eaten|logg?ed)", "show me today'?s? (food|meals?)", "\\b(meal|food) log\\b",
  // ── logging & reports (numbers that must be recorded exactly) ──
  "\\b\\d{3,5}\\s*steps?\\b", "\\bsteps?\\b.*\\b\\d{3,5}\\b", "\\b\\d+(?:\\.\\d+)?\\s*(?:kg|kgs|kilos?)\\b",
  "\\b\\d+(?:\\.\\d+)?\\s*(?:l|litres?|liters?|ml|glasses?|cups?)\\b.*water|water.*\\b\\d",
  "\\blog\\b", "\\btrack\\b", "\\brecord\\b", "\\bweigh(?:ed|t)?\\s*in\\b",
  // ── data displays / lookups (need the real DB, which Coach K can't read) ──
  "\\bstats?\\b", "\\bmy progress\\b", "how am i doing", "\\bprogress\\b",
  "weight\\s*(?:chart|graph|trend|history|journey)", "\\bmy workouts?\\b", "workout\\s*(?:history|diary)",
  "\\bachievements?\\b", "\\bbadges?\\b", "\\bcalendar\\b", "\\bconsistency\\b", "\\bstreak\\b",
  "\\bmonthly report\\b", "\\bmy numbers\\b",
  // ── explicit commands ──
  "\\bmenu\\b", "shopping\\s*list", "\\bgroceries\\b", "\\bgrocery\\b", "\\bportions?\\b",
  "\\bfact\\b", "daily tip", "did you know", "\\breferral\\b", "\\bchallenge\\b",
  "\\btoday'?s? (?:workout|session)\\b", "\\bmy workout\\b", "\\bfull (?:plan|programme|program)\\b",
  "\\bdemo\\b", "how to do", "\\bshow me\\b.*(?:exercise|move)",
  // ── transactions (mood score, fasting timer, NPS) ──
  "\\b(?:mood|stress|feeling)\\s*\\d\\b", "\\b(?:mood|stress)\\s*\\d\\s*(?:/|out of)\\s*(?:5|10)",
  "start(?:ed|ing)?\\s*(?:my\\s*)?fast", "broke\\s*(?:my\\s*)?fast", "end(?:ed|ing)?\\s*(?:my\\s*)?fast",
  // ── health / safety (must stay on the deterministic safety rails) ──
  "\\bsupplements?\\b", "\\bcreatine\\b", "protein powder", "\\bwhey\\b", "\\bbcaa\\b",
  "\\binjur(?:y|ed|ies)\\b", "\\bsharp pain\\b", "\\bstabbing\\b", "\\bpulled (?:a )?muscle\\b",
  "\\bperiod\\b", "\\bmenstru", "\\bpms\\b", "\\bcycle\\b",
  // ── billing / account ──
  "\\bpay\\b", "\\bcancel\\b", "\\bsubscri", "\\bunsubscribe\\b", "\\bpause\\b", "\\bresume\\b",
  "\\breactivate\\b", "\\brefund\\b", "\\bupgrade\\b", "\\bprice\\b", "\\bbilling\\b",
].join("|"), "i");

/**
 * True → this message is an ACTION/command/data/transaction/safety/billing and must stay on
 * the deterministic pipeline (Coach K does not get it). False → it's conversation; Coach K
 * owns it. Biased toward "true" (keep deterministic) so a log is never lost to the engine.
 */
export function mustStayDeterministic(message: string): boolean {
  return DETERMINISTIC_ACTION.test(message || "");
}
