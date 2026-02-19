function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const R = {

  foodGood: () => pick([
    "Logged. That's how it's done.",
    "Solid meal. Keep that standard.",
    "Logged. Consistency is what gets results.",
    "That's the KAM Life way. Keep it up.",
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

  stepsLow: () => pick([
    "That's too low. Get up and do a 10-minute walk right now. Small movement adds up.",
    "Not good enough. You need to move more. Even 10 minutes outside counts.",
    "Below target. Do a 5-minute walk before bed. Every step counts.",
  ]),

  stepsGood: () => pick([
    "Solid. That's how you build the habit.",
    "Good work. Keep that momentum tomorrow.",
    "Steps done. Consistency over perfection.",
  ]),

  stepsTarget: () => pick([
    "Target hit. That's discipline.",
    "Full target. That's the standard — repeat it tomorrow.",
    "You hit it. Now do it again tomorrow.",
  ]),

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

  sleepPoor: () => pick([
    "Under 5 hours kills recovery and spikes cravings. Protect your sleep — it's part of the programme.",
    "Poor sleep slows fat loss. Get to bed 30 minutes earlier tonight.",
    "Sleep is part of training. Less than 5 hours is not enough. Fix this.",
  ]),

  sleepGood: () => pick([
    "Good sleep. Your body recovers and burns fat at night — protect that.",
    "Solid rest. That's how you recover properly.",
    "Sleep logged. That's the foundation — keep it consistent.",
  ]),

  weeklyLockedIn: () => pick([
    "Elite week. That's the KAM Life standard. Keep this intensity.",
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
};
