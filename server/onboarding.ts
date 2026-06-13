import { db } from "./db";
import { users, weightLogs, chatHistory, stepLogs } from "../shared/schema";
import { eq, and, desc, gte } from "drizzle-orm";
import { buildFullProgramme, getKamlifeProgramme } from "./programme";
import { calculateTargets, calculateStepsTarget } from "./targets";
import { replyWithButtons } from "./twilio-interactive";
import { askCoachK } from "./gpt";
import { getShoppingList, formatShoppingList } from "./shopping-lists";
import { getDisplayName, sastDayStart } from "./utils";
import { getTodayWorkoutState } from "./workout-state";

// ============================================================
// MENU TEXT — context-aware
// ============================================================

export async function getMenuText(user: any, opts?: { showCommands?: boolean }): Promise<string> {
  const name = getDisplayName(user);
  const hey = name ? `Hey ${name} 👋` : `Hey 👋`;
  const mode = user.trainingMode || "home";
  const stepsTarget = user.stepsTarget || 8000;

  const todayStart = sastDayStart();

  let todayStepCount: number | null = null;
  let workoutState: Awaited<ReturnType<typeof getTodayWorkoutState>>;

  try {
    const [todaySteps, ws] = await Promise.all([
      db.select().from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStart)))
        .limit(1),
      getTodayWorkoutState(user),
    ]);
    todayStepCount = todaySteps.length > 0 ? todaySteps[0].steps : null;
    workoutState = ws;
  } catch {
    workoutState = await getTodayWorkoutState(user);
  }

  // Trial countdown — business-critical, stays on every greeting
  let trialLine = "";
  if (user.subscriptionStatus === "trial" && user.betaBypassUntil) {
    const daysLeft = Math.max(0, Math.ceil((new Date(user.betaBypassUntil).getTime() - Date.now()) / 86_400_000));
    trialLine = daysLeft <= 3
      ? `\n\n⏰ *${daysLeft} day${daysLeft !== 1 ? "s" : ""} left on free trial* — reply *pay* to keep coaching`
      : `\n\n_Free trial: ${daysLeft} days remaining_`;
  }

  // Full command list only when explicitly asked (menu/help) or the user is lost.
  // A greeting gets a coach, not a sitemap.
  const commandsBlock = opts?.showCommands
    ? `\n\n*What you can send me:*\n🍳 Any meal — photo, voice note or plain text. I do the maths.\n💪 _workout_ · _done_ · _tomorrow's session_\n📊 _my progress_ · _weight 82_ · _steps 6000_\n🛒 _shopping list_ · _meal prep_ · _supplements_\n⚙️ _my water_ · _badges_ · _referral_ · _connect steps_ · _pause_`
    : "";

  const tail = `${commandsBlock}${trialLine}`;

  const daysSilent = user.lastActiveAt
    ? Math.floor((Date.now() - new Date(user.lastActiveAt).getTime()) / 86_400_000)
    : 0;

  // Already done today
  if (workoutState.type === "ALREADY_DONE") {
    const body = todayStepCount !== null && todayStepCount < stepsTarget
      ? `Session done ✅ — ${(stepsTarget - todayStepCount).toLocaleString()} steps to go and today's full.`
      : `Session done ✅ — good work today.`;
    return `${hey} ${body}${tail}[BUTTONS:Log food|My progress|Tomorrow's session]`;
  }

  // Rest day
  if (workoutState.type === "REST") {
    return `${hey} ${workoutState.todayName} — rest day. Next session: ${workoutState.nextTrainingName}.\n\nRecovery is where the work pays off. Protein in, water up, walk if you can.${tail}[BUTTONS:Log food|My progress|Tomorrow's session]`;
  }

  // Missed sessions — flag it in the greeting
  if (workoutState.type === "MISSED") {
    const missed = workoutState.missedSessions.join(" + ");
    return `${hey} You missed ${missed}. ${workoutState.todayName} is still a training day — let's get it done.${tail}[BUTTONS:Today's workout|Log food|My progress]`;
  }

  // Returning after silence
  if (daysSilent >= 3) {
    const daysText = daysSilent <= 7 ? `${daysSilent} days` : "a while";
    return `${hey} Been ${daysText} — no lecture. We pick up where you left off.${tail}[BUTTONS:Today's workout|Log food|My progress]`;
  }

  // Normal training day
  const stepsSoFar = todayStepCount !== null
    ? ` You're at ${todayStepCount.toLocaleString()} steps — ${todayStepCount >= stepsTarget ? "target hit ✅" : `${(stepsTarget - todayStepCount).toLocaleString()} to go`}.`
    : "";
  const trainBody = mode === "walk_only"
    ? `Today's job: ${stepsTarget.toLocaleString()} steps.${stepsSoFar}`
    : `Training day — your session's ready.${stepsSoFar}`;
  return `${hey} ${trainBody}${tail}[BUTTONS:Today's workout|Log food|My progress]`;
}

// ============================================================
// ONBOARDING MEAL PLAN
// ============================================================

