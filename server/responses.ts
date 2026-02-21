function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const R = {

  foodGood: () => pick([
    "Logged. That's how it's done.",
    "Solid meal. Keep that standard.",
    "Logged. Consistency is what gets results.",
    "That's the KamLife Coach way. Keep it up.",
  ]),

  noProtein: () => pick([
    "Add protein next time — eggs, chicken, tinned fish. Every meal needs it.",
    "Where's the protein? Eggs, beans, chicken. Sort it out next meal.",
    "No protein detected. Fix that next time — your body needs it to hold muscle while losing fat.",
  ]),

  junkDetected: () => pick([
    "That's a cheat. One bad meal doesn't break progress — but two in a row does. Next meal must be clean.",
    "Junk logged. You've used your flexibility. Next meal: protein + veg. No excuses.",
    "That counts as your occasional junk. Reset next meal — lean protein and vegetables.",
  ]),

  alcoholDetected: () => pick([
    "Alcohol kills fat loss. It's your choice, but know the cost. Back to clean eating tomorrow.",
    "That drink costs you more than calories — it kills recovery and sleep. Limit it.",
    "Alcohol logged. This slows everything down. Don't make it a habit.",
  ]),

  portionGood: () => pick([
    "Perfect portion. That's discipline.",
    "Good portion control. That's what separates people who get results.",
    "Spot on. One fist carbs per meal is the standard.",
  ]),

  portionHigh: (target: string) => pick([
    `Too much. Your target is ${target} fist(s) of carbs per meal. Reduce it next time.`,
    `That's over your carb target of ${target} fist(s). Cut it down next meal.`,
    `Portion too big. Stick to ${target} fist(s) of carbs — that's your fat loss window.`,
  ]),

  drinkLogged: () => pick([
    "Logged. Stay on top of water — minimum 2L daily.",
    "Hydration tracked. Keep water as your primary drink.",
    "Logged. Water first, always.",
  ]),

  stepsLow: () => "That's not enough movement. Get outside for 10 minutes right now — even a short walk counts.",

  stepsGood: () => "Decent effort. Push for your daily target tomorrow — consistency is what moves the scale.",

  stepsTarget: () => "Target hit. That's the standard — repeat it tomorrow.",

  mealSkipped: () => pick([
    "Skipping meals slows fat loss and triggers cravings later. Eat 2 eggs or a tin of fish now.",
    "Don't skip meals. Your metabolism needs fuel. Get some protein in — eggs, beans, yogurt.",
    "Meal skipped. That's not the plan. Have a small protein source now and don't skip again.",
  ]),

  workoutDone: () => pick([
    "Done. That's another session banked. Recovery now — eat protein and rest.",
    "Workout logged. You showed up. That's what matters.",
    "Solid. One more session in the bank. Keep the standard.",
  ]),

  sleepPoor: () => "Under 5 hours is not enough. Your body can't recover or burn fat properly. Get to bed earlier tonight — this is non-negotiable.",

  sleepOk: () => "Not bad but not optimal. Aim for 7-8 hours — that's when your body does its best work.",

  sleepGood: () => "Solid sleep. That's how you recover properly and keep cravings in check.",

  weeklyLockedIn: () => pick([
    "Elite week. That's the KamLife Coach standard. Keep this intensity.",
    "90%+ compliance. You're not just building a body — you're building discipline.",
    "Locked in. This is what separates people who get results from people who don't.",
  ]),

  weeklyConsistent: () => pick([
    "Solid week. You're building real momentum — don't let up now.",
    "Consistent. That's the foundation. Push for 90% this coming week.",
    "Good week. You're trending in the right direction. Tighten it up.",
  ]),

  weeklyBuilding: () => pick([
    "Room to grow. Identify your weakest pillar and fix it this week.",
    "You're building — but there's more in the tank. Let's push harder this week.",
    "Progress, but not enough. Pick one thing to improve and lock it in.",
  ]),

  weeklyReset: () => pick([
    "Rough week. We reset today. No looking back — what's the plan for tomorrow?",
    "Below 60%. That means we start again. Commit to just 3 things this week: protein every meal, 6k steps daily, 3 workouts.",
    "We reset. No excuses — just action. Reply MENU to start fresh.",
  ]),

  weightLogged: (val: string) => pick([
    `Logged ${val}kg. The scale is just data — consistency is what matters.`,
    `${val}kg recorded. Don't obsess over the number — focus on the process.`,
    `Weight logged: ${val}kg. Keep tracking weekly. Trends matter more than single readings.`,
  ]),

  drinkFollowUp: () => pick([
    "Hydration tracked. Anything else to log? (yes/no)",
    "Drink logged. Stay on water. Anything else? (yes/no)",
    "Noted. Keep water as your main drink. Anything else to log? (yes/no)",
  ]),

  onboardingName: (name: string) => pick([
    `Welcome ${name}. By continuing you agree to our coaching terms — KamLife Coach provides fitness guidance only, not medical advice. Consult a doctor before starting any programme.\n\nWhat's your main goal? (Fat Loss or Muscle Gain)`,
    `Got it, ${name}. By continuing you agree to our coaching terms — KamLife Coach provides fitness guidance only, not medical advice. Consult a doctor before starting any programme.\n\nWhat are we working towards? (Fat Loss or Muscle Gain)`,
    `${name} — let's get started. By continuing you agree to our coaching terms — KamLife Coach provides fitness guidance only, not medical advice. Consult a doctor before starting any programme.\n\nWhat's the goal? (Fat Loss or Muscle Gain)`,
  ]),

  onboardingGoal: () => pick([
    "Locked in. What's your current weight in kg?",
    "Got it. Now tell me your current weight in kg.",
    "Goal set. What do you weigh right now? (in kg)",
  ]),

  onboardingComplete: () => pick([
    "You're in. Log your food, steps, sleep, and workouts daily. I'll check in every Sunday. Reply MENU to start.",
    "Onboarding done. The real work starts now. Reply MENU to see your options.",
    "Setup complete. No more excuses — just action. Reply MENU to begin.",
  ]),

  promptFood: () => "What did you eat?",
  promptSteps: () => "How many steps today?",
  promptSleep: () => "How many hours did you sleep?",
  promptWeight: () => "What is your weight today (kg)?",
  promptDrink: () => "What did you drink?",
  promptDrinkToday: () => "What did you drink today?",
  promptAnythingElse: () => "Anything else to log? (yes/no)",

  portionCheck: (carb: string) => `Portion check for ${carb}: how much was it?\n1) 1 fist\n2) 2 fists\n3) 3+ fists`,

  workoutToday: (day: number, workout: string) => `Today is Day ${day}: ${workout}\nReply DONE when finished.`,

  targets: (cals: number, protein: number, steps: number) =>
    `Your targets:\nCalories: ${cals}kcal\nProtein: ${protein}g\nSteps: ${steps}`,
};
