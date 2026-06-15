/**
 * ROUTING AUDIT — runs realistic client messages through the REAL handleMessage
 * pipeline (real regexes, real handler order, real gates) with a stubbed DB.
 *
 * This is the anti-whack-a-mole harness: every routing bug ever found in
 * production gets a case here, so it can never silently return. New phrasing
 * variants get added as discovered.
 *
 * Offline by design: KAMLIFE_DB_STUB=1 (no postgres), fake OpenAI key (LLM
 * calls fail fast → classifier returns OTHER/0 → NORMALIZER skipped), so what
 * is tested is the DETERMINISTIC routing spine — the part that must never lie.
 *
 * Run: npm run test:routing
 */

// Env BEFORE any server import — module side-effects depend on these.
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

const NOW = Date.now();
const BASE_USER = {
  id: "test-user-routing-audit",
  phoneNumber: "whatsapp:+27000000001",
  name: "Kam Test",
  onboardingState: "COMPLETE",
  subscriptionStatus: "active",
  popiConsent: true, // field name in schema is popiConsent (no second 'a')
  popiConsentAt: new Date(NOW - 30 * 86_400_000),
  trialEndsAt: new Date(NOW + 30 * 86_400_000),
  subscriptionExpiresAt: new Date(NOW + 30 * 86_400_000),
  goalType: "fat_loss",
  calorieTarget: 1800,
  proteinTarget: 130,
  stepsTarget: 10000,
  currentWeight: "83",
  targetWeightKg: null,
  trainingMode: "gym",
  trainingDaysPerWeek: 3,
  trainingExperience: "beginner",
  programmePhase: 1,
  programmeWeek: 3,
  programmeDayInWeek: 2,
  weeklyFoodBudget: "100_300",
  lifeSituation: "office",
  gender: "male",
  age: 30,
  heightCm: 175,
  injuries: "none",
  medicalConditions: "none",
  awaitingInputType: null,
  todayCalories: 0,
  todayCaloriesDate: null,
  todaySteps: 0,
  todayWater: 0,
  workoutStreak: 2,
  totalWorkoutsCompleted: 8,
  buddyId: null,
  preferredLanguage: "en",
  profileNotes: "",
  homeEquipment: "none",
  gymName: null,
  lastActiveAt: new Date(NOW - 3_600_000),
  createdAt: new Date(NOW - 30 * 86_400_000),
};

type Case = {
  name: string;
  msg: string;
  /** every regex must match the reply */
  expect?: RegExp[];
  /** no regex may match the reply */
  reject?: RegExp[];
  /** patch the stub user for this case only */
  user?: Record<string, any>;
};

