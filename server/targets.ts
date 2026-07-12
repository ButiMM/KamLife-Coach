// ============================================================
// TARGET CALCULATION
// Mifflin-St Jeor BMR (gold standard) + activity + goal adjustment
// Gender, age, height all factor in — no more one-size-fits-all
// ============================================================

export function calculateTargets(
  weightKg: number,
  goalType: string,
  lifeSituation: string,
  trainingDaysPerWeek: number,
  gender: string = "male",
  age: number = 30,
  heightCm: number = 170,
  trainingExperience: string = "beginner",
): { calorieTarget: number; proteinTarget: number } {

  const isBreastfeeding = lifeSituation === "postpartum_breastfeeding";

  // ── Mifflin-St Jeor BMR (far more accurate than weight × 22) ──
  // Male:   10 × weight(kg) + 6.25 × height(cm) − 5 × age + 5
  // Female: 10 × weight(kg) + 6.25 × height(cm) − 5 × age − 161
  const isFemale = gender === "female";
  const bmr = isFemale
    ? (10 * weightKg) + (6.25 * heightCm) - (5 * age) - 161
    : (10 * weightKg) + (6.25 * heightCm) - (5 * age) + 5;

  // ── Activity multiplier based on life situation ──
  const activityMult: Record<string, number> = {
    office: 1.3,
    student: 1.35,
    unemployed: 1.25,
    retired: 1.2,
    stay_home_parent: 1.3,
    retail_physical: 1.5,
    domestic_worker: 1.45,
    postpartum_breastfeeding: 1.35,
    "1": 1.35,  // student
    "2": 1.3,   // office
    "3": 1.5,   // physical job
    "4": 1.25,  // unemployed
    "5": 1.3,   // stay home parent
    "6": 1.2,   // retired
  };
  const mult = activityMult[lifeSituation] || 1.3;

  // ── Training calorie addition (spread over 7 days) ──
  // Smaller addition for females — metabolic reality
  // Beginners work at lower intensity initially; advanced athletes burn more per session
  const calPerSession = isFemale ? 150 : 200;
  const expMult = trainingExperience === "advanced" ? 1.2 : trainingExperience === "intermediate" ? 1.0 : 0.75;
  const trainingAdj = Math.round((calPerSession * expMult * Math.min(trainingDaysPerWeek, 7)) / 7);

  // ── Goal adjustment ──
  // Fat loss deficit is smaller for females to preserve hormonal health
  // Breastfeeding: never create a large deficit — 200 kcal max to protect milk supply
  const goalAdj: Record<string, number> = {
    fat_loss: isBreastfeeding ? -200 : (isFemale ? -300 : -400),
    muscle_gain: isFemale ? 250 : 400,
    recomposition: 0,
    general: isFemale ? 50 : 100,
    health_condition: 0,
  };
  const adj = goalAdj[goalType] ?? 0;

  let calorieTarget = Math.round(bmr * mult + trainingAdj + adj);

  // ── Breastfeeding calorie bonus — milk production burns 300–500 kcal/day ──
  if (isBreastfeeding) calorieTarget += 400;

  // ── Safety floors by gender ──
  // Breastfeeding: 1,800 kcal is the clinical minimum — below this, milk supply drops
  const minCal = isBreastfeeding ? 1800 : (isFemale ? 1200 : 1500);
  // NaN guard: if any input (weight/age/height/bmr) was non-numeric, never ship "NaN kcal".
  calorieTarget = Number.isFinite(calorieTarget) ? Math.max(minCal, Math.min(4500, calorieTarget)) : minCal;

  // ── Protein target ──
  // Fat loss: higher protein preserves muscle
  // Muscle gain: high protein for growth
  // Female: slightly lower per-kg need
  const proteinMult: Record<string, number> = {
    fat_loss: isFemale ? 1.8 : 2.0,
    muscle_gain: isFemale ? 1.9 : 2.2, // evidence tops out ~2.2g/kg; 2.4 created daily "50g short" failure-nagging
    recomposition: isFemale ? 1.8 : 2.2,
    general: isFemale ? 1.6 : 1.8,
    health_condition: isFemale ? 1.6 : 2.0,
  };
  // Protein need follows LEAN mass, not total mass. Scaling off total bodyweight
  // prescribed a 140kg client 280g/day — physiologically pointless, unaffordable in
  // this market (~R100+/day of protein), and demoralizing enough to churn. Clinical
  // standard for BMI ≥ 30: adjusted bodyweight = ideal (BMI 22) + 40% of the excess.
  const safeWeight = Number.isFinite(weightKg) ? weightKg : 75;
  const bmiP = heightCm > 0 ? safeWeight / Math.pow(heightCm / 100, 2) : 0;
  const idealKg = 22 * Math.pow(heightCm / 100, 2);
  const proteinRefKg = bmiP >= 30 ? idealKg + 0.4 * (safeWeight - idealKg) : safeWeight;
  let proteinTarget = Math.round(proteinRefKg * (proteinMult[goalType] || 2.0));
  proteinTarget = Math.min(proteinTarget, 220); // absolute ceiling — matches the auto-adjust cap

  // Breastfeeding: minimum 70g protein — quality matters for breast milk composition
  if (isBreastfeeding) proteinTarget = Math.max(70, proteinTarget);

  // ── Age adjustments ──
  // Youth: don't over-restrict
  if (age < 18) {
    calorieTarget = Math.max(calorieTarget, isFemale ? 1600 : 1800);
    proteinTarget = Math.min(proteinTarget, Math.round(proteinRefKg * 1.8)); // don't overload growing bodies
  }
  // Elderly: preserve muscle, moderate calories
  if (age >= 60) {
    proteinTarget = Math.max(proteinTarget, Math.round(proteinRefKg * 1.6)); // elderly need MORE protein not less
    calorieTarget = Math.max(calorieTarget, isFemale ? 1400 : 1600);
  }

  return { calorieTarget, proteinTarget };
}

