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
import { putCard } from "./card-store";
import { waterTargetLitres } from "./targets";

// Shared: the public base URL (forced to https:// — see below) or "" when a card can't be
// served. APP_URL was stored WITHOUT a scheme, so the first live marker leaked as a text link
// instead of an image; forcing https:// makes it a valid media URL Twilio fetches.
function cardBaseUrl(): string {
  let base = (process.env.APP_URL || "").trim().replace(/\/$/, "");
  if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;
  return base;
}

type Row = { label: string; current: number; target: number; unit: string; overIsBad?: boolean; decimals?: number };

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
  if (isBulk && ratio(cal) < 0.6) return pick(["Under your building fuel — eat more, muscle needs it.", "Still room to build — add a proper meal, that's where growth comes from."]);
  // Goal reached — celebrate AND teach why it matters.
  if (proteinHit && !isBulk && ratio(cal) >= 0.9 && ratio(cal) <= 1.05) return pick(["Textbook day — protein in, calories on point. This is exactly it.", "Nailed it: enough protein, right calories. Repeat this and results follow."]);
  if (proteinHit) return pick(["Protein hit — the one that matters most. It protects muscle while you lean out.", "Protein's in — that's the win that keeps you full and strong."]);
  if (ratio(cal) < 0.5) return pick(["Plenty of room left — protein first at your next meal.", "Lots of day left — lead with protein and you'll stay full."]);
  return pick(["One good choice at a time.", "Small steady choices — that's the whole game.", "Consistency beats perfection. Keep logging."]);
}

/** Meal-log card marker: " [MEDIA:…]" for a macro-goal client, else "". `forDate` (the meal's
 *  logged-at date) makes a RETRO log show that DAY'S totals — e.g. yesterday's card with the
 *  new pizza slices added — instead of today's. */
export async function macroCardMarker(opts: { user: any; mealName: string; mealKcal: number; forDate?: Date }): Promise<string> {
  try {
    const base = cardBaseUrl();
    if (!base) return "";
    const retro = opts.forDate ? isPastDay(opts.forDate) : false;
    const t = await todayRows(opts.user, false, retro ? opts.forDate : undefined);
    if (!t) return "";
    const png = renderMacroCard({
      title: (opts.mealName || "Meal").slice(0, 42),
      subtitle: retro ? "Logged to yesterday" : "Meal logged",
      pill: `+${Math.max(0, Math.round(opts.mealKcal || 0))} cal`,
      rows: t.rows,
      hint: coachingHint(t.rows, t.isBulk),
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
    const kcal = t.rows[0]?.current || 0;
    const png = renderMacroCard({
      title: user?.name ? `${String(user.name).split(" ")[0]}'s day so far` : "Your day so far",
      subtitle: "Today so far",
      pill: `${kcal} cal in`,
      rows: t.rows,
      hint: coachingHint(t.rows, t.isBulk),
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
