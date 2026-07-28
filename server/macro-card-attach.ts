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

import { db } from "./db";
import { mealLogs } from "../shared/schema";
import { eq, and, gte, lt, sql } from "drizzle-orm";
import { sastDayStart } from "./utils";

// SAST midnight of the day containing `d` (UTC+2). Lets the card sum a SPECIFIC day, so a
// retroactive log ("4 slices of pizza to yesterday") shows YESTERDAY'S totals, not today's.
function sastDayStartOf(d: Date): Date {
  const sast = new Date(d.getTime() + 2 * 3_600_000);
  sast.setUTCHours(0, 0, 0, 0);
  return new Date(sast.getTime() - 2 * 3_600_000);
}
/** True when `d` falls on an earlier SAST day than now — i.e. a retro (past-day) log. */
function isPastDay(d: Date): boolean {
  return sastDayStartOf(d).getTime() < sastDayStart().getTime();
}
import { getGoalProfile } from "./goal-profiles";
import { renderMacroCard, renderWelcomeCard } from "./macro-card";
import { achievementFor, renderAchievementCard, type AchievementCardData } from "./achievement-card";
import { putCard } from "./card-store";
import { waterTargetLitres } from "./targets";
import { getNumbersMode } from "./numbers-mode";

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
  const profile = getGoalProfile(user?.goalType);
  if (!profile.usesMacros) return null; // wellness → no card
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
export function mealTitleFromReply(text: string): string {
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
  const cleaned = firstLine
    .replace(/\.\s.*$/, "")                                                       // keep just the first sentence
    .replace(/^\s*based on\b.*?\b(?:looks?|seems?)\b\s*(?:like|as though|to be)?\s*/i, "") // "Based on…, it looks like "
    .replace(/^\s*(this is|that'?s|it'?s|here'?s|i (?:can )?see|looks like|got it)[,:]?\s*/i, "")
    .replace(/^(a|an|the)\s+/i, "")                                               // leading article
    .replace(/\blogged\b.*$/i, "").replace(/[,:]\s*$/, "").trim().slice(0, 46);
  return stripWrapQuotes(cleaned) || "Meal";
}

// Strip wrapping quote marks (straight or curly) from a food name — the vision model likes
// to echo the caption in scare-quotes ("Skinny hot chocolate"), which read as sarcasm on
// the card (2026-07-22, founder: "come on man"). Inner apostrophes (McDonald's) are kept.
function stripWrapQuotes(s: string): string {
  return (s || "").replace(/^["'“”‘’]+\s*/, "").replace(/\s*["'“”‘’]+$/, "").trim();
}

// PLAIN-LANGUAGE COACHING on the card (2026-07-22, founder: the card must TEACH, and it must
// KEEP CHANGING — a fresh, indirectly-educational cue for THIS day's state, celebrating a goal
// reached and flagging anything out of the ordinary). No jargon, no emoji (the card font can't
// render it). One short line, most-important-first; a couple of variants per state so it varies.
export function coachingHint(rows: Row[], isBulk: boolean): string {
  const r = (label: string) => rows.find(x => x.label === label);
  const ratio = (x?: Row) => (x && x.target > 0 ? x.current / x.target : 0);
  const cal = r("Calories"), prot = r("Protein"), carb = r("Carbs"), fat = r("Fat");
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  const proteinHit = !!(prot && prot.current >= prot.target);
  // Out of the ordinary — a big overshoot on a limiting macro. Teach WHY, kindly, not just "over".
  if (ratio(fat) > 1.25) return pick(["Fat ran high — it's the densest fuel, so it adds up fast. Keep it grilled from here.", "Lots of fat today — nothing wrong, just filling. Lean protein and veg next."]);
  if (ratio(fat) > 1.1) return pick(["Fat ran a bit high — keep the rest lean. Grilled, not fried.", "Watch the fat from here — small change, big calorie saving."]);
  if (ratio(carb) > 1.1) return pick(["Carbs are maxed — protein and veg from here, ease the starch.", "Plenty of starch in today — lean on protein and veg next."]);
  if (!isBulk && ratio(cal) > 1.25) return pick(["Over for today — no drama, one meal never undoes a week. Light and lean tomorrow.", "Past your food today. It happens — a walk helps, and tomorrow resets clean."]);
  if (!isBulk && ratio(cal) > 1.05) return pick(["Over your food for today — go light and lean next meal.", "Just past target — keep the next one small and protein-first."]);
  if (isBulk && ratio(cal) < 0.6) return pick(["Under your building fuel — eat more, muscle needs it.", "Still room to build — add a proper meal."]);
  // Goal reached — celebrate AND teach why it matters.
  if (proteinHit && !isBulk && ratio(cal) >= 0.9 && ratio(cal) <= 1.05) return pick(["Textbook day — protein in, calories on point. This is exactly it.", "Nailed it: enough protein, right calories. Repeat this and results follow."]);
  if (proteinHit) return pick(["Protein hit — the one that matters most. It protects muscle while you lean out.", "Protein's in — that's the win that keeps you full and strong."]);
  // SPECIFIC NEXT MOVE, not a platitude (2026-07-23, founder + reviewers: "it's the same
  // generic thing over and over — it doesn't coach"). A coach names the gap and what closes
  // it; "One good choice at a time" is a fridge magnet. Use THEIR real remaining numbers.
  const protLeft = prot ? Math.round(prot.target - prot.current) : 0;
  const calLeft = cal ? Math.round(cal.target - cal.current) : 0;
  if (protLeft > 0) {
    const fix = protLeft >= 60 ? "two protein meals" : protLeft >= 35 ? "a proper protein meal" : protLeft >= 18 ? "eggs, tin fish or a shake" : "a yoghurt or a boiled egg";
    if (calLeft < 200 && calLeft > -200) return `${protLeft}g protein to go — ${fix}, easy on the oil.`;
    return `${protLeft}g protein to go — ${fix} closes it.`;
  }
  if (calLeft > 400) return `${calLeft} kcal still to eat — your body needs the fuel.`;
  return pick(["Everything's in for today — logged, on target, done. Repeat tomorrow.", "Targets met and logged. This is the day that builds the result."]);
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
export function nextMoveLine(rows: Row[], isBulk: boolean): string {
  const r = (label: string) => rows.find(x => x.label === label);
  const ratio = (x?: Row) => (x && x.target > 0 ? x.current / x.target : 0);
  const cal = r("Calories"), prot = r("Protein"), fat = r("Fat");
  const protLeft = prot ? Math.round(prot.target - prot.current) : 0;
  const calLeft = cal ? Math.round(cal.target - cal.current) : 0;

  // Over the day's food — the move is about the NEXT meal, never guilt about the last one.
  if (!isBulk && ratio(cal) > 1.05) {
    return calLeft < -400 ? "Keep tonight light — protein and veg only" : "Go lean at the next meal — grilled, no starch";
  }
  if (ratio(fat) > 1.25) return "Grill it, don't fry it — that's the whole fix today";

  // Building and under-fuelled.
  if (isBulk && calLeft > 500) return "Eat more today — add a proper meal";

  // Protein is the one that actually moves the result, so it owns the instruction.
  if (protLeft >= 60) return "Get protein into your next two meals";
  if (protLeft >= 35) return "Make your next meal a proper protein meal";
  if (protLeft >= 18) return "Add eggs, tin fish or a shake today";
  if (protLeft > 0) return "One yoghurt or a boiled egg finishes today";

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

  if (isBulk) {
    if (calR < 0.6) return { text: "Eat more", tone: "warn" };
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

// One plain sentence of education per subject. A fact, never a second instruction. Kept short
// enough to render whole — a footer that ends in "…" teaches nobody anything.
export const WHY_LINE: Record<string, string> = {
  protein: "Protein protects your muscle while you lose fat.",
  fat: "Fat is the densest fuel — oil adds up fastest.",
  carbs: "Starch isn't the problem. The portion size is.",
  calories: "Your body reads the week, not one single meal.",
};

// EARLIEST mention wins, not list order — a line's subject is what it opens with. "Carbs are
// maxed — protein and veg from here" is about carbs; scanning in list order would call it protein.
function hintSubject(s: string): string | null {
  let best: string | null = null, at = Infinity;
  for (const [name, re] of HINT_SUBJECTS) {
    const m = re.exec(s || "");
    if (m && m.index < at) { at = m.index; best = name; }
  }
  return best;
}

export function distinctHint(hint: string, nextMove: string): string {
  const norm = (x: string) => (x || "").toLowerCase().replace(/[^a-z ]/g, "").trim();
  const h = norm(hint), n = norm(nextMove);
  if (!h || !n) return hint;
  const subject = hintSubject(hint);
  if (subject && subject === hintSubject(nextMove)) return WHY_LINE[subject] || "";
  const shared = n.split(" ").filter(w => w.length > 3 && h.includes(w)).length;
  return shared >= 3 ? "" : hint;
}

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
  if (marker) return marker;
  if (!(kcal > 0)) return "";
  if (getNumbersMode(user) !== "normal") return ""; // number-free client — the words are the reply
  const p = Math.round(protein) > 0 ? ` | *${Math.round(protein)}g* protein` : "";
  return `\n\n_${Math.round(kcal)} kcal${p}_`;
}

/** Meal-log card marker: " [MEDIA:…]" for a macro-goal client, else "". `forDate` (the meal's
 *  logged-at date) makes a RETRO log show that DAY'S totals — e.g. yesterday's card with the
 *  new pizza slices added — instead of today's. */
export async function macroCardMarker(opts: { user: any; mealName: string; mealKcal: number; forDate?: Date; achievementStreak?: number }): Promise<string> {
  try {
    // ON A MILESTONE DAY THE RECEIPT STANDS ASIDE (2026-07-28, marketing review: "people don't
    // share a receipt, they share an achievement"). The macro card is useful and nobody has ever
    // forwarded one. Seven days straight is about the person, and that is the thing they show
    // someone. One card, so the moment isn't split — the numbers are still in the text reply.
    const ach = opts.achievementStreak
      ? achievementFor({ firstName: firstNameOf(opts.user), streak: opts.achievementStreak })
      : null;
    if (ach) {
      const b = cardBaseUrl();
      if (b) return ` [MEDIA:${b}/card/${putCard(renderAchievementCard(ach))}.png]`;
    }
    // NO CARD FOR A TRIVIAL ITEM (2026-07-28 live: a full four-bar macro card rendered for a
    // 10 kcal black coffee). A card is a moment; spending one on a zero-calorie drink cheapens
    // every other card and costs a render. The log still happens — only the picture is skipped.
    if ((opts.mealKcal || 0) < 50) return "";
    const base = cardBaseUrl();
    if (!base) return "";
    const retro = opts.forDate ? isPastDay(opts.forDate) : false;
    const t = await todayRows(opts.user, false, retro ? opts.forDate : undefined);
    if (!t) return "";
    const verdict = dayStatusPill(t.rows, t.isBulk);
    const png = renderMacroCard({
      title: (opts.mealName || "Meal").slice(0, 42),
      subtitle: retro ? "Logged to yesterday" : "Meal logged",
      pill: verdict.text,
      pillTone: verdict.tone,
      rows: t.rows,
      nextMove: nextMoveLine(t.rows, t.isBulk),
      // The next-move band and the footer must never say the same thing twice (2026-07-28 live:
      // "Eat more today — add a proper meal" above "Still room to build — add a proper meal").
      hint: distinctHint(coachingHint(t.rows, t.isBulk), nextMoveLine(t.rows, t.isBulk)),
    });
    return ` [MEDIA:${base}/card/${putCard(png)}.png]`;
  } catch (e) {
    console.warn("[MACRO_CARD] skipped:", (e as any)?.message || e);
    return "";
  }
}

/** On-demand "my daily calories" card marker — a snapshot of the day so far. "" if N/A. */
export async function dailyMacroCardMarker(user: any): Promise<string> {
  try {
    const base = cardBaseUrl();
    if (!base) return "";
    const t = await todayRows(user, true); // daily scorecard includes today's water
    if (!t) return "";
    const verdict = dayStatusPill(t.rows, t.isBulk);
    const png = renderMacroCard({
      title: user?.name ? `${String(user.name).split(" ")[0]}'s day so far` : "Your day so far",
      subtitle: "Today so far",
      pill: verdict.text,
      pillTone: verdict.tone,
      rows: t.rows,
      nextMove: nextMoveLine(t.rows, t.isBulk),
      // The next-move band and the footer must never say the same thing twice (2026-07-28 live:
      // "Eat more today — add a proper meal" above "Still room to build — add a proper meal").
      hint: distinctHint(coachingHint(t.rows, t.isBulk), nextMoveLine(t.rows, t.isBulk)),
    });
    return ` [MEDIA:${base}/card/${putCard(png)}.png]`;
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
