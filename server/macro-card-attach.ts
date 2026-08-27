/**
 * MACRO CARD ATTACH — turns a client's day-so-far into the [MEDIA:…] marker that puts the
 * branded card image on their meal-log reply.
 *
 * Goal-aware by construction: only macro-goal clients get a card (wellness clients keep their
 * plain, no-numbers reply — see goal-profiles). Fail-open: any missing config (no APP_URL),
 * missing targets, or error returns "" so the text reply still sends — a card is a bonus, never
 * a blocker. Carb/fat daily targets are derived from the calorie budget (standard split) since
 * the product sets calorie + protein targets only.
 */

import { mealLogs, weightLogs } from "../shared/schema";
import { eq, and, gte, lt, sql, asc } from "drizzle-orm";
import { isPastSastDay } from "./sast";

import { getGoalProfile } from "./goal-profiles";
import { renderWelcomeCard } from "./macro-card";
import { achievementFor, shareAchievement, renderAchievementCard, type AchievementCardData } from "./achievement-card";
import { putCard } from "./card-store";
import { waterTargetLitres } from "./targets";
import { getNumbersMode, stripNumbersFromProse } from "./numbers-mode";
import { cardWillAttach, cardSuppressedByDump, noteCardSent } from "./card-policy";
import { sastHour } from "./sast";

// Shared: the public base URL (forced to https:// — see below) or "" when a card can't be
// served. APP_URL was stored WITHOUT a scheme, so the first live marker leaked as a text link
// instead of an image; forcing https:// makes it a valid media URL Twilio fetches.
export function cardBaseUrl(): string {
  let base = (process.env.APP_URL || "").trim().replace(/\/$/, "");
  if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;
  return base;
}

type Row = { label: string; current: number; target: number; unit: string; overIsBad?: boolean; decimals?: number };

/** First name for card copy — "" when we don't have one, so the copy falls back to "You". */
function firstNameOf(user: any): string {
  return String(user?.name || "").trim().split(/\s+/)[0] || "";
}

// Shared: today's macro rows for a macro-goal client, or null when a card doesn't apply.
// `overIsBad` marks the macros where GOING OVER is a warning (carbs, fat, and calories on a
// cut) so the card reddens them; protein (and calories on a bulk) never red — more is fine.
// includeWater adds today's water as a final row — the DAILY scorecard shows it (founder:
// "add total water to the daily scorecard"), the per-meal card stays the 4 macros.
export async function todayRows(user: any, includeWater = false, forDate?: Date): Promise<{ rows: Row[]; isBulk: boolean } | null> {
  // TWO OWNERS FOR ONE RULE (2026-08-10). This function used to refuse a wellness client
  // outright — "wellness → no card, ever" — while the line that builds the card below already
  // says usesNumbers:false for exactly that client, i.e. give them the SAME card with a verdict
  // where the figure sits. The gate in card-policy.ts was removed days ago and this copy kept
  // the promise broken: the simplicity camp got no calling card at all. Row-building is not a
  // policy decision, so the policy moved to the one call site that needs it (the numeric macro
  // status reply in early-commands) and this function now just computes.
  const profile = getGoalProfile(user?.goalType);
  const calTarget = Number(user?.calorieTarget) || 0;
  const protTarget = Number(user?.proteinTarget) || 0;
  if (!(calTarget > 0) || !(protTarget > 0)) return null;
  const isBulk = profile.energyStance === "surplus";
  // ONE SOURCE OF TRUTH: the card reads the SAME day-ledger as the running total and the diary,
  // so the numbers on the card can never disagree with the text (2026-07-22 rebuild, Box 1).
  const { getDayLedger } = await import("./day-ledger");
  const ledger = await getDayLedger(user.id, { forDate, user });
  const fatTarget = Math.max(1, Math.round((calTarget * 0.27) / 9));
  const carbTarget = Math.max(1, Math.round((calTarget - protTarget * 4 - fatTarget * 9) / 4));
  const rows: Row[] = [
    { label: "Calories", current: ledger.kcal, target: calTarget, unit: "", overIsBad: !isBulk },
    { label: "Protein", current: ledger.protein, target: protTarget, unit: "g", overIsBad: false },
    { label: "Carbs", current: ledger.carbs, target: carbTarget, unit: "g", overIsBad: true },
    { label: "Fat", current: ledger.fat, target: fatTarget, unit: "g", overIsBad: true },
  ];
  if (includeWater && !forDate) { // water is only tracked for TODAY (no historical litres)
    const wTarget = waterTargetLitres(user?.currentWeight);
    rows.push({ label: "Water", current: ledger.water, target: wTarget, unit: "L", overIsBad: false, decimals: 1 });
  }
  return { rows, isBulk };
}