export function getOnboardingMealPlan(user: any): string {
  const budget = user.weeklyFoodBudget || "100_300";
  const goal = user.goalType || "fat_loss";
  const medicals = (user.medicalConditions || "").split(",").map((s: string) => s.trim());
  const situation = user.lifeSituation || "office";
  const schedule = user.workSchedule || "standard";
  const daysPerWeek = user.trainingDaysPerWeek || 3;
  const name = user.name || "there";
  const cal = user.calorieTarget || 1800;
  const prot = user.proteinTarget || 140;
  const otherNotes = (user.otherMedicalNotes || "").toLowerCase();

  // Medical flags
  const isDiabetic = medicals.includes("diabetes");
  const isHypertension = medicals.includes("hypertension");
  const isPCOS = medicals.includes("pcos");
  const isHIV = medicals.includes("hiv_arvs");
  const isLowGI = isDiabetic || isPCOS;
  const isNightShift = schedule === "night_shift";
  const isStudent = situation === "student";
  const isUnemployed = situation === "unemployed";
  const isPhysicalJob = situation === "retail_physical";

  // Allergy detection from free-text notes
  const noPeanuts = otherNotes.includes("peanut");
  const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard") || otherNotes.includes("sardine") || otherNotes.includes("tuna");
  const noDairy = otherNotes.includes("dairy") || otherNotes.includes("milk") || otherNotes.includes("lactose");
  const noGluten = otherNotes.includes("gluten") || otherNotes.includes("coeliac") || otherNotes.includes("wheat") || otherNotes.includes("celiac");

  // Calorie/protein adjustments
  const adjustedCal = isPhysicalJob ? cal + 300 : isHIV ? cal + 200 : cal;
  const adjustedProt = isHIV ? Math.round(prot * 1.2) : prot;

  const goalLabels: Record<string, string> = {
    fat_loss: "Fat loss", muscle_gain: "Muscle gain", recomposition: "Body recomposition",
    general: "General fitness", health_condition: "Health management",
  };
  const budgetLabels: Record<string, string> = {
    under_100: "Under R100", "100_300": "R100–R300", "300_600": "R300–R600", over_600: "Over R600",
  };

  // Medical flags for header
  const medFlags: string[] = [];
  if (isDiabetic) medFlags.push("Diabetic protocol — low GI carbs, strict meal timing");
  if (isHypertension) medFlags.push("Hypertension — low sodium, no Aromat, no processed meats");
  if (isPCOS) medFlags.push("PCOS — low GI, anti-inflammatory");
  if (isHIV) medFlags.push("HIV/ARVs — take with breakfast, +20% protein");
  if (noPeanuts) medFlags.push("Peanut allergy — PB removed");
  if (noFish) medFlags.push("Fish allergy — pilchards/tuna replaced with eggs/chicken");
  if (noDairy) medFlags.push("Dairy free");
  if (noGluten) medFlags.push("Gluten free");

  // Training day layout
  const allDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  let trainingSet: Set<string>;
  if (daysPerWeek >= 6) trainingSet = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
  else if (daysPerWeek === 5) trainingSet = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
  else if (daysPerWeek === 4) trainingSet = new Set(["Monday", "Tuesday", "Thursday", "Friday"]);
  else if (daysPerWeek === 3) trainingSet = new Set(["Monday", "Wednesday", "Friday"]);
  else if (daysPerWeek === 2) trainingSet = new Set(["Monday", "Thursday"]);
  else trainingSet = new Set(["Wednesday"]);

  const meal1Label = isNightShift ? "Pre-shift meal" : "Breakfast";
  const meal3Label = isNightShift ? "Post-shift meal" : "Dinner";
  const maxPrep = isStudent ? "8 min" : "20 min";

  // ---- BREAKFAST proteins (egg-based, always appropriate for morning) ----
  const bfProteins = goal === "muscle_gain"
    ? ["3 whole eggs", "3 whole eggs + banana", "3 whole eggs", "3 whole eggs + banana", "3 whole eggs", "3 whole eggs", "3 whole eggs + banana"]
    : ["2 boiled eggs", "2 boiled eggs", "2 boiled eggs", "2 boiled eggs", "2 boiled eggs", "2 boiled eggs", "2 boiled eggs"];

  // ---- LUNCH/DINNER proteins — varied, no repeats more than twice ----
  let lunchProteins: string[];
  let dinnerProteins: string[];
  if (budget === "under_100") {
    lunchProteins = noFish
      ? ["3 boiled eggs", "sugar beans (200g cooked)", "3 boiled eggs + sugar beans", "2 boiled eggs", "sugar beans (200g)", "3 boiled eggs", "2 boiled eggs"]
      : ["1 tin pilchards", "2 boiled eggs", "1 tin pilchards", "sugar beans (200g)", "1 tin pilchards", "2 boiled eggs + sugar beans", "1 tin pilchards"];
    dinnerProteins = noFish
      ? ["2 boiled eggs", "3 boiled eggs", "2 boiled eggs", "sugar beans (200g)", "2 boiled eggs", "3 boiled eggs", "2 boiled eggs"]
      : ["½ tin pilchards", "2 boiled eggs", "½ tin pilchards", "2 boiled eggs", "sugar beans (200g)", "½ tin pilchards", "2 boiled eggs"];
  } else if (budget === "100_300") {
    lunchProteins = noFish
      ? ["150g chicken thigh", "3 boiled eggs", "150g chicken thigh", "2 boiled eggs + baked beans", "150g chicken thigh", "3 boiled eggs", "150g chicken thigh"]
      : ["1 tin pilchards", "150g chicken thigh", "1 tin pilchards", "150g chicken thigh", "2 boiled eggs + baked beans", "1 tin pilchards", "150g chicken thigh"];
    dinnerProteins = noFish
      ? ["2 boiled eggs", "150g chicken thigh", "2 boiled eggs", "150g chicken thigh", "2 boiled eggs", "150g chicken thigh", "3 boiled eggs"]
      : ["150g chicken thigh", "2 boiled eggs", "½ tin pilchards", "150g chicken thigh", "2 boiled eggs", "½ tin pilchards", "150g chicken thigh"];
  } else if (budget === "300_600") {
    lunchProteins = noFish
      ? ["150g chicken thigh", "100g beef mince", "150g chicken breast", "100g beef mince", "150g chicken thigh", "2 eggs + cottage cheese", "100g beef mince"]
      : ["150g chicken thigh", "1 tin pilchards", "100g beef mince", "150g chicken breast", "1 tin pilchards", "150g chicken thigh", "100g beef mince"];
    dinnerProteins = noFish
      ? ["100g beef mince", "150g chicken breast", "2 eggs + cottage cheese", "150g chicken thigh", "100g beef mince", "150g chicken breast", "150g chicken thigh"]
      : ["100g beef mince", "150g chicken thigh", "1 tin pilchards", "100g beef mince", "150g chicken breast", "2 eggs", "100g beef mince"];
  } else {
    lunchProteins = noFish
      ? ["150g chicken breast", "150g beef mince", "150g chicken breast", "3 eggs + cottage cheese", "150g chicken thigh", "150g beef mince", "150g chicken breast"]
      : ["150g chicken breast", "200g salmon", "150g beef mince", "150g chicken breast", "1 tin pilchards", "150g chicken thigh", "200g salmon"];
    dinnerProteins = noFish
      ? ["150g beef mince", "150g chicken breast", "150g chicken thigh", "150g beef mince", "3 eggs + cottage cheese", "150g chicken thigh", "150g beef mince"]
      : ["150g beef mince", "150g chicken breast", "200g salmon", "150g chicken thigh", "150g beef mince", "1 tin pilchards", "150g chicken thigh"];
  }

  // ---- BREAKFAST carbs (oats, bread, sweet potato — morning foods only) ----
  let bfCarbs: string[];
  if (isLowGI) {
    bfCarbs = noGluten
      ? ["½ cup oats", "½ cup samp and beans", "½ cup oats", "½ cup samp and beans", "½ cup oats", "½ cup brown rice", "½ cup oats"]
      : ["½ cup oats", "½ cup samp and beans", "½ cup oats", "½ cup samp and beans", "½ cup oats", "½ cup samp and beans", "½ cup oats"];
  } else if (goal === "muscle_gain") {
    bfCarbs = noGluten
      ? ["1 cup oats", "2 sweet potatoes", "1 cup oats", "2 sweet potatoes", "1 cup oats", "2 sweet potatoes", "1 cup oats"]
      : ["1 cup oats", "2 slices brown bread", "1 cup oats", "2 slices brown bread", "1 cup oats", "2 slices brown bread", "1 cup oats"];
  } else {
    bfCarbs = noGluten
      ? ["1 medium sweet potato", "½ cup oats", "1 medium sweet potato", "½ cup oats", "1 medium sweet potato", "½ cup oats", "1 medium sweet potato"]
      : ["½ cup oats", "2 slices brown bread", "½ cup oats", "2 slices brown bread", "½ cup oats", "2 slices brown bread", "½ cup oats"];
  }

  // ---- LUNCH carbs (no oats — meal-appropriate starches) ----
  let lunchCarbs: string[];
  if (isLowGI) {
    lunchCarbs = noGluten
      ? ["1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato"]
      : ["1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato"];
  } else if (goal === "muscle_gain") {
    lunchCarbs = ["1 cup brown rice", "2 sweet potatoes", "1 cup brown rice", "2 sweet potatoes", "1 cup brown rice", "2 sweet potatoes", "1 cup brown rice"];
  } else if (goal === "fat_loss") {
    lunchCarbs = noGluten
      ? ["1 medium sweet potato", "½ cup brown rice", "1 medium sweet potato", "½ cup brown rice", "1 medium sweet potato", "½ cup brown rice", "1 medium sweet potato"]
      : ["½ cup brown rice", "1 medium sweet potato", "2 slices brown bread", "½ cup brown rice", "1 medium sweet potato", "2 slices brown bread", "½ cup brown rice"];
  } else {
    lunchCarbs = noGluten
      ? ["1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato"]
      : ["½ cup brown rice", "1 medium sweet potato", "2 slices brown bread", "½ cup brown rice", "1 medium sweet potato", "½ cup brown rice", "2 slices brown bread"];
  }

  // ---- DINNER carbs — lighter for fat loss, same as lunch for others ----
  let dinnerCarbs: string[];
  if (goal === "fat_loss") {
    dinnerCarbs = noGluten
      ? ["½ medium sweet potato", "½ cup samp and beans", "½ medium sweet potato", "½ cup brown rice", "½ medium sweet potato", "½ cup samp and beans", "½ medium sweet potato"]
      : ["½ cup brown rice", "½ medium sweet potato", "½ cup samp and beans", "½ medium sweet potato", "½ cup brown rice", "½ medium sweet potato", "½ cup samp and beans"];
  } else if (goal === "recomposition") {
    // Recomp: carbs on training days, veg-only on rest days — use isTraining per-day in the loop, not hardcoded positions
    dinnerCarbs = allDays.map((day) => trainingSet.has(day) ? "½ medium sweet potato" : "extra veg only (rest day)") as string[];
  } else {
    dinnerCarbs = lunchCarbs;
  }

  // Vegetables rotation
  const vegOptions = ["cabbage (boiled)", "spinach (wilted)", "cabbage + tomato", "spinach + onion",
    budget !== "under_100" ? "frozen mixed veg" : "cabbage", "spinach + tomato", "cabbage + onion"];

  // Dairy/milk based on goal
  const milkType = (goal === "muscle_gain" && !noDairy && budget !== "under_100") ? "full cream milk" : (!noDairy ? "low fat milk" : "water");
  const pbServing = noPeanuts ? (budget !== "under_100" ? "1 extra egg" : "extra sugar beans") : (goal === "muscle_gain" ? "2 tbsp peanut butter" : "1 tbsp peanut butter");

  // Pre-workout options (training days)
  const preOptions = [
    noGluten ? `banana + 2 egg whites — 180 cal, 14g protein, 5 min` : `2 brown bread + ${noPeanuts ? "1 boiled egg" : "1 tbsp peanut butter"} — 220 cal, 12g protein, 3 min`,
    `½ cup oats + 1 egg white + banana — 200 cal, 10g protein, 5 min`,
    noFish ? `banana + 1 boiled egg — 180 cal, 10g protein, 2 min` : `banana + ¼ tin pilchards — 180 cal, 14g protein, 2 min`,
    `½ cup oats + ${milkType} — 190 cal, 8g protein, 5 min`,
  ];

  // Post-workout options (training days)
  const postOptions = [
    noFish ? `3 boiled eggs + 1 medium sweet potato — 340 cal, 24g protein` : `½ tin pilchards + ½ cup pap — 280 cal, 22g protein`,
    `2 eggs + 1 medium sweet potato — 290 cal, 18g protein`,
    noFish ? `150g chicken + ½ cup rice — 320 cal, 30g protein` : `1 tin pilchards + 2 brown bread slices — 300 cal, 25g protein`,
    `2 eggs + banana — 250 cal, 16g protein`,
  ];

  // Calorie split per meal
  const bfCal = Math.round(adjustedCal * 0.25);
  const lunchCal = Math.round(adjustedCal * 0.35);
  const dinnerCal = Math.round(adjustedCal * 0.28);

  // Build 7-day plan
  let plan = "";
  allDays.forEach((day, i) => {
    const isTraining = trainingSet.has(day);
    const bfProt = bfProteins[i];
    const bfCarb = bfCarbs[i];
    const lp = lunchProteins[i];
    const lc = lunchCarbs[i];
    const dp = dinnerProteins[i];
    const dc = dinnerCarbs[i];
    const v = vegOptions[i % vegOptions.length];
    const v2 = vegOptions[(i + 3) % vegOptions.length];
    const pre = preOptions[i % preOptions.length];
    const post = postOptions[i % postOptions.length];

    // ---- BREAKFAST ----
    let bf: string;
    if (isStudent) {
      bf = i % 2 === 0
        ? `½ cup oats + ${noDairy ? "water" : "low fat milk"} + 1 boiled egg — ${bfCal} cal, 14g protein, 8 min`
        : noGluten ? `2 boiled eggs + banana — ${bfCal} cal, 15g protein, 5 min` : `2 boiled eggs + 2 brown bread — ${bfCal} cal, 16g protein, 8 min`;
    } else if (isLowGI) {
      bf = i % 2 === 0
        ? `${bfCarb} + ${noDairy ? "" : `${milkType} + `}2 boiled eggs — ${bfCal} cal, 18g protein, ${maxPrep}`
        : `${bfCarb} + 1 boiled egg — ${bfCal} cal, 16g protein, 20 min (batch cook Sunday)`;
    } else if (goal === "muscle_gain") {
      bf = i % 3 === 0
        ? `${bfProt} + ${bfCarb} + ${milkType} — ${bfCal} cal, 26g protein, ${maxPrep}`
        : i % 3 === 1 ? `${bfProt} + banana + ${pbServing} — ${bfCal} cal, 24g protein, ${maxPrep}`
        : `${bfProt} + ${bfCarb} + banana — ${bfCal} cal, 24g protein, ${maxPrep}`;
    } else {
      bf = i % 2 === 0
        ? `${bfCarb} + ${bfProt} — ${bfCal} cal, 18g protein, ${maxPrep}`
        : noGluten ? `${bfProt} + 1 medium sweet potato — ${bfCal} cal, 16g protein, ${maxPrep}` : `${bfProt} + 2 brown bread — ${bfCal} cal, 16g protein, ${maxPrep}`;
    }

    // ---- LUNCH ----
    const seasonNote = isHypertension ? " (season: lemon + garlic, no Aromat)" : "";
    let lunch: string;
    if (isStudent) {
      lunch = noFish
        ? `${lp} + ${lc} + ${v} — ${lunchCal} cal, 22g protein, 10 min`
        : i % 2 === 0 ? `1 tin pilchards + ${noGluten ? "1 sweet potato" : "2 brown bread"} — ${lunchCal} cal, 25g protein, 3 min` : `${lp} + ${lc} — ${lunchCal} cal, 20g protein, 10 min`;
    } else {
      lunch = `${lp} + ${lc} + ${v}${seasonNote} — ${lunchCal} cal, 25g protein, ${maxPrep}`;
    }

    // ---- DINNER ----
    let dinner: string;
    if (isStudent) {
      dinner = i % 2 === 0
        ? noFish ? `2 eggs + cabbage — ${dinnerCal} cal, 14g protein, 8 min` : `½ tin pilchards + cabbage — ${dinnerCal} cal, 18g protein, 5 min`
        : `2 eggs + spinach — ${dinnerCal} cal, 14g protein, 8 min`;
    } else {
      dinner = `${dp} + ${dc} + ${v2}${seasonNote} — ${dinnerCal} cal, 25g protein, ${maxPrep}`;
    }

    // Snack
    let snack = "";
    if (budget !== "under_100") {
      if (goal === "muscle_gain") snack = noPeanuts ? `baked beans ½ tin — 110 cal, 7g protein` : `${pbServing} + banana — 260 cal, 9g protein`;
      else if (!noDairy && budget !== "100_300") snack = `low fat yoghurt 150g — 100 cal, 10g protein`;
      else snack = `baked beans ½ tin — 110 cal, 7g protein`;
    }

    const dayLabel = isTraining ? `${day} — Training Day 🏋️` : `${day} — Rest Day`;
    let dayPlan = `\n*${dayLabel}*\n`;
    if (isTraining) dayPlan += `Pre-workout (60–90 min before): ${pre}\n`;
    dayPlan += `${meal1Label}: ${bf}\n`;
    if (isLowGI) dayPlan += `Snack 10am: 1 apple or banana + 1 boiled egg — 120 cal, 8g protein\n`;
    dayPlan += `Lunch: ${lunch}\n`;
    if (isLowGI) dayPlan += `Snack 3pm: ${noDairy ? "1 boiled egg" : "125g low fat yoghurt or 1 boiled egg"} — 80 cal, 8g protein\n`;
    if (isTraining) dayPlan += `Post-workout (within 30 min): ${post}\n`;
    if (snack && !isLowGI) dayPlan += `Snack: ${snack}\n`;
    dayPlan += `${meal3Label}: ${dinner}\n`;
    dayPlan += `Daily total: ≈${adjustedCal} cal, ${adjustedProt}g protein`;
    plan += dayPlan;
  });

  // Shopping list + total + tip by budget
  let shopList: string;
  let shopTotal: number;
  let proTip: string;

  if (budget === "under_100") {
    shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\n${noFish ? "Extra eggs (6 pack) — R25" : "Pilchards 3 tins — R36"}\nSugar beans 500g — R20\nCabbage 1 head — R8\n${isLowGI ? "Oats 500g — R15 (replaces pap)" : "Pap/maize meal 2kg — R15"}\nSpinach 1 bunch — R10\nOnions — R8\nSunflower oil 500ml — R10`;
    shopTotal = 152;
    proTip = "Cook a big pot of sugar beans on Sunday — it feeds you 3 days at under R7 per serving. Add one egg per bowl for complete protein.";
  } else if (budget === "100_300") {
    shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\n${noFish ? "Chicken portions extra 500g — R20" : "Pilchards 3 tins — R36"}\nFrozen chicken portions 1kg — R40\nOats 500g — R15\n${noGluten ? "" : "Brown bread 1 loaf — R14\n"}Sweet potato 1kg — R12\nCabbage — R8\nSpinach — R10\nOnions + tomatoes — R23\nGarlic — R8\nSunflower oil — R10`;
    shopTotal = 221;
    proTip = "Buy a whole frozen chicken instead of portions — cut it yourself and save R15–R20 per kg. Shoprite often runs chicken specials on Tuesdays.";
  } else if (budget === "300_600") {
    shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\nFrozen chicken 1.5kg — R60\nBeef mince 500g — R60\n${noFish ? "" : "Pilchards 2 tins — R24\n"}Oats 1kg — R25\nBrown rice 1kg — R20\nSweet potato 1.5kg — R18\nBanana bunch — R15\n${noDairy ? "" : `${goal === "muscle_gain" ? "Full cream milk 1L — R22" : "Low fat milk 1L — R20"}\n`}${noPeanuts ? "" : "Peanut butter 400g — R25\n"}Spinach — R10\nCabbage — R8\nTomatoes 500g — R15\n${noDairy ? "" : "Cottage cheese 250g — R20\n"}Garlic + lemon — R13`;
    shopTotal = 378;
    proTip = "Brown 500g mince on Sunday and split into 3 portions — that's 3 dinners sorted in one 20-minute cook. Mince gives you the most protein per rand of any red meat.";
  } else {
    shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\nChicken breast 1kg — R80\n${noFish ? "" : "Salmon 400g (×2) — R160\n"}Beef mince 500g — R60\n${noDairy ? "" : "Low fat Greek yoghurt 500g — R35\n"}Oats 1kg — R25\nBrown rice 1kg — R20\nSweet potato 2kg — R24\nBanana bunch — R15\n${noPeanuts ? "" : "Peanut butter 400g — R25\n"}Broccoli — R20\nSpinach — R10\n${noDairy ? "" : "Low fat milk 1L — R20\n"}Almonds 100g — R40\nOlive oil 250ml — R40`;
    shopTotal = 619;
    proTip = "Salmon goes on special at Shoprite most Fridays — buy two packs and freeze immediately. Frozen salmon has identical nutrition to fresh and costs R30 less.";
  }

  // Special situation notes
  const goalNote = goal === "fat_loss"
    ? `\n\n⚠️ *Fat loss rules:* Sweet potato over white pap always. High-volume veg fills the plate first — protein second, carbs last. ${noDairy ? "" : "Low fat dairy only."} ${noPeanuts ? "" : "Max 1 tbsp peanut butter — not a staple."}`
    : goal === "muscle_gain"
    ? `\n\n💪 *Muscle gain rules:* Whole eggs every time — the yolk has the nutrients. ${noDairy ? "" : `${milkType} for extra calories.`} ${noPeanuts ? "" : "Peanut butter is your friend — calorie dense and protein rich."} Pre and post-workout meals are non-negotiable.`
    : goal === "recomposition"
    ? `\n\n🔄 *Recomp rules:* Carbs before and after training. Lower carbs on rest day evenings. Protein stays the same every day — no exceptions. Zero empty calories.`
    : "";
  const nightNote = isNightShift ? `\n\n🌙 *Night shift:* All timings are relative to your shift. Pre-shift = your breakfast. Post-shift = your dinner.` : "";
  const hivNote = isHIV ? `\n\n💊 *ARV reminder:* Take your medication with breakfast every day — never on an empty stomach.` : "";
  const isPostpartumPlan = situation === "postpartum_breastfeeding";
  const domesticNote = (situation === "retail_physical" && !isUnemployed) ? `\n\n🧹 *Active job note:* Your job already burns 300+ extra calories. Plan adjusted. Batch cook Sunday so you have food ready without cooking after long shifts.` : "";
  const studentNote = isStudent ? `\n\n📚 *Student note:* Every meal in this plan is under 10 minutes and under 3 ingredients. Res tuck shop strategy — pilchards + brown bread is one of the best budget meals in SA. Maggi noodles + 1 egg is acceptable when budget is critical.` : "";
  const unemployedNote = isUnemployed ? `\n\n💰 *Budget note:* Every meal here costs under R15. Batch cook beans on Sunday for the week — one 500g bag of sugar beans feeds you protein for 4 days at R5 per serving.` : "";
  const postpartumNote = isPostpartumPlan ? `\n\n🤱 *Breastfeeding plan:* Your calories are set higher to protect your milk supply — do NOT eat less than your target. Losing 0.5kg/week max is the goal. Priority nutrients: *Protein* (eggs, chicken, pilchards — for milk quality), *Calcium* (Clover Amasi, milk, sardines — for baby's bones and yours), *Iron* (red meat, spinach, pilchards — you lost iron in delivery), *Water* (add an extra 500ml/day — breastfeeding is dehydrating). Training: pelvic floor exercises first, gentle walks from week 1, return to gym training at 6 weeks with doctor clearance. No heavy impact until cleared.` : "";

  const trainingDaysStr = Array.from(trainingSet).join(", ");
  const header = `*Your Personalised 7 Day Meal Plan*\n${name} | Goal: ${goalLabels[goal] || goal} | ${adjustedCal} cal/day | ${adjustedProt}g protein/day\nBudget: ${budgetLabels[budget]} per week | Shop at Shoprite or Boxer${medFlags.length > 0 ? `\n⚠️ Medical: ${medFlags.join(" · ")}` : ""}`;
  const trainingLine = `\n*Training Days:* ${trainingDaysStr} (${daysPerWeek} day${daysPerWeek > 1 ? "s" : ""}/week)`;

  const headerBlock = `${header}${trainingLine}${goalNote}${nightNote}${hivNote}${domesticNote}${studentNote}${unemployedNote}${postpartumNote}`;
  const planBlock = plan.trim();
  const shopBlock = `${shopList}\nEstimated total: R${shopTotal}\n🛒 ${proTip}`;
  return `${headerBlock}\n\n---\n\n${planBlock}\n\n---\n\n${shopBlock}\n\n_Reply SWAP [day] to swap a day. Reply SHOPPING LIST for just the shopping list._`;
}

