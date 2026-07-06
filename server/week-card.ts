/**
 * THE WEEK CARD — a screenshot-designed artifact of the client's real week.
 *
 * Marketing as a consequence of use (Spotify Wrapped / Strava logic): the client's
 * own numbers, formatted so a screenshot of it IS the advert — with the brand line
 * as the footer. Deterministic, zero GPT cost, rides the same Sunday proactive slot
 * as the voice recap (one extra part, not a new interruption).
 *
 * Never built for a week with nothing to show (a shame card is anti-marketing) or a
 * week with a life event (celebrating stats over a bereavement is tone-deaf — the
 * voice recap handles that tone).
 *
 * Pure — no DB, no API. Unit-tested in script/unit-tests.ts.
 */

export interface WeekCardData {
  name: string | null;
  currentWeight: number | null;
  stepsTarget: number | null;
  workoutsThisWeek: number;
  trainingDaysPerWeek: number;
  avgStepsThisWeek: number;
  weightChange: number | null; // kg change vs 2 weeks ago
  mealsLoggedDays: number;
  workoutStreak: number;
  lifeContext: string | null;
}

export function buildWeekCard(data: WeekCardData): string | null {
  if (data.lifeContext) return null;
  if (data.workoutsThisWeek < 1 && data.mealsLoggedDays < 3) return null;

  const fn = (data.name || "").split(" ")[0] || "Champ";
  const lines: string[] = [`🏆 *YOUR WEEK — ${fn}*`, ""];

  const target = data.trainingDaysPerWeek || 3;
  lines.push(`💪 Sessions: ${data.workoutsThisWeek}/${target}${data.workoutsThisWeek >= target ? " ✅" : ""}`);

  if (data.avgStepsThisWeek > 0) {
    const stepsTarget = data.stepsTarget ?? 8500;
    lines.push(`👟 Steps: ${data.avgStepsThisWeek.toLocaleString()}/day average${data.avgStepsThisWeek >= stepsTarget ? " ✅" : ""}`);
  }

  if (data.mealsLoggedDays > 0) {
    lines.push(`🍽️ Food logged: ${data.mealsLoggedDays} of 7 days${data.mealsLoggedDays >= 7 ? " 🔥" : ""}`);
  }

  if (data.currentWeight !== null) {
    const change = data.weightChange;
    const changeTxt = change !== null && Math.abs(change) >= 0.2
      ? ` — ${change < 0 ? "down" : "up"} ${Math.abs(change).toFixed(1)}kg in 2 weeks`
      : ` — holding steady`;
    lines.push(`⚖️ ${data.currentWeight.toFixed(1)}kg${changeTxt}`);
  }

  if (data.workoutStreak >= 3) lines.push(`🔥 Session streak: ${data.workoutStreak}`);

  lines.push("", `_KamLife Coach — your coach on WhatsApp_`);
  return lines.join("\n");
}
