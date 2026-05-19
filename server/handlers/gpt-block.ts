import { db } from "../db";
import { users, chatHistory } from "../../shared/schema";
import { eq, desc } from "drizzle-orm";
import { askCoachK, getSAContextFlags, isUnderGPTCallLimit, selectModel, classifyIntent, type ClassifiedIntent } from "../gpt";
import { nutritionAgent, programmingAgent, mindsetAgent, adminAgent, routeToAgent } from "../agents";
import { storeMemory, retrieveMemories } from "../memory";
import { sanitizeCoachReply, scanForSAFoods } from "./food-scanner";
import { logChat, withTimeout } from "./chat-log";
import { checkFoodPatterns, getDamageControlNote, checkPerfectDay } from "./checks";
import { detectLanguage } from "../constants";
import { checkGptRateLimit, sastDayStart } from "../utils";
import { getKamlifeProgramme } from "../programme";
import { sendWhatsApp } from "../scheduler";

export async function handleGptBlock(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
  intentPromise: Promise<{ intent: ClassifiedIntent; confidence: number }>;
}): Promise<string> {
  const { phone, message, m, user, intentPromise } = ctx;
  // ---- LANGUAGE DETECTION — needed for GPT instruction and response prefix ----
  const _detectedLang = detectLanguage(m);
  const activeLang: string = _detectedLang !== "en" ? _detectedLang : (user.preferredLanguage || "en");
  let langPrefix = "";
  if (activeLang !== "en") {
    const _langFirstName = user.name?.split(" ")[0] || "";
    switch (activeLang) {
      case "zu": langPrefix = `Sawubona ${_langFirstName}. `; break;
      case "xh": langPrefix = `Molo ${_langFirstName}. `; break;
      case "st": langPrefix = `Dumela ${_langFirstName}. `; break;
      case "tn": langPrefix = `Dumela ${_langFirstName}. `; break;
      case "ts": langPrefix = `Avuxeni ${_langFirstName}. `; break;
      case "af": langPrefix = `Dag ${_langFirstName}. `; break;
    }
  }

  // ---- EVERYTHING ELSE → GPT decides ----
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString("en-ZA", { weekday: "long" });
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const clientName = user.name || "there";
  const trainingMode = user.trainingMode || "home";
  const saContext = getSAContextFlags(user);

  // Fix 9 — Conversation context memory: last 10 exchanges, alternating Client/Coach K format
  let recentConvBlock = "";
  let recentChatText = "";
  try {
    const recentChats = await db.select().from(chatHistory)
      .where(eq(chatHistory.userId, user.id))
      .orderBy(desc(chatHistory.createdAt))
      .limit(10);
    if (recentChats.length > 0) {
      const ordered = recentChats.reverse();
      const thread = ordered.map(c => {
        const clientLine = c.messageIn ? `Client: "${(c.messageIn).slice(0, 150)}"` : "";
        const coachLine = c.messageOut ? `Coach K: "${(c.messageOut).slice(0, 150)}"` : "";
        return [clientLine, coachLine].filter(Boolean).join("\n");
      }).join("\n");
      recentChatText = thread;
      recentConvBlock = `\n\nRECENT CONVERSATION (last 10 exchanges — build on this, do not repeat):\n${thread}`;
    }
  } catch (e) { console.warn("[non-fatal]", e); }

  // Fix 5 — Ramadan check against recent chat history (in addition to profile notes)
  const RAMADAN_KW = ["ramadan", "ramadhan", "fasting", "iftar", "suhoor", "sehri", "muslim", "islam", "halaal", "halal"];
  if (recentChatText && RAMADAN_KW.some(kw => recentChatText.toLowerCase().includes(kw))) {
    const existingFlags = getSAContextFlags(user);
    if (!existingFlags.includes("RAMADAN")) {
      // User mentioned Ramadan in recent chat — inject flag into instruction
      recentConvBlock += `\n\nRAMADAN / FASTING ACTIVE: Client has mentioned Ramadan or fasting in recent messages. Train only after Iftar. Suhoor is the most critical meal — high protein, slow carbs. Adjust all meal timing advice to the eating window only.`;
    }
  }

  const instruction = `Today is ${dayOfWeek} ${timeOfDay}.${saContext ? "\n\n" + saContext : ""}${recentConvBlock}

RESPOND TO THIS CLIENT'S EXACT MESSAGE AS COACH K.

SCENARIO GUIDE — read the message and decide which applies:

WORKOUT / PROGRAMME REQUEST ("give me a program", "3 day", "full body", "training plan", "what do I do today", "1", "2", "workout", etc.):
  Tell the client their programme is ready and to reply with the word "programme" to see the full plan. Do not list exercises here.

STEPS LOGGED (number + "steps" / "walked" / "km"):
  Respond based on their step target of ${user.stepsTarget || 8500}. If below — push them. If at or above — celebrate and give next action.

FOOD / MEAL LOGGED (any food item or meal described):
  Coach specifically on THAT exact food. ALWAYS include the estimated calories (kcal) and protein (g) — this is NON-NEGOTIABLE. Format: "That is roughly X kcal and Xg protein." If you cannot estimate a specific number, use a range. Never give a food response without numbers. Never say "I cannot estimate" — always give a best estimate based on standard portions.
  If junk — acknowledge without shaming, give one specific swap. If good — celebrate and connect to their ${user.goalType || "fat loss"} goal. Never end with a protein warning. Never give generic advice.
  CRITICAL — If the meal contains ANY of: chicken, beef, mince, fish, tuna, hake, salmon, eggs, pilchards, beans, lentils, pork, lamb, cottage cheese, Greek yoghurt, biltong — DO NOT suggest adding protein or swapping to pilchards. The client is ALREADY eating protein. Celebrate the choice. Budget suggestions (pilchards, eggs, sugar beans) ONLY fire when the client explicitly says they have no money or their stored budget tier is "under_100". Never suggest budget swaps after a quality meal unprompted.

BROKE / BUDGET / MONTH-END / NO MONEY:
  Full affordable plan: Oats R15 (500g, lasts 1 week) — one cup oats + peanut butter = 400 kcal 20g protein. Eggs R25 (12 eggs) — 2 eggs = 160 kcal 12g protein. Pilchards R12 (1 tin) — full tin = 200 kcal 24g protein. Sugar beans R20 (dry 500g) — cooked cup = 220 kcal 15g protein. Peanut butter R25 (lasts 2 weeks). Brown bread R14. Total under R110. Explain how to use each one practically.

WEIGHT LOGGED (number + "kg"):
  Acknowledge. If weight went up — explain water retention, sodium, hormones. Do NOT panic them. Stay on programme. If weight went down — celebrate specifically. If same — consistency wins over weeks.

NUTRITION AND CALORIE INTELLIGENCE:
  You are a qualified fitness and nutrition coach. When a client tells you their weight and goal calculate the correct calorie and protein targets using standard sports nutrition formulas. Show the calculation. State the result. When a client has an injury or medical condition reason about what is safe and build accordingly. When a client's stated information conflicts with their stored profile trust what they are telling you right now and recalculate everything. Do not wait to be told the formula. You know the formula. Use it.

WATER LOGGED ("drank", "litre", "ml", "bottle", "glass"):
  One sentence acknowledgment. Reference how much they logged. No generic tips.

SLEEP LOGGED (number + "hours" / "slept"):
  Under 6 hours — coach firmly on sleep and fat loss link. Give one practical fix for tonight. 7-9 hours — solid, connect to results. Over 9 — check if they are ill or stressed.

PERIOD / MENSTRUAL:
  Normalise. Lighter sessions are fine. No guilt. Hydration and iron-rich foods.

SUPPLEMENTS ("creatine", "protein powder", "pre-workout"):
  Creatine — worth it, 5g daily, no cycling. Protein powder — food not magic, use if struggling to hit ${user.proteinTarget || 120}g from whole foods. Everything else optional. Food first always.

RAMADAN / FASTING:
  Train after Iftar. Suhoor = most important meal of the day. Protein priority at Iftar. Light cardio only if fasting during day.

TRAVELLING / HOTEL:
  4 exercises, hotel room, bodyweight only, sets x reps. No equipment assumed.

HOLIDAY / VACATION:
  Client is on holiday and asking for advice. Give practical holiday-specific tips: bodyweight exercises they can do anywhere (beach, hotel, park), walking targets, how to eat well at restaurants/buffets while still enjoying the holiday. Do NOT pause their coaching or tell them to stop messaging. They WANT coaching while on holiday. Keep it fun and practical — holiday is not a reason to stop, it is a chance to stay consistent in a new way.

ALCOHOL:
  Coach forward. Acknowledge it happened. One practical next step. Never shame.

DIABETES / BLOOD SUGAR:
  Low GI carbs. Consistent meal timing. Train 1-2 hours after eating. Never skip meals.

CULTURAL EVENT (church, funeral, lobola, umemulo):
  Acknowledge its importance. Enjoy it fully. Protein first on the plate. No guilt. Back on programme next meal.

JOINED THE GYM:
  Welcome it with one sentence. Update training to gym. Give full gym programme.

TIRED / LOW ENERGY:
  DO NOT mention water. Ask about sleep first, then food timing, then stress.

INJURY MENTIONED:
  Give specific alternative exercises that route around the injury.

GENERAL QUESTION:
  Answer with SA coaching knowledge. Specific. Practical.

WHATSAPP FORMAT RULES — apply to every single response:
These messages are read on a phone screen. Never write an essay. Format depends on the response type:

SIMPLE COACHING RESPONSE: 2 to 3 sentences maximum. One specific action at the end. No bullet points. No asterisks. Plain text only.

PROGRAMME DELIVERY: Use bold day headers. Each exercise on its own line: exercise name, sets and reps, YouTube link, one form cue, one common mistake. Separate each day with a line break. Bold is allowed here.

MEAL PLAN DELIVERY: Each meal on its own block: meal name, ingredients, estimated calories and protein, preparation time. Always state the cost in rands. Bold meal names are allowed here.

CALCULATION RESPONSE: Show the formula. Show the numbers. State the result clearly. Add one sentence explaining what this specific result means for this client's goal. No padding.

CRISIS RESPONSE: Short. Warm. Direct. Give the support resources first — Samaritans SA 0800 567 567. Say nothing else until they respond.

MILESTONE CELEBRATION: Energetic, specific, personal. Reference something real and measurable from their journey — a number, a first, a behaviour change. Never use generic praise like "You're amazing" or "I'm so proud of you."

BANNED PHRASES — never say these under any circumstances:
- "You seem surprised"
- "Eish, what's going on" as a generic opener
- "How can I help you today" or any variation
- "I hope this helps"
- "Let me know" in any form
- "I understand" as a standalone sentence
- "Great question"
- "Absolutely" or "Certainly" or "Of course"
- "Feel free to ask" or "Feel free to reach out"
- "You've got this" as a standalone sentence
- "Stay hydrated" as a default response
These are app phrases. Coach K does not use them. Coach K responds to what the client actually said — not to how they said it.

QUESTION RULE: Never end a response with a question unless you genuinely need specific information to coach better. If a question is needed — ask exactly one. Single and specific. Never two questions in one response.

REPEAT QUESTION RULE: If your most recent message ended with a question and the client's reply does not clearly answer it — do NOT ask the exact same question again verbatim. Accept whatever partial answer they gave, make a reasonable assumption, or move on to the next topic. Repeating the same question word for word makes the coaching feel robotic. Rephrase or proceed.

FORMATTING RULE: Never use asterisks for bold in conversational responses. Asterisks and bold are only allowed in programme delivery and meal plan delivery.

ANTI-GENERIC ENFORCEMENT — every response MUST pass these checks:
1. SPECIFICITY CHECK: Every response must contain at least ONE of: a specific number (calories, kg, reps, steps, rands), a specific food name, a specific exercise name, or a specific time/date. If your response contains none of these, it is too generic — rewrite it.
2. CONTEXT CHECK: Reference something the client actually said or something from their profile (goal, weight, training mode, week number). If your response could apply to literally anyone, it is too generic.
3. ACTION CHECK: End every response with ONE specific action the client can do right now. Not "keep going" or "stay consistent" — a real action like "do 20 squats before your shower tonight" or "add 2 boiled eggs to your next meal".
4. If you catch yourself writing a response that sounds like a motivational poster — delete it and write what a real coach would say to THIS specific person.

CRITICAL RULES — these are non-negotiable:
- Client's name is ${clientName}. Never call them "a client", "Hi client", or "champ" if you have a real name.
- NEVER say "drink 2 litres of water" as a response to anything except a water question.
- Pilchards ARE an excellent protein source — never say otherwise.
- Never append a protein warning at the end of a food coaching response.
- Never mention AI, bot, system, or technology.
- Never use a motivational quote as a standalone response.
- Maximum 3 sentences and 60 words for conversational responses. Exception: programme delivery, meal plans, and food logging responses may be longer.
- Always end with exactly one specific action the client must take right now.
- SA voice throughout: real, warm, firm, direct.`;

  // ---- DIABETES-SPECIFIC COACHING (Item 19) — inject context into instruction ----
  const isDiabetic = (user.medicalConditions || "").includes("diabetes");
  const isNutritionOrExerciseQ = /\b(eat|food|meal|carb|sugar|glucose|blood sugar|exercise|train|workout|walk|steps|insulin|medication|metformin)\b/i.test(m);
  let finalInstruction = instruction;
  if (isDiabetic && isNutritionOrExerciseQ) {
    finalInstruction = `DIABETES COACHING ACTIVE: This client has diabetes. Apply ALL of the following:\n- Low GI carbs only: samp and beans, oats, sweet potato, brown rice. Never white pap alone.\n- Never recommend skipping meals — blood sugar stability is critical.\n- Train 1-2 hours after eating, never fasted.\n- Consistent meal timing is non-negotiable — same times every day.\n- Metformin causes nausea if taken without food — always advise with a meal.\n- Weight loss of even 5% significantly improves insulin sensitivity — celebrate every kg lost.\n\n` + instruction;
  }

  // ---- MENSTRUAL CYCLE AWARENESS — adjust coaching for cycle phase ----
  const isFemaleContext = (user.profileNotes || "").includes("menstrual") ||
    /\b(period|my period|pms|cycle|time of month|ovulation|menstrual|cramps|bloated.*period|hormones)\b/i.test(m);
  if (isFemaleContext) {
    // Store cycle day 1 if client mentions period starting
    if (/\b(period.*start|started.*period|period.*came|got.*period|cycle.*start|day.*one|day 1.*period)\b/i.test(m)) {
      const cycleMarker = `menstrual_day1:${new Date().toISOString().slice(0, 10)}`;
      const existingNotes = user.profileNotes || "";
      const updatedNotes = existingNotes.replace(/menstrual_day1:\d{4}-\d{2}-\d{2}/, cycleMarker) || `${existingNotes} ${cycleMarker}`.trim();
      await db.update(users).set({ profileNotes: updatedNotes }).where(eq(users.phoneNumber, phone));
    }
    // Calculate cycle phase from stored day 1
    const cycleMatch = (user.profileNotes || "").match(/menstrual_day1:(\d{4}-\d{2}-\d{2})/);
    let cycleContext = "";
    if (cycleMatch) {
      const day1 = new Date(cycleMatch[1]);
      const cycleDay = Math.floor((Date.now() - day1.getTime()) / 86_400_000) % 28 + 1;
      if (cycleDay >= 1 && cycleDay <= 5) {
        cycleContext = `MENSTRUAL PHASE (days 1-5): Client is menstruating. Reduce training intensity by 20-30% — light weights, longer rests, walking over running. Higher iron needs — encourage red meat, beans, spinach. Gentle on carbs — sweet potato and oats for stable energy. Acknowledge cramps and fatigue as real physiological responses, not excuses. Never push heavy training today.`;
      } else if (cycleDay >= 6 && cycleDay <= 13) {
        cycleContext = `FOLLICULAR PHASE (days 6-13): Oestrogen rising. Best phase for strength gains and high-intensity training. Energy is high. Push hard on workouts this week — progressive overload is most effective now. Lean protein critical. This is her best training window of the month.`;
      } else if (cycleDay >= 14 && cycleDay <= 16) {
        cycleContext = `OVULATION PHASE (days 14-16): Peak energy and strength. Maximum training capacity. Encourage her hardest session of the month here if she feels good. High protein. Keep carbs moderate.`;
      } else {
        cycleContext = `LUTEAL PHASE (days 17-28): Progesterone rising. Energy and mood may dip in the second half of this phase. Carb cravings are real and hormonal — direct her to complex carbs (sweet potato, oats) not sugar. Reduce workout intensity slightly in final days (24-28). Acknowledge PMS symptoms as physiological. Never shame cravings — redirect to better choices.`;
      }
    } else {
      cycleContext = `FEMALE CLIENT CYCLE CONTEXT: Client has mentioned her cycle or period. Acknowledge this with empathy. Adjust training and nutrition advice accordingly. Ask which day of her cycle she is on if it helps give better advice.`;
    }
    if (cycleContext) finalInstruction = `${cycleContext}\n\n${finalInstruction}`;
  }

  // ---- LANGUAGE-AWARE COACHING — simplify English for non-English speakers ----
  if (activeLang !== "en") {
    const langNames: Record<string, string> = { zu: "Zulu", xh: "Xhosa", st: "Sesotho", tn: "Setswana", ts: "Xitsonga", af: "Afrikaans" };
    const langName = langNames[activeLang] || "non-English";
    finalInstruction = `LANGUAGE CONTEXT: This client's primary language is ${langName}. Use SIMPLE English — short sentences, basic words, no jargon. Maximum 8-10 words per sentence. Say "eat" not "consume". Say "belly fat" not "visceral fat". Explain any exercise in one plain sentence.\n\n${finalInstruction}`;
  }

  // ---- MEMORY: retrieve relevant memories for this message ----
  let memoryContext = "";
  try {
    const memories = await retrieveMemories(phone, message);
    if (memories.length > 0) memoryContext = memories.join("\n");
  } catch (e) { console.warn("[non-fatal]", e); }

  // ---- SHORT REPLY HANDLER — "yes", "no", "ok" etc need conversation context ----
  // Pure punctuation / frustration symbols — "!!!!!", "???", "..." — treat as short contextual reply
  if (/^[!?.\s]+$/.test(m) && m.replace(/\s/g, "").length >= 1) {
    try {
      const lastExchange = await db.select({ messageOut: chatHistory.messageOut, intent: chatHistory.intent })
        .from(chatHistory).where(eq(chatHistory.userId, user.id)).orderBy(desc(chatHistory.createdAt)).limit(1);
      const lastOut = lastExchange[0]?.messageOut || "";
      const lastIntent = lastExchange[0]?.intent || "";
      const punctCtx = `Client sent only "${message}" (pure frustration/reaction). They are responding to your previous message (intent: ${lastIntent}): "${lastOut.slice(0, 300)}". This means they are either frustrated, confused, or surprised by your last reply. Acknowledge the reaction briefly and either clarify your last response or ask what specifically they need. Do not ask what they mean — you know they are reacting to your last message. Be direct, max 2 sentences, SA voice.`;
      const punctReply = sanitizeCoachReply(await withTimeout("gpt_punct", 15000, () => askCoachK(message, user, punctCtx, memoryContext)), message, user.weeklyFoodBudget, user.injuries);
      await logChat(user.id, message, punctReply, "SHORT_REPLY");
      return punctReply;
    } catch (e) { console.warn("[punct-reply]", e); }
  }

  // Pure reactions — no GPT needed. Just acknowledge and move on.
  const PURE_REACTIONS = new Set(["wow", "lol", "omg", "nice", "awesome", "great", "perfect", "noted", "got it", "will do", "lekker", "cool", "sharp", "eish", "dankie", "aight"]);
  if (PURE_REACTIONS.has(m)) {
    const acks = ["Sharp.", "Noted.", "Lekker.", "Good.", "Keep it up."];
    const ack = acks[Math.floor(Math.random() * acks.length)];
    await logChat(user.id, message, ack, "REACTION_ACK");
    return ack;
  }


  const SHORT_REPLIES = ["yes", "no", "yeah", "nah", "nope", "yep", "yebo", "ja", "ok", "okay", "sure", "fine", "thanks", "thank you", "wtf", "right"];
  if (SHORT_REPLIES.includes(m)) {
    try {
      const lastExchange = await db.select({ messageOut: chatHistory.messageOut, intent: chatHistory.intent })
        .from(chatHistory)
        .where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      const lastOut = lastExchange[0]?.messageOut || "";
      const lastIntent = lastExchange[0]?.intent || "";
      const shortReplyContext = `Client replied "${message}" to your previous message (intent: ${lastIntent}): "${lastOut.slice(0, 300)}". This is a direct response to what you said. Respond accordingly — if you asked a question, this is the answer. If you gave advice, "${message}" is acknowledgment. Be specific and move forward. Do not ask "what do you mean" — interpret from context.`;
      const shortReply = sanitizeCoachReply(await withTimeout("gpt_short", 20000, () => askCoachK(message, user, shortReplyContext, memoryContext)), message, user.weeklyFoodBudget, user.injuries);
      await logChat(user.id, message, shortReply, "SHORT_REPLY");
      return shortReply;
    } catch (e) { console.warn("[short-reply]", e); }
  }

  // ---- FRUSTRATION HANDLER — client venting after a bad bot response ----
  const severeServiceRiskComplaint =
    /\b(kill|killed|hospital|unsafe|dangerous|harm)\b/i.test(m) &&
    /\b(this|service|app|bot|coach|you)\b/i.test(m);

  if (severeServiceRiskComplaint) {
    const name = user.name || "there";
    const injuryCtx = user.injuries && user.injuries !== "none"
      ? ` I still have your injury noted: ${user.injuries}.`
      : "";
    const safetyReply = `${name}, you are right to call that out.${injuryCtx} I will keep responses specific and safety-first from here. Immediate action: if your pain is active today, skip loading that area and do a pain-free session only.`;
    await logChat(user.id, message, safetyReply, "SAFETY_COMPLAINT");
    return safetyReply;
  }

  const isFrustrated =
    /\b(wow just wow|seriously\?|what the|this is ridiculous|what is this|are you serious|come on|wtf|what the hell|this is useless|pathetic|this doesn.?t make sense|that.?s wrong|you.?re wrong|bad response|wrong answer|that.?s not what i|you didn.?t even|you ignored|you didn.?t listen|not what i asked|not worth|waste of money|waste of time|cancel|refund|unsubscribe|this is bad|this is shit|this sucks|useless|rubbish|garbage|disappointed|i.?m done|giving up on this|doesn.?t work|broken|stupid)\b/i.test(m) ||
    (m.length < 30 && /^\s*(wow|seriously|really|eish|ag man|ag nee|shem|hayibo|haibo|omg|oh my god|yoh)\s*[!?.]*$/i.test(m));

  if (isFrustrated) {
    try {
      const lastBotMsg = await db.select({ messageOut: chatHistory.messageOut, intent: chatHistory.intent })
        .from(chatHistory)
        .where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      const lastOut = lastBotMsg[0]?.messageOut || "";
      const lastIntent = lastBotMsg[0]?.intent || "";
      const profileGuard = `PROFILE FACTS: Goal=${user.goalType || "fat_loss"}, Budget=${user.weeklyFoodBudget || "100_300"}, Injuries=${user.injuries || "none"}, Medical=${user.medicalConditions || "none"}. You MUST use these facts and never ignore them.`;
      const frustContext = `You are Coach K. Client said: "${message}". Your previous message was: "${lastOut.slice(0, 200)}".

They are unhappy with your response. ${profileGuard}

TWO SENTENCES ONLY:
1. Acknowledge what specifically was wrong with your last response (don't be vague — name it)
2. Correct it with one specific, profile-aware coaching action

NEVER SAY: "I apologise", "I'm sorry", "I understand", "It sounds like", "You need support", "Let's focus", "feel free", "reach out", "be kind to yourself"
SA voice. Direct. Coach forward, not backward.`;
      const frustReply = sanitizeCoachReply(await withTimeout("gpt_frust", 20000, () => askCoachK(message, user, frustContext)), message, user.weeklyFoodBudget, user.injuries);
      await logChat(user.id, message, frustReply, "FRUSTRATION");
      return frustReply;
    } catch (e) { console.warn("[fall-through-gpt]", e); }
  }

  // Daily GPT call cap — prevents runaway costs from heavy users
  const underLimit = await isUnderGPTCallLimit(user.id);
  if (!underLimit) {
    const capName = user.name || "there";
    const capGoal = user.goalType === "muscle_gain" ? "hit your protein and get 8 hours sleep tonight" : "hit your step target and keep your last meal clean tonight";
    return `${capName}, I have hit my daily message limit. Your programme, targets, and logs are all still active — reply *menu* to access them. Focus on one thing: ${capGoal}. Full coaching resumes tomorrow morning.`;
  }

  // ---- AGENT ROUTER: send to the right specialist, fall back to askCoachK on failure ----
  // Await classifier here — by now it has had 0.5-2s to complete across all the handlers above.
  const intentResult = await intentPromise;
  const classifiedIntent = intentResult.intent;
  const intentConfidence = intentResult.confidence;

  // Determine effective agent type:
  // 1. RANT with high confidence → mindset agent (empathetic, doesn't lecture on nutrition)
  // 2. Otherwise use keyword-based routing as before
  let agentType = routeToAgent(message);
  if (classifiedIntent === "RANT" && intentConfidence >= 0.75) {
    agentType = "mindset";
    console.log(`[INTENT] RANT override → mindset agent (${Math.round(intentConfidence * 100)}% confidence)`);
  }

  if (!checkGptRateLimit(user.id)) {
    console.warn(`[RATE] GPT rate limit hit for user ${user.id.slice(0, 8)}`);
    return "You're sending messages very fast — give Coach K a moment and try again.";
  }

  let gptReply: string;
  const AGENT_ERROR = "Eish Coach K had a moment. Try that again.";

  try {
    if (agentType === "nutrition") {
      gptReply = await nutritionAgent(user, message, memoryContext, saContext);
    } else if (agentType === "programming") {
      const prog = getKamlifeProgramme(user);
      gptReply = await programmingAgent(user, message, memoryContext, prog, saContext);
    } else if (agentType === "mindset") {
      const dataPoint = `${user.totalWorkoutsCompleted || 0} workouts completed, ${user.programmeWeek || 1} weeks on programme`;
      gptReply = await mindsetAgent(user, message, memoryContext, dataPoint, saContext);
    } else if (agentType === "admin") {
      const targetValue = `Calorie target: ${user.calorieTarget || 1800} kcal | Protein target: ${user.proteinTarget || 130}g | Steps target: ${user.stepsTarget || 8500}`;
      gptReply = await adminAgent(user, message, "log", message, targetValue);
    } else {
      gptReply = await withTimeout("gpt_coach", 30000, () => askCoachK(message, user, finalInstruction, memoryContext));
    }
    // If specialist agent returned its own error string, fall back to full Coach K
    if (gptReply === AGENT_ERROR) {
      gptReply = await withTimeout("gpt_coach_fallback", 30000, () => askCoachK(message, user, finalInstruction, memoryContext));
    }
  } catch (e) {
    console.warn("[agent-routing]", e);
    gptReply = await withTimeout("gpt_coach_catch", 30000, () => askCoachK(message, user, finalInstruction, memoryContext));
  }

  const finalReply = sanitizeCoachReply(langPrefix ? `${langPrefix}${gptReply}` : gptReply, message, user.weeklyFoodBudget, user.injuries);

  // ---- MEMORY: store important facts for future sessions ----
  try {
    if (/\b(injury|injured|hurt|pain|bad knee|bad back|bad shoulder|bad hip)\b/i.test(m)) {
      await storeMemory(phone, `Client reported injury: "${message}"`, "medical");
    } else if (/\b(allergic|allergy|intolerant|can't eat|cannot eat|dairy free|gluten free|peanut allergy)\b/i.test(m)) {
      await storeMemory(phone, `Client dietary restriction: "${message}"`, "medical");
    } else if (/\b(diabetes|diabetic|hypertension|pcos|hiv|tb |tuberculosis|pregnant|epilepsy)\b/i.test(m)) {
      await storeMemory(phone, `Client medical condition: "${message}"`, "medical");
    } else if (/\b(i prefer|i hate|i love|don't like|can't stand|favourite food|i always eat|i never eat)\b/i.test(m)) {
      await storeMemory(phone, `Client food or training preference: "${message}"`, "preference");
    } else if (/\b(quit|give up|want to stop|not working|no results|nothing is changing)\b/i.test(m)) {
      await storeMemory(phone, `Client struggled with motivation: "${message}"`, "mindset");
    } else if (/\b(hit my goal|reached my goal|lost.*kg|gained.*kg|pb|personal best|new record)\b/i.test(m)) {
      await storeMemory(phone, `Client milestone: "${message}"`, "milestone");
    }
  } catch (e) { console.warn("[non-fatal]", e); }

  // Auto-store significant coaching notes for future memory
  try {
    const mLower = message.toLowerCase();
    if (/\b(stressed|anxious|depressed|overwhelmed|struggling|bad week|hard week|tough week|not okay|burnout)\b/.test(mLower)) {
      await storeMemory(phone, `Client mentioned stress or emotional difficulty: "${message.slice(0, 100)}"`, "mindset");
    } else if (/\b(hate|don.?t like|can.?t stand|avoid|never eat|allergic to|dislike)\b/.test(mLower)) {
      await storeMemory(phone, `Food/exercise preference noted: "${message.slice(0, 100)}"`, "preference");
    } else if (/\b(love|favourite|always eat|prefer|enjoy|my go.?to)\b/.test(mLower)) {
      await storeMemory(phone, `Positive preference noted: "${message.slice(0, 100)}"`, "preference");
    } else if (/\b(night shift|work from home|just had a baby|new job|retrenched|moved|single mom|single dad|divorce|breakup)\b/.test(mLower)) {
      await storeMemory(phone, `Life situation update: "${message.slice(0, 120)}"`, "preference");
    }
  } catch (e) { console.warn("[non-fatal]", e); }

  // ---- FOOD CONTEXT CHECK — only if GPT response is about food the user actually ate ----
  // STRICT: must have BOTH a log trigger AND actual SA food detected by scanner
  // This prevents "I had a great workout", "food is expensive", "dinner plans" from being logged as food
  const hasLogTrigger = /\b(ate|had|having|eating|breakfast|lunch|dinner|supper|snack(ed|ing)?|just had|just ate|i had|i ate|meal|grabbed|nibbled|had some|bit of|piece of)\b|quick bite/i.test(m);
  const isLogCommand = /\b(log it|save this|save it|log that|save that)\b/i.test(m);
  const isQuestion = /\?|^(what|how|when|where|why|can|should|is|are|do|does|which|could|would)\b/i.test(m);
  const isFrustration = /^\s*(ugh|argh|wtf|what the|this is|not working|doesn.?t work|ridiculous|stupid|useless|terrible|broken|help!+|please!+)\b/i.test(m);
  const gptFoodMatch = scanForSAFoods(m);
  const isFoodLog = !isLogCommand && !isQuestion && !isFrustration && hasLogTrigger && gptFoodMatch.length > 0;
  if (isFoodLog) {
    const pattern = await checkFoodPatterns(user.id);
    const perfectDay = await checkPerfectDay(user.id, user.proteinTarget || 130);
    // ---- Calorie running total — from EXISTING food logs only (not current GPT message) ----
    let dailyTotal = "";
    try {
      const todayStart = sastDayStart();
      const todayFoodLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)));
      let totalCal = 0; let totalProt = 0;
      // Only scan EXISTING food logs — do NOT include current message (GPT handled it, not the food scanner)
      for (const log of todayFoodLogs) {
        const matched = scanForSAFoods(log.messageIn || "");
        if (matched.length > 0) {
          totalCal += matched.reduce((s: number, f: any) => s + (f.typicalPortionCalories || 0), 0);
          totalProt += matched.reduce((s: number, f: any) => s + (f.typicalPortionProtein || 0), 0);
        }
      }
      const calTarget = user.calorieTarget || 1800;
      const protTarget = user.proteinTarget || 130;
      if (totalCal > 0) {
        const remaining = calTarget - totalCal;
        dailyTotal = `\n\n_Today so far: ~${totalCal} kcal | ${totalProt}g protein. Target: ${calTarget} kcal | ${protTarget}g protein.${remaining > 100 ? ` ${remaining} kcal remaining.` : remaining < -100 ? ` Over by ${Math.abs(remaining)} kcal.` : " On target."}_`;
      }
    } catch (e) { console.warn("[non-fatal]", e); }
    const damageControl = await getDamageControlNote(user.id, message);
    const fullReply = finalReply + (pattern ? "\n\n" + pattern : "") + (perfectDay || "") + dailyTotal + damageControl;
    await logChat(user.id, message, fullReply, "FOOD_LOG");
    return fullReply;
  }

  // Log the GPT catchall with the classifier's intent label so the observability
  // dashboard shows accurate intent tags for messages that fell through all handlers.
  const gptIntentLabel = (classifiedIntent !== "OTHER" && intentConfidence >= 0.6)
    ? classifiedIntent
    : (agentType === "mindset" ? "MINDSET" : agentType === "nutrition" ? "NUTRITION" : agentType === "programming" ? "PROGRAMME" : "GENERAL");
  await logChat(user.id, message, finalReply, gptIntentLabel).catch(e => console.warn("[non-fatal logChat]", e));

  return finalReply;
}