const CASES: Case[] = [
  // ── STEPS ───────────────────────────────────────────────────────────────
  { name: "steps: plain number+unit logs", msg: "8500 steps",
    expect: [/8[,\s.]?500/, /steps/i], reject: [/didn'?t catch/i] },
  { name: "steps: walked today phrasing", msg: "I walked 12000 steps today",
    expect: [/12[,\s.]?000/, /steps/i] },
  { name: "steps: decimal thousands", msg: "12.5k steps",
    expect: [/12[,\s.]?500/] },
  { name: "steps: word numbers", msg: "I did ten thousand steps",
    expect: [/10[,\s.]?000/, /steps/i] },
  { name: "steps: QUESTION must not log (prod bug 2026-06)", msg: "Doesn't going over 10,000 steps affect my goals?",
    reject: [/steps?\s+logged/i, /kcal burned/i, /7-day average/i, /target hit/i] },
  { name: "steps: 'is 8000 steps enough?' must not log", msg: "Is 8000 steps enough for fat loss?",
    reject: [/steps?\s+logged/i, /7-day average/i] },
  { name: "steps: duration walk converts", msg: "I walked for 30 minutes",
    expect: [/steps|walk/i], reject: [/didn'?t catch/i] },
  { name: "steps: future 'I'll walk 10000 steps tomorrow' must NOT log (audit catch 2026-06-13)", msg: "I'll walk 10000 steps tomorrow",
    reject: [/steps?\s+logged|7-day average|target hit|steps today/i] },
  { name: "steps: 'going to do 8000 steps later' must NOT log (audit catch 2026-06-13)", msg: "I'm going to do 8000 steps later",
    reject: [/steps?\s+logged|7-day average|target hit/i] },

  // ── WORKOUT ─────────────────────────────────────────────────────────────
  { name: "workout: \"today's workout\" delivers plan or rest-day, never logs (prod bug 2026-06-11)", msg: "Today's workout",
    expect: [/week|session|warm.?up|exercise|rest day/i], reject: [/logged to yesterday/i, /sessions in total/i, /got it.*logged/i] },
  { name: "workout: bare 'workout' delivers plan or rest-day", msg: "workout",
    expect: [/week|session|warm.?up|rest day/i], reject: [/logged/i] },
  { name: "workout: voice artifact 'Meet today's workout.' delivers plan (prod 2026-06-11 14:26)", msg: "Meet today's workout.",
    expect: [/week|day|workout|session|rest day/i], reject: [/sessions in total/i, /issue/i, /crush it\?/i] },
  { name: "workout: 'Today's workout?' with question mark delivers plan", msg: "Today's workout?",
    expect: [/week|day|workout|session|rest day/i], reject: [/sessions in total/i] },
  { name: "workout: contextual 'Show it to me' delivers plan (prod 2026-06-11 14:27)", msg: "Show it to me",
    expect: [/week|day|workout|session|rest day/i], reject: [/didn'?t catch/i] },
  { name: "workout: 'what's my session' delivers plan", msg: "what's my session",
    expect: [/week|day|workout|session|rest day/i], reject: [/sessions in total/i] },
  { name: "workout: 'done' logs completion", msg: "done",
    expect: [/session|workout|logged|💪|✅|streak|next/i] },
  { name: "workout: retro 'trained legs yesterday' logs", msg: "I trained legs yesterday",
    expect: [/yesterday|logged|legs|session/i] },
  { name: "workout: food sentence with 'done' must not log workout (prod bug)", msg: "ate pizza yesterday, done with that",
    reject: [/session logged|workout logged|sessions in total/i] },
  { name: "cardio: 'went for a 5km run' still logs (regression guard)", msg: "went for a 5km run this morning",
    expect: [/run|cardio|session|logged|good work|active|💪|✅|steps/i], reject: [/didn'?t catch/i] },
  { name: "cardio: question 'should I do 30 min yoga?' must NOT log (audit catch 2026-06-13)", msg: "Should I do 30 minutes of yoga today?",
    reject: [/session logged|workout logged|sessions in total|good work staying active/i] },
  { name: "cardio: 'is 5km a good distance to run?' must NOT log (audit catch 2026-06-13)", msg: "Is 5km a good distance to run?",
    reject: [/session logged|workout logged|sessions in total/i] },
  { name: "cardio: future 'going to run 5km tomorrow' must NOT log (audit catch 2026-06-13)", msg: "I'm going to run 5km tomorrow",
    reject: [/session logged|workout logged|sessions in total/i] },

  // ── WEIGHT ──────────────────────────────────────────────────────────────
  { name: "weight: bare kg logs", msg: "83kg",
    expect: [/83/], reject: [/didn'?t catch/i] },
  { name: "weight: sentence form logs", msg: "I weighed in at 84.5kg this morning",
    expect: [/84[.,]5/] },
  { name: "weight: question must not log", msg: "What should my weight be for my height?",
    reject: [/logged/i] },
  { name: "weight: retrospective 'last week it was 83kg' must NOT log today's weight (prod bug 2026-06-15)", msg: "Last week it was 83 kg",
    reject: [/weight logged|83kg.*target|targets updated/i] },
  { name: "weight: 'I used to weigh 90kg' must NOT log (prod bug 2026-06-15)", msg: "I used to weigh 90kg",
    reject: [/weight logged|90kg.*target|targets updated/i] },
  { name: "weight: 'I started at 95kg' must NOT log (prod bug 2026-06-15)", msg: "I started at 95kg",
    reject: [/weight logged|95kg.*target|targets updated/i] },

  // ── SLEEP ───────────────────────────────────────────────────────────────
  { name: "sleep: hours log", msg: "I slept 7 hours",
    expect: [/7/, /sleep|hour|recovery/i] },
  { name: "sleep: impossible hours rejected", msg: "I slept 25 hours",
    expect: [/between 1 and 16|doesn'?t look right/i] },
  { name: "sleep: bad night phrasing", msg: "bad night, barely slept",
    expect: [/sleep|rest|tonight|recovery/i] },
  { name: "sleep: 'didn't sleep 8 hours, only got 5 hours' logs 5 not 8 (audit catch 2026-06-13)", msg: "I didn't sleep 8 hours, only got 5 hours",
    expect: [/\b5 hours\b/i], reject: [/\b8 hours\b/i] },

  // ── WATER ───────────────────────────────────────────────────────────────
  { name: "water: litres log", msg: "drank 2 litres of water today",
    expect: [/water|litre|2/i] },
  { name: "water: question 'is 500ml enough water?' must NOT log (audit catch 2026-06-13)", msg: "is 500ml enough water?",
    reject: [/logged|added|running total|target hit|so far today/i] },
  { name: "water: negation 'haven't had my 2 litres of water yet' must NOT log (audit catch 2026-06-13)", msg: "I haven't had my 2 litres of water yet",
    reject: [/litres? logged|2L added|running total|water target hit/i] },

  // ── FOOD LOG ────────────────────────────────────────────────────────────
  { name: "food: classic 'I had X' logs with numbers", msg: "I had 2 eggs and pap for breakfast",
    expect: [/kcal/i, /protein/i] },
  { name: "food: portion label grams scale with quantity — 4 slices is 120g, not 60g (known bug, prior session)", msg: "I had 4 slices of brown bread for breakfast",
    expect: [/4 slices/i, /120\s*g/i, /kcal/i], reject: [/\(60g\)/i] },
  { name: "food: bare list with meal header logs (prod bug 2026-06-11)", msg: "Lunch\nTin fish\nRice\nMixed veggies",
    expect: [/kcal/i, /protein/i], reject: [/not logged yet/i, /in the making/i] },
  { name: "food: bare list with TYPO meal header logs (prod bug 2026-06-11)", msg: "Luch\nTin fish\nRice\nMixed veggies",
    expect: [/kcal/i, /protein/i], reject: [/not logged yet/i, /in the making/i] },
  { name: "food: future tense stays planned, not logged", msg: "Tonight I'm gonna have chicken and rice for dinner",
    expect: [/not logged yet|in the making|when you'?ve eaten/i], reject: [/Meal total/i] },
  { name: "food: 'ate it' with no pending plan", msg: "ate it",
    expect: [/nothing pending|tell me what you ate/i] },
  { name: "food: 'Omg I just had it' hits confirm path (prod bug 2026-06-11)", msg: "Omg I just had it",
    expect: [/nothing pending|tell me what you ate/i], reject: [/didn'?t catch what food/i] },
  { name: "food: 'I just had it with rice' is a food log, not a confirm", msg: "I just had it with rice",
    reject: [/nothing pending/i] },
  { name: "food: question about food must not log", msg: "Is rice bad for fat loss?",
    reject: [/Meal total|logged/i] },
  { name: "food: 'does chicken and rice have protein' must not log (prod bug 2026-06-15)", msg: "does chicken and rice have protein",
    reject: [/Meal total|kcal.*protein|logged/i] },
  { name: "food: 'I had 2 eggs, is that enough protein?' must not silently log (prod bug 2026-06-15)", msg: "I had 2 eggs, is that enough protein?",
    reject: [/Meal total.*2 eggs|logged.*2 eggs/i] },
  // ── EATING-OUT GUIDE: requires explicit eating intent, never bare mention ──
  { name: "eatout: 'my cousin works at KFC' must NOT return KFC guide (prod bug 2026-06-15)", msg: "My cousin works at KFC",
    reject: [/Coach K Pick|Streetwise|Quarter chicken|kcal.*protein/i] },
  { name: "eatout: 'there is a KFC near me' must NOT return guide (location, no eating intent)", msg: "There is a KFC near me",
    reject: [/Coach K Pick|Streetwise|kcal.*protein/i] },
  { name: "eatout: 'KFC prices are crazy' must NOT return guide (commentary, no eating intent)", msg: "KFC prices are crazy these days",
    reject: [/Coach K Pick|Streetwise|kcal.*protein/i] },
  { name: "eatout: 'do you know Nando's?' must NOT return guide (question)", msg: "Do you know Nando's?",
    reject: [/Coach K Pick|Quarter chicken|kcal.*protein/i] },
  { name: "eatout: 'I ate at KFC for lunch' SHOULD return KFC guide", msg: "I ate at KFC for lunch today",
    expect: [/KFC|Coach K Pick|Streetwise/i] },
  { name: "eatout: 'I'm going to KFC' SHOULD return KFC guide (going to)", msg: "I'm going to KFC",
    expect: [/KFC|Coach K Pick|Streetwise/i] },
  { name: "eatout: 'KFC for lunch' SHOULD return KFC guide (meal time)", msg: "KFC for lunch",
    expect: [/KFC|Coach K Pick|Streetwise/i] },
  { name: "eatout: 'ordered from Nando's' SHOULD return Nando's guide (ordered from)", msg: "I ordered from Nando's",
    expect: [/Nando|Coach K Pick|Quarter chicken/i] },
  { name: "eatout: 'had Steers after work' SHOULD return Steers guide (time signal)", msg: "Had Steers after work",
    expect: [/Steers|Coach K Pick|burger/i] },

  // ── FOOD LOG MGMT ───────────────────────────────────────────────────────
  { name: "mgmt: remove last meal removes ONE entry, never wipes the day (audit catch)", msg: "remove last meal",
    expect: [/remov|nothing|no meals/i], reject: [/cleared for today/i, /all entries wiped/i] },
  { name: "mgmt: undo last meal also single-entry (audit catch)", msg: "undo last meal",
    expect: [/remov|nothing|no meals/i], reject: [/cleared for today/i, /all entries wiped/i] },
  { name: "mgmt: clear food log", msg: "clear food log",
    expect: [/clear|nothing|empty|no meals/i] },
  { name: "mgmt: 'clear my schedule today' must NOT wipe food log (audit catch 2026-06-13)", msg: "clear my schedule today",
    reject: [/cleared for today|all entries wiped/i] },
  { name: "mgmt: 'log it' confirms pending meal path (prod bug 2026-06-11 13:49)", msg: "Log it",
    expect: [/nothing pending|tell me what you ate/i], reject: [/today so far/i] },

  // ── ZERO-SUGAR DRINKS ───────────────────────────────────────────────────
  { name: "drinks: Monster Zero keeps its name, never becomes Diet Coke (prod bug 2026-06-11 13:50)", msg: "Had a monster zero sugar",
    expect: [/monster/i, /0 kcal|zero/i], reject: [/diet coke/i] },
  { name: "drinks: coke zero logs as zero", msg: "had a coke zero with lunch",
    expect: [/zero|0 kcal/i] },

  // ── RETROACTIVE LOGGING ─────────────────────────────────────────────────
  { name: "retro: yesterday's meal logs with date", msg: "Yesterday I had 2 eggs and pap for dinner",
    expect: [/kcal/i, /yesterday/i] },
  { name: "retro: multi-day catch-up logs each day to the correct date (prod gap 2026-06-11)", msg: "Had chicken and rice Wednesday, oats Thursday morning, pap and pilchards Friday dinner",
    expect: [/logged \d+ days|✅/i, /kcal/i],
    reject: [/not logged yet|in the making|planned/i] },
  { name: "retro: multi-day catch-up handles prefix food (food before day name)", msg: "Rice and beef Wednesday and oats with eggs Thursday",
    expect: [/logged \d+ days|kcal/i],
    reject: [/not logged yet|planned/i] },
  { name: "retro: 'log yesterday's food' asks what they ate, must NOT relog today (prod bug 2026-06-13)", msg: "I want to log yesterday's food",
    expect: [/what did you eat yesterday|send it starting with/i],
    reject: [/copied from|♻️|remaining today/i] },
  { name: "repeat: negation 'I don't want the same as yesterday' must NOT relog (audit catch 2026-06-13)", msg: "I don't want the same as yesterday",
    reject: [/copied from|♻️|Meal total/i] },
  { name: "repeat: 'not the same meal today' must NOT relog (audit catch 2026-06-13)", msg: "not the same meal today",
    reject: [/copied from|♻️|Meal total/i] },

  // ── TOTALS / PROGRESS ───────────────────────────────────────────────────
  { name: "totals: today's calories", msg: "today's calories",
    expect: [/kcal|calorie/i, /1[,\s.]?800|target/i] },
  { name: "progress: my progress", msg: "my progress",
    expect: [/progress|week|log|start/i] },

  // ── GOAL CHANGE ─────────────────────────────────────────────────────────
  { name: "goal: canonical phrasing updates with targets", msg: "change my goal to muscle gain",
    expect: [/muscle gain/i, /kcal/i, /protein/i] },
  { name: "goal: 'building phase' natural phrasing reaches goal flow, never logs food (audit catch: fuzzy→mopani worms)", msg: "I want to go into a building phase",
    expect: [/what changed|muscle gain/i], reject: [/food logged/i, /kcal.*protein.*\(/i, /worms/i] },

  // ── PROFILE / GYM ───────────────────────────────────────────────────────
  { name: "gym: 'I joined a gym' updates mode", msg: "I joined a gym this week", user: { trainingMode: "home" },
    expect: [/gym/i] },
  { name: "gym: 'no gym access' gets home alternative, never gym upgrade (audit catch)", msg: "I have no gym access this week",
    expect: [/home|bodyweight/i], reject: [/updated to \*?full gym/i] },
  { name: "days: question 'Should I switch to 5 days?' must NOT auto-apply (audit catch 2026-06-13)", msg: "Should I switch to 5 days?",
    reject: [/updated to 5 days|5 days\/week/i] },
  { name: "days: question 'Can I train 4 days a week?' must NOT auto-apply (audit catch 2026-06-13)", msg: "Can I train 4 days a week?",
    reject: [/updated to 4 days|4 days\/week/i] },

  // ── INJURY ──────────────────────────────────────────────────────────────
  { name: "injury: 'no more pain meds' must NOT clear injuries (audit catch 2026-06-13)", msg: "no more pain meds since yesterday",
    user: { injuries: "lower back strain" },
    reject: [/marked as recovered|full programme is back/i] },
  { name: "injury: 'still hurts' mid-sentence must NOT clear injuries (audit catch 2026-06-13)", msg: "the pain is gone in my knee but my back still hurts",
    user: { injuries: "lower back strain" },
    reject: [/marked as recovered|full programme is back/i] },
  { name: "injury: genuine recovery confirmation clears injuries", msg: "injury healed, knee is better",
    user: { injuries: "knee strain" },
    expect: [/marked as recovered|full programme is back/i] },

  // ── MENU / GREETING / GRATITUDE ─────────────────────────────────────────
  { name: "menu: bare menu", msg: "menu",
    expect: [/menu|log food|progress|workout/i] },
  { name: "greeting: hello with emoji+suffix", msg: "hello coach k 👋",
    expect: [/morning|afternoon|evening|kam|sharp|hey|hello|howzit|log|workout/i], reject: [/didn'?t catch/i] },
  { name: "greeting: sawubona", msg: "sawubona",
    expect: [/sawubona|yebo|kam/i] },
  { name: "gratitude: ngiyabonga instant ack", msg: "ngiyabonga",
    expect: [/sharp|noted|lekker|good|yebo|sho|keep/i] },
  { name: "gratitude: baie dankie instant ack", msg: "baie dankie",
    expect: [/sharp|noted|lekker|good|yebo|sho|keep/i] },

  // ── SHOPPING LIST ───────────────────────────────────────────────────────
  { name: "shopping: list request returns list", msg: "shopping list",
    expect: [/R\d|shoprite|boxer|list|eggs|pilchards/i] },

  // ── META-CRITICISM — must never be therapy-spoken (prod bug 2026-06-11) ──
  { name: "meta: 'vague and robotic' no therapy speak", msg: "Wow that's vague and robotic",
    reject: [/overwhelmed/i, /fitness journey/i, /challenges your way/i, /i sense your/i] },
  { name: "meta: 'no this is a disaster' no therapy speak", msg: "No this is a disaster",
    reject: [/overwhelmed/i, /fitness journey/i, /challenges your way/i] },

  // ── SAFETY — false-positive medical (must NOT fire ambulance) ────────────
  { name: "safety: 'stroke of luck' must NOT trigger medical emergency (audit catch 2026-06-13)", msg: "what a stroke of luck, I hit a new PB today!",
    reject: [/10177|ambulance|medical emergency/i] },
  { name: "safety: 'breaststroke' must NOT trigger medical emergency (audit catch 2026-06-13)", msg: "did 20 lengths of breaststroke at the pool",
    reject: [/10177|ambulance|medical emergency/i] },
  { name: "safety: genuine 'I think I'm having a stroke' still fires emergency", msg: "I think I'm having a stroke",
    expect: [/10177|ambulance|emergency/i] },
];

async function main() {
  const { handleMessage } = await import("../server/routes");

  let passed = 0;
  const failures: string[] = [];

  for (const c of CASES) {
    (globalThis as any).__KAMLIFE_STUB_USER = { ...BASE_USER, ...(c.user || {}) };
    let reply = "";
    try {
      reply = await handleMessage(BASE_USER.phoneNumber, c.msg);
    } catch (err: any) {
      failures.push(`✗ ${c.name}\n    msg: ${JSON.stringify(c.msg)}\n    THREW: ${String(err?.message || err).slice(0, 200)}`);
      continue;
    }
    const missing = (c.expect || []).filter(re => !re.test(reply));
    const leaked = (c.reject || []).filter(re => re.test(reply));
    if (missing.length === 0 && leaked.length === 0) {
      passed++;
    } else {
      const why = [
        ...missing.map(re => `missing ${re}`),
        ...leaked.map(re => `forbidden ${re} matched`),
      ].join("; ");
      failures.push(`✗ ${c.name}\n    msg: ${JSON.stringify(c.msg)}\n    ${why}\n    reply: ${JSON.stringify(reply.slice(0, 180))}`);
    }
  }

  console.log(`\nrouting-audit: ${passed}/${CASES.length} passed`);
  if (failures.length > 0) {
    console.log(`\n${failures.join("\n\n")}\n`);
    process.exit(1);
  }
  console.log("✓ every message routed to the right handler\n");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
