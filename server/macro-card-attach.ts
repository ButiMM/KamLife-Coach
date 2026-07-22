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

/** Returns " [MEDIA:https://…/card/<token>.png]" for a macro-goal client, else "". */
export async function macroCardMarker(opts: { user: any; mealName: string; mealKcal: number }): Promise<string> {
  const { user, mealName, mealKcal } = opts;
  try {
    // Only macro goals get a card; wellness/has-a-condition keep the plain reply.
    if (!getGoalProfile(user?.goalType).usesMacros) return "";
    // APP_URL may be stored without a scheme (it was — the first live marker came out as
    // "kamlife-…railway.app/…" with no https://, so the strip-regex missed it and the raw
    // URL leaked as TEXT instead of an image). Force https:// so the marker is a valid media
    // URL that Twilio fetches and WhatsApp shows inline — the client never sees a link.
    let base = (process.env.APP_URL || "").trim().replace(/\/$/, "");
    if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;
    if (!base) return ""; // no public URL to serve the image from → skip gracefully
    const calTarget = Number(user?.calorieTarget) || 0;
    const protTarget = Number(user?.proteinTarget) || 0;
    if (!(calTarget > 0) || !(protTarget > 0)) return "";

    const todayStart = sastDayStart();
    const [sum] = await db.select({
      kcal: sql<number>`COALESCE(SUM(${mealLogs.kcalInt}),0)::int`,
      protein: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}),0)::int`,
      carbs: sql<number>`COALESCE(SUM(${mealLogs.carbsInt}),0)::int`,
      fat: sql<number>`COALESCE(SUM(${mealLogs.fatInt}),0)::int`,
    }).from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)));

    // Derived carb/fat targets: fat ~27% of calories, carbs fill the rest after protein.
    const fatTarget = Math.max(1, Math.round((calTarget * 0.27) / 9));
    const carbTarget = Math.max(1, Math.round((calTarget - protTarget * 4 - fatTarget * 9) / 4));

    const png = renderMacroCard({
      mealName: (mealName || "Meal").slice(0, 42),
      mealKcal: Math.max(0, Math.round(mealKcal || 0)),
      rows: [
        { label: "Calories", current: sum?.kcal || 0, target: calTarget, unit: "" },
        { label: "Protein", current: sum?.protein || 0, target: protTarget, unit: "g" },
        { label: "Carbs", current: sum?.carbs || 0, target: carbTarget, unit: "g" },
        { label: "Fat", current: sum?.fat || 0, target: fatTarget, unit: "g" },
      ],
      hint: "Protein first — one meal at a time",
    });
    const token = putCard(png);
    return ` [MEDIA:${base}/card/${token}.png]`;
  } catch (e) {
    console.warn("[MACRO_CARD] skipped:", (e as any)?.message || e);
    return "";
  }
}