// ============================================================
// STEP TARGET — goal-aware, lifestyle-aware starting goal.
// Food creates the primary calorie deficit — steps are supplemental NEAT.
// Muscle-gain clients run a calorie surplus; pushing high steps burns the
// surplus they need to build. Fat-loss clients still need to eat right first;
// steps add bonus burn on top, not replace dietary discipline.
// Pure function — no DB, unit-tested in script/unit-tests.ts.
// ============================================================
export function calculateStepsTarget(
  weightKg: number,
  age: number,
  heightCm: number,
  trainingExperience: string = "beginner",
  goalType: string = "fat_loss",
): number {
  // Goal-type base: set the ceiling based on what role steps play for this goal.
  const goal = (goalType || "fat_loss").toLowerCase();
  let stepsTarget: number;
  if (goal === "muscle_gain") stepsTarget = 6000;       // health floor; preserve calorie surplus
  else if (goal === "recomposition") stepsTarget = 8000; // food + steps share the work
  else stepsTarget = 8500;                              // fat_loss: realistic + sustainable

  // BMI-based easing — heavier bodies start lower (knees, ankles, sustainability).
  const bmi = heightCm > 0 ? weightKg / Math.pow(heightCm / 100, 2) : 0;
  if (bmi >= 40) stepsTarget = Math.min(stepsTarget, 5500);
  else if (bmi >= 35) stepsTarget = Math.min(stepsTarget, 6500);
  else if (bmi >= 30) stepsTarget = Math.min(stepsTarget, 7500);

  // Age-based easing (independent of BMI) — take the gentler of the two.
  if (age >= 70) stepsTarget = Math.min(stepsTarget, 5500);
  else if (age >= 60) stepsTarget = Math.min(stepsTarget, 7500);

  // Never-trained beginners start lower regardless, then ramp up as the habit builds.
  if (trainingExperience === "beginner") stepsTarget = Math.min(stepsTarget, 7500);

  // Floor — keep the goal meaningful even for the most deconditioned start.
  if (stepsTarget < 4000) stepsTarget = 4000;

  return stepsTarget;
}

