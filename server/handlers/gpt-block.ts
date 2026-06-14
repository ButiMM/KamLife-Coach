import { db } from "../db";
import { users, chatHistory } from "../../shared/schema";
import { eq, desc, and, gte } from "drizzle-orm";
import { askCoachK, getSAContextFlags, isUnderGPTCallLimit, selectModel, classifyIntent, type ClassifiedIntent } from "../gpt";
import { nutritionAgent, programmingAgent, mindsetAgent, adminAgent, routeToAgent } from "../agents";
import { recomputeTodayFoodTotals } from "./food-scanner";
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

  // Live daily status — injected into every GPT call so the AI knows exactly where the client stands
  let todayStatusBlock = "";
  try {
    const todayTotals = await recomputeTodayFoodTotals(user.id);
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 120;
    const stepTarget = user.stepsTarget || 8500;
    const todaySteps = user.todaySteps || 0;
    const sastHour = new Date(Date.now() + 2 * 3_600_000).getUTCHours();

    const calEaten = todayTotals.calories;
    const protEaten = todayTotals.protein;
    const calDiff = calEaten - calTarget;
    const calStatus = calEaten === 0
      ? "nothing logged yet"
      : calDiff > 0
        ? `${calDiff} kcal OVER target — do not encourage more eating`
        : `${Math.abs(calDiff)} kcal remaining`;
    const protStatus = protEaten === 0
      ? "no protein logged yet"
      : protEaten >= protTarget
        ? `protein target met (${protEaten}g)`
        : `${protTarget - protEaten}g short of target`;
    const stepStatus = todaySteps === 0
      ? "no steps logged"
      : todaySteps >= stepTarget
        ? `step target hit (${todaySteps.toLocaleString()} steps)`
        : `${(stepTarget - todaySteps).toLocaleString()} steps short (${todaySteps.toLocaleString()} done so far)`;

    const progContext = user.programmePhase
      ? `\n- Programme: Phase ${user.programmePhase}, Week ${user.programmeWeek || 1}, Day ${user.programmeDayInWeek || 1}`
      : "";
    const weightLine = user.currentWeight ? `\n- Current weight: ${parseFloat(String(user.currentWeight)).toFixed(1)}kg` : "";
    todayStatusBlock = `\n\nCLIENT STATUS RIGHT NOW (${sastHour}:00 SAST):
- Calories: ${calEaten} kcal eaten / ${calTarget} target → ${calStatus}
- Protein: ${protEaten}g eaten / ${protTarget}g target → ${protStatus}
- Steps today: ${stepStatus}${progContext}${weightLine}
- Goal: ${user.goalType || "fat_loss"}
USE THIS DATA. If they are over on calories — call it out with the number. If short on protein — give one specific high-protein food. Do not ignore this data. NEVER ask the client for information shown above (weight, goal, targets, today's numbers) — you already have it; asking again destroys trust.`;
  } catch (e) { /* non-fatal — context is best-effort */ }

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

  const instruction = `Today is ${dayOfWeek} ${timeOfDay}.${saContext ? "\n\n" + saContext : ""}${todayStatusBlock}${recentConvBlock}

RESPOND TO THIS CLIENT'S EXACT MESSAGE AS COACH K.

SCENARIO GUIDE — read the message and decide which applies:

FOOD LOG MANAGEMENT (client wants to remove, delete, undo, correct, or change something they logged — any natural phrasing like "remove breakfast", "I didn't eat that", "delete the lunch I logged", "take off the mince", "that was wrong", "scratch that", "undo it", "I made a mistake with my log"):
  Tell them: "To remove your last meal say 'remove last meal'. To remove a specific food say 'remove [food name]'. To remove a specific meal say 'remove breakfast' (or lunch/dinner/supper). To clear everything today say 'clear food log'." Keep it short — one sentence per option, max 3 options shown.

WORKOUT / PROGRAMME REQUEST ("give me a program", "3 day", "full body", "training plan", "what do I do today", "1", "2", "workout", etc.):
  Tell the client their programme is ready and to reply with the word "programme" to see the full plan. Do not list exercises here.

STEPS LOGGED (number + "steps" / "walked" / "km"):
  Respond based on their step target of ${user.stepsTarget || 8500}. If below — push them. If at or above — celebrate and give next action.

FOOD / MEAL LOGGED (any food item or meal described):
  Coach specifically on THAT exact food. ALWAYS include the estimated calories (kcal) and protein (g) — this is NON-NEGOTIABLE. Format: "That is roughly X kcal and Xg protein." If you cannot estimate a specific number, use a range. Never give a food response without numbers. Never say "I cannot estimate" — always give a best estimate based on standard portions.
  If junk or high calorie — be honest but never shame. One sentence on what it costs them, one adjustment for the NEXT meal. Never overhaul their entire diet from one meal. The philosophy: refine what they already eat, don't replace it — people don't stick to complete diet changes. "That's a heavy one — go lighter on dinner and push the steps" is the right energy. If good — celebrate and connect to their ${user.goalType || "fat loss"} goal. Never end with a protein warning. Never give generic advice.
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

LIFE IS HAPPENING — the client is telling you about something in their life that has affected, is affecting, or will affect their training or routine. This covers ANY situation: sick, flu, fever, not well; busy with work, exams, deadlines; gym closed or not functioning; traveling or away from home; special event of any kind (graduation, wedding, funeral, church, lobola, matric, family gathering, moving house); overwhelmed or stressed; couldn't complete steps or targets; ate something off; short on time this week:

  CRITICAL GREETING RULE — NON-NEGOTIABLE: If the client's message starts with "Hi", "Hello", "Hope you're well", "Hey", or any greeting AND the message also contains real information about their life situation — you MUST respond ONLY to the real information. Completely ignore the greeting. Do NOT say "hello back", do NOT open with any greeting, do NOT acknowledge "Hi" or "Hope you're well". The client did not message you to exchange pleasantries — they messaged you because something is happening. Respond to THAT.

  READ THE WHOLE MESSAGE before responding. The greeting is noise. The life situation is the signal.

  HOW TO RESPOND based on what they actually said:

  SICK / ILL / FLU / FEVER / NOT WELL:
    Rest is the only prescription. Do NOT suggest a lighter workout, a walk, or "just 20 squats". When someone is sick, training is counterproductive. Acknowledge they're not well. Give one specific recovery nutrition tip (protein to preserve muscle, enough food to fuel the immune system). Tell them their programme is waiting when they feel better. No guilt, no pressure.

  BUSY WEEK / OVERWHELMED / WORK / EXAMS / DEADLINES:
    Normalise it — life happens and consistency over time matters more than any single week. Give ONE thing they can do today that takes under 10 minutes. Not a full programme. One thing. Walk to the car park and back. 3 sets of squats. 2 boiled eggs for protein. One specific action that fits into their actual day.

  GYM CLOSED / CAN'T GET TO GYM:
    Ask what they have access to — bodyweight only, dumbbells, or nothing. Then deliver a session adapted to that. Do NOT tell them to just rest unless they're sick.

  TRAVELING / AWAY FROM HOME:
    Hotel room bodyweight workout: 4 exercises, sets and reps. Practical eating advice for restaurants and takeaways. Keep them engaged — traveling is not an excuse to pause.

  SPECIAL LIFE EVENT (graduation, wedding, funeral, lobola, matric, birthday, family gathering):
    Acknowledge the event specifically and warmly. If it's a celebration — celebrate it. If it's a loss — lead with empathy. Give one practical action for eating or staying active around the event. Never make them feel guilty for being human.

  COULDN'T COMPLETE STEPS / BEHIND ON TARGETS:
    Never shame. Acknowledge what stopped them (if they said). Tell them missing one day does not undo their progress. Give them one thing they can do right now to move — even if it's just 1,000 steps before bed.

  ATE SOMETHING OFF / CONFESSING A SLIP:
    Never shame. Acknowledge it, give the numbers if you can (approximate kcal/protein), coach forward. One specific better choice for the next meal — not instead of what they ate, for the NEXT meal.

  GENERAL LIFE UPDATE / JUST CHECKING IN:
    Respond to what they actually said. Reference something specific — their goal, a number from their journey, what they mentioned. Never send a generic acknowledgment.

ALCOHOL:
  Coach forward. Acknowledge it happened. One practical next step. Never shame.

DIABETES / BLOOD SUGAR:
  Low GI carbs. Consistent meal timing. Train 1-2 hours after eating. Never skip meals.

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

PROGRAMME DELIVERY: Use bold day headers. Each exercise on its own line: exercise name, sets and reps, one form cue, one common mistake. Do NOT include YouTube links or markdown hyperlinks — WhatsApp does not render them. Separate each day with a line break. Bold is allowed here.

MEAL PLAN DELIVERY: Each meal on its own block: meal name, ingredients, estimated calories and protein, preparation time. Always state the cost in rands. Bold meal names are allowed here.

CALCULATION RESPONSE: Show the formula. Show the numbers. State the result clearly. Add one sentence explaining what this specific result means for this client's goal. No padding.

CRISIS RESPONSE: Short. Warm. Direct. Give the support resources first — Samaritans SA 0800 567 567. Say nothing else until they respond.

MILESTONE CELEBRATION: Energetic, specific, personal. Reference something real and measurable from their journey — a number, a first, a behaviour change. Never use generic praise like "You're amazing" or "I'm so proud of you."

BANNED PHRASES — never say these under any circumstances:
- "You seem surprised"
- "Eish, what's going on" as a generic opener
- "How can I help you today" or any variation
- Opening with "Hello", "Hi", "Hey" or any greeting — EVER. Coach K never opens a response with a greeting. Start with the coaching.
- Echoing the client's greeting back at them ("Hello back!", "Hi there!", "Hey!") — this is the worst possible response when someone has sent you real information
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

  // ---- LANGUAGE-AWARE COACHING — translate + simplify for non-English speakers ----
  if (activeLang !== "en") {
    const langNames: Record<string, string> = { zu: "Zulu", xh: "Xhosa", st: "Sesotho", tn: "Setswana", ts: "Xitsonga", af: "Afrikaans" };
    const langName = langNames[activeLang] || "non-English";
    finalInstruction = `LANGUAGE CONTEXT: This client's primary language is ${langName}. Their message may be written in ${langName}, Tsotsitaal, or a mix with English. FIRST translate their message to English in your head, THEN identify the coaching intent and respond. Use SIMPLE English in your reply — short sentences, basic words, no jargon. Maximum 8-10 words per sentence. Say "eat" not "consume". Say "belly fat" not "visceral fat". Explain any exercise in one plain sentence.\n\n${finalInstruction}`;
  }

  // ---- MEMORY: retrieve relevant memories — fire and don't block response ----
  // 500ms timeout so a slow/missing pgvector table never delays coaching replies
  let memoryContext = "";
  try {
    const memories = await Promise.race([
      retrieveMemories(phone, message),
      new Promise<string[]>(r => setTimeout(() => r([]), 500)),
    ]);
    if (memories.length > 0) memoryContext = memories.join("\n");
  } catch (e) { /* non-fatal — memory is enhancement, not core */ }

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

  // Pure reactions — only words that are unambiguously positive regardless of context.
  // Words like "wow", "eish", "omg" are ambiguous (can be sarcasm/frustration) — they fall through to context-aware handling.
  // Gratitude is never ambiguous — all SA languages included, no GPT call needed.
  const PURE_REACTIONS = new Set([
    "nice", "awesome", "great", "perfect", "noted", "got it", "will do", "lekker", "cool", "aight",
    "thanks", "thank you", "thanks coach", "thank you coach", "thanks a lot", "thank u", "ty",
    "dankie", "baie dankie",                       // Afrikaans
    "ngiyabonga", "siyabonga", "ngiyabonga coach", // isiZulu
    "enkosi",                                      // isiXhosa
    "ke a leboha", "ke a leboga", "kea leboha",    // Sesotho/Setswana
    "ndza khensa",                                 // Xitsonga
  ]);
  if (PURE_REACTIONS.has(m)) {
    const acks = ["Sharp.", "Noted.", "Lekker.", "Good.", "Keep it up.", "Yebo. 👊", "Sho."];
    const ack = acks[Math.floor(Math.random() * acks.length)];
    await logChat(user.id, message, ack, "REACTION_ACK");
    return ack;
  }

  // Ambiguous reactions — "wow", "eish", "omg", "sharp" — route through context to read the room
  const AMBIGUOUS_REACTIONS = ["wow", "eish", "omg", "oh my god", "yoh", "hayibo", "haibo", "shem", "really", "seriously", "sharp", "lol", "wtf", "right"];
  const SHORT_REPLIES = ["yes", "no", "yeah", "nah", "nope", "yep", "yebo", "ja", "ok", "okay", "sure", "fine"];
  if (SHORT_REPLIES.includes(m) || AMBIGUOUS_REACTIONS.includes(m)) {
    try {
      const lastExchange = await db.select({ messageOut: chatHistory.messageOut, intent: chatHistory.intent })
        .from(chatHistory)
        .where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      const lastOut = lastExchange[0]?.messageOut || "";
      const lastIntent = lastExchange[0]?.intent || "";
      const shortReplyContext = `Client replied "${message}" to your previous message (intent: ${lastIntent}): "${lastOut.slice(0, 300)}".

CRITICAL — READ THE TONE FIRST:
- If your previous message was clearly wrong, confused, or unhelpful AND the client says "wow", "eish", "omg", "really", "seriously", "lol" — they are expressing disbelief or frustration, NOT celebration. Acknowledge the bad response briefly and correct it.
- If your previous message was good coaching and the client's reaction is positive — acknowledge and move forward.
- Never respond to sarcasm with cheerfulness. If the context is negative, match it with directness and a correction.
- NEVER claim there was a technical issue ("it seems there was an issue") — nothing went wrong unless the client says so.
- NEVER pivot to a different topic. If your previous message was about the workout, do NOT ask about meals. Stay on the subject of your previous message.
Do not ask "what do you mean" — interpret from context. Max 2 sentences.`;
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

  // Client critiquing the bot's RESPONSE QUALITY — not personal emotional distress.
  // "vague", "robotic", "that was wrong", "no this is a disaster" = coaching feedback.
  // These must NOT route to the mindset agent (which treats everything as personal struggle).
  const isMetaCriticism =
    /\b(vague|robotic|generic)\b/i.test(m) ||
    /\b(this|that|your|the)\s+(response|answer|reply|message|coaching)\s+(is|was|doesn.?t|makes no)\b/i.test(m) ||
    /\b(this is a disaster|that.?s a disaster|no this is|you (ignored|didn.?t (listen|read|understand|get it)))\b/i.test(m) ||
    /\b(not what i (asked|said|meant)|didn.?t answer|ignored (my|the) question)\b/i.test(m);

  const isFrustrated =
    /\b(wow just wow|seriously\?|what the|this is ridiculous|what is this|are you serious|come on|wtf|what the hell|this is useless|pathetic|this doesn.?t make sense|that.?s wrong|you.?re wrong|bad response|wrong answer|that.?s not what i|you didn.?t even|you ignored|you didn.?t listen|not what i asked|not worth|waste of money|waste of time|cancel|refund|unsubscribe|this is bad|this is shit|this sucks|useless|rubbish|garbage|disappointed|i.?m done|giving up on this|doesn.?t work|broken|stupid)\b/i.test(m) ||
    (m.length < 30 && /^\s*(wow|seriously|really|eish|ag man|ag nee|shem|hayibo|haibo|omg|oh my god|yoh)\s*[!?.]*$/i.test(m)) ||
    isMetaCriticism;

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
      const frustContext = isMetaCriticism
        ? `You are Coach K. Client said: "${message}". Your previous message was: "${lastOut.slice(0, 200)}".

The client is critiquing the QUALITY of your coaching response — they called it vague, robotic, generic, or wrong. This is NOT personal emotional distress. Do NOT respond with empathy, emotional support, or life coaching. ${profileGuard}

TWO SENTENCES ONLY:
1. Acknowledge in one direct sentence what the last response missed (was it too brief? too generic? ignored what they said?)
2. Give one specific, data-driven coaching action using their actual numbers (weight, target, goal, programme)

BANNED — never say any of these: "I sense your disappointment", "navigate your fitness journey", "overwhelmed", "challenges your way", "I'm sorry", "I apologise", "you've got this", "let's ensure", "keep you engaged and motivated", "feel free", "reach out", "be kind to yourself", "I understand", "It sounds like"
SA voice. Direct. Correct the miss. Coach forward.`
        : `You are Coach K. Client said: "${message}". Your previous message was: "${lastOut.slice(0, 200)}".

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

  // ---- LOW-CONFIDENCE INTENT — ask for clarification rather than guessing wrong ----
  // A confident wrong answer is worse than a clarifying question.
  // Only fires when the message is genuinely ambiguous AND has no obvious handler signal.
  if (intentConfidence < 0.5 && message.trim().length > 20) {
    const hasObviousFoodSignal = /\b(?:ate|had|food|meal|eating|breakfast|lunch|dinner|supper|kcal|calorie|protein|gram)\b/i.test(m);
    const hasObviousStepSignal = /\b(?:\d[\d,]*\s*steps?|walked\s+\d|km\b)\b/i.test(m);
    const hasObviousWeightSignal = /\b(?:\d{2,3}(?:\.\d+)?\s*kg\b|weigh|scale|body weight)\b/i.test(m);
    const hasObviousWorkout = /\b(?:gym|workout|training|trained|session|lift|squat|bench|press|done|finished)\b/i.test(m);
    if (!hasObviousFoodSignal && !hasObviousStepSignal && !hasObviousWeightSignal && !hasObviousWorkout) {
      const clarifyReply = `Didn't catch that — was that a *food log*, *workout update*, or a question?\n\nReply:\n• *food* then what you ate (e.g. "food — 2 eggs and toast")\n• *done* if you just trained\n• Or just ask me anything directly`;
      await logChat(user.id, message, clarifyReply, "UNCLEAR");
      return clarifyReply;
    }
  }

  // Determine effective agent type:
  // 1. RANT with high confidence → mindset agent (empathetic, doesn't lecture on nutrition)
  // 2. Otherwise use keyword-based routing as before
  let agentType = routeToAgent(message);
  if (classifiedIntent === "RANT" && intentConfidence >= 0.75 && !isMetaCriticism) {
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
      const targetValue = `Calorie target: ${user.calorieTarget || 1800} kcal | Protein target: ${user.proteinTarget || 120}g | Steps target: ${user.stepsTarget || 8500}`;
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
    const _todayStrP = new Date().toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg" }).split("/").reverse().join("-");
    const _todayCalsP = user.todayCaloriesDate === _todayStrP ? (user.todayCalories || 0) : 0;
    const _calCeilingForPattern = (user.calorieTarget || 0) > 0 && (_todayCalsP - (user.calorieTarget || 0)) >= 100;
    const pattern = await checkFoodPatterns(user.id, _calCeilingForPattern);
    const perfectDay = await checkPerfectDay(user.id, user.proteinTarget || 120);
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
      const protTarget = user.proteinTarget || 120;
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
