// Onboarding meal-plan builder — extracted from onboarding.ts (2026-07-12) to keep
// that file under its size budget after the intake-question additions. Pure string
// builder: takes a user, returns the formatted meal plan. No external dependencies.

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

  // Dietary preference flags — stored in profileNotes as diet:halal / diet:vegetarian / diet:vegan
  const profileNotesLower = (user.profileNotes || "").toLowerCase();
  const isHalal = profileNotesLower.includes("diet:halal");
  const isVegetarian = profileNotesLower.includes("diet:vegetarian") || profileNotesLower.includes("diet:vegan");
  const isVegan = profileNotesLower.includes("diet:vegan");
  // Effective restriction flags extend allergy flags with dietary preferences
  const noFishEff = noFish || isVegetarian; // vegetarians/vegans don't eat fish or meat
  const noDairyEff = noDairy || isVegan;    // vegans don't consume dairy

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
  if (isHalal) medFlags.push("Halal — no pork, alcohol-free. Buy halal-certified chicken and beef.");
  if (isVegetarian && !isVegan) medFlags.push("Vegetarian — no meat or fish");
  if (isVegan) medFlags.push("Vegan — plant-based only, no animal products");

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

  // ---- BREAKFAST proteins (egg-based for omnivores, plant-based for vegans) ----
  const bfProteins = isVegan
    ? (noPeanuts
        ? ["½ cup oats + soya milk + banana", "soya yoghurt 150g + fruit", "½ cup oats + soya milk", "soya yoghurt 150g + banana", "½ cup oats + soya milk", "soya yoghurt 150g", "½ cup oats + soya milk + banana"]
        : ["½ cup oats + 1 tbsp PB + banana", "soya yoghurt 150g", "½ cup oats + 1 tbsp PB", "½ cup oats + banana + 1 tbsp PB", "½ cup oats + soya milk", "soya yoghurt 150g + fruit", "½ cup oats + 1 tbsp PB + banana"])
    : goal === "muscle_gain"
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

  // Dietary override — completely replace protein arrays for vegetarian/vegan clients
  if (isVegan) {
    if (budget === "under_100") {
      lunchProteins = ["200g cooked sugar beans", "150g cooked lentils", "200g cooked sugar beans", noPeanuts ? "soya mince 50g dry" : "soya mince 50g + 1 tbsp PB", "200g sugar beans + lentils", "150g cooked lentils", "soya mince 50g dry"];
      dinnerProteins = ["150g cooked lentils", "200g cooked sugar beans", "150g cooked lentils", "200g cooked sugar beans", "150g cooked lentils", "200g cooked sugar beans", "150g cooked lentils"];
    } else {
      lunchProteins = ["200g firm tofu", "150g cooked lentils", "soya mince 100g dry", "200g sugar beans + lentils", "200g firm tofu", "soya mince 100g dry", "150g cooked lentils"];
      dinnerProteins = ["150g cooked lentils", "200g firm tofu", "soya mince 100g dry", "200g cooked sugar beans", "150g cooked lentils", "200g firm tofu", "soya mince 100g dry"];
    }
  } else if (isVegetarian) {
    if (budget === "under_100") {
      lunchProteins = ["4 boiled eggs", "200g cottage cheese", "4 boiled eggs", "sugar beans (200g cooked) + 1 egg", "4 boiled eggs", "200g cottage cheese", "4 boiled eggs"];
      dinnerProteins = ["3 boiled eggs", "sugar beans (200g cooked)", "3 boiled eggs", "200g cottage cheese", "3 boiled eggs", "sugar beans (200g cooked)", "3 boiled eggs"];
    } else if (budget === "100_300") {
      lunchProteins = ["4 boiled eggs", "200g cottage cheese", "4 boiled eggs", "sugar beans (200g) + 2 eggs", "4 boiled eggs", "200g cottage cheese", "4 boiled eggs"];
      dinnerProteins = ["3 boiled eggs", "200g cottage cheese", "3 boiled eggs", "sugar beans (200g)", "3 boiled eggs", "200g cottage cheese", "3 boiled eggs"];
    } else if (budget === "300_600") {
      lunchProteins = ["4 boiled eggs", "150g firm tofu", "150g cottage cheese", "3 eggs + sugar beans 100g", "150g firm tofu", "200g cottage cheese", "4 boiled eggs"];
      dinnerProteins = ["150g cottage cheese", "3 boiled eggs", "150g firm tofu", "3 boiled eggs + sugar beans", "150g cottage cheese", "150g firm tofu", "3 boiled eggs"];
    } else {
      lunchProteins = ["4 boiled eggs", "200g firm tofu", "200g cottage cheese", "3 eggs + 150g Greek yoghurt", "200g firm tofu", "4 boiled eggs + cottage cheese", "200g firm tofu"];
      dinnerProteins = ["200g firm tofu", "3 boiled eggs", "200g cottage cheese", "200g firm tofu", "3 boiled eggs + sugar beans", "200g cottage cheese", "200g firm tofu"];
    }
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

  // Dairy/milk based on goal (vegans get soya milk instead)
  const milkType = isVegan ? "soya milk" : (goal === "muscle_gain" && !noDairy && budget !== "under_100") ? "full cream milk" : (!noDairy ? "low fat milk" : "water");
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

  // Override pre/post workout options for vegetarian and vegan clients
  if (isVegan) {
    preOptions[0] = noPeanuts ? `banana + ½ cup oats — 220 cal, 6g protein, 5 min` : `1 tbsp PB + banana — 220 cal, 8g protein, 2 min`;
    preOptions[1] = `½ cup oats + soya milk + banana — 210 cal, 7g protein, 5 min`;
    preOptions[2] = noPeanuts ? `banana + ½ cup oats — 200 cal, 6g protein, 5 min` : `1 tbsp PB + 1 banana — 220 cal, 8g protein, 2 min`;
    preOptions[3] = `½ cup oats + soya milk — 160 cal, 6g protein, 5 min`;
    postOptions[0] = `200g cooked lentils + ½ cup brown rice — 300 cal, 18g protein`;
    postOptions[1] = `200g cooked sugar beans + 1 medium sweet potato — 290 cal, 16g protein`;
    postOptions[2] = `soya mince 80g dry + ½ cup rice — 280 cal, 22g protein`;
    postOptions[3] = `200g cooked lentils + banana — 270 cal, 17g protein`;
  } else if (isVegetarian) {
    // No fish, no meat — eggs and dairy are fine
    preOptions[2] = `banana + 1 boiled egg — 180 cal, 10g protein, 2 min`;
    postOptions[0] = `3 boiled eggs + 1 medium sweet potato — 340 cal, 24g protein`;
    postOptions[2] = noDairy ? `4 boiled eggs + ½ cup brown rice — 320 cal, 28g protein` : `150g cottage cheese + ½ cup brown rice — 280 cal, 25g protein`;
  }

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
    if (isVegan) {
      // bfProt is already a plant-based string from the vegan bfProteins array
      bf = i % 2 === 0
        ? `${bfProt} + ${bfCarb} — ${bfCal} cal, 12g protein, 5 min`
        : `${bfProt} — ${bfCal} cal, 10g protein, 3 min`;
    } else if (isStudent) {
      bf = i % 2 === 0
        ? `½ cup oats + ${noDairyEff ? "water" : "low fat milk"} + 1 boiled egg — ${bfCal} cal, 14g protein, 8 min`
        : noGluten ? `2 boiled eggs + banana — ${bfCal} cal, 15g protein, 5 min` : `2 boiled eggs + 2 brown bread — ${bfCal} cal, 16g protein, 8 min`;
    } else if (isLowGI) {
      bf = i % 2 === 0
        ? `${bfCarb} + ${noDairyEff ? "" : `${milkType} + `}2 boiled eggs — ${bfCal} cal, 18g protein, ${maxPrep}`
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
      lunch = noFishEff
        ? `${lp} + ${lc} + ${v} — ${lunchCal} cal, 22g protein, 10 min`
        : i % 2 === 0 ? `1 tin pilchards + ${noGluten ? "1 sweet potato" : "2 brown bread"} — ${lunchCal} cal, 25g protein, 3 min` : `${lp} + ${lc} — ${lunchCal} cal, 20g protein, 10 min`;
    } else {
      lunch = `${lp} + ${lc} + ${v}${seasonNote} — ${lunchCal} cal, 25g protein, ${maxPrep}`;
    }

    // ---- DINNER ----
    let dinner: string;
    if (isStudent) {
      dinner = i % 2 === 0
        ? noFishEff ? (isVegan ? `150g cooked lentils + cabbage — ${dinnerCal} cal, 12g protein, 8 min` : `2 eggs + cabbage — ${dinnerCal} cal, 14g protein, 8 min`) : `½ tin pilchards + cabbage — ${dinnerCal} cal, 18g protein, 5 min`
        : isVegan ? `200g cooked sugar beans + spinach — ${dinnerCal} cal, 12g protein, 8 min` : `2 eggs + spinach — ${dinnerCal} cal, 14g protein, 8 min`;
    } else {
      dinner = `${dp} + ${dc} + ${v2}${seasonNote} — ${dinnerCal} cal, 25g protein, ${maxPrep}`;
    }

    // Snack
    let snack = "";
    if (budget !== "under_100") {
      if (goal === "muscle_gain") snack = noPeanuts ? `baked beans ½ tin — 110 cal, 7g protein` : `${pbServing} + banana — 260 cal, 9g protein`;
      else if (!noDairyEff && budget !== "100_300") snack = `low fat yoghurt 150g — 100 cal, 10g protein`;
      else snack = `baked beans ½ tin — 110 cal, 7g protein`;
    }

    const dayLabel = isTraining ? `${day} — Training Day 🏋️` : `${day} — Rest Day`;
    let dayPlan = `\n*${dayLabel}*\n`;
    if (isTraining) dayPlan += `Pre-workout (60–90 min before): ${pre}\n`;
    dayPlan += `${meal1Label}: ${bf}\n`;
    if (isLowGI) dayPlan += `Snack 10am: 1 apple or banana + ${isVegan ? (noPeanuts ? "handful almonds" : "1 tbsp peanut butter") : "1 boiled egg"} — 120 cal, ${isVegan ? "4" : "8"}g protein\n`;
    dayPlan += `Lunch: ${lunch}\n`;
    if (isLowGI) dayPlan += `Snack 3pm: ${isVegan ? (noPeanuts ? "200g cooked sugar beans" : "1 tbsp peanut butter + apple") : noDairyEff ? "1 boiled egg" : "125g low fat yoghurt or 1 boiled egg"} — 80 cal, ${isVegan ? "5" : "8"}g protein\n`;
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

  // Override shopping list for vegetarian/vegan clients
  if (isVegan || isVegetarian) {
    if (budget === "under_100") {
      shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\n${isVegan ? "Soya milk 1L — R20" : "Eggs 12 pack — R45"}\n${isVegan ? "" : "Cottage cheese 250g — R18\n"}Sugar beans 500g — R20\nLentils 500g — R15\n${isVegan ? "Soya mince 250g dry — R20\n" : ""}Cabbage 1 head — R8\n${isLowGI ? "Oats 500g — R15 (replaces pap)" : "Pap/maize meal 2kg — R15"}\nSpinach 1 bunch — R10\nOnions — R8\nSunflower oil 500ml — R10`;
      shopTotal = isVegan ? 118 : 134;
      proTip = isVegan ? "Soak sugar beans overnight and cook Sunday — 4 days of plant protein at under R5 per serving. Soya mince from Shoprite is R20 and gives you a full week of dinners." : "Cook a big pot of sugar beans on Sunday — it feeds you 4 days at under R7 per serving. Add 2 boiled eggs per bowl for complete protein.";
    } else if (budget === "100_300") {
      shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\n${isVegan ? "Soya milk 1L — R20\n" : "Eggs 12 pack — R45\n"}Sugar beans 500g — R20\nLentils 500g — R15\nSoya mince 250g dry — R20\nFirm tofu 400g — R35\n${isVegan ? "" : "Cottage cheese 250g — R18\n"}Oats 500g — R15\n${noGluten ? "" : "Brown bread 1 loaf — R14\n"}Sweet potato 1kg — R12\nCabbage — R8\nSpinach — R10\nOnions + tomatoes — R23\nGarlic — R8\nSunflower oil — R10`;
      shopTotal = isVegan ? 180 : 233;
      proTip = "Firm tofu from Shoprite absorbs any flavour — fry with garlic and soy sauce. It surprises people how good it is. 12g protein per 100g and cheaper than chicken breast per gram of protein.";
    } else {
      shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\n${isVegan ? "Soya milk 1L — R20" : "Eggs 12 pack — R45"}\nFirm tofu 400g×2 — R70\nSoya mince 250g dry — R20\nLentils 500g — R15\nSugar beans 500g — R20\n${isVegan ? "" : `Cottage cheese 250g — R18\n${budget !== "100_300" ? "Low fat Greek yoghurt 500g — R35\n" : ""}`}Oats 1kg — R25\nBrown rice 1kg — R20\nSweet potato 1.5kg — R18\nBanana bunch — R15\n${noPeanuts ? "" : "Peanut butter 400g — R25\n"}Broccoli — R20\nSpinach — R10\nGarlic + lemon — R13`;
      shopTotal = isVegan ? 261 : 344;
      proTip = isVegan ? "Rotate tofu and soya mince through the week — different textures, same protein. Marinade tofu in soy sauce and garlic 30 minutes before cooking for best results." : "Cottage cheese mixed with eggs makes the quickest high-protein breakfast in SA — R18 for 250g at Shoprite. 45g protein from just these two ingredients.";
    }
  } else if (isHalal) {
    shopList += `\n\n⚠️ _Halal: Buy chicken and beef from a halal-certified butcher or look for the halal label at Shoprite, Pick n Pay, or your local halal store._`;
  }

  // Special situation notes
  const goalNote = goal === "fat_loss"
    ? `\n\n⚠️ *Fat loss rules:* Sweet potato over white pap always. High-volume veg fills the plate first — protein second, carbs last. ${noDairyEff ? "" : "Low fat dairy only."} ${noPeanuts ? "" : "Max 1 tbsp peanut butter — not a staple."}`
    : goal === "muscle_gain"
    ? `\n\n💪 *Muscle gain rules:* ${isVegan ? "Plant protein at every meal — beans, lentils, tofu, soya mince. Hit the numbers." : "Whole eggs every time — the yolk has the nutrients."} ${noDairyEff ? (isVegan ? "Soya milk adds easy calories." : "") : `${milkType} for extra calories.`} ${noPeanuts ? "" : "Peanut butter is your friend — calorie dense and protein rich."} Pre and post-workout meals are non-negotiable.`
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