// ============================================================
// ONBOARDING COMPLETION HELPER
// Called from ASK_BUDGET (legacy path) and ASK_EXPERIENCE (fast-track path)
// ============================================================

async function completeOnboarding(phone: string, u: any, budget: string, budgetLevel: string, exp: string): Promise<string> {
  const defaultGoal = u.goalType || "fat_loss";
  const actualWeight = parseFloat(u.currentWeight || "75");
  const age = u.age || 30;
  const gender = u.gender || "male";
  const heightCm = u.heightCm || 170;
  const isYouth = age < 18;
  const isElderly = age >= 60;

  const trainingDays = u.trainingDaysPerWeek || ((isYouth || isElderly) ? 3 : 4);

  const { calorieTarget, proteinTarget } = calculateTargets(
    actualWeight, defaultGoal, u.lifeSituation || "office", trainingDays, gender, age, heightCm, u.trainingExperience || "beginner"
  );

  const stepsTarget = calculateStepsTarget(actualWeight, age, heightCm, u.trainingExperience || "beginner");

  let referralCode: string | undefined;
  {
    const namePrefix = (u.name || "KAM").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "K");
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${namePrefix}${Math.floor(1000 + Math.random() * 9000)}`;
      try {
        const existing = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, candidate)).limit(1);
        if (existing.length === 0) { referralCode = candidate; break; }
      } catch (e) {
        // A DB blip here must never abort onboarding completion — the referral code
        // is a nice-to-have; just skip it and let the welcome go out.
        console.warn("[ONBOARDING] referral code check failed, skipping:", e);
        break;
      }
    }
  }

  await db.update(users).set({
    trainingDaysPerWeek: trainingDays,
    trainingExperience: exp,
    weeklyFoodBudget: budget,
    budgetLevel,
    lifeSituation: u.lifeSituation || "office",
    workSchedule: u.workSchedule || "standard",
    calorieTarget,
    proteinTarget,
    stepsTarget,
    programmePhase: 1,
    programmeWeek: 1,
    programmeDayInWeek: 1,
    programmeStartDate: new Date(),
    subscriptionStatus: "trial",
    betaBypassUntil: new Date(Date.now() + 7 * 86_400_000),
    onboardingState: "COMPLETE",
    ...(referralCode && !u.referralCode ? { referralCode } : {}),
  }).where(eq(users.phoneNumber, phone));

  const goalLabel: Record<string, string> = {
    fat_loss: "Fat loss", muscle_gain: "Muscle gain", recomposition: "Recomposition",
  };
  const mode = u.trainingMode || "home";
  const gymName = u.gymName;
  const modeLabel = mode === "walk_only" ? "Walking + bodyweight" : mode === "gym_dumbbell" ? "Dumbbell gym" : mode === "gym" ? (gymName || "Gym") : "Home training";

  const isPostpartum = u.lifeSituation === "postpartum_breastfeeding";
  const ageNote = isPostpartum
    ? `\n\n_Postpartum note: Your calorie target is set higher than a standard fat loss plan — breastfeeding burns 300–500 kcal/day and cutting too hard reduces milk supply. Aim for 0.5kg/week max. Pelvic floor exercises before any running or heavy lifting. Cleared for gentle training from 6 weeks — get doctor sign-off first._`
    : isYouth
    ? `\n\n_Note for under-18s: Your programme is designed to be safe and fun. No heavy maximal lifts — we focus on movement, form, and building healthy habits for life._`
    : isElderly
      ? `\n\n_Your programme is joint-friendly with lower-impact alternatives. We focus on mobility, strength maintenance, and keeping you active and independent. Always listen to your body._`
      : "";

  const stepsLabel = stepsTarget.toLocaleString();

  const updatedUser = { ...u, trainingMode: mode, programmePhase: 1, programmeWeek: 1, programmeDayInWeek: 1, stepsTarget, age: u.age || 30, primaryFocusArea: u.primaryFocusArea };
  // The user is already marked COMPLETE above — programme generation must never be
  // allowed to throw here, or the welcome (their first impression) is lost entirely.
  let firstWorkout: string;
  try {
    firstWorkout = getKamlifeProgramme(updatedUser, true);
  } catch (e) {
    console.error("[ONBOARDING] getKamlifeProgramme failed in completeOnboarding — using fallback:", e);
    firstWorkout = `Your Day 1 workout is ready — reply *1* or *workout* and I'll send it straight through.`;
  }

  const weightDisplay = actualWeight !== 75 ? `\n*Weight:* ${actualWeight}kg` : "";
  const heightDisplay = heightCm !== 170 ? ` · ${heightCm}cm` : "";
  const bmiDisplay = u.bmi ? ` · BMI ${u.bmi}` : "";

  const refCodeLine = referralCode ? `\n\n🎁 *Your referral code: ${referralCode}* — share it. Your friend gets 50% off month 1. You get R50 credit when they subscribe.` : "";

  // Goal-specific hook line — personal, not generic
  const goalHook: Record<string, string> = {
    fat_loss: `The weight does not come off in the gym — it comes off in the kitchen and on your feet. I have set your targets so you lose fat without starving.`,
    muscle_gain: `Muscle is built with consistency, not intensity. Progressive overload every session and enough protein — that is the whole secret. I have set your numbers.`,
    recomposition: `Recomp takes longer but the results last. We build muscle and lose fat at the same time. Protein stays high, training stays consistent, steps stay non-negotiable.`,
  };

  const trainingHook = mode === "walk_only"
    ? `No gym needed. Walking and bodyweight — done right, it changes your body.`
    : mode === "home"
      ? `Home training is underrated. The best results I have seen came from people with no gym and no excuses.`
      : `${gymName || "The gym"} is your tool. How you use it decides everything.`;

  const name = u.name || "there";
  const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  const cleanPhoneOnb = u.phoneNumber.replace(/^whatsapp:/, "");
  const payLinkOnb = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhoneOnb)}` : appUrl;

  const goalCalExplainer: Record<string, string> = {
    fat_loss: `*What ${calorieTarget} kcal means:* A banana is ~100 kcal. A plate of pap with stew is ~550 kcal. A Viennie on white bread is ~350 kcal. Your body burns ~1,200–1,500 kcal just to breathe and run your organs — before you move a single step. Eat at your target and you lose fat without starving.\n\n*What ${proteinTarget}g protein means:* 1 egg = ~6g. 1 tin of pilchards = ~25g. 100g chicken breast = ~31g. Two eggs and a tin of pilchards gets you 37g — a third of your daily target. Hit this number and hunger drops, muscle stays.`,
    muscle_gain: `*What ${calorieTarget} kcal means:* This is a small surplus above what you burn — enough to build muscle without unnecessary fat gain. A plate of pap with chicken is ~600 kcal. Three eggs is ~210 kcal. Don't undershoot this target — you can't build with an empty tank.\n\n*What ${proteinTarget}g protein means:* This is the actual driver of muscle growth — more important than what exercises you do. 1 egg = ~6g. 100g chicken = ~31g. 1 tin of tuna = ~26g. Spread it across 3–4 meals and hit the number daily.`,
    recomposition: `*What ${calorieTarget} kcal means:* This is your maintenance level — we build muscle and lose fat simultaneously. A banana is ~100 kcal. A plate of pap with chicken is ~600 kcal. The key is consistency — day-to-day variation is fine, weekly average is what counts.\n\n*What ${proteinTarget}g protein means:* Protein is the whole mechanism here. It repairs muscle after training and keeps you full so you don't overeat. 1 egg = ~6g. 100g chicken = ~31g. Amasi (250ml) = ~9g. Hit this number and the recomp happens.`,
  };
  const calExplainer = goalCalExplainer[defaultGoal] || goalCalExplainer.fat_loss;

  const msg1 = `${name}, your programme is built.\n\n${goalHook[defaultGoal] || goalHook.fat_loss}\n\n*Your targets:*\n• ${calorieTarget} kcal/day · ${proteinTarget}g protein\n• ${stepsLabel} steps/day — non-negotiable\n• ${trainingDays} training sessions/week\n\n${trainingHook}${ageNote}${refCodeLine}`;
  const msg1b = `${calExplainer}\n\nLog your first meal and I will show you exactly where it lands. Type what you ate — e.g. *2 eggs and pap* — and Coach K does the maths.`;

  const msg2 = `*Day 1 is ready.*\n\n${firstWorkout}`;
  const msg3 = `Your personalised shopping list and weekly meal plan are ready.\n\nPay to unlock them — and Day 2 drops the moment you finish today's session.\n\n*R199/month — cancel anytime:*\n${payLinkOnb}\n\n_R6.63/day. Less than a coffee. Not satisfied after your first week? Message us and we'll make it right. POPIA protected._`;
  const msg4 = `*From today, send me everything you eat.* Breakfast. Lunch. Dinner. A photo or a few words — I do the maths.\n\nSend your step count at the end of each day. Even if you missed the target — especially then.\n\n📸 *Progress photos* — front, side, back. Natural light, same position every time. Send them now to set your baseline. You will thank yourself in 8 weeks.`;
  return `${msg1}\n\n---\n\n${msg1b}\n\n---\n\n${msg2}\n\n---\n\n${msg3}\n\n---\n\n${msg4}`;
}

