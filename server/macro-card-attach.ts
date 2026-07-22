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
import { eq, and, gte, sql } from "drizzle-orm";
import { sastDayStart } from "./utils";
import { getGoalProfile } from "./goal-profiles";
import { renderMacroCard } from "./macro-card";
import { putCard } from "./card-store";

// Shared: the public base URL (forced to https:// — see below) or "" when a card can't be
// served. APP_URL was stored WITHOUT a scheme, so the first live marker leaked as a text link
// instead of an image; forcing https:// makes it a valid media URL Twilio fetches.
function cardBaseUrl(): string {
  let base = (process.env.APP_URL || "").trim().replace(/\/$/, "");
  if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;
  return base;
}

type Row = { label: string; current: number; target: number; unit: string; overIsBad?: boolean };

// Shared: today's macro rows for a macro-goal client, or null when a card doesn't apply.
// `overIsBad` marks the macros where GOING OVER is a warning (carbs, fat, and calories on a
// cut) so the card reddens them; protein (and calories on a bulk) never red — more is fine.
async function todayRows(user: any): Promise<{ rows: Row[]; isBulk: boolean } | null> {
  const profile = getGoalProfile(user?.goalType);
  if (!profile.usesMacros) return null; // wellness → no card
  const calTarget = Number(user?.calorieTarget) || 0;
  const protTarget = Number(user?.proteinTarget) || 0;
  if (!(calTarget > 0) || !(protTarget > 0)) return null;
  const isBulk = profile.energyStance === "surplus";
  const [sum] = await db.select({
    kcal: sql<number>`COALESCE(SUM(${mealLogs.kcalInt}),0)::int`,
    protein: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}),0)::int`,
    carbs: sql<number>`COALESCE(SUM(${mealLogs.carbsInt}),0)::int`,
    fat: sql<number>`COALESCE(SUM(${mealLogs.fatInt}),0)::int`,
  }).from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, sastDayStart())));
  const fatTarget = Math.max(1, Math.round((calTarget * 0.27) / 9));
  const carbTarget = Math.max(1, Math.round((calTarget - protTarget * 4 - fatTarget * 9) / 4));
  return {
    isBulk,
    rows: [
      { label: "Calories", current: sum?.kcal || 0, target: calTarget, unit: "", overIsBad: !isBulk },
      { label: "Protein", current: sum?.protein || 0, target: protTarget, unit: "g", overIsBad: false },
      { label: "Carbs", current: sum?.carbs || 0, target: carbTarget, unit: "g", overIsBad: true },
      { label: "Fat", current: sum?.fat || 0, target: fatTarget, unit: "g", overIsBad: true },
    ],
  };
}

// PLAIN-LANGUAGE COACHING on the card (2026-07-22, founder: "what does the coach TEACH when
// calories/macros are too high — for all goals, over or under?"). No jargon, no emoji (the
// card font can't render it). One cue, the most important thing for THIS day's state.
export function coachingHint(rows: Row[], isBulk: boolean): string {
  const r = (label: string) => rows.find(x => x.label === label);
  const ratio = (x?: Row) => (x && x.target > 0 ? x.current / x.target : 0);
  const cal = r("Calories"), prot = r("Protein"), carb = r("Carbs"), fat = r("Fat");
  if (ratio(fat) > 1.1) return "Fat ran high today — keep the rest lean. Grilled, not fried.";
  if (ratio(carb) > 1.1) return "Carbs are maxed — protein and veg from here, ease the starch.";
  if (!isBulk && ratio(cal) > 1.05) return "Over your food for today — go light and lean next meal.";
  if (isBulk && ratio(cal) < 0.6) return "Under your building fuel — eat more, muscle needs it.";
  if (prot && prot.current >= prot.target) return "Protein hit — the one that matters most. Well done.";
  if (ratio(cal) < 0.5) return "Plenty of room left — protein first at your next meal.";
  return "One good choice at a time.";
}

/** Meal-log card marker: " [MEDIA:…]" for a macro-goal client, else "". */
export async function macroCardMarker(opts: { user: any; mealName: string; mealKcal: number }): Promise<string> {
  try {
    const base = cardBaseUrl();
    if (!base) return "";
    const t = await todayRows(opts.user);
    if (!t) return "";
    const png = renderMacroCard({
      title: (opts.mealName || "Meal").slice(0, 42),
      subtitle: "Meal logged",
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
    const t = await todayRows(user);
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
