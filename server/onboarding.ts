import { db } from "./db";
import { users, weightLogs, chatHistory, workoutLogs, stepLogs } from "../shared/schema";
import { eq, and, desc, gte } from "drizzle-orm";
import { buildFullProgramme, getKamlifeProgramme } from "./programme";
import { calculateTargets } from "./targets";
import { askCoachK } from "./gpt";

// ============================================================
// MENU TEXT — context-aware
// ============================================================

export async function getMenuText(user: any): Promise<string> {
  const name = getDisplayName(user);
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const day = user.programmeDayInWeek || 1;
  const dayType = getDayType(day);
  const dayLabel = { push: "Push 💪", pull: "Pull 🏋️", legs: "Legs 🦵", core: "Core 🔥", rest: "Rest 🛌" }[dayType] || "Today's session";
  const mode = user.trainingMode || "home";
  const stepsTarget = user.stepsTarget || 8000;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  let workoutDone = false;
  let todayStepCount: number | null = null;

  try {
    const [todayWorkout, todaySteps] = await Promise.all([
      db.select().from(workoutLogs)
        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStart)))
        .limit(1),
      db.select().from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStart)))
        .limit(1),
    ]);
    workoutDone = todayWorkout.length > 0;
    todayStepCount = todaySteps.length > 0 ? todaySteps[0].steps : null;
  } catch { }

  const workoutStatus = mode !== "walk_only"
    ? (workoutDone ? `Workout ✅` : `Today: ${dayLabel}`)
    : null;
  const stepStatus = todayStepCount !== null
    ? `Steps: ${todayStepCount.toLocaleString()}/${stepsTarget.toLocaleString()}${todayStepCount >= stepsTarget ? " ✅" : ""}`
    : null;

  const statusParts = [workoutStatus, stepStatus].filter(Boolean).join(" · ");

  const headerLine = name
    ? `*KamLife Coach* — ${name}\nPhase ${phase}: ${phaseName}${statusParts ? ` | ${statusParts}` : ""}`
    : `*KamLife Coach* 💪`;

  return `${headerLine}

What do you need?
1️⃣ Today's workout
2️⃣ Food coaching
3️⃣ Log steps
4️⃣ Log sleep
5️⃣ Log weight
6️⃣ Weekly report
7️⃣ Measurements check-in
8️⃣ Non-scale victory check-in

Or just tell me what you ate, how training went, your steps, or anything on your mind.`;
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
    dinnerCarbs = ["½ medium sweet potato", "½ cup brown rice", "extra veg only (rest day)", "½ medium sweet potato", "½ cup brown rice", "extra veg only (rest day)", "½ medium sweet potato"];
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
  const domesticNote = (situation === "retail_physical" && !isUnemployed) ? `\n\n🧹 *Active job note:* Your job already burns 300+ extra calories. Plan adjusted. Batch cook Sunday so you have food ready without cooking after long shifts.` : "";
  const studentNote = isStudent ? `\n\n📚 *Student note:* Every meal in this plan is under 10 minutes and under 3 ingredients. Res tuck shop strategy — pilchards + brown bread is one of the best budget meals in SA. Maggi noodles + 1 egg is acceptable when budget is critical.` : "";
  const unemployedNote = isUnemployed ? `\n\n💰 *Budget note:* Every meal here costs under R15. Batch cook beans on Sunday for the week — one 500g bag of sugar beans feeds you protein for 4 days at R5 per serving.` : "";

  const trainingDaysStr = Array.from(trainingSet).join(", ");
  const header = `*Your Personalised 7 Day Meal Plan*\n${name} | Goal: ${goalLabels[goal] || goal} | ${adjustedCal} cal/day | ${adjustedProt}g protein/day\nBudget: ${budgetLabels[budget]} per week | Shop at Shoprite or Boxer${medFlags.length > 0 ? `\n⚠️ Medical: ${medFlags.join(" · ")}` : ""}`;
  const trainingLine = `\n*Training Days:* ${trainingDaysStr} (${daysPerWeek} day${daysPerWeek > 1 ? "s" : ""}/week)`;

  return `${header}${trainingLine}${goalNote}${nightNote}${hivNote}${domesticNote}${studentNote}${unemployedNote}\n${plan}\n\n${shopList}\nEstimated total: R${shopTotal}\n🛒 Pro tip: ${proTip}\n\n_Reply SWAP [day] to swap any day. Reply SHOPPING LIST for just the shopping list. Reply WHY to understand why I chose these specific foods for your goal._`;
}

// ============================================================
// ONBOARDING FLOW — 3-QUESTION FAST TRACK
// POPIA → Name → Goal → Gym or Home → Immediate programme
// Everything else collected progressively through coaching
// ============================================================

