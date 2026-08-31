process.env.KAMLIFE_DB_STUB = "1"; process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.NORMALIZER = "off"; process.env.PROACTIVE_PAUSED = "true"; process.env.NODE_ENV = "production";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000"; process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000"; process.env.APP_URL = "https://x.up.railway.app";
const g: any = globalThis as any;
(async () => {
  const schema = await import("../shared/schema");
  const { handleMessage } = await import("../server/routes");
  const { sastToday } = await import("../server/utils");
  const USER: any = { id: "qa", phoneNumber: "whatsapp:+27000000070", name: "Kam",
    onboardingState: "COMPLETE", onboardingComplete: true, subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss", currentWeight: 95, targetWeight: 85,
    heightCm: 180, age: 35, gender: "male", activityLevel: "moderate", trainingMode: "gym", trainingDaysPerWeek: 3,
    injuries: "none", medicalConditions: "none", awaitingInputType: null, profileNotes: "", todayWater: "0",
    stepTarget: 10000, lastActiveAt: new Date(), createdAt: new Date() };
  for (const o of [{p:129,c:2146,b:"under_100"},{p:129,c:420,b:"100_300"},{p:22,c:2146,b:"under_100"}]) {
    g.__KAMLIFE_STUB_USER = { ...USER, weeklyFoodBudget: o.b, todayCaloriesDate: sastToday(),
      calorieTarget: 2400, todayCalories: 2400 - o.c, proteinTarget: 150, todayProteinG: 150 - o.p };
    g.__KAMLIFE_STUB_ROWS = new Map([[schema.mealLogs, []], [schema.stepLogs, []], [schema.workoutLogs, []], [schema.weightLogs, []]]);
    g.__KAMLIFE_STUB_WRITES = [];
    const r = await handleMessage(USER.phoneNumber, "what should I eat next?").catch((e:any)=>String(e));
    console.log(`\n===== protLeft=${o.p} calLeft=${o.c} budget=${o.b} =====\n${r}`);
  }
})();
