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
  { name: "workout: lift PB share must NOT be read as retro workout (prod bug 2026-06-24)", msg: "Hack squat I did 25kg each side for the first time. 6 reps",
    reject: [/already got yesterday'?s workout logged/i, /logged to yesterday/i] },
  { name: "workout: lift log 'bench 80kg 3x10' logs lifts, not a retro session", msg: "bench press 80kg 3x10",
    expect: [/logged|kg|aim|next/i], reject: [/already got yesterday'?s workout logged/i] },
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
  { name: "repeat: 'same lunch as yesterday' with no history is honest, never fabricates (prod bug 2026-06-24)", msg: "Same lunch as yesterday",
    expect: [/tell me what|what (?:you ate|your lunch)|no .* logged|nothing found/i],
    reject: [/✅ \*Lunch logged\*|copied from breakfast/i] },
  { name: "repeat: protest 'No no no dinner from yesterday!!!' must NOT copy a meal (prod cascade 2026-07-02)", msg: "No no no dinner from yesterday!!!",
    reject: [/logged\* \(from|copied from|\+\d+ kcal/i] },
  { name: "repeat: meta-correction 'what I mean is…same meal as lunch' must NOT copy (prod cascade 2026-07-02)", msg: "Omg what I mean is I had the same meal as lunch so you must the previously logged meals",
    reject: [/logged\* \(from|copied from/i] },
  { name: "mgmt: 'Remove both meals' is multi-removal, never a food-name miss (prod cascade 2026-07-02)", msg: "Remove both meals",
    expect: [/Removed the last \d|No meals logged today/i],
    reject: [/don.?t see "both meals"/i] },
  { name: "mgmt: 'remove the two previous meals' is multi-removal (prod cascade 2026-07-02)", msg: "remove the two previous meals",
    expect: [/Removed the last \d|No meals logged today/i],
    reject: [/don.?t see/i] },
  { name: "mgmt: fuzzy 'remove the other meals you mistakenly logged' shows the numbered list (prod cascade 2026-07-02)", msg: "Remove the other meals you mistakenly logged",
    expect: [/which to remove|remove 1 and 3|Nothing logged today/i],
    reject: [/don.?t see "other/i] },
  { name: "mode: 'Going to the gym first' is a trip statement, must NOT flip the programme (prod bug 2026-07-03)", msg: "Going to the gym first",
    reject: [/programme updated to|full gym.*next session/i] },
  { name: "mode: 'heading to gym now' must NOT flip the programme (prod bug 2026-07-03)", msg: "heading to the gym now",
    reject: [/programme updated to/i] },
  { name: "workout: bare 'Tomorrow???' is a question, must NOT dump the next session (prod bug 2026-07-03)", msg: "Tomorrow???",
    reject: [/Next Session \(Day|Send \*done\* when finished/i] },
  { name: "mode: 'I joined a gym' still upgrades the programme (durable signal)", msg: "I joined a gym yesterday",
    expect: [/programme updated to|full gym/i] },
  { name: "cancel: 'I'm cancelling my subscription' must enter the cancel flow, NEVER get a payment link (prod bug 2026-07-03)", msg: "I'm cancelling my subscription. This is a whole bunch of shit.",
    expect: [/before i cancel|what's making you want to leave|last check/i],
    reject: [/payment link|payfast\/link/i] },
  { name: "rate: 'how much should I be gaining per week' is a rate question, never the portion guide (prod bug 2026-07-03, fired twice)", msg: "How much should I be gaining per week??",
    reject: [/portion|palm of your hand|plate rule/i] },
  { name: "weight: 'where should my weight be in 6 months' is a projection, never the ASCII history chart (prod bug 2026-07-03)", msg: "Where should my weight be in 6 months??",
    reject: [/```|weigh-ins over|weigh-ins total/i] },
  { name: "voice-q: 'what do you think about rice and sweet potato on the same plate' must NOT log food (prod bug 2026-07-03)", msg: "What do you think about double starching, like having rice and sweet potato on the same plate. What do you think about that?",
    reject: [/Food logged|Meal total|kcal \| ~?\d+g protein/i] },
  { name: "voice-q: 'is it advisable to buy a walking pad' stays a question", msg: "Is it advisable for me to buy a walking pad?",
    reject: [/Food logged|Meal total/i] },
  { name: "mgmt: 'Remove last meal, it was a question' removes the last meal despite the trailing clause (prod bug 2026-07-03)", msg: "Remove last meal, it was a question",
    expect: [/Removed your last meal|No meal logged yet today/i],
    reject: [/don.?t see "last meal/i] },
  { name: "takeaway: 'I had 4 pieces of KFC with pap' LOGS the meal, never ordering advice (prod bug 2026-07-03)", msg: "I had 4 pieces of KFC with pap",
    expect: [/Food logged|kcal/i],
    reject: [/Coach K Pick|if you.?re going KFC|Streetwise 2 \(original/i] },
  { name: "takeaway: 'Yes but I had 4 pieces with pap' logs both, not just pap (prod bug 2026-07-03)", msg: "I had 4 pieces of kfc and pap",
    expect: [/kfc|chicken/i, /pap/i] },
  { name: "takeaway: planning 'what should I order at KFC' STILL gets the guide", msg: "Going to KFC for lunch, what should I order?",
    expect: [/Coach K Pick|Streetwise|2 pieces original/i] },

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

  // ── FAIL-OPEN FOOD RECOGNITION — bare food statements reach GPT (prod bug 2026-06-18) ──
  // The SA database can't be comprehensive, so a bare food log with no "I had/ate" trigger
  // now also goes to the GPT food extractor. Offline (no real GPT) we can only assert the
  // SAFETY property: a non-food short statement must NOT be answered with "describe your food".
  { name: "fail-open: non-food short statement does NOT get food-clarify reply", msg: "feeling good today",
    reject: [/didn'?t catch what food/i] },
  { name: "fail-open: another non-food short statement falls through cleanly", msg: "almost at the gym now",
    reject: [/didn'?t catch what food/i] },

  // ── SWITCH ENERGY DRINK — brand name, not swap verb (prod bug 2026-06-18) ──────────
  // "Switch" is an SA energy drink brand. "Switch energy drink" must log calories,
  // not return healthier-swap advice. The swap guide fires only when "switch" is used
  // as a VERB ("switch to", "switch from", "switch away") not as a brand noun.
  { name: "switch: 'Switch energy drink' logs as food, does not give swap advice (prod bug 2026-06-18)", msg: "Switch energy drink",
    reject: [/healthier swaps for energy drinks/i, /rooibos tea/i] },
  { name: "switch: 'I had a switch' does not trigger swap advice", msg: "I had a switch",
    reject: [/healthier swaps for energy drinks/i] },
  { name: "switch: 'switch to healthier energy drink' still gives swap advice (regression guard)", msg: "how do I switch to a healthier energy drink",
    expect: [/rooibos|black coffee|sparkling water|healthier|swaps?/i] },
  { name: "switch: 'swap my energy drink' still gives swap advice (regression guard)", msg: "what can I swap my energy drink for",
    expect: [/rooibos|black coffee|sparkling water|healthier|swaps?/i] },

  // ── ONBOARDING / POPIA CONSENT — must be case-insensitive (prod bug 2026-06-17) ──
  // Phones auto-capitalise the first letter, so clients reply "Yes". The consent
  // check was case-sensitive and looped the agreement prompt forever, blocking
  // EVERY new client from onboarding. All capitalised forms below must accept.
  { name: "popia: capitalised 'Yes' accepts consent — no re-prompt loop (prod bug 2026-06-17)", msg: "Yes",
    user: { onboardingState: "ASK_POPIA", popiConsent: false },
    expect: [/what'?s your name/i], reject: [/need your agreement/i, /reply \*?yes\*? to continue/i] },
  { name: "popia: shouty 'YES' accepts consent", msg: "YES",
    user: { onboardingState: "ASK_POPIA", popiConsent: false },
    expect: [/what'?s your name/i], reject: [/need your agreement/i] },
  { name: "popia: 'Yebo' (Zulu yes, capitalised) accepts consent", msg: "Yebo",
    user: { onboardingState: "ASK_POPIA", popiConsent: false },
    expect: [/what'?s your name/i], reject: [/need your agreement/i] },
  { name: "popia: 'I Agree' (capitalised phrase) accepts consent", msg: "I Agree",
    user: { onboardingState: "ASK_POPIA", popiConsent: false },
    expect: [/what'?s your name/i], reject: [/need your agreement/i] },
  { name: "popia: lowercase 'yes' still accepts (regression guard)", msg: "yes",
    user: { onboardingState: "ASK_POPIA", popiConsent: false },
    expect: [/what'?s your name/i], reject: [/need your agreement/i] },
  { name: "popia: 'No' still refuses (capitalised refusal not mistaken for consent)", msg: "No",
    user: { onboardingState: "ASK_POPIA", popiConsent: false },
    expect: [/without consent|cannot store|cannot coach/i], reject: [/what'?s your name/i] },

  // ── WATER LOGGING — production bugs caught 2026-06-23 ───────────────────────────
  // Bug 1: "Water log" fell through to GPT and returned "I can't help you with water"
  // (a core feature). Fixed by catching bare water commands in isWaterStatusCmd.
  { name: "water: 'water log' returns summary, not GPT hallucination (prod bug 2026-06-23)", msg: "water log",
    expect: [/daily water target|water target|you have logged/i],
    reject: [/can'?t help|cannot help|don'?t.*water|sorry/i] },
  { name: "water: 'log water' returns summary (prod bug 2026-06-23)", msg: "log water",
    expect: [/daily water target|water target|you have logged/i] },
  { name: "water: 'my water' returns status (regression guard)", msg: "my water",
    expect: [/daily water target|water target|you have logged/i] },
  { name: "water: 'water status' returns status (regression guard)", msg: "water status",
    expect: [/daily water target|water target|you have logged/i] },

  // Bug 2: combined water+supplement messages — supplement handler ran first and returned
  // without logging the water. Fixed by tryLogWater() being called from inside the
  // supplement handler's logSupp path before returning. Note: logSupp requires a
  // consumption verb ("took"/"had"/"drank") to distinguish logging from Q&A.
  { name: "water+supplement: 'had 2 litres of water and took creatine' logs both (prod bug 2026-06-23)",
    msg: "had 2 litres of water and took my creatine",
    // tryLogWater has 4 reply variants; all contain "so far today" or match one of the other patterns
    expect: [/logged 2l|2l.*total|water|logged|so far today/i, /taken\s*✅|taken/i] },
  { name: "water+supplement: 'drank 500ml water and took magnesium' logs both (regression guard)",
    msg: "drank 500ml of water and took my magnesium",
    expect: [/logged.*0\.5|500ml|0\.5l|water|so far today/i, /taken\s*✅|taken/i] },

  // ── QUESTION-SAFETY BATTERY ──────────────────────────────────────────────────
  // The systemic disease: keyword handlers taking IRREVERSIBLE/VISIBLE actions
  // (log, flip, remove, charge, dump) on messages that are actually QUESTIONS.
  // These run with the AI classifier OFFLINE, so they test the KEYWORD-level
  // defense — the exact layer every stress-test failure came from. A QUESTION
  // must NEVER produce a side effect. If any of these fail, the disease is still
  // present at that site. (NS = the shared "no side effect" reject set.)
  ...(() => {
    const NS = [
      /\*Food logged|Food logged ✅|logged\*\s*\(from|Running total today|Meal total:/i,
      /Removed your last meal|Removed the last \d|Removed \d+ meal/i,
      /programme updated to/i,
      /Here is your payment link|payfast\/link/i,
      /Next Session \(Day|Reply \*DONE\* when finished/i,
      /weigh-ins (over|total)/i,
    ];
    const q = (name: string, msg: string): Case => ({ name: `qsafety: ${name}`, msg, reject: NS });
    return [
      // food discussion — must not log
      q("what do you think about rice and sweet potato", "What do you think about rice and sweet potato on the same plate?"),
      q("is pap bad for me", "Is pap bad for me at night?"),
      q("how many calories in 2 eggs", "How many calories in 2 eggs and toast?"),
      q("should I eat chicken or fish", "Should I eat chicken or fish for dinner?"),
      q("is peanut butter good for muscle", "Is peanut butter good for muscle gain?"),
      q("brown rice vs white rice", "What's better, brown rice or white rice?"),
      q("does chicken have enough protein", "Does 200g chicken have enough protein for me?"),
      q("thoughts on eating late", "What are your thoughts on eating pap late at night?"),
      q("is it okay to have samp", "Is it okay to have samp and beans every day?"),
      q("double starch opinion", "Double starching, like having rice and potato together, what do you reckon?"),
      // takeaway discussion — planning is fine but no LOG on a question
      q("is KFC bad", "Is KFC really that bad for muscle gain?"),
      q("thoughts on nandos", "What do you think about Nando's for a cutting phase?"),
      // workout — must not dump the next session or flip mode
      q("should I switch to full gym", "Should I switch to full gym?"),
      q("is home as good as gym", "Is a home workout as good as the gym for building muscle?"),
      q("do I need a gym", "Do I really need a gym to gain muscle?"),
      q("how many sets should I do", "How many sets should I do per exercise?"),
      q("is my programme too hard", "Is my programme too hard for a beginner?"),
      q("should I train tomorrow", "Should I train tomorrow or rest?"),
      q("how do I approach training", "How do I approach the training this week?"),
      // steps — must not log/nag
      q("why am I on 11000 steps", "Why am I on 11,000 steps a day? Make it make sense."),
      q("how many steps should I do", "How many steps should I be doing for fat loss?"),
      q("give me 5 steps belly fat", "Give me 5 steps to lose belly fat"),
      // weight — must not draw the history chart
      q("where should my weight be", "Where should my weight be in 6 months?"),
      q("how much should I lose per week", "How much weight should I lose per week?"),
      q("how much should I gain per week", "How much should I be gaining per week??"),
      q("is my weight normal", "Is my weight normal for my height?"),
      // money — must not send a payment link on a question/cancellation
      q("is it worth paying 199", "Is it really worth paying R199 for this?"),
      q("why should I pay", "Why should I pay for this service?"),
      q("what happens if I cancel", "What happens to my data if I cancel my subscription?"),
      q("how much does it cost", "How much does the subscription cost per month?"),
      // supplements / general — must not misfire into a log
      q("should I take creatine", "Should I take creatine on rest days?"),
      q("thoughts on protein powder", "What do you think about protein powder vs real food?"),
      q("how much water should I drink", "How much water should I drink on training days?"),
      // portion/rate confusion that already bit us
      q("how much rice per meal", "How much rice should I have per meal?"),
    ];
  })(),
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
