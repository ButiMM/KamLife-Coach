// Plain-language education — zero GPT cost, deterministic.
//
// Most clients don't know what a calorie is. They know data bundles, what a
// walk feels like, and what a plate of food looks like. Every number the bot
// sends gets ONE chance to be explained in those terms — early in the
// programme, once, then we shut up. This is translation, not a curriculum:
// no new commands, no lessons, no GPT calls. Lines ride inside replies that
// already exist.

import { sastToday } from "./utils";
import { getGoalProfile } from "./goal-profiles";

type EduEvent = "meal" | "totals" | "steps";

interface EduCtx {
  event: EduEvent;
  calorieTarget?: number;
  proteinTarget?: number;
  /** kcal over target today (after step offset). 0/undefined = not over. */
  overBy?: number;
  burnKcal?: number;
}

// Concepts already taught, per user (in-memory — a redeploy may repeat a line
// once; the day-windows below stop anything repeating beyond the first weeks).
const taught = new Map<string, Set<string>>();
// Max one education line per user per day — coaching, not a curriculum.
const taughtToday = new Map<string, string>();


function daysOnProgramme(user: any): number {
  const start = user?.programmeStartDate || user?.createdAt;
  if (!start) return 999;
  return Math.floor((Date.now() - new Date(start).getTime()) / 86_400_000);
}

function claim(userId: string, concept: string): boolean {
  if (taughtToday.get(userId) === sastToday()) return false;
  const set = taught.get(userId) || new Set<string>();
  if (set.has(concept)) return false;
  set.add(concept);
  if (taught.size > 5000) taught.clear();
  if (taughtToday.size > 5000) taughtToday.clear();
  taught.set(userId, set);
  taughtToday.set(userId, sastToday());
  return true;
}

/**
 * One italic explainer line for the highest-priority concept this user hasn't
 * been taught yet — or "" when there's nothing due. Append to an existing
 * reply; never build a message around it.
 */
export function educationNote(user: any, ctx: EduCtx): string {
  try {
    if (!user?.id) return "";
    const days = daysOnProgramme(user);
    const goal = user.goalType || "fat_loss";
    const target = ctx.calorieTarget || user.calorieTarget || 1800;
    const protTarget = ctx.proteinTarget || user.proteinTarget || 120;

    if (ctx.event === "steps") {
      if (days <= 10 && (ctx.burnKcal || 0) >= 100 && claim(user.id, "steps_why")) {
        return `\n\n_Why steps matter: walking is real burning — that walk used ~${ctx.burnKcal} kcal of food energy. Stack it daily and the week adds up to thousands, which your body takes from stored fat._`;
      }
      return "";
    }

    // meal / totals — first eligible concept wins, situational beats scheduled.
    if ((ctx.overBy || 0) >= 150 && days <= 21 && claim(user.id, "over_day")) {
      return `\n\n_Keep perspective: a kilo of body fat is about 7 700 kcal, so today's extra is a dent, not damage. One day over changes nothing — it only counts if it repeats. Tomorrow the budget resets._`;
    }
    if (days <= 3 && claim(user.id, "cal_basics")) {
      return goal === "muscle_gain"
        ? `\n\n_The numbers, explained once: calories are just energy in food. Your ${target} kcal target sits a bit above what your body burns in a day — that extra, plus protein, is the raw material new muscle gets built from._`
        : `\n\n_The numbers, explained once: calories are just energy in food. Your body burns more than ${target} kcal a day just living — we set your eating at ${target} so the shortfall comes out of stored fat. That's the whole game. No magic, just maths._`;
    }
    if (days >= 1 && days <= 7 && claim(user.id, "budget")) {
      return `\n\n_Easy way to hold it: ${target} kcal is your day's bundle, like data. Every meal spends some, and the number I send back is what's left. You never count anything — that's my job._`;
    }
    if (days >= 2 && days <= 14 && claim(user.id, "protein_why")) {
      return goal === "muscle_gain"
        ? `\n\n_Why I push protein: training is the signal, protein is the bricks. Without ~${protTarget}g a day, the work in the gym has nothing to build with._`
        : `\n\n_Why I push protein: lose weight without it and you lose muscle along with the fat. Protein protects the muscle — so what goes is fat — and it keeps you full, so you snack less._`;
    }
    return "";
  } catch {
    return "";
  }
}

/** Translate "kcal remaining" into meals — the unit everyone understands. */
export function remainingInMeals(kcal: number): string {
  if (kcal >= 900) return "room for two proper meals";
  if (kcal >= 550) return "a full dinner with room for a snack";
  if (kcal >= 350) return "one solid meal";
  if (kcal >= 150) return "a light meal or a good snack";
  if (kcal > 0) return "a small snack at most — choose well";
  return "";
}

/**
 * WEEKLY-JOURNEY WORDING (2026-07-16, founder: "what does the bot teach them about
 * their weekly goals... you're on a weekly journey"). One line that zooms the client
 * out from today to the week, so a deliberate treat or a heavy braai stops reading
 * as failure the moment the week can be SEEN absorbing it. Pure — the DB summing
 * lives in food-scanner.weeklyNetLine; this is the single wording brain, goal-aware
 * and numbers-mode-aware. netKcal is (eaten − loggedDays×target): positive = over.
 * The over branch always teaches the same law: tomorrow stays NORMAL — a punishment
 * day is how diets die.
 */