// ============================================================
// ADAPTIVE STEP TARGET — right-size the goal to what the client actually walks.
// 2026-07-12, Kam: "I usually tell people 10,000 and it works, but 50% of my clients
// can't walk 10,000 — we need to make a plan about that." The onboarding target is
// smart, but it's set once and never learns. After a week of real data this suggests a
// change: DOWN when they're consistently well under (so nobody stares at a number they
// never hit — meet them where they are, then build), UP when they're smashing it. It
// only SUGGESTS — the client taps to accept, we never override their choice silently.
// Pure — no DB, unit-tested.
// ============================================================
export interface StepTargetAdjustment {
  newTarget: number;
  direction: "down" | "up";
  reason: string; // short, kind, client-facing
}

export function suggestStepTargetAdjustment(
  currentTarget: number,
  avgSteps: number,
  daysLogged: number,
): StepTargetAdjustment | null {
  if (!currentTarget || currentTarget < 2000) return null;
  if (daysLogged < 4 || avgSteps <= 0) return null; // not enough real data to judge fairly
  const roundTo500 = (n: number) => Math.max(3000, Math.round(n / 500) * 500);
  const pct = avgSteps / currentTarget;

  // Consistently well under → lower to a target they'll actually hit, plus a small stretch.
  if (pct < 0.7) {
    const newTarget = roundTo500(avgSteps + 750);
    if (newTarget >= currentTarget) return null; // rounding didn't move it meaningfully
    return {
      newTarget,
      direction: "down",
      reason: `You averaged ${Math.round(avgSteps).toLocaleString()} this week. No stress — let's make *${newTarget.toLocaleString()}* your goal so you WIN every day, then build up from there.`,
    };
  }

  // Consistently at/over → nudge up so the goal keeps pulling them forward.
  if (pct >= 1.0 && currentTarget < 12000) {
    const newTarget = Math.min(12000, roundTo500(currentTarget + 1000));
    if (newTarget <= currentTarget) return null;
    return {
      newTarget,
      direction: "up",
      reason: `You're smashing ${currentTarget.toLocaleString()} every day 👏 — ready to climb to *${newTarget.toLocaleString()}*?`,
    };
  }

  return null; // 70–100%: appropriately challenged — leave it alone.
}

// ============================================================
// WATER TARGET — the ONE canonical daily hydration goal (2026-07-12, Kam: "apply the
// same precision to all the other core areas"). 33 ml per kg of body weight, floored at
// a sensible 2.0 L and rounded to one decimal. This exact expression was copy-pasted in
// SIX places and one had already drifted (lifecycle.ts: no floor, different rounding),
// so a 50 kg client saw 1.7 L on one screen and 2.0 L on another — the same core number
// contradicting itself. One source of truth now. Pure — no DB, unit-tested.
// ============================================================
export function waterTargetLitres(weightKg?: number | string | null): number {
  const w = typeof weightKg === "string" ? parseFloat(weightKg) : weightKg;
  const kg = Number.isFinite(w as number) && (w as number) > 0 ? (w as number) : 75;
  return Math.max(2.0, Math.round(kg * 0.033 * 10) / 10);
}