// MEAL SUMMARY for the card title (2026-07-22, founder: "the card must summarise the MEAL —
// tin fish, rice, veggies — not the bot's 'Based on what you mentioned…' preamble"). Pull the
// FOODS out of a food-log reply: the bulleted item lines are the source of truth. Falls back to
// a filler-stripped first line only when there are no bullets. Shared by every log path so the
// title reads the same across the board — text log, photo log, on-demand.
/**
 * THE CLIENT'S OWN WORDS FOR THEIR FOOD (2026-08-04). The reply used to carry a bulleted
 * receipt and this function scraped the title out of it — so killing the receipt would have
 * silently broken the card title AND findDuplicateMealToday, which matches on name overlap
 * and would have started double-logging again. The model now emits a machine-only ITEMS line
 * instead: same data, never shown, and phrased the way the client would say it.
 */
export function mealTitleFromItemsLine(text: string): string {
  const m = (text || "").match(/^\s*ITEMS:\s*(.+)$/im);
  if (!m) return "";
  const names = m[1].split(",").map(x => x.replace(/[*_`#]/g, "").trim()).filter(x => x.length >= 2 && x.length <= 40);
  if (!names.length) return "";
  // A long plate reads "toast, eggs +2", never a truncated "Some…" — a cut-off word is the
  // machine's language leaking back in, which is the same disease in miniature.
  return names.length > 3 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
}

export function mealTitleFromReply(text: string): string {
  const fromItems = mealTitleFromItemsLine(text);
  if (fromItems) return fromItems;
  const names: string[] = [];
  for (const raw of (text || "").split("\n")) {
    const m = raw.match(/^\s*[•·\-\*]\s*(.+)/);           // bulleted item line
    if (!m) continue;
    const name = stripWrapQuotes(m[1].split(/[(:]/)[0].replace(/[*_`#]/g, "").replace(/^\d+\s*x\s*/i, "").trim());
    if (name && name.length >= 2 && name.length <= 40 && !/^\d/.test(name)) names.push(name);
    if (names.length >= 3) break;
  }
  if (names.length) return names.join(", ").slice(0, 46);
  const firstLine = (text || "Meal").replace(/[*_`#]/g, "").split("\n").find(l => l.trim().length > 3) || "Meal";
  // (2026-07-30 live.) This produced the card title "tasty lunch of mince pasta! I'd estimate that"
  // — the coach's own sentence, printed as the name of the client's food. Two bugs, both here:
  // the sentence cut split on ". " so a reply ending in "!" was never trimmed, and the lead-in
  // list had "that's" but not "That looks like".
  //
  // It is worse than ugly. findDuplicateMealToday matches on NAME OVERLAP, so a prose title can
  // never match an earlier log — which is why a photo of a meal he had ALREADY logged was logged
  // a second time. One bad string, two defects.
  const cleaned = firstLine
    .replace(/[.!?]\s.*$/, "").replace(/[.!?]+$/, "")                             // first sentence only
    .replace(/^\s*based on\b.*?\b(?:looks?|seems?)\b\s*(?:like|as though|to be)?\s*/i, "") // "Based on…, it looks like "
    .replace(/^\s*(?:that|this|it|here)?\s*(?:is|'?s)?\s*(?:looks?|seems?)\s+(?:like|to be)\s*/i, "") // "That looks like ", "Looks like "
    .replace(/^\s*(this is|that'?s|it'?s|here'?s|i (?:can )?see|got it)[,:]?\s*/i, "")
    .replace(/^(a|an|the)\s+/i, "")                                               // leading article
    .replace(/^(?:tasty|lovely|nice|good|great|solid|hearty|delicious)\s+/i, "")   // flattery is not a food
    .replace(/^(?:breakfast|lunch|dinner|supper|snack|meal|plate)\s+of\s+/i, "")   // "lunch of mince pasta"
    .replace(/,?\s*(?:about|roughly|around|approx\w*|~)\s*\d.*$/i, "")            // ", about 550 kcal"
    .replace(/\blogged\b.*$/i, "").replace(/[,:—–-]+\s*$/, "").trim().slice(0, 46);
  return stripWrapQuotes(cleaned) || "Meal";
}

// Strip wrapping quote marks (straight or curly) from a food name — the vision model likes
// to echo the caption in scare-quotes ("Skinny hot chocolate"), which read as sarcasm on
// the card (2026-07-22, founder: "come on man"). Inner apostrophes (McDonald's) are kept.
function stripWrapQuotes(s: string): string {
  return (s || "").replace(/^["'“”‘’]+\s*/, "").replace(/\s*["'“”‘’]+$/, "").trim();
}



/**
 * THE NEXT MOVE — one instruction a person can act on without knowing what a calorie is.
 *
 * (2026-07-27, founder: "the card tells the client what your next move is, what you need to do.
 * It's so important for the layman… most people don't care about calories, they just want to
 * lose the belly.") His open question was how to serve both audiences at once. The answer is
 * ordering, not a setting: this line is the biggest thing on the card, the bars sit underneath.
 * Nobody chooses a mode — the person who doesn't count reads one line and stops; the person who
 * does reads on. Same card, both served.
 *
 * Rules: an ACTION (verb first), in food, never a macro name, never a number the reader has to
 * interpret. "Add eggs or tin fish to your next meal" — not "43g protein remaining".
 */
// NO EMOJI IN CARD LINES. The card is rendered to an image by a font that has no emoji glyphs,
// so "Good start 👌" reached the founder as "Good start ☐" (2026-08-04 live, one hour after I
// put them in). Emoji belong in the CHAT text, where WhatsApp renders them; on the card they
// are a tofu box. His register survives without them — the words were always the voice.
export function nextMoveLine(rows: Row[], isBulk: boolean, hour = sastHour(), isPastDay = false, foodDayClosed = false): string {
  const r = (label: string) => rows.find(x => x.label === label);
  if (isPastDay) return "Yesterday's log — today's plate is a separate day";
  const ratio = (x?: Row) => (x && x.target > 0 ? x.current / x.target : 0);
  const cal = r("Calories"), prot = r("Protein"), fat = r("Fat");
  const protLeft = prot ? Math.round(prot.target - prot.current) : 0;
  const calLeft = cal ? Math.round(cal.target - cal.current) : 0;

  // BUILT FOR THE DUMP, NOT THE MOMENT (2026-08-04, founder). His clients do not log lunch at
  // lunch — they send the whole day at 9pm, six photos in ninety seconds. The dump window in
  // card-policy.ts already collapses that into ONE card. What the card SAID was still written
  // for a day that has hours left in it: "walk this afternoon" at 21:00 is useless, and worse,
  // it proves the coach is not reading the clock the client is living in.
  //
  // So after 20:00 the directive stops being a to-do and becomes a close-out that faces
  // tomorrow. Same principle — one instruction, one lever, his voice — chosen from WHEN the
  // report arrived rather than from an ideal real-time flow nobody actually lives.
  // THE CARD MAY NOT SELL FOOD TO A CLIENT WHO SAID THEY ARE DONE (2026-08-26, live phone trace).
  //
  // chooseAction guards its eat_more and protein rungs with `!s.foodDayClosed`. This function is
  // the SAME two rungs, on the card, and it had no such guard — so on one day-state the client
  // read both of these in one turn:
  //
  //     text: "Get today's session done."                    <- closure respected
  //     card: "Get a real protein into your next two meals"  <- still selling food
  //
  // Two owners of "what should they do next", one closure-aware and one blind. The fix is not new
  // prose: a closed day is a finished day, and this function already owns the four close-out lines
  // for that — "That's the day. Tomorrow get a real protein in at breakfast" is exactly the right
  // coaching for a client who has stopped eating short of protein. So closure enters the SAME
  // branch the clock does, and the lines below are unchanged.
  if (foodDayClosed || hour >= 20) {
    return !isBulk && ratio(cal) > 1.05 ? "Day's done. Tomorrow, first meal before you leave the house"
      : protLeft >= 35 ? "That's the day. Tomorrow get a real protein in at breakfast"
      : isBulk && calLeft > 500 ? "Day's wrapped. Tomorrow, eat earlier — that's the whole fix"
      : "That's the day wrapped — same again tomorrow";
  }

  // Calories already in — the card must not argue with "target reached" by selling another meal
  // (live 18:08: Calorie target reached + "Next meal: protein and veg"). That fix was right and
  // it blurred two different truths into one sentence: AT the line and 500 past it both read
  // "Calories are in", which is the same self-contradiction one step along. Neither sells a
  // plate; only one of them claims they are on target.
  if (ratio(cal) >= 1) {
    return ratio(cal) > 1.05
      ? "Past the line today — water from here, and we go again tomorrow"
      : "Calories are in — water from here, not another plate";
  }
  if (ratio(fat) > 1.25) return hour < 11 ? "Keep lunch simple — protein and veg" : "Next meal: protein and veg, keep it simple";

  // Building and under-fuelled — but NEVER a bare "eat more" when a limiting macro is already
  // blown (2026-07-28 live: the pill read "Fat over" directly above "Eat more today — add a
  // proper meal"). Calories left and fat over are both true; the instruction has to hold both,
  // or the card argues with itself and the client trusts neither half.
  // THE CLOCK, NOT JUST THE LEDGER (2026-08-04, the founder's first gauntlet message).
  // 08:25. He photographed toast, eggs and viennas — breakfast — and one minute later the card
  // told him "Eat more today — add a proper meal". Both halves were true of the ledger (680 of
  // 2849) and the sentence was still absurd: nobody has eaten their day's food at breakfast.
  // A human coach never tells a man who just ate a meal to go and eat a meal.
  //
  // "Behind target" only becomes a finding once enough of the day has gone. Before then the
  // move is forward — carry it into the next meal — which is true at 8am and still an action.
  const earlyDay = hour < 11;

  if (isBulk && calLeft > 500) {
    const fatOver = !!fat && fat.target > 0 && fat.current > fat.target;
    if (fatOver) return "Eat more — but make it lean. Grilled, not fried";
    return earlyDay ? "Good start — keep it coming at lunch" : "Eat more today — add a proper meal";
  }

  // Protein is the one that actually moves the result, so it owns the instruction.
  if (protLeft >= 60) return earlyDay ? "Chicken or eggs at lunch AND supper" : "Get a real protein into your next two meals";
  if (protLeft >= 35) return earlyDay ? "Make lunch a proper protein — chicken, fish or eggs" : "Make your next meal a proper protein — chicken, fish or eggs";
  if (protLeft >= 18) return "Add eggs, tin fish or a shake today";
  if (protLeft > 0) return "One yoghurt or a boiled egg and you're done";

  if (calLeft > 400) return "Eat a proper meal — you're short on food today";
  return "Nothing left to do — today is done properly";
}


/**
 * THE VERDICT PILL — two words that answer the only question the client actually has.
 *
 * (2026-07-28, founder: "clarity without confusing them, but giving them what they want.")
 * The pill used to be "+795 cal": a number nobody asked for, already printed in the text reply,
 * occupying the loudest corner of the card. Nobody reads a card to find out what one meal cost.
 * They read it to find out whether they're okay. So the pill says that, in plain words and a
 * colour, and every number stays on the bars below for whoever wants to check the working.
 *
 * It reads the SAME rows the bars are drawn from, so the verdict can never contradict them.
 * Kept to ~12 characters — the title yields to the pill, so a long verdict eats the meal name.
 */
export function dayStatusPill(rows: Row[], isBulk: boolean): { text: string; tone: "good" | "warn" | "bad" } {
  const r = (label: string) => rows.find(x => x.label === label);
  const ratio = (x?: Row) => (x && x.target > 0 ? x.current / x.target : 0);
  const cal = r("Calories"), prot = r("Protein");
  const calR = ratio(cal), protHit = !!(prot && prot.current >= prot.target);

  // READ EVERY BAR, NOT TWO OF THEM (2026-07-28 live: a green "On track" pill sat directly above
  // a RED Fat 94/86g bar on the same card). The comment above this function claimed the verdict
  // "can never contradict the bars" — it only ever looked at Calories and Protein, so any client
  // over on carbs or fat got a green light from the loudest element on the card. A verdict that
  // ignores the evidence beside it is worse than no verdict.
  const blown = rows.filter(x => x.overIsBad && x.target > 0 && x.current > x.target);
  if (blown.length > 0 && !(isBulk && blown.every(x => x.label === "Calories"))) {
    const worst = blown.sort((a, b) => (b.current / b.target) - (a.current / a.target))[0];
    return worst.label === "Calories"
      ? { text: "Over today", tone: "bad" }
      : { text: `${worst.label} over`, tone: "bad" };
  }

  if (isBulk) {
    // A STATE, NOT AN INSTRUCTION (2026-07-29 live: the pill read "Eat more" directly above
    // "Eat more today — add a proper meal" and "Still room to build — add a proper meal". Three
    // surfaces, one order, on a single card). The pill says where they ARE; the band below says
    // what to DO. The moment the pill starts giving orders it is competing with the band.
    if (calR < 0.6) return { text: "Under target", tone: "warn" };
    if (protHit && calR >= 0.9) return { text: "Perfect day", tone: "good" };
    return { text: "On track", tone: "good" };
  }
  if (calR > 1.05) return { text: "Over today", tone: "bad" };
  if (protHit && calR >= 0.9) return { text: "Perfect day", tone: "good" };
  if (protHit) return { text: "Protein in", tone: "good" };
  if (calR >= 0.85) return { text: "Nearly there", tone: "warn" };
  return { text: "On track", tone: "good" };
}

/**
 * Blank the footer when it repeats the next-move line — ONE instruction per card.
 *
 * The old word-overlap count was too lenient: "Get protein into your next two meals" over
 * "62g protein to go — two protein meals closes it" shared only two long words and both
 * survived, so the card gave the same order twice in different clothes. That is precisely the
 * cognitive load to cut. The reliable signal isn't word count, it's SUBJECT: if both lines are
 * about the same macro, they are the same instruction.
 *
 * And when they collide we don't just delete the footer — we give it a different JOB. The band
 * above is the ACTION; the footer becomes the WHY. Same space on the card, no repetition, and
 * the client walks away knowing one more thing than they did. That's the difference between a
 * calculator and a coach.
 */
const HINT_SUBJECTS: Array<[string, RegExp]> = [
  ["protein", /\bprotein\b/i],
  ["fat", /\bfat\b|\bfried?\b|\bgrill/i],
  ["carbs", /\bcarb|\bstarch\b/i],
  ["calories", /\bcalorie|\bkcal\b|\beat more\b|\bfuel\b/i],
];




// A SECOND WEIGH-IN READER WITH NOTHING CALLING IT — DELETED (2026-08-25, P0-5 · weight).
//
// `weightChangeSinceStart` computed kg-since-start from weight_logs directly, with no
// do-not-mention check, for a card that no code path builds: zero callers, and it did not carry
// the `export` that GUARD #13 examines, so reachability never saw it either. It was not leaking a
// figure in production — nothing ran it — but it was a loaded second definition of "what the scale
// says", sitting in the module that renders IMAGES, where the reply boundary's text strip cannot
// reach. The next person to want a weight line on a card would have found it and used it.
// getWeightTruth in day-ledger.ts is the reader. There is no reason for a second one here.

/** Render an achievement card and return its media marker, or "" if it can't be served. */
export function achievementCardMarker(ach: AchievementCardData): string {
  try {
    const base = cardBaseUrl();
    if (!base) return "";
    return ` [MEDIA:${base}/card/${putCard(renderAchievementCard(ach))}.png]`;
  } catch (e) {
    console.warn("[ACHIEVEMENT_CARD] skipped:", (e as any)?.message || e);
    return "";
  }
}

/**
 * Will this log produce an ACHIEVEMENT card rather than the usual macro card?
 *
 * The caller needs to know, because when the card carries the milestone the text celebration
 * must stand down — otherwise a client gets the same congratulation twice, once in a paragraph
 * and once in a picture (2026-07-28 live, the 30-day log).
 *
 * Deliberately a PURE re-check rather than a flag left behind by the last render: two clients
 * logging in the same second would read each other's flag, and the bug would be invisible until
 * somebody got a stranger's celebration.
 */
export function achievementCardShown(user: any, streak: number | undefined, marker: string): boolean {
  if (!marker || !streak) return false;
  return achievementFor({ firstName: firstNameOf(user), streak }) !== null;
}

/**
 * THE CARD OR THE NUMBERS — for the client who asked for numbers.
 *
 * (2026-07-28, found by the day-one journey test.) The card is fail-open by design: no APP_URL,
 * a render error, anything at all, and the marker comes back "". For the default client that is
 * fine — number-free is the deliberate default, and the reply still names the food in plain
 * language. But a client who typed "show me the numbers" (numbers:full) has explicitly opted in,
 * and for them a failed card meant a food log with no figures anywhere, silently, on every log.
 *
 * So the fallback is structural rather than remembered at each call site, and it respects the
 * numbers dial rather than overriding it — see numbers-mode.ts.
 */
export function cardOrTotals(marker: string, kcal: number, protein: number, user?: any): string {
  // THE LAST TOTALS LINE (2026-08-04, Slice 4). This existed as the card's understudy: no card
  // attached, so print "_300 kcal | 10g protein_" instead. Under the locked card policy a
  // regular log never gets a card — so the understudy was about to go on stage for EVERY meal,
  // which is the receipt coming back through the side door the day after it was deleted.
  //
  // The numbers are not lost: they are written to the client's record, they drive the targets,
  // and they are on the card at the moments a card is earned. They are simply no longer read
  // aloud at someone who told us they ate bread.
  void kcal; void protein; void user;
  return marker;
}

/** Meal-log card marker: " [MEDIA:…]" for a macro-goal client, else "". `forDate` (the meal's
 *  logged-at date) makes a RETRO log show that DAY'S totals — e.g. yesterday's card with the
 *  new pizza slices added — instead of today's. */
/**
 * Is this client on the number-free setting? Both card builders ask here rather than reading
 * getNumbersMode themselves, so the card can never drift from the text the way it did until
 * 2026-07-29 — every prose surface honoured number-free while the picture ignored it.
 */
export function cardNumbersOff(user: any): boolean {
  return getNumbersMode(user) !== "normal";
}

/**
 * The instruction band and footer line on a number-free card. They are prose, so they can carry
 * a figure ("36g protein to go") that the bars no longer show — same leak, different surface.
 */
export function cardProse(text: string, numbersOff: boolean): string {
  if (!numbersOff) return text;
  return stripNumbersFromProse(text || "").trim();
}

/**
 * A LOG IS NOT A CARD MOMENT (2026-08-04, card policy locked).
 *
 * This function used to attach a picture to every meal. Two reasons that was wrong, and neither
 * shows up in a screenshot:
 *
 *   1. EVERY IMAGE COSTS THE CLIENT DATA. Prepaid, R199/month, three to five PNGs a day. That
 *      is a cost we push onto them silently and it would churn someone while looking like
 *      "it got boring".
 *   2. A CARD ON EVERY LOG MAKES THE CARD WORTHLESS. The thing we want them to show people
 *      cannot also be the thing they get for logging a black coffee. Rarity is the mechanic.
 *
 * So the locked policy is: signup (once), a real milestone, the weekly Sunday summary, and on
 * demand. A regular log gets two sentences and nothing else — which is also what the voice rules
 * ask for. The milestone branch below is the ONLY card this path can still produce.
 */

/** One owner for "a rendered card, as a WhatsApp media marker". Not prose — a URL. */
function cardMarker(base: string, png: Buffer | Uint8Array): string {
  return ` [MEDIA:${base}/card/${putCard(png as any)}.png]`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE MEAL CARD — the calling card, back on the moment it belongs to (2026-08-07).
 *
 * (Founder: "the meal card is our calling card. You can't share screenshots of a bunch of
 * sentences.") On 28 July the meal card was replaced by a MILESTONE-only card, on a marketing
 * note that people share achievements, not receipts. That note was right about achievements and
 * wrong about the consequence: the gate meant that logging a meal — the one moment a client has
 * just told us something about their day — produced no picture at all. He described the symptom
 * from the outside without seeing the source: "a person sending a card once every seven days."
 *
 * So both are true now. A streak milestone still wins, because it is the more shareable thing.
 * Every OTHER log gets the meal card, which carries the one instruction the coach computed.
 *
 * TWO CAMPS, ONE CARD. The numbers camp reads the protein figure; the simplicity camp reads a
 * verdict where the figure sits. Same picture, same brain, same next move underneath — nobody
 * picks a mode and nobody gets a lesser product. Before this, a wellness-goal client was
 * excluded from cards by policy and had nothing to look at and nothing to share, forever.
 * ──────────────────────────────────────────────────────────────────────────── */
export function mealCard(opts: {
  firstName: string; mealName: string; rows: Row[]; isBulk: boolean; usesNumbers: boolean;
  hour?: number;
  isPastDay?: boolean;
  /** They said they are done eating today. The card's next move must agree with the decision's. */
  foodDayClosed?: boolean;
}): AchievementCardData {
  const r = (label: string) => opts.rows.find(x => x.label === label);
  const prot = r("Protein");
  const cal = r("Calories");
  const protSoFar = Math.max(0, Math.round(prot?.current ?? 0));
  const protLeft = Math.round((prot?.target ?? 0) - protSoFar);
  const calRatio = cal && cal.target > 0 ? cal.current / cal.target : 0;

  // The simplicity camp gets a VERDICT where the number goes — the same judgement the numbers
  // camp reaches by reading the figure, made for them instead of by them.
  const verdict = protLeft > 40 ? "MORE"
    : calRatio > 1.05 && !opts.isBulk ? "EASY"
    : protLeft <= 0 ? "DONE"
    : "GOOD";

  return {
    figure: opts.usesNumbers ? `${protSoFar}g` : verdict,
    unit: opts.usesNumbers ? (opts.isPastDay ? "protein yesterday" : "protein today") : (opts.isPastDay ? "yesterday" : "so far today"),
    line: `${opts.firstName ? opts.firstName + ": " : ""}${opts.mealName} logged.`,
    sub: nextMoveLine(opts.rows, opts.isBulk, opts.hour, !!opts.isPastDay, !!opts.foodDayClosed),
  };
}

/**
 * DID THEY CLOSE THE DAY? Read from held-constraints — the same durable owner canonicalDecision
 * consults, so the card and the text cannot disagree about it. A constraint outlives the sentence
 * that stated it, which is why this is a stored read and not a look at the current message.
 * Fail-open to "not closed": a card is a bonus, never a blocker, and the pre-existing behaviour
 * on an unreadable constraint is exactly what it was before.
 */
async function dayClosedFor(user: any): Promise<boolean> {
  try {
    const { readHeldConstraints } = await import("./held-constraints");
    return !!(await readHeldConstraints(user?.phoneNumber, user)).foodDayClosed;
  } catch { return false; }
}

export async function macroCardMarker(opts: { user: any; mealName: string; mealKcal: number; forDate?: Date; achievementStreak?: number }): Promise<string> {
  try {
    // A MILESTONE IS A MOMENT (2026-07-28, marketing review: "people don't share a receipt,
    // they share an achievement"). Seven days straight is about the person, and that is the
    // thing they show someone. achievementFor is the milestone gate — it returns null on an
    // ordinary day, which is now the whole of the rest of this function.
    if (cardSuppressedByDump(opts.user?.id)) return "";   // six photos in ninety seconds → one card
    const base = cardBaseUrl();
    if (!base) return "";

    // A MILESTONE STILL WINS — it is the more shareable picture, and that July note was right
    // about that much. What changed is what happens on an ORDINARY day: a card, not silence.
    const ach = opts.achievementStreak
      ? achievementFor({ firstName: firstNameOf(opts.user), streak: opts.achievementStreak })
      : null;
    if (ach) {
      noteCardSent(opts.user?.id);
      return cardMarker(base, renderAchievementCard(ach));
    }

    const today = await todayRows(opts.user, false, opts.forDate);
    if (!today) return "";
    const isPastDay = !!opts.forDate && isPastSastDay(opts.forDate);
    const card = mealCard({
      firstName: firstNameOf(opts.user),
      mealName: opts.mealName || "Meal",
      rows: today.rows,
      foodDayClosed: isPastDay ? false : await dayClosedFor(opts.user),
      isBulk: today.isBulk,
      usesNumbers: getNumbersMode(opts.user) !== "low" && getGoalProfile(opts.user?.goalType).usesMacros,
      isPastDay,
    });
    noteCardSent(opts.user?.id);
    return cardMarker(base, renderAchievementCard(card));
  } catch (e) {
    console.warn("[MILESTONE_CARD] skipped:", (e as any)?.message || e);
    return "";
  }
}

/** On-demand "my daily calories" card marker — a snapshot of the day so far. "" if N/A. */
export async function dailyMacroCardMarker(user: any): Promise<string> {
  try {
    const base = cardBaseUrl();
    if (!base) return "";
    // ONE OWNER, BOTH CALL SITES (2026-08-04, Slice 3). The comment that used to sit here said
    // it exactly: "rebuilding one of two call sites and calling the card fixed is the disease
    // this codebase keeps naming." So this path takes the same progress card as the log path.
    // "My daily calories" now answers with what they have actually done, not a bar chart of what
    // they have left — the spec forbids calories, macro bars and running totals on the card, and
    // this was the loudest surviving source of all three.
    // NOT shareAchievement (2026-08-07). That function is documented "no milestone gate: they
    // asked, so we answer" — correct for an explicit *share my progress*, and catastrophic here.
    // It ranks weight → streak → sessions and falls through to `sessions >= 3`, so a client whose
    // weight has not moved a whole kilo this week gets the SAME lifetime session count on every
    // progress query, forever. The founder: "that thing has been telling me for the past two days
    // that I've done twenty two workouts." Two days is what it looked like from outside; the code
    // would have done it for two years.
    //
    // A question about TODAY gets a card about today: what they have eaten, and the next move.
    // shareAchievement stays exactly as it is, for the one command that asks for a boast.
    const today = await todayRows(user, false);
    if (!today) return "";
    const card = mealCard({
      firstName: firstNameOf(user),
      mealName: "Today",
      rows: today.rows,
      foodDayClosed: await dayClosedFor(user),
      isBulk: today.isBulk,
      usesNumbers: getNumbersMode(user) !== "low" && getGoalProfile(user?.goalType).usesMacros,
    });
    return cardMarker(base, renderAchievementCard(card));
  } catch (e) {
    console.warn("[DAILY_CARD] skipped:", (e as any)?.message || e);
    return "";
  }
}

/**
 * COACH K WELCOME AVATAR marker (2026-07-22, founder: a branded face that pops up with the menu,
 * like the government health bot). Real illustrated character art takes over AUTOMATICALLY once
 * COACH_AVATAR_URL is set in Railway — until then, a premium branded Coach K card is rendered and
 * self-served. Returns " [MEDIA:…]" or "" (fail-open — never block the menu).
 */
export function welcomeAvatarMarker(): string {
  try {
    const artUrl = (process.env.COACH_AVATAR_URL || "").trim();
    if (artUrl) return ` [MEDIA:${/^https?:\/\//i.test(artUrl) ? artUrl : "https://" + artUrl}]`;
    const base = cardBaseUrl();
    if (!base) return "";
    const png = renderWelcomeCard({ name: "Coach K", tagline: "Your fitness coach — right here on WhatsApp" });
    return ` [MEDIA:${base}/card/${putCard(png)}.png]`;
  } catch (e) {
    console.warn("[WELCOME_CARD] skipped:", (e as any)?.message || e);
    return "";
  }
}