export function weeklyNetWording(opts: { loggedDays: number; netKcal: number; building: boolean; numbersLow: boolean }): string {
  const { loggedDays, netKcal, building, numbersLow } = opts;
  if (loggedDays < 3) return ""; // too thin to judge a week — say nothing
  const perDayBand = 100; // within ±100 kcal/day of budget = on track
  const onTrack = Math.abs(netKcal) <= loggedDays * perDayBand;
  const over = netKcal > 0;
  if (numbersLow) {
    if (onTrack) return `📅 *Your week:* on track. One heavy day never decides anything — the week does, and yours is winning.`;
    if (over) {
      return building
        ? `📅 *Your week:* plenty of fuel in — make sure the training matches it so it builds muscle, not padding.`
        : `📅 *Your week:* running a bit heavy. No punishment day — eat NORMAL tomorrow (regular meals, protein first) and the week comes right on its own.`;
    }
    return building
      ? `📅 *Your week:* under-fuelled overall — muscle can't be built from air. Eat your full days.`
      : `📅 *Your week:* ahead of plan. Don't turn that into starving — keep eating your normal days and let the week do the work.`;
  }
  const abs = Math.abs(netKcal);
  if (onTrack) return `📅 *Your week:* ${loggedDays} days logged, within ~${abs} kcal of budget overall — the week is on track, whatever any single day did.`;
  if (over) {
    return building
      ? `📅 *Your week:* ~${abs} kcal over your building budget across ${loggedDays} days — fine if training is hard; if not, ease back toward target.`
      : `📅 *Your week:* ~${abs} kcal over budget across ${loggedDays} days. That's the week talking, not one day — and the fix is boring: tomorrow stays NORMAL (target, protein first). Never starve to repay a day; that's how diets die.`;
  }
  return building
    ? `📅 *Your week:* ~${abs} kcal UNDER your building budget across ${loggedDays} days — that's muscle fuel left on the table. Eat your full target.`
    : `📅 *Your week:* ~${abs} kcal under budget across ${loggedDays} days — ahead of plan. Keep meals normal; no need to bank more.`;
}

/**
 * GOAL-AWARE STATUS LINE (2026-07-16, founder: "a number must never travel alone").
 * "Over by 117 kcal" means OPPOSITE things per goal — a fat-loss stumble, a muscle-gain
 * plan-working, a recomp drift. ONE education line, goal-aware, never shaming, short
 * enough not to overwhelm. Single source of truth for every food status footer (meal
 * lists, photo path, text path) so the coaching can never drift apart again.
 */
/**
 * ORANGE PROGRESS BARS (2026-07-21, founder wants the graphic from the marketing on the
 * real log — "those orange things… protein, carbs, fats"). WhatsApp has no bar UI, but it
 * renders emoji: brand-orange 🟧 fill on a ⬜ track reads as a real progress bar, no image
 * needed. Pure. Rows with no target are dropped so a bar never lies. Fill caps at 100%.
 */
export function progressBar(current: number, target: number, segments = 10): string {
  const pct = target > 0 ? Math.max(0, Math.min(1, current / target)) : 0;
  const filled = Math.round(pct * segments);
  return "🟧".repeat(filled) + "⬜".repeat(segments - filled);
}
export function macroBarsBlock(rows: Array<{ label: string; current: number; target: number; unit?: string }>): string {
  const valid = rows.filter(r => r.target > 0);
  if (valid.length === 0) return "";
  return valid
    .map(r => `${r.label} ${progressBar(r.current, r.target)} ${Math.round(r.current)}/${Math.round(r.target)}${r.unit || ""}`)
    .join("\n");
}

export function goalStatusLine(goalType: string | null | undefined, calRemaining: number): string {
  // HEALTH-LED goals (general wellness / has-a-condition) never get a kcal/deficit footer
  // (2026-07-21 spine surgery, founder: "even if we don't overpay somebody with numbers…
  // educate the ones that don't want numbers"). A gogo gets a warm, plain-language line
  // about the habit, never a calorie budget. Body-comp goals keep their numbers below.
  if (!getGoalProfile(goalType).usesMacros) {
    return `Logged 👌 Real food, tracked — that's the habit that actually changes things. Protein on the plate and a bit of a walk today, and you're winning.`;
  }
  const goal = (goalType || "fat_loss").toLowerCase();
  const over = Math.abs(Math.min(0, calRemaining));
  const building = goal === "muscle_gain" || goal === "weight_gain";
  if (calRemaining > 100) {
    const meals = remainingInMeals(calRemaining);
    return building
      ? `~${calRemaining} kcal still to eat — the surplus IS the muscle fuel, don't leave it on the table.`
      : `~${calRemaining} kcal still available${meals ? ` — ${meals}` : ""}. Deficit on track. ✅`;
  }
  if (calRemaining >= -100) {
    return building
      ? `Target hit — surplus landed. That's exactly how muscle gets built. ✅`
      : goal === "recomposition" || goal === "maintenance"
        ? `Right on the line — recomp lives exactly here. ✅`
        : `Right on target. This is how the weight comes off — one honest day at a time. ✅`;
  }
  if (building) {
    return over <= 400
      ? `~${over} kcal past target — the surplus is already built INTO your target, so aim to stop at it. Occasionally over is fine in a building phase.`
      : `~${over} kcal over — a surplus builds muscle, a flood builds fat. Cap it here; back to target tomorrow.`;
  }
  return `Over by ~${over} kcal. One day never breaks a ${goal === "recomposition" || goal === "maintenance" ? "recomp" : "deficit"} — the WEEK decides. Next meal: protein + veg, and a 20-minute walk claws most of this back.`;
}