// ============================================================
// ONBOARDING FLOW — 3-QUESTION FAST TRACK
// POPIA → Name → Goal → Gym or Home → Immediate programme
// Everything else collected progressively through coaching
// ============================================================

export async function handleOnboarding(user: any, message: string, phone: string): Promise<string> {
  const state = user.onboardingState || "START";
  const msg = message.trim();

  // ---- BLOCKED states — hard exits ----
  if (state === "BLOCKED_UNDERAGE") {
    return `Coach K is for ages 14 and up. When you're ready, message again and we'll build your programme.`;
  }

  // ---- PRE_ONBOARD — 1-2 conversational exchanges before formal questionnaire ----
  // People come in talking about cellulite, weekends-only training, referrals, real life.
  // Engage with that first. Max 2 exchanges, then naturally hand off to signup.
  if (state === "PRE_ONBOARD") {
    const isReady = /^(yes|yebo|ja|sure|ok|okay|let.?s go|ready|start|sign|register|get me started|i.?m ready|go ahead|do it|yes coach|yes please)[\s!.]*$/i.test(msg.trim());
    if (isReady) {
      await db.update(users).set({ onboardingState: "ASK_POPIA" }).where(eq(users.phoneNumber, phone));
      return `Before I build your programme, I need your consent to store and process your personal information under POPIA (South Africa's data protection law).\n\n*What I store:* your name, phone number, fitness goal, food logs, workouts, and steps. If you share health info (weight, medical conditions), that is stored as special personal information and used only to make your coaching safer.\n\n*Your rights:* reply *delete my data* at any time to permanently erase everything. Full policy: kamlifecoach.co.za/privacy\n\n*Never sold. Never shared for marketing.*\n\nReply *yes* to give consent and continue.`;
    }
    // Another question / more context — answer briefly and re-invite
    const continuationCtx = `You are Coach K — a direct, warm South African fitness coach on WhatsApp. A potential new client is asking questions before signing up. Reply in 1-2 sentences only. Be specific and helpful. End EVERY response on a new line with exactly: "Reply *yes* when you're ready to build your programme."

Banned: "I understand", "I hear you", "journey", "wellness", "reach out", "feel free", "awesome"
SA voice — direct, short, practical. No fluff. No price mentions.`;
    const preReply = await askCoachK(message, user, continuationCtx);
    return preReply;
  }

  // ---- START — if they sent a real message, engage it before pitching ----
  if (state === "START") {
    const isSimpleStart = /^(yes|yebo|ja|sure|ok|okay|hi|hey|hello|howzit|hola|sawubona|eita|sup|yo|let.?s go|start|begin|go|send|register|join|sign|i want|get me)[\s!.]*$/i.test(msg.trim());

    if (!isSimpleStart && msg.length > 8) {
      // Real message — engage with their situation first
      await db.update(users).set({ onboardingState: "PRE_ONBOARD" }).where(eq(users.phoneNumber, phone));
      const intakeCtx = `You are Coach K — a direct, warm South African fitness and nutrition coach running KamLife Coach on WhatsApp.

A new potential client has just messaged you for the FIRST TIME. Reply in exactly 2-3 short sentences:
1. Acknowledge their specific situation or concern by name (cellulite, weight, no-gym, weekend training, referral — whatever they said)
2. Give them one piece of genuine, specific hope based on real fitness principles
3. Ask ONE follow-up question that will help you understand their situation better

Then on a NEW LINE add: "Reply *yes* when you're ready and I'll build your personalised programme."

Rules: Short sentences. No lists. No bullet points. SA voice — warm, direct, no corporate speak.
Banned words: "I understand", "I hear you", "journey", "wellness", "reach out", "feel free", "awesome", "amazing", "fantastic"
Do NOT mention price. Do NOT mention R199. Just be a helpful coach.
If they mention a referral (e.g. "from Donda"), acknowledge it warmly — one word is enough.`;
      const intakeReply = await askCoachK(message, user, intakeCtx);
      return intakeReply;
    }

    // Simple greeting or "yes" → standard pitch
    await db.update(users).set({ onboardingState: "ASK_POPIA" }).where(eq(users.phoneNumber, phone));
    return `Coach K here. Real SA fitness coaching — personalised programme, food guidance, daily accountability. All on WhatsApp. No app to download.\n\nR199/month — R6.63/day. Cancel anytime.\n\n_I'm AI, not a human coach or doctor. If you have any health conditions, check with your doctor before starting. Your info is stored under POPIA — only used for your coaching, never sold. Reply *delete my data* anytime._\n\nReply *yes* to build your programme.`;
  }

  // ---- ASK_POPIA ----
  if (state === "ASK_POPIA") {
    const consentWords = ["yes", "agree", "consent", "ok", "okay", "yebo", "ja", "sure", "accept", "i agree", "i consent", "yes coach", "i do"];
    const isConsent = consentWords.some(k => {
      if (msg === k) return true;
      if (k.includes(" ")) return msg.includes(k); // multi-word phrases
      return new RegExp(`\\b${k}\\b`).test(msg);   // single-word: whole-word only
    });
    if (isConsent) {
      await db.update(users).set({ popiConsent: true, popiConsentAt: new Date(), onboardingState: "WELCOME" }).where(eq(users.phoneNumber, phone));
      return `Sharp. What's your name?`;
    }
    const isRefusal = /\b(no|nope|refuse|disagree|don.?t|not|never|nah|nay)\b/i.test(msg) || msg.trim().toLowerCase() === "no";
    if (isRefusal) {
      // POPIA requires we delete data when consent is refused
      await db.delete(users).where(eq(users.phoneNumber, phone));
      return `Understood. Without consent I cannot store your data or coach you. If you change your mind, message me again and we can start fresh.`;
    }
    return `I need your agreement before I can coach you. Your data is used only for your coaching — never sold. Reply *yes* to continue.`;
  }

  // ---- WELCOME — name ----
  if (state === "WELCOME") {
    const raw = msg.trim();
    const words = raw.split(/\s+/);
    const hasBadPunctuation = /[^a-zA-Z\s''-]/.test(raw);
    const COMMANDS = new Set(["RESET", "START", "RESTART", "MENU", "HELP", "DONE", "YES", "NO", "OK", "OKAY", "HI", "HEY", "HELLO", "HOWZIT", "HOLA", "YO", "SUP", "EITA", "SAWUBONA", "YEBO", "STOP", "CANCEL"]);
    if (!raw || raw.length < 2 || raw.length > 20 || words.length > 3 || hasBadPunctuation || COMMANDS.has(raw.toUpperCase())) {
      return `Just your first name — what do people call you?`;
    }
    const name = words.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
    await db.update(users).set({ name, onboardingState: "ASK_GENDER" }).where(eq(users.phoneNumber, phone));
    return `Sharp ${name}. Male or female?`;
  }

  // ---- ASK_GENDER ----
  if (state === "ASK_GENDER") {
    const lower = msg.toLowerCase().trim();
    const isMale = lower === "male" || lower === "m" || lower === "1" || lower === "guy" || lower === "man" || lower === "bro" || lower === "indoda";
    const isFemale = lower === "female" || lower === "f" || lower === "2" || lower === "woman" || lower === "lady" || lower === "girl" || lower === "sis" || lower === "intombi";
    if (!isMale && !isFemale) {
      return `Male or female?`;
    }
    const gender = isMale ? "male" : "female";
    if (isFemale) {
      await db.update(users).set({ gender, onboardingState: "ASK_FEMALE_FOCUS" }).where(eq(users.phoneNumber, phone));
      return `Got it. What's your main training focus?\n\n1️⃣ *Full body* — tone and strengthen everything\n2️⃣ *Glutes & legs* — build and sculpt the lower body`;
    }
    await db.update(users).set({ gender, onboardingState: "ASK_AGE_NEW" }).where(eq(users.phoneNumber, phone));
    return `How old are you?`;
  }

  // ---- ASK_FEMALE_FOCUS ----
  if (state === "ASK_FEMALE_FOCUS") {
    const lower = msg.toLowerCase().trim();
    const isGlutes = msg.includes("2") || lower.includes("glute") || lower.includes("bum") || lower.includes("butt") || lower.includes("leg") || lower.includes("lower") || lower.includes("booty");
    const focusArea = isGlutes ? "glutes_legs" : null;
    await db.update(users).set({
      ...(focusArea ? { primaryFocusArea: focusArea } : { primaryFocusArea: null }),
      onboardingState: "ASK_POSTPARTUM",
    }).where(eq(users.phoneNumber, phone));
    return `One more — are you currently pregnant, recently gave birth, or breastfeeding?\n\n1️⃣ Yes — postpartum or breastfeeding\n2️⃣ No — continue`;
  }

  // ---- ASK_POSTPARTUM ----
  if (state === "ASK_POSTPARTUM") {
    const lower = msg.toLowerCase().trim();
    const isPostpartum = msg.includes("1") || lower.includes("yes") || lower.includes("breastfeed") || lower.includes("postpartum") || lower.includes("gave birth") || lower.includes("nursing") || lower.includes("new mom") || lower.includes("new mum") || lower.includes("baby");
    if (isPostpartum) {
      await db.update(users).set({ lifeSituation: "postpartum_breastfeeding", onboardingState: "ASK_AGE_NEW" }).where(eq(users.phoneNumber, phone));
      return `Understood — your plan will be adjusted. While breastfeeding your body needs more calories, not fewer. We will lose the weight slowly and safely so your milk supply stays strong.\n\nHow old are you?`;
    }
    await db.update(users).set({ onboardingState: "ASK_AGE_NEW" }).where(eq(users.phoneNumber, phone));
    return `How old are you?`;
  }

  // ---- ASK_AGE_NEW — age drives workout safety, intensity, and tone ----
  if (state === "ASK_AGE_NEW") {
    const age = parseInt(msg.replace(/[^0-9]/g, ""));
    if (isNaN(age) || age < 10 || age > 110) {
      return `Just your age — for example: 28`;
    }
    if (age < 14) {
      await db.update(users).set({ onboardingState: "BLOCKED_UNDERAGE" }).where(eq(users.phoneNumber, phone));
      return `Coach K is designed for ages 14 and up. Chat to a parent or guardian about getting started together.`;
    }
    const isElderly = age >= 60;
    const isYouth = age < 18;
    await db.update(users).set({
      age,
      elderlyClient: isElderly,
      onboardingState: "ASK_EMAIL",
    }).where(eq(users.phoneNumber, phone));

    // Age-appropriate response
    if (isYouth) {
      return `${age} — sharp, young legend. 💪 What's your email address? (Type *skip* to continue without one.)`;
    }
    if (isElderly) {
      return `${age} — respect. I'll make sure your programme is joint-friendly and safe. What's your email? (Type *skip* to continue without one.)`;
    }
    return `Got it. What's your email address? (Backup contact if WhatsApp has issues — type *skip* if you'd rather not.)`;
  }

  // ---- ASK_EMAIL — optional, backup contact ----
  if (state === "ASK_EMAIL") {
    const lower = msg.toLowerCase().trim();
    const isSkip = lower === "skip" || lower === "no" || lower === "nope" || lower === "n/a" || lower === "none";
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!isSkip && !emailRegex.test(msg.trim())) {
      return `Just your email address, or type *skip* to continue without one.`;
    }
    const emailVal = isSkip ? null : msg.trim().toLowerCase();
    await db.update(users).set({ ...(emailVal ? { email: emailVal } : {}), onboardingState: "ASK_WEIGHT_HEIGHT" }).where(eq(users.phoneNumber, phone));
    return `${emailVal ? "Got it." : "No problem."} What's your weight and height?\n\nExample: *78kg, 1.72m*`;
  }

  // ---- ASK_GOAL ----
  if (state === "ASK_GOAL") {
    const lower = msg.toLowerCase();
    const hasGoalNumber = /[1-3]/.test(msg);
    const hasGoalKeyword = lower.includes("lose") || lower.includes("fat") || lower.includes("muscle") || lower.includes("build") || lower.includes("recomp") || lower.includes("both") || lower.includes("weight");
    if (!hasGoalNumber && !hasGoalKeyword) {
      return `What's your main goal?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both`;
    }
    let goal = "fat_loss";
    if (msg.includes("2") || lower.includes("build") || lower.includes("muscle") || lower.includes("gain")) goal = "muscle_gain";
    else if (msg.includes("3") || lower.includes("recomp") || lower.includes("both")) goal = "recomposition";

    // If weight already captured (e.g., from ASK_WEIGHT_HEIGHT flow), skip the duplicate re-ask and set protein target now.
    const hasWeight = !!user.currentWeight;
    if (hasWeight) {
      const w = parseFloat(user.currentWeight!);
      await db.update(users).set({
        goalType: goal,
        proteinTarget: Math.round(w * 2),
        onboardingState: "ASK_MEDICAL",
      }).where(eq(users.phoneNumber, phone));
      const goalLabel = goal === "muscle_gain" ? "Build muscle" : goal === "recomposition" ? "Lose fat and build muscle" : "Lose fat";
      return `Goal locked in: *${goalLabel}*.\n\nAny medical conditions I must know about?\n\n1️⃣ Diabetes\n2️⃣ High blood pressure\n3️⃣ Heart condition\n4️⃣ HIV on ARVs\n5️⃣ PCOS\n6️⃣ None of the above`;
    }

    await db.update(users).set({ goalType: goal, onboardingState: "ASK_WEIGHT_HEIGHT_FAST" }).where(eq(users.phoneNumber, phone));
    return `Before I set your targets: what's your current weight and height?\n\nExample: *78kg, 1.72m*\n\nIf you don't know, reply *skip*.`;
  }

  // ---- ASK_WEIGHT_HEIGHT_FAST — keep fast flow but avoid generic targets ----
  if (state === "ASK_WEIGHT_HEIGHT_FAST") {
    const lower = msg.toLowerCase().trim();
    const isSkip = lower === "skip" || lower === "not sure" || lower === "dont know" || lower === "don't know" || lower === "unknown";

    if (isSkip) {
      const fallbackWeight = user.gender === "female" ? 65 : 75;
      await db.update(users).set({
        currentWeight: fallbackWeight.toString(),
        heightCm: null,
        bmi: null,
        proteinTarget: Math.round(fallbackWeight * 2),
        onboardingState: "ASK_MEDICAL",
      }).where(eq(users.phoneNumber, phone));
      return `No stress. I will start with baseline targets and adjust once you log weight.\n\nAny medical conditions I must know about?\n\n1️⃣ Diabetes\n2️⃣ High blood pressure\n3️⃣ Heart condition\n4️⃣ HIV on ARVs\n5️⃣ PCOS\n6️⃣ None of the above`;
    }

    const weightMatch = msg.match(/(\d+(?:\.\d+)?)\s*kg/i);
    if (!weightMatch) {
      return `I need weight in kg to personalise targets.\n\nExample: *78kg, 1.72m* (or reply *skip*)`;
    }

    const weight = parseFloat(weightMatch[1]);
    if (weight < 30 || weight > 350) {
      return `That weight looks off. Please send it like: *78kg, 1.72m*`;
    }

    const heightMMatch = msg.match(/(\d+\.\d+)\s*m(?!g)/i);
    const heightCmMatch = msg.match(/(\d{3})\s*cm/i);
    let heightCmVal: number | null = null;
    let bmiVal: string | null = null;

    if (heightMMatch) {
      const heightM = parseFloat(heightMMatch[1]);
      if (heightM >= 1.2 && heightM <= 2.4) {
        heightCmVal = Math.round(heightM * 100);
      }
    } else if (heightCmMatch) {
      const parsedCm = parseInt(heightCmMatch[1], 10);
      if (parsedCm >= 120 && parsedCm <= 240) {
        heightCmVal = parsedCm;
      }
    }

    if (heightCmVal) {
      const hM = heightCmVal / 100;
      const bmi = Math.round((weight / (hM * hM)) * 10) / 10;
      bmiVal = bmi.toString();
    }

    await db.update(users).set({
      currentWeight: weight.toString(),
      heightCm: heightCmVal,
      bmi: bmiVal,
      proteinTarget: Math.round(weight * 2),
      onboardingState: "ASK_MEDICAL",
    }).where(eq(users.phoneNumber, phone));

    return `Perfect — targets will be based on ${weight}kg${heightCmVal ? ` and ${heightCmVal}cm` : ""}.\n\nAny medical conditions I must know about?\n\n1️⃣ Diabetes\n2️⃣ High blood pressure\n3️⃣ Heart condition\n4️⃣ HIV on ARVs\n5️⃣ PCOS\n6️⃣ None of the above`;
  }

  // ---- ASK_EQUIPMENT — route by training location ----
  if (state === "ASK_EQUIPMENT") {
    const lower = msg.toLowerCase();

    // Walk-only: genuine mobility/medical limitation
    if (/\b(walk only|just walk|walking only|only walk|only walking|can only walk|doctor.*walk|injury.*walk|heart.*walk)\b/i.test(lower)) {
      await db.update(users).set({ trainingMode: "walk_only", gymName: null, onboardingState: "ASK_BUDGET" }).where(eq(users.phoneNumber, phone));
      return `Noted — walking + light bodyweight work only.\n\nWhat's your monthly grocery budget?\n\n1️⃣ Under R1,500\n2️⃣ R1,500 – R3,000\n3️⃣ R3,000 – R5,000\n4️⃣ R5,000+`;
    }

    // "No equipment" quick path — bodyweight only, skip sub-question
    if (/no equipment|bodyweight only|nothing|no gear/i.test(lower)) {
      await db.update(users).set({ trainingMode: "home", homeEquipment: "bodyweight_only", gymName: null, onboardingState: "ASK_BUDGET" }).where(eq(users.phoneNumber, phone));
      return `Bodyweight programme — no equipment needed.\n\nWhat's your monthly grocery budget?\n\n1️⃣ Under R1,500\n2️⃣ R1,500 – R3,000\n3️⃣ R3,000 – R5,000\n4️⃣ R5,000+`;
    }

    // Home training → ask what equipment they have
    if (/\bhome\b/i.test(lower) || /at home|home training|home workout/i.test(lower)) {
      await db.update(users).set({ gymName: null, onboardingState: "ASK_HOME_EQUIPMENT" }).where(eq(users.phoneNumber, phone));
      return `What do you have at home?[BUTTONS:Dumbbells|Resistance bands|Bodyweight only|Mix (both)]`;
    }

    // Gym → ask if full gym or dumbbells only
    if (/\bgym\b/i.test(lower) || /virgin|planet fitness|curves|fitness/i.test(lower)) {
      let gymName: string | null = null;
      if (lower.includes("virgin")) gymName = "Virgin Active";
      else if (lower.includes("planet")) gymName = "Planet Fitness";
      else if (lower.includes("curves")) gymName = "Curves";
      else gymName = "Gym";
      await db.update(users).set({ gymName, onboardingState: "ASK_GYM_SETUP" }).where(eq(users.phoneNumber, phone));
      return `What does your gym have?[BUTTONS:Full gym (machines)|Dumbbells only]`;
    }

    // Unrecognised — re-ask
    return `Gym or home training?[BUTTONS:Gym|Home training|No equipment]`;
  }

  // ---- ASK_HOME_EQUIPMENT — capture home kit ----
  if (state === "ASK_HOME_EQUIPMENT") {
    const lower = msg.toLowerCase();
    let mode = "home";
    let homeEquipment = "bodyweight_only";

    if ((/dumbbell|dumbbells|weights|weight set|adjustable|db/i.test(lower)) && (/band|resistance/i.test(lower) || /mix|both/i.test(lower))) {
      mode = "gym_dumbbell"; homeEquipment = "mix";
    } else if (/dumbbell|dumbbells|weights|weight set|adjustable|db/i.test(lower)) {
      mode = "gym_dumbbell"; homeEquipment = "dumbbells";
    } else if (/band|resistance band/i.test(lower)) {
      mode = "home"; homeEquipment = "bands";
    } else if (/mix|both/i.test(lower)) {
      mode = "gym_dumbbell"; homeEquipment = "mix";
    }
    // default: bodyweight_only, mode=home

    await db.update(users).set({ trainingMode: mode, homeEquipment, gymName: null, onboardingState: "ASK_BUDGET" }).where(eq(users.phoneNumber, phone));

    const equipLabel = homeEquipment === "dumbbells" ? "Dumbbell" : homeEquipment === "bands" ? "Resistance band" : homeEquipment === "mix" ? "Dumbbell + band" : "Bodyweight";
    return `${equipLabel} programme locked in.\n\nWhat's your monthly grocery budget?\n\n1️⃣ Under R1,500\n2️⃣ R1,500 – R3,000\n3️⃣ R3,000 – R5,000\n4️⃣ R5,000+`;
  }

  // ---- ASK_GYM_SETUP — full gym vs dumbbells only ----
  if (state === "ASK_GYM_SETUP") {
    const lower = msg.toLowerCase();
    const mode = /dumbbell|dumbbells only|db only|no machine|basic/i.test(lower) ? "gym_dumbbell" : "gym";

    await db.update(users).set({ trainingMode: mode, onboardingState: "ASK_BUDGET" }).where(eq(users.phoneNumber, phone));

    return `What's your monthly grocery budget?\n\n1️⃣ Under R1,500\n2️⃣ R1,500 – R3,000\n3️⃣ R3,000 – R5,000\n4️⃣ R5,000+`;
  }

  // ---- ASK_BUDGET — grocery budget tier ----
  // Fast-track path: routes to ASK_EXPERIENCE (experience not yet captured)
  // Legacy path: experience was captured before budget → complete directly
  if (state === "ASK_BUDGET") {
    const lower = msg.toLowerCase();
    let budget = "100_300";
    let budgetLevel = "medium";
    if (msg.includes("1") || lower.includes("under") || lower.includes("1500") || lower.includes("1,500") || lower.includes("budget") || lower.includes("tight")) {
      budget = "under_100"; budgetLevel = "low";
    } else if (msg.includes("2") || lower.includes("3000") || lower.includes("3,000") || lower.includes("medium")) {
      budget = "100_300"; budgetLevel = "medium";
    } else if (msg.includes("3") || lower.includes("5000") || lower.includes("5,000")) {
      budget = "300_600"; budgetLevel = "high";
    } else if (msg.includes("4") || lower.includes("over") || lower.includes("premium") || lower.includes("no limit")) {
      budget = "over_600"; budgetLevel = "premium";
    }

    if (user.trainingExperience) {
      // Legacy path: experience already captured, complete now
      return completeOnboarding(phone, user, budget, budgetLevel, user.trainingExperience);
    }

    // Fast-track path: ask experience before completing
    await db.update(users).set({
      weeklyFoodBudget: budget,
      budgetLevel,
      onboardingState: "ASK_EXPERIENCE",
    }).where(eq(users.phoneNumber, phone));

    return `Last one — training experience?\n\n1️⃣ Beginner — just starting out\n2️⃣ Some experience — been active before\n3️⃣ Intermediate — 1-2 years consistent\n4️⃣ Advanced — 2+ years serious lifting`;
  }

  // ---- LEGACY STATES — kept for existing users mid-onboarding ----
  // These handle clients who started onboarding before the 3-question rewrite

  // Legacy ASK_AGE — route into the new 3-question flow so stranded users converge.
  if (state === "ASK_AGE") {
    const age = parseInt(msg.replace(/[^0-9]/g, ""));
    if (isNaN(age) || age < 10 || age > 110) return `Just your age. For example: 28`;
    if (age < 14) return `Coach K is designed for ages 14 and up.`;
    const isElderly = age >= 60;
    await db.update(users).set({ age, elderlyClient: isElderly, onboardingState: "ASK_EMAIL" }).where(eq(users.phoneNumber, phone));
    return `Got it. What's your email address? (Backup contact if WhatsApp has issues — type *skip* if you'd rather not.)`;
  }

  if (state === "ASK_WEIGHT_HEIGHT") {
    const lowerMsg = msg.toLowerCase().trim();
    const isFemale = user.gender === "female";

    // ── HEIGHT ESTIMATE PATH — user already gave weight, now picking height estimate ──
    // Triggered when they have weight saved but no height, and send short/average/tall/1/2/3
    if (user.currentWeight && !user.heightCm) {
      const shortH = isFemale ? 155 : 163;
      const avgH   = isFemale ? 163 : 172;
      const tallH  = isFemale ? 172 : 181;
      let estimatedCm = 0;
      if (/^\s*1\s*$/.test(msg) || /\b(short|shorter|petite|small)\b/i.test(lowerMsg)) estimatedCm = shortH;
      else if (/^\s*2\s*$/.test(msg) || /\b(average|avg|medium|normal|middle)\b/i.test(lowerMsg)) estimatedCm = avgH;
      else if (/^\s*3\s*$/.test(msg) || /\b(tall|taller|big|large|above)\b/i.test(lowerMsg)) estimatedCm = tallH;

      if (estimatedCm > 0) {
        const savedWeight = parseFloat(user.currentWeight);
        const hM = estimatedCm / 100;
        const bmi = Math.round((savedWeight / (hM * hM)) * 10) / 10;
        await db.update(users).set({
          heightCm: estimatedCm,
          bmi: bmi.toString(),
          onboardingState: "ASK_GOAL",
        }).where(eq(users.phoneNumber, phone));
        return `Using ~${estimatedCm}cm as an estimate — I'll adjust if you measure later.\n\nMain goal?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both`;
      }
    }

    // ── "I DON'T KNOW MY HEIGHT" detection ──
    const heightUnknown = /\b(don.?t know|dont know|no idea|not sure|unknown|skip|idk|have no idea|can.?t remember|cannot remember|never measured)\b/i.test(lowerMsg)
      || (lowerMsg.includes("height") && /\b(no|not|don.?t|unsure)\b/i.test(lowerMsg));

    // ── Parse weight from message ──
    const weightMatch = msg.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs)?/i);
    if (!weightMatch && !heightUnknown) return `Your weight and height. Example: *78kg, 1.72m*`;

    // If they said "don't know height" without giving weight yet, use saved weight or ask weight first
    if (heightUnknown && !weightMatch && !user.currentWeight) {
      return `No problem on height — I'll estimate it. What's your weight? Example: *78kg*`;
    }

    const weight = weightMatch ? parseFloat(weightMatch[1]) : parseFloat(user.currentWeight || "70");
    if (weight < 30 || weight > 300) return `That doesn't look right. Example: *78kg, 1.72m*`;

    // Parse height — multiple formats: 1.72m, 172cm, 5'8, bare 3-digit number
    const heightMMatch = msg.match(/(\d+\.\d+)\s*m(?!g|i)/i);
    const heightCmMatch = msg.match(/(\d{3})\s*(?:cm)?/i);
    const heightFtMatch = msg.match(/(\d)[''`]?\s*(\d{1,2})/);
    let heightM = 0; let heightCmVal = 0;

    if (heightMMatch) {
      heightM = parseFloat(heightMMatch[1]);
      heightCmVal = Math.round(heightM * 100);
    } else if (heightCmMatch) {
      heightCmVal = parseInt(heightCmMatch[1]);
      heightM = heightCmVal / 100;
    } else if (heightFtMatch) {
      const ft = parseInt(heightFtMatch[1]);
      const inches = parseInt(heightFtMatch[2]);
      heightCmVal = Math.round((ft * 30.48) + (inches * 2.54));
      heightM = heightCmVal / 100;
    }

    // No height provided OR "don't know" — save weight and offer estimate options
    if (heightCmVal < 100 || heightCmVal > 230) {
      await db.update(users).set({ currentWeight: weight.toString() }).where(eq(users.phoneNumber, phone));
      const shortLabel = isFemale ? "Short (under 160cm)" : "Short (under 165cm)";
      const avgLabel   = isFemale ? "Average (163cm)"     : "Average (172cm)";
      const tallLabel  = isFemale ? "Tall (172cm+)"       : "Tall (181cm+)";
      return `Got it — ${weight}kg.\n\nWhat's your height? If you're not sure, pick the closest:\n\n1️⃣ ${shortLabel}\n2️⃣ ${avgLabel}\n3️⃣ ${tallLabel}\n\nOr type it: *1.72m* or *172cm*`;
    }

    const bmi = Math.round((weight / (heightM * heightM)) * 10) / 10;
    await db.update(users).set({
      currentWeight: weight.toString(),
      heightCm: heightCmVal,
      bmi: bmi.toString(),
      onboardingState: "ASK_GOAL",
    }).where(eq(users.phoneNumber, phone));
    return `${weight}kg, ${heightCmVal}cm — got it. Main goal?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both`;
  }

  if (state === "ASK_SITUATION") {
    // Legacy — skip to medical
    await db.update(users).set({ onboardingState: "ASK_MEDICAL" }).where(eq(users.phoneNumber, phone));
    return `Any medical conditions I must know about?\n\n1️⃣ Diabetes\n2️⃣ High blood pressure\n3️⃣ Heart condition\n4️⃣ HIV on ARVs\n5️⃣ PCOS\n6️⃣ None of the above`;
  }

  if (state === "ASK_MEDICAL") {
    const lower = msg.toLowerCase();
    const isNone = lower.includes("none") || lower.includes("nothing") || msg.includes("6") || msg.includes("8");
    const conditions: string[] = [];
    if (msg.includes("1") || lower.includes("diab")) conditions.push("diabetes");
    if (msg.includes("2") || lower.includes("blood pressure") || lower.includes("hypert")) conditions.push("hypertension");
    if (msg.includes("3") || lower.includes("heart")) conditions.push("heart_condition");
    if (msg.includes("4") || lower.includes("hiv") || lower.includes("arv")) conditions.push("hiv_arvs");
    if (msg.includes("5") || lower.includes("pcos")) conditions.push("pcos");
    const hasDiabetes = conditions.includes("diabetes");
    const hasHeart = conditions.includes("heart_condition");
    const hasHIV = conditions.includes("hiv_arvs");
    const hasHighRiskCondition = hasHeart || hasDiabetes || hasHIV;
    await db.update(users).set({
      medicalConditions: conditions.length > 0 ? conditions.join(",") : "none",
      nutritionProtocol: hasDiabetes ? "LOW_GI" : null,
      mealTimingStrict: hasDiabetes,
      doctorClearanceRequired: hasHeart,
      onboardingState: "ASK_INJURIES",
    }).where(eq(users.phoneNumber, phone));

    // For heart, diabetes, and HIV/ARV users — explicit medical liability disclaimer
    // before proceeding. Coach K adjusts their programme but is not a substitute for
    // their treating doctor or dietitian.
    if (hasHighRiskCondition) {
      const conditionNames = conditions
        .filter(c => ["heart_condition", "diabetes", "hiv_arvs"].includes(c))
        .map(c => c === "heart_condition" ? "heart condition" : c === "hiv_arvs" ? "HIV/ARVs" : "diabetes")
        .join(" and ");
      return `Got it — ${conditionNames} noted.\n\n⚠️ *Medical note:* Coach K will adjust your programme and nutrition for your condition, but is not a substitute for your doctor or dietitian. Please make sure your doctor knows you are starting a new exercise and eating plan.\n\nCoach K will never tell you to stop or change your medication. If any recommendation conflicts with what your doctor told you — follow your doctor.\n\nAny injuries? Bad knees, back, shoulder? Or say None.`;
    }

    return `Any injuries? Bad knees, back, shoulder? Or say None.`;
  }

  if (state === "AWAITING_MEDICAL_NOTES") {
    await db.update(users).set({ otherMedicalNotes: msg, onboardingState: "ASK_MEDICAL" }).where(eq(users.phoneNumber, phone));
    return `Got it. Any of these: 1 Diabetes, 2 Hypertension, 3 Heart, 4 HIV/ARVs, 5 PCOS, 6 None`;
  }

  if (state === "ASK_INJURIES") {
    const lower = msg.toLowerCase().trim();
    const isClearNone = lower === "none" || lower === "no" || lower === "n/a" || lower === "nil" || lower === "nope" || lower === "nothing";
    const injuries = isClearNone ? "" : msg;
    await db.update(users).set({ injuries, onboardingState: "ASK_EQUIPMENT" }).where(eq(users.phoneNumber, phone));
    return `Gym or home training?[BUTTONS:Gym|Home training|No equipment]`;
  }

  if (state === "ASK_GYM_NAME") {
    const gymMap: Record<string, string> = { "1": "Virgin Active", "2": "Planet Fitness", "3": "Curves", "4": "Local gym", "5": "Other" };
    const lower = msg.toLowerCase();
    let gymName = gymMap[msg.trim()] || msg.trim();
    if (!gymMap[msg.trim()]) {
      if (lower.includes("virgin")) gymName = "Virgin Active";
      else if (lower.includes("planet")) gymName = "Planet Fitness";
      else if (lower.includes("curves")) gymName = "Curves";
    }
    await db.update(users).set({ gymName, onboardingState: "ASK_TRAINING_DAYS" }).where(eq(users.phoneNumber, phone));
    return `How many days per week?\n\n1️⃣ 2 days\n2️⃣ 3 days\n3️⃣ 4 days\n4️⃣ 5 days`;
  }

  if (state === "ASK_TRAINING_DAYS") {
    const dayMap: Record<string, number> = { "1": 2, "2": 3, "3": 4, "4": 5, "5": 6 };
    let days = dayMap[msg.trim()] || 3;
    const numMatch = msg.match(/\b([2-6])\b/);
    if (numMatch && !dayMap[msg.trim()]) days = parseInt(numMatch[1]);
    await db.update(users).set({ trainingDaysPerWeek: days, onboardingState: "ASK_EXPERIENCE" }).where(eq(users.phoneNumber, phone));
    return `Training experience?\n\n1️⃣ Beginner\n2️⃣ Some experience\n3️⃣ Intermediate (1-2 years)\n4️⃣ Advanced (2+ years)`;
  }

  if (state === "ASK_EXPERIENCE") {
    const lower = msg.toLowerCase();
    let exp = "beginner";
    if (msg.includes("3") || lower.includes("intermediate")) exp = "intermediate";
    else if (msg.includes("4") || lower.includes("advanced")) exp = "advanced";

    await db.update(users).set({ trainingExperience: exp }).where(eq(users.phoneNumber, phone));

    if (user.weeklyFoodBudget) {
      // Fast-track path: budget was captured in ASK_BUDGET, complete now
      return completeOnboarding(phone, user, user.weeklyFoodBudget, user.budgetLevel || "medium", exp);
    }

    // Legacy path: budget not yet captured
    await db.update(users).set({ onboardingState: "ASK_BUDGET" }).where(eq(users.phoneNumber, phone));
    return `What's your monthly grocery budget?\n\n1️⃣ Under R1,500\n2️⃣ R1,500 – R3,000\n3️⃣ R3,000 – R5,000\n4️⃣ R5,000+`;
  }
  // Duplicate ASK_BUDGET handler removed — it was dead code shadowed by main handler at line ~606.

  // ---- ASK_WORK_SCHEDULE → COMPLETE ----
  if (state === "ASK_WORK_SCHEDULE") {
    const lower = msg.toLowerCase();
    const hasSchedNumber = /[1-5]/.test(msg);
    const hasSchedKeyword = lower.includes("standard") || lower.includes("8am") || lower.includes("8 am") || lower.includes("early") || lower.includes("night") || lower.includes("irregular") || lower.includes("change") || lower.includes("home") || lower.includes("wfh") || lower.includes("shift");
    if (!hasSchedNumber && !hasSchedKeyword) {
      return `Work schedule?\n\n1️⃣ Standard (8am–5pm)\n2️⃣ Early shift\n3️⃣ Night shift\n4️⃣ Irregular\n5️⃣ Work from home`;
    }
    const scheduleMap: Record<string, string> = {
      "1": "standard", "2": "early_shift", "3": "night_shift", "4": "irregular", "5": "work_from_home",
    };
    let schedule = scheduleMap[msg.trim()] || "standard";
    if (!scheduleMap[msg.trim()]) {
      if (lower.includes("night")) schedule = "night_shift";
      else if (lower.includes("early")) schedule = "early_shift";
      else if (lower.includes("irregular") || lower.includes("changes")) schedule = "irregular";
      else if (lower.includes("home") || lower.includes("wfh")) schedule = "work_from_home";
    }

    const freshUser = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const u = freshUser[0];
    const weight = parseFloat(u.currentWeight || "75");
    const goal = u.goalType || "fat_loss";
    const exp = u.trainingExperience || "beginner";

    const { calorieTarget, proteinTarget } = calculateTargets(
      weight, goal, u.lifeSituation || "office", u.trainingDaysPerWeek || 3,
      u.gender || "male", u.age || 30, u.heightCm || 170, exp
    );

    const stepsTarget = calculateStepsTarget(weight, u.age || 30, u.heightCm || 170, exp);
    const startPhase = exp === "beginner" ? 1 : 2;

    await db.update(users).set({
      workSchedule: schedule,
      calorieTarget,
      proteinTarget,
      stepsTarget,
      programmePhase: startPhase,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      programmeStartDate: new Date(),
      subscriptionStatus: "trial",
      betaBypassUntil: new Date(Date.now() + 7 * 86_400_000),
      onboardingState: "COMPLETE",
      popiConsent: true,
      popiConsentAt: new Date(),
    }).where(eq(users.phoneNumber, phone));

    const finalUser = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const f = finalUser[0];
    // Already COMPLETE above — never let programme generation throw away the welcome.
    let programme: string;
    try {
      programme = getKamlifeProgramme(f);
    } catch (e) {
      console.error("[ONBOARDING] getKamlifeProgramme failed in ASK_WORK_SCHEDULE — using fallback:", e);
      programme = `Your Day 1 workout is ready — reply *1* or *workout* and I'll send it straight through.`;
    }
    const goalLabel: Record<string, string> = {
      fat_loss: "Fat loss", muscle_gain: "Muscle gain", recomposition: "Body recomposition",
      general: "General fitness", health_condition: "Health management",
    };
    const nightNote = schedule === "night_shift"
      ? `\n\n⚠️ *Night shift note:* Your meal timing and training windows are adjusted for your schedule. Pre-shift = breakfast. Post-shift = dinner.`
      : "";
    const heartNote = u.doctorClearanceRequired
      ? `\n\n⚠️ *Heart condition noted:* Please get doctor clearance before starting the strength programme. Walking and light activity are safe to begin now.`
      : "";

    const appUrlLeg = process.env.APP_URL || "https://kamlifecoach.co.za";
    const merchantIdLeg = process.env.PAYFAST_MERCHANT_ID;
    const cleanPhoneLeg = phone.replace(/^whatsapp:/, "");
    const payLinkLeg = merchantIdLeg ? `${appUrlLeg}/api/payfast/link?phone=${encodeURIComponent(cleanPhoneLeg)}` : appUrlLeg;
    const legCalExplainer = goal === "muscle_gain"
      ? `*What ${calorieTarget} kcal means:* This is a surplus above maintenance — fuel to build muscle. Don't undershoot it. 1 egg = ~6g protein. 100g chicken = ~31g. Hit ${proteinTarget}g protein daily and the programme works.`
      : `*What ${calorieTarget} kcal means:* A plate of pap with stew is ~550 kcal. Your body burns ~1,200–1,500 kcal just to breathe before you move. Eat at this target and you lose fat without starving. Hit ${proteinTarget}g protein and hunger drops.`;
    return `Sharp. Your programme is built.\n\n*Goal:* ${goalLabel[goal] || goal}\n*Training:* ${f.trainingMode || "Home"} · ${f.trainingDaysPerWeek || 3} days/week\n*Calorie target:* ${calorieTarget} kcal/day\n*Protein target:* ${proteinTarget}g/day${nightNote}${heartNote}\n\n${legCalExplainer}\n\n_Coach K is AI-powered coaching — not a substitute for medical advice._\n\n---\n\n${programme}\n\n---\n\nYour personalised shopping list and weekly meal plan are ready.\n\nPay to unlock them — and Day 2 drops the moment you finish today's session.\n\n*R199/month — cancel anytime:*\n${payLinkLeg}\n\n_R6.63/day. Not satisfied after your first week? Message us and we'll make it right._\n\n---\n\n*From today, send me everything you eat.* Breakfast. Lunch. Dinner. A photo or a few words — I do the maths.\n\nSend your step count at the end of each day. Even if you missed the target — especially then.\n\n📸 *Progress photos* — front, side, back. Natural light, same position every time. Send them now to set your baseline. You will thank yourself in 8 weeks.`;
  }

  return await getMenuText(user);
}

// ============================================================
// HELPER FUNCTIONS (used internally by getMenuText)
// ============================================================

function getPhaseNames(): Record<number, string> {
  return { 1: "Foundation", 2: "Build", 3: "Push", 4: "Peak", 5: "Deload" };
}

function getDayType(dowOverride?: number): "push" | "pull" | "legs" | "core" | "rest" {
  // Fixed weekly schedule: Mon=push, Tue=pull, Wed=legs, Thu=core, Fri=push, Sat=pull, Sun=rest
  const dow = dowOverride !== undefined ? dowOverride : new Date().getDay();
  const map: Array<"push" | "pull" | "legs" | "core" | "rest"> =
    ["rest", "push", "pull", "legs", "core", "push", "pull"];
  return map[dow];
}