// ============================================================
// STEP BURN — the ONE canonical walking-energy formula (2026-07-12, Kam: "we need to
// be exactly precise… steps incorporated into [the deficit]"). Three call sites used to
// disagree: the step logger and the "how much did I burn" answer scaled by body weight
// (off 70kg AND 75kg — even those two disagreed), while the daily-deficit offset in the
// food logger used a FLAT rate and under-credited every heavy client. Now all of them
// use this. ~0.04 kcal/step at 70kg, scaled linearly by weight — a 120kg body genuinely
// moves ~1.7× the mass per step of a 70kg one, so the deficit must reflect that.
// Pure — no DB, unit-tested.
// ============================================================
export function stepBurnKcal(steps: number, weightKg?: number | null): number {
  const s = Number.isFinite(steps) && steps > 0 ? steps : 0;
  let w = Number.isFinite(weightKg as number) ? (weightKg as number) : 70;
  if (w < 35) w = 70;      // junk/missing weight → assume an average adult
  else if (w > 250) w = 250; // clamp implausible extremes
  return Math.round(s * 0.04 * (w / 70));
}

// ============================================================
// DAILY STEP CONTEXT — real-time adjustment for today's situation.
// On workout days the gym session already burned 300-450 kcal; reduce step
// demand so clients aren't double-taxed and can recover properly.
// Returns the adjusted target + a floor range (hitting rangeMin is still a win).
// Pure function — no DB, unit-tested in script/unit-tests.ts.
// ============================================================
export function getDailyStepContext(
  baseTarget: number,
  goalType: string,
  alreadyWorkedOutToday: boolean,
): { target: number; rangeMin: number; goalContext: "fat_loss" | "muscle_gain" | "recomp" } {
  const goal = (goalType || "fat_loss").toLowerCase();
  let target = baseTarget;

  if (goal === "muscle_gain") {
    // Protect the calorie surplus — on workout days the body needs fuel for recovery.
    target = alreadyWorkedOutToday ? Math.max(4000, Math.round(baseTarget * 0.80)) : baseTarget;
  } else if (goal === "fat_loss" || goal === "weight_loss") {
    // Workout already burned — ease the step load; no need to double-tax.
    target = alreadyWorkedOutToday ? Math.round(baseTarget * 0.78) : baseTarget;
  } else {
    // Recomposition
    target = alreadyWorkedOutToday ? Math.round(baseTarget * 0.82) : baseTarget;
  }

  target = Math.max(4000, target);
  const rangeMin = Math.round(target * 0.82);

  const goalContext: "fat_loss" | "muscle_gain" | "recomp" =
    goal === "muscle_gain" ? "muscle_gain"
    : (goal === "fat_loss" || goal === "weight_loss") ? "fat_loss"
    : "recomp";

  return { target, rangeMin, goalContext };
}

// ============================================================
// ENERGY FRAME — one sentence that anchors maintenance/surplus/deficit semantics
// for every model prompt. The calorie target ALREADY includes the goal adjustment;
// without this line the model invents a maintenance number and answers "what should
// my surplus be?" with today's remaining kcal (2026-07-06 audit). Shared by the
// brain snapshot AND the GPT fallback so both mouths state the same energy truth.
// Pure — unit-tested in script/unit-tests.ts.
// ============================================================
export function energyFrameLine(goalType: string | null | undefined, calorieTarget: number | null | undefined): string | null {
  const target = Number(calorieTarget) || 0;
  if (target <= 0) return null;
  if (goalType === "muscle_gain") {
    return `Energy frame: maintenance ≈ ${target - 400} kcal (estimate). The ${target} kcal target ALREADY includes the muscle-gain surplus (~300–500 above maintenance) — if asked what their surplus should be: it is built into the target; eating to ${target} IS the surplus. Surplus/deficit describe a FULL day vs maintenance, never the gap left mid-day.`;
  }
  if (goalType === "fat_loss") {
    return `Energy frame: maintenance ≈ ${target + 450} kcal (estimate). The ${target} kcal target ALREADY includes the fat-loss deficit — eating to ${target} IS the plan. Surplus/deficit describe a FULL day vs maintenance, never the gap left mid-day.`;
  }
  return `Energy frame: the ${target} kcal target is the daily plan for this goal. Surplus/deficit describe a FULL day vs maintenance, never the gap left mid-day.`;
}