export async function handleOnboarding(user: any, message: string, phone: string): Promise<string> {
  const state = user.onboardingState || "START";
  const msg = message.trim();

  // ---- START — POPIA consent combined with introduction ----
  if (state === "START") {
    await db.update(users).set({ onboardingState: "ASK_POPIA" }).where(eq(users.phoneNumber, phone));
    return `Coach K here. SA fitness and nutrition coach — real programmes, real food advice, real accountability.\n\nI store your health and fitness data to coach you personally (POPIA protected, never sold, deleted on request).\n\nReply *yes* to start. Three questions and your programme is ready.`;
  }

  // ---- ASK_POPIA ----
  if (state === "ASK_POPIA") {
    const consentWords = ["yes", "agree", "consent", "ok", "okay", "yebo", "ja", "sure", "accept", "i agree", "i consent", "yes coach", "i do"];
    if (consentWords.some(k => msg === k || msg.startsWith(k) || msg.includes(k))) {
      await db.update(users).set({ popiConsent: true, popiConsentAt: new Date(), onboardingState: "WELCOME" }).where(eq(users.phoneNumber, phone));
      return `Sharp. What's your name?`;
    }
    return `I need your consent before I can coach you. Your data is used only for your coaching — never sold. Reply *yes* to continue.`;
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
    await db.update(users).set({ name, onboardingState: "ASK_GOAL" }).where(eq(users.phoneNumber, phone));
    return `Sharp ${name}. What's your main goal?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both`;
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
    await db.update(users).set({ goalType: goal, onboardingState: "ASK_EQUIPMENT" }).where(eq(users.phoneNumber, phone));
    return `Gym or home training?`;
  }

  // ---- ASK_EQUIPMENT — gym or home, then go straight to COMPLETE ----
  if (state === "ASK_EQUIPMENT") {
    const lower = msg.toLowerCase();
    let mode = "home";
    let gymName: string | null = null;

    if (/\b(dumbbell|dumbbells|db only|no barbell|no cables|basic gym)\b/i.test(lower)) {
      mode = "gym_dumbbell";
      gymName = "Basic Gym";
    } else if (/\bgym\b/i.test(lower) || lower.includes("virgin") || lower.includes("planet fitness") || lower.includes("curves")) {
      mode = "gym";
      if (lower.includes("virgin")) gymName = "Virgin Active";
      else if (lower.includes("planet")) gymName = "Planet Fitness";
      else if (lower.includes("curves")) gymName = "Curves";
      else if (/\bgym\b/i.test(lower)) gymName = "Gym";
    }

    // Female glute focus detection
    const primaryFocusArea = /\b(glutes?|bum|booty|legs? and glutes?|lower body|hips?)\b/i.test(lower) ? "glutes_legs" : null;

    // Set defaults for everything — collected progressively through coaching
    const defaultDays = 3;
    const defaultExp = "beginner";
    const defaultGoal = user.goalType || "fat_loss";
    const defaultWeight = 75;
    const defaultBudget = "100_300";

    const { calorieTarget, proteinTarget } = calculateTargets(
      defaultWeight, defaultGoal, "office", defaultDays
    );

    await db.update(users).set({
      trainingMode: mode,
      gymName: gymName || null,
      trainingDaysPerWeek: defaultDays,
      trainingExperience: defaultExp,
      weeklyFoodBudget: defaultBudget,
      budgetLevel: "medium",
      lifeSituation: "office",
      workSchedule: "standard",
      calorieTarget,
      proteinTarget,
      stepsTarget: 7000,
      programmePhase: 1,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      programmeStartDate: new Date(),
      subscriptionStatus: "inactive",
      onboardingState: "COMPLETE",
      ...(primaryFocusArea ? { primaryFocusArea } : {}),
    }).where(eq(users.phoneNumber, phone));

    const goalLabel: Record<string, string> = {
      fat_loss: "Fat loss", muscle_gain: "Muscle gain", recomposition: "Recomposition",
    };
    const modeLabel = mode === "gym_dumbbell" ? "Dumbbell gym" : mode === "gym" ? (gymName || "Gym") : "Home training";
    const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
    const merchantId = process.env.PAYFAST_MERCHANT_ID;
    const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
    const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;

    return `Sharp. Your programme is built.\n\n*Goal:* ${goalLabel[defaultGoal] || defaultGoal}\n*Training:* ${modeLabel} · 3 days/week\n*Calorie target:* ${calorieTarget} kcal/day\n*Protein target:* ${proteinTarget}g/day\n\nActivate coaching to get Day 1 and start:\n\n*R99/month — cancel anytime:*\n${payLink}\n\nThat is R3.30 per day. Daily workouts, food coaching, SA meal plans, weekly progress reports — all in WhatsApp. No app needed.\n\nPay now and Day 1 drops immediately.`;
  }

  // ---- LEGACY STATES — kept for existing users mid-onboarding ----
  // These handle clients who started onboarding before the 3-question rewrite

  if (state === "ASK_AGE") {
    const age = parseInt(msg.replace(/[^0-9]/g, ""));
    if (isNaN(age) || age < 10 || age > 110) return `Just your age. For example: 28`;
    if (age < 16) return `I coach from age 16 upward.`;
    const isElderly = age >= 65;
    await db.update(users).set({ age, elderlyClient: isElderly, onboardingState: "ASK_WEIGHT_HEIGHT" }).where(eq(users.phoneNumber, phone));
    return `Weight and height? Example: 78kg, 1.72m`;
  }

  if (state === "ASK_WEIGHT_HEIGHT") {
    const weightMatch = msg.match(/(\d+(?:\.\d+)?)\s*kg/i);
    if (!weightMatch) return `Weight and height please. Example: 78kg, 1.72m`;
    const weight = parseFloat(weightMatch[1]);
    if (weight < 30 || weight > 350) return `That weight doesn't look right. Example: 78kg`;
    const heightMMatch = msg.match(/(\d+\.\d+)\s*m(?!g)/i);
    const heightCmMatch = msg.match(/(\d{3})\s*cm/i);
    let heightM = 1.7; let heightCmVal = 170;
    if (heightMMatch) { heightM = parseFloat(heightMMatch[1]); heightCmVal = Math.round(heightM * 100); }
    else if (heightCmMatch) { heightCmVal = parseInt(heightCmMatch[1]); heightM = heightCmVal / 100; }
    const bmi = Math.round((weight / (heightM * heightM)) * 10) / 10;
    await db.update(users).set({ currentWeight: weight.toString(), heightCm: heightCmVal, bmi: bmi.toString(), proteinTarget: Math.round(weight * 2), onboardingState: "ASK_GOAL" }).where(eq(users.phoneNumber, phone));
    return `Main goal?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both`;
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
    await db.update(users).set({
      medicalConditions: conditions.length > 0 ? conditions.join(",") : "none",
      nutritionProtocol: hasDiabetes ? "LOW_GI" : null,
      mealTimingStrict: hasDiabetes,
      doctorClearanceRequired: hasHeart,
      onboardingState: "ASK_INJURIES",
    }).where(eq(users.phoneNumber, phone));
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
    return `Gym or home training?`;
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
    await db.update(users).set({ trainingExperience: exp, onboardingState: "ASK_BUDGET" }).where(eq(users.phoneNumber, phone));
    return `Weekly food budget?\n\n1️⃣ Under R100\n2️⃣ R100–R300\n3️⃣ R300–R600\n4️⃣ Over R600`;
  }

  if (state === "ASK_BUDGET") {
    const lower = msg.toLowerCase();
    let budget = "100_300";
    if (/^\s*1\s*$/.test(msg) || lower.includes("under") || lower.includes("tight")) budget = "under_100";
    else if (/^\s*2\s*$/.test(msg)) budget = "100_300";
    else if (/^\s*3\s*$/.test(msg) || lower.includes("average")) budget = "300_600";
    else if (/^\s*4\s*$/.test(msg) || lower.includes("flexible") || lower.includes("over")) budget = "over_600";
    const randMatch = msg.match(/R\s*(\d+)/i);
    if (randMatch) {
      const r = parseInt(randMatch[1]);
      budget = r < 100 ? "under_100" : r <= 300 ? "100_300" : r <= 600 ? "300_600" : "over_600";
    }
    const budgetLevel = budget === "under_100" ? "low" : budget === "over_600" ? "high" : "medium";
    await db.update(users).set({ weeklyFoodBudget: budget, budgetLevel, onboardingState: "ASK_WORK_SCHEDULE" }).where(eq(users.phoneNumber, phone));
    return `Last one. Work schedule?\n\n1️⃣ Standard (8am–5pm)\n2️⃣ Early shift\n3️⃣ Night shift\n4️⃣ Irregular\n5️⃣ Work from home`;
  }

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
      weight, goal, u.lifeSituation || "office", u.trainingDaysPerWeek || 3
    );

    const stepsTarget = exp === "beginner" ? 7000 : 8000;
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
      onboardingState: "COMPLETE",
      popiConsent: true,
      popiConsentAt: new Date(),
    }).where(eq(users.phoneNumber, phone));

    const finalUser = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const f = finalUser[0];
    const programme = getKamlifeProgramme(f);
    const mealPlan = getOnboardingMealPlan(f);
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

    return `*${f.name}, your profile is set.* Here is what Coach K has built for you.\n\n🎯 *Goal:* ${goalLabel[goal] || goal}\n⚖️ *Weight:* ${weight}kg\n🍽️ *Calories:* ${calorieTarget} kcal/day\n💪 *Protein:* ${proteinTarget}g/day\n👟 *Steps:* ${stepsTarget.toLocaleString()}/day\n\n${programme}\n\n${mealPlan}${nightNote}${heartNote}\n\n*Your action today:* Do your first session. Reply DONE when you finish and I log it.`;
  }

  return await getMenuText(user);
}

// ============================================================
// HELPER FUNCTIONS (used internally by getMenuText)
// ============================================================

function getDisplayName(user: any): string {
  const INVALID = new Set(["HI", "HEY", "HELLO", "YES", "NO", "OK", "OKAY", "MENU", "HELP", "DONE", "USER", "THERE"]);
  if (!user.name || user.name.length < 2 || INVALID.has((user.name || "").toUpperCase())) return "";
  return user.name;
}

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
