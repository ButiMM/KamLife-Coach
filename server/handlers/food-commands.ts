/**
 * FOOD COMMANDS — extracted verbatim from early-commands.ts (2026-07-21), decomposition pass 2.
 * The food-advice cluster: restaurant smart-order, informal/street eating, alcohol awareness,
 * drink + food swaps, meal prep, personalised grocery list, supplement tracking. Deterministic
 * and factual (accurate macros, real SA foods) — appropriately owned by code, not the brain.
 * BEHAVIOUR IS IDENTICAL — moved verbatim, same order, called from the same pipeline position.
 */

import { db } from "../db";
import { users, mealLogs, chatHistory } from "../../shared/schema";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import { SA_FOODS_SEED } from "../foods";
import { isAskingNotReporting } from "../utils";
import { askCoachK } from "../gpt";
import { getShoppingList, formatShoppingList } from "../shopping-lists";
import { getGroceryPersonalization } from "../grocery-personalize";
import { scanForSAFoods, invalidateFoodTotalsCache } from "./food-scanner";
import { logChat, withTimeout } from "./chat-log";
import { tryLogWater } from "./water";
import { generateMealPlan } from "../meal-plan";
import { answerSwapAsk } from "../food-swaps";
import { matchRestaurant, formatRestaurantGuide, listRestaurantNames } from "../restaurants";
import { matchStreetDish, isStreetContext, formatStreetDish, streetGuide } from "../street-food";
import { sastDayStart, parseMealDate, isRetroactiveMeal, mealDateLabel , commaName} from "../utils";

export async function handleFoodCommands(ctx: { phone: string; message: string; m: string; user: any }): Promise<string | null> {
  const { phone, message, m, user } = ctx;
  const firstName = user.name?.split(" ")[0] || "";
  const capName = user.name?.split(" ")[0] || "there";

  // ---- RESTAURANT SMART ORDER — every major SA chain, goal-aware macros (server/restaurants.ts).
  // Deterministic on purpose: accurate macros are the whole value; the numbers are never LLM-guessed.
  // Discovery: "which restaurants can you help with" lists the coverage.
  if (/\b(which|what|list).{0,20}\brestaurants?\b/i.test(m) && /\b(help|order|eat|handle|know|cover|do you)\b/i.test(m)) {
    const names = listRestaurantNames();
    const discReply = `I've got smart, goal-aware orders for these spots:\n\n${names.map((n) => `• ${n}`).join("\n")}\n\nJust tell me where you're eating — "I'm at KFC" or "what should I order at Spur" — and I'll give you the exact order with the numbers.`;
    await logChat(user.id, message, discReply, "RESTAURANT_LIST");
    return discReply;
  }
  const restaurantHit = matchRestaurant(m);
  const isRestaurantQ = restaurantHit && /\b(order|eat|eating|have|get|getting|menu|what.*should|best|healthy|smartest|good choice|low cal|protein|going to|i'?m at|at the)\b/i.test(m);
  if (isRestaurantQ && restaurantHit) {
    const guide = formatRestaurantGuide(restaurantHit, user.goalType || "fat_loss");
    await logChat(user.id, message, guide, "RESTAURANT_GUIDE");
    return guide;
  }

  // ---- STREET / INFORMAL EATING — taxi rank, spaza, vendor, shisa nyama (server/street-food.ts).
  // ADVICE only: a past-tense log ("I had a kota") stays with the scanner; this fires on
  // "what should I get" / "I'm at the rank" / "is a kota ok".
  if (!/\b(i had|i ate|i just (had|ate)|ate a|had a|just had|logged|i'?m eating a)\b/i.test(m)
      && /\b(order|eat|eating|get|getting|should|what|which|is (it|a|this)|good|healthy|instead|best|ok\b|okay|advice|help)\b/i.test(m)) {
    const streetHit = matchStreetDish(m);
    const g = streetHit ? formatStreetDish(streetHit, user.goalType || "fat_loss")
      : isStreetContext(m) ? streetGuide(user.goalType || "fat_loss") : null;
    if (g) { await logChat(user.id, message, g, "STREET_FOOD_GUIDE"); return g; }
  }

  // ---- ALCOHOL AWARENESS — "had 3 beers", "wine tonight", "drinks at the braai" ----
  // Strip "cider vinegar" / "apple cider vinegar" first — it's a condiment, not a drink
  const mNoVinegar = m.replace(/\bapple\s+cider\s+vinegar\b/gi, "").replace(/\bcider\s+vinegar\b/gi, "");
  const alcoholMatch = /\b(\d+)?\s*(beers?|wines?|glasses?\s*(?:of\s*)?wine|brandies?|brandy|whiskey|whisky|vodka|gin|rum|ciders?|savanna|hunters|castle|black label|heineken|windhoek|amstel|stellenbosch|nederburg|four cousins|robertson|4th street|smirnoff|jameson|jack daniel|gordons|captain morgan)\b/i.test(mNoVinegar);
  const hasAlcoholVerb = /\b(had|drank|drinking|having|drinks?|tonight|last night|yesterday|at the braai|at the party|weekend)\b/i.test(mNoVinegar);
  const isDirectAlcoholQty = /^(\d+\s*)?(beers?|wines?|glasses?\s*(of\s*)?(wine|beer|brandy|whisky|whiskey|vodka|gin|rum|cider)|shots?|doubles?)\b/i.test(m.trim());
  // AND IT MUST BE A REPORT, NOT A QUESTION (2026-07-30). "Can I have a beer tonight?" matches
  // the drink AND the verb ("tonight"), so it logged 200 kcal the client never drank — and then
  // the day's totals, the card and the evening coaching were all wrong off a question about
  // permission. Same class as the phantom pilchards. isAskingNotReporting owns this.
  const isAlcoholLog = alcoholMatch && (hasAlcoholVerb || isDirectAlcoholQty) && !isAskingNotReporting(m);
  if (isAlcoholLog) {
    const qtyMatch = m.match(/(\d+)\s*(?:beers?|wines?|glasses?|brandies?|ciders?|shots?|doubles?|bottles?)/i);
    const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;

    const isBeer = /\b(beers?|castle|black label|heineken|windhoek|amstel|lager|hansa)\b/i.test(m);
    const isWine = /\b(wines?|glass.*wine|nederburg|four cousins|robertson|4th street|stellenbosch|sauvignon|merlot|pinotage|chenin)\b/i.test(m);
    const isCider = /\b(ciders?|savanna|hunters)\b/i.test(m);
    const isSpirits = /\b(brandies?|brandy|whiskey|whisky|vodka|gin|rum|smirnoff|jameson|jack|gordons|captain morgan|shots?|doubles?)\b/i.test(m);

    let calPerDrink = 150; let drinkName = "drink";
    if (isBeer) { calPerDrink = 200; drinkName = "beer"; }
    else if (isWine) { calPerDrink = 130; drinkName = "glass of wine"; }
    else if (isCider) { calPerDrink = 220; drinkName = "cider"; }
    else if (isSpirits) { calPerDrink = 100; drinkName = "shot"; }

    const totalCal = calPerDrink * qty;
    const calTarget = user.calorieTarget || 1800;
    const pctOfDay = Math.round((totalCal / calTarget) * 100);

    const isRetroAlcohol = isRetroactiveMeal(m);
    const alcoholLoggedAt = parseMealDate(m);
    const alcoholDateLabel = mealDateLabel(alcoholLoggedAt);

    // Always insert into mealLogs — alcohol calories must actually be tracked
    await db.insert(mealLogs).values({
      userId: user.id,
      rawMessage: message.slice(0, 1000),
      source: "alcohol_log",
      kcalInt: totalCal,
      proteinInt: 0,
      carbsInt: Math.round(totalCal * 0.85 / 4),
      fatInt: 0,
      items: [{ name: `${drinkName} ×${qty}`, kcal: totalCal, protein: 0 }],
      mealLabel: "alcohol",
      loggedAt: alcoholLoggedAt,
    }).catch(e => console.warn("[alcohol mealLog insert]", e));
    invalidateFoodTotalsCache(user.id);

    let alcoholReply: string;
    if (isRetroAlcohol) {
      // Past tense — advice about what to do TODAY, not "tomorrow"
      const todayAction = totalCal > 400
        ? `Today: high-protein meals, extra water, and get your steps in to compensate.`
        : `Back on track today — hit your protein target and get your steps in.`;
      alcoholReply = `${qty} ${drinkName}${qty > 1 ? "s" : ""} logged for ${alcoholDateLabel} — ~${totalCal} kcal (${pctOfDay}% of your daily target).\n\n${todayAction}`;
    } else {
      alcoholReply = `${qty} ${drinkName}${qty > 1 ? "s" : ""} = ~${totalCal} kcal. That's ${pctOfDay}% of your daily target.\n\n`;
      if (totalCal > 600) {
        alcoholReply += `That's a full meal's worth of calories with zero protein. Your body stops burning fat while it processes alcohol.\n\n*Damage control:* High protein meals the rest of today. 1 glass of water per drink. 30 min walk tomorrow.`;
      } else if (totalCal > 300) {
        alcoholReply += `Manageable. Cut one carb serving from your next meal to balance it out. Drink water between rounds.\n\n*Tomorrow:* Extra protein at breakfast. Get your walk in.`;
      } else {
        alcoholReply += `Manageable. Stay hydrated — 1 glass of water per drink. Don't let it become 3 more.`;
      }
    }

    await logChat(user.id, message, alcoholReply, "ALCOHOL_LOG");
    return alcoholReply;
  }

  // ---- DRINK SWAP — intercept BEFORE food swap so "energy drink switch" doesn't get food alternatives ----
  // "Switch" alone is an SA energy drink brand — only treat it as the VERB when it has directional
  // context ("switch to", "switch from", "switch away"). Bare "Switch energy drink" is a food log, not a swap request.
  const switchAsVerb = /\bswitch\s+(?:to|from|away|off|out|up)\b/i.test(m) || /\b(?:how|should|can)\s+(?:do\s+)?(?:i\s+)?switch\b/i.test(m);
  const isDrinkSwap = (/\b(swap|replace|instead of|alternative|substitute|other option)\b/i.test(m) || switchAsVerb)
    && /\b(energy drink|red bull|monster|redbull|powerade|sports drink|energy|coffee|fizzy|cold drink|soda|cool drink|juice)\b/i.test(m);
  const isJustDrinkQuery = /\b(energy drink switch|drink alternatives|what (can|should) i drink|healthier drink|better drink option)\b/i.test(m);
  if (isDrinkSwap || isJustDrinkQuery) {
    const goal = user.goalType || "fat_loss";
    const isEnergyDrink = /\b(energy drink|red bull|monster|redbull|powerade|energy)\b/i.test(m);
    const isCoffee = /\bcoffee\b/i.test(m);
    const isJuice = /\bjuice\b/i.test(m);
    let drinkReply = "";
    if (isEnergyDrink) {
      drinkReply = `*Healthier swaps for energy drinks:*\n\n• *Black coffee* — 2 kcal | same caffeine kick, zero sugar\n• *Rooibos tea* — 0 kcal | good for digestion, South African staple\n• *Sparkling water* — 0 kcal | still gives the fizz\n• *Lite iced coffee (no sugar)* — ~30 kcal | caffeine without the 150+ kcal sugar bomb\n• *Electrolyte water* — 0–10 kcal | if you need the minerals post-workout\n\nEnergy drinks pack 150–180 kcal and 40g+ sugar per can — that's almost a full meal in liquid.${goal === "fat_loss" ? " That's a big chunk of your daily budget." : ""}`;
    } else if (isCoffee) {
      drinkReply = `*Swap your coffee for:*\n\n• *Rooibos tea* — 0 kcal | zero caffeine, great at night\n• *Green tea* — 2 kcal | light caffeine, antioxidants\n• *Herbal tea (chamomile, peppermint)* — 0 kcal | calming, good before sleep\n• *Black coffee* stays zero if you skip the sugar and milk\n\nIf it's the milk and sugar in coffee causing the calories — just try cutting those first.`;
    } else if (isJuice) {
      drinkReply = `*Swap juice for:*\n\n• *Water with lemon* — 5 kcal | feels fancy, basically free\n• *Sparkling water* — 0 kcal | same fizz, no sugar\n• *Rooibos (cold brew)* — 0 kcal | put it in the fridge overnight\n• *Eat the fruit instead* — same vitamins, but the fibre keeps you full longer\n\nOrange juice is ~120 kcal per glass with 23g sugar — the whole fruit is 62 kcal with fibre that keeps you full.`;
    } else {
      drinkReply = `*Healthier drink swaps:*\n\n• *Water* — 0 kcal\n• *Sparkling water* — 0 kcal\n• *Rooibos tea* — 0 kcal\n• *Black coffee* — 2 kcal\n• *Herbal teas* — 0 kcal\n\nMost cold drinks, juices, and flavoured drinks pack 100–200 kcal with nothing to show for it nutritionally. Switching to water or rooibos is one of the easiest cuts you can make.`;
    }
    await logChat(user.id, message, drinkReply, "DRINK_SWAP");
    return drinkReply;
  }

  // ---- FOOD SWAP — "I don't like pilchards", "what can I have instead of", "swap", "replace" ----
  // APPETITE ≠ DISLIKE (2026-07-27 live). "Honestly can't eat anymore today 🐷 what does that
  // mean for my goal? Teach me" came back as "Swaps for Peach" — two guards that already exist
  // in this codebase, neither applied here:
  //   1. "can't eat" fired the swap trigger, but "can't eat ANYMORE" means full, not "I dislike
  //      this food". Opposite meaning, same words.
  //   2. scanForSAFoods ran FUZZY, so "Teach" matched "Peach" at edit distance 1. The exactOnly
  //      flag was built for exactly this ("building phase" → mopani worms) and wasn't passed.
  const isFullNotFussy = /\b(can.?t|cannot|couldn.?t)\s+eat\s+(any\s?more|anything else|another|more)\b|\b(too full|so full|stuffed|no appetite|not hungry)\b/i.test(m);
  const isSwapRequest = !isFullNotFussy
    && /\b(don.?t like|hate|can.?t eat|swap|replace|instead of|alternative|substitute|other option|something else|what else|switch)\b/i.test(m)
    && scanForSAFoods(m, { exactOnly: true }).length > 0;

  // ---- FULL FOR THE DAY — "can't eat anymore today, what does that mean for my goal?" ----
  // The real question underneath the swap bug above, and it had no handler: the chronic
  // under-eating path in advice-commands needs "I only eat once a day" phrasing, so a
  // single honest day of coming up short matched nothing at all.
  if (isFullNotFussy && /\b(what does that mean|does that matter|is that (ok|okay|bad|fine)|for my goal|teach me|explain|will that affect|affect my)\b/i.test(m)) {
    const undereatReply = await fullForTodayReply(user);
    await logChat(user.id, message, undereatReply, "UNDEREATING_TODAY");
    return undereatReply;
  }
  if (isSwapRequest) {
    const foods = scanForSAFoods(m);
    const foodName = foods[0].name;
    const category = foods[0].category;
    const budget = user.weeklyFoodBudget || "100_300";
    const goal = user.goalType || "fat_loss";

    // Find same-category alternatives from the SA food database
    const alternatives = SA_FOODS_SEED.filter(f =>
      f.category === category &&
      f.name !== foodName &&
      f.budgetTier <= (budget === "under_100" ? 1 : budget === "100_300" ? 2 : 3)
    ).sort((a, b) => b.proteinPer100g - a.proteinPer100g).slice(0, 4);

    if (alternatives.length > 0) {
      let swapReply = `*Swaps for ${foodName}:*\n\n`;
      for (const alt of alternatives) {
        swapReply += `• *${alt.name}* — ${alt.typicalPortionCalories} kcal | ${alt.typicalPortionProtein}g protein (${alt.typicalPortionDescription})\n`;
      }
      swapReply += `\nPick whichever one you enjoy — consistency beats perfection. I'll update your plan.`;
      await logChat(user.id, message, swapReply, "FOOD_SWAP");
      return swapReply;
    }
    // If no swap found in DB, use GPT
    const gptSwap = await withTimeout("gpt_swap", 20000, () => askCoachK(message, user,
      `Client doesn't want ${foodName} (${category}). Suggest 3-4 SA alternatives in the same category at a ${budget} budget. Include calories and protein per portion. Their goal is ${goal}. Be specific.`
    ));
    await logChat(user.id, message, gptSwap, "FOOD_SWAP");
    return gptSwap;
  }

  // ---- MEAL PREP PLAN — "meal prep" / "prep" / "sunday cook" ----
  if (m === "5" || m === "meal prep" || m === "prep" || m === "sunday cook" || m === "batch cook" || m === "food prep" || /\b(meal prep|food prep|batch cook|sunday cook|cook for the week|prep for the week)\b/i.test(m)) {
    const budget = user.weeklyFoodBudget || "100_300";
    const goal = user.goalType || "fat_loss";
    const cal = user.calorieTarget || 1800;
    const prot = user.proteinTarget || 120;
    const otherNotes = (user.otherMedicalNotes || "").toLowerCase();
    const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard");
    const noDairy = otherNotes.includes("dairy") || otherNotes.includes("milk");
    const name = commaName(user);

    let plan = `*🍳 Meal Prep Plan — Cook Once, Eat All Week*\n\n`;

    if (budget === "under_100") {
      plan += `*Total cook time: ~90 min*\n*Budget: under R100*\n\n`;
      plan += `*Step 1 — Big Pot of Beans (30 min)*\nSoak 500g sugar beans overnight. Boil until soft. Add onion, garlic, tomato. Makes 6 portions.\n_Store: 3 in fridge, 3 in freezer._\n\n`;
      plan += `*Step 2 — Boiled Eggs (15 min)*\nBoil 12 eggs. Cool. Store in fridge. That is 72g protein ready to grab.\n\n`;
      plan += `*Step 3 — Pap Base (20 min)*\nCook 1kg pap. Divide into 5 portions in containers.\n\n`;
      plan += `*Step 4 — Spinach + Cabbage (15 min)*\nWilt a bunch of spinach with garlic. Shred half a cabbage, stir-fry with onion.\n\n`;
      plan += `*Daily assembly:*\n• Breakfast: 2 eggs + pap\n• Lunch: Beans + cabbage + pap\n• Dinner: ${noFish ? "2 eggs + beans" : "Pilchards (open tin)"} + spinach + pap\n\n`;
      plan += `~${cal} kcal | ~${prot}g protein/day. All from R100/week.`;
    } else if (budget === "100_300") {
      plan += `*Total cook time: ~2 hours*\n*Budget: R150–R250*\n\n`;
      plan += `*Step 1 — Chicken (40 min)*\nSeason 1kg frozen chicken portions with garlic, paprika, salt. Bake at 180°C for 40 min. Makes 5 portions.\n\n`;
      plan += `*Step 2 — Rice or Sweet Potato (25 min)*\nCook 1kg brown rice OR chop 1.5kg sweet potato, boil until soft. Divide into 5 containers.\n\n`;
      plan += `*Step 3 — Beans + Lentils (30 min)*\nCook 500g sugar beans with tomato and onion. Makes 4 portions.\n\n`;
      plan += `*Step 4 — Eggs (15 min)*\nBoil 12 eggs for grab-and-go breakfasts.\n\n`;
      plan += `*Step 5 — Vegetables (15 min)*\nStir-fry cabbage + spinach + onion. Divide into containers.\n\n`;
      plan += `*Daily assembly:*\n• Breakfast: 2 eggs + oats (cook fresh, 3 min)\n• Lunch: Chicken + rice + vegetables\n• Dinner: Beans + sweet potato + spinach\n• Snack: ${noDairy ? "Banana + 2 eggs" : "Yoghurt + banana"}\n\n`;
      plan += `~${cal} kcal | ~${prot}g protein/day.`;
    } else {
      plan += `*Total cook time: ~2.5 hours*\n*Budget: R300+*\n\n`;
      plan += `*Step 1 — Protein Rotation (50 min)*\nBake 1kg chicken breast (40 min). Brown 500g lean mince with onion + garlic (15 min). Boil 12 eggs (15 min).\n5 chicken portions + 4 mince portions + 12 eggs = week sorted.\n\n`;
      plan += `*Step 2 — Carb Base (25 min)*\nCook 1kg brown rice. Bake 1kg sweet potato chunks. Divide into containers.\n\n`;
      plan += `*Step 3 — Vegetables (20 min)*\nRoast broccoli + butternut (20 min at 200°C). Stir-fry spinach + cabbage.\n\n`;
      plan += `*Step 4 — Snack Prep (10 min)*\n${noDairy ? "Portion banana + peanut butter into containers." : "Portion Greek yoghurt + oats + banana into containers."}\n\n`;
      plan += `*Daily assembly:*\n• Breakfast: Oats + 2 eggs + banana\n• Lunch: Chicken + rice + roast veg\n• Dinner: Mince + sweet potato + spinach\n• Snack: ${noDairy ? "Peanut butter + banana" : "Greek yoghurt + oats"}\n\n`;
      plan += `~${cal} kcal | ~${prot}g protein/day.`;
    }

    plan += `\n\n*Pro tip:* Do this every Sunday. 2 hours saves you 7 days of bad decisions.`;
    await logChat(user.id, message, plan, "MEAL_PREP");
    return plan;
  }

  // ---- MY GROCERY LIST — personalized from last 7 days of logged meals ----
  if (m === "my grocery list" || m === "my groceries" || m === "personal shopping list" || /\b(my\s*grocery|personal.*shop|buy.*based.*on.*what.*eat|smart.*shop)\b/i.test(m)) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const recentFoodLogs = await db.select({ messageIn: chatHistory.messageIn }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sevenDaysAgo)));

      if (recentFoodLogs.length < 3) {
        return `Not enough food logs to build your personal list yet. Log what you eat for a few days — just tell me "I had eggs and pap" — and I will build a grocery list based on YOUR actual meals.\n\nMeanwhile, type *shopping list* for a generic budget list.`;
      }

      // Scan all logged foods and count frequency
      const foodCounts: Record<string, { count: number; cal: number; prot: number; name: string }> = {};
      for (const log of recentFoodLogs) {
        const matched = scanForSAFoods(log.messageIn || "");
        for (const food of matched) {
          const key = food.name.toLowerCase();
          if (!foodCounts[key]) foodCounts[key] = { count: 0, cal: food.typicalPortionCalories || 0, prot: food.typicalPortionProtein || 0, name: food.name };
          foodCounts[key].count++;
        }
      }

      const sorted = Object.values(foodCounts).sort((a, b) => b.count - a.count);
      if (sorted.length === 0) {
        return `I could not match specific foods from your logs. Type *shopping list* for a generic budget list, or log meals using SA food names (pap, pilchards, chicken, etc).`;
      }

      const budget = user.weeklyFoodBudget || "100_300";
      const name = user.name?.split(" ")[0] || "there";
      const topFoods = sorted.slice(0, 12);

      // Build grocery items from their actual eating patterns
      const groceryItems: string[] = [];
      const proteinItems: string[] = [];
      const carbItems: string[] = [];
      const vegItems: string[] = [];
      const otherItems: string[] = [];

      for (const food of topFoods) {
        const n = food.name.toLowerCase();
        const weeklyServings = Math.ceil(food.count * (7 / 7)); // project to full week
        if (["chicken", "beef", "mince", "fish", "hake", "pilchards", "tuna", "eggs", "biltong", "boerewors", "wors", "sardines", "salmon", "pork", "lamb", "turkey"].some(p => n.includes(p))) {
          proteinItems.push(`${food.name} — ${weeklyServings}× this week`);
        } else if (["pap", "rice", "bread", "oats", "sweet potato", "potato", "samp", "pasta", "cereal", "weetbix"].some(c => n.includes(c))) {
          carbItems.push(`${food.name} — ${weeklyServings}× this week`);
        } else if (["spinach", "cabbage", "broccoli", "tomato", "onion", "lettuce", "morogo", "beans", "lentils", "butternut"].some(v => n.includes(v))) {
          vegItems.push(`${food.name} — ${weeklyServings}× this week`);
        } else {
          otherItems.push(`${food.name} — ${weeklyServings}×`);
        }
      }

      let list = `*🛒 ${name}'s Personal Grocery List*\n_Based on your last 7 days of meals_\n\n`;
      if (proteinItems.length > 0) list += `*Protein:*\n${proteinItems.map(i => `• ${i}`).join("\n")}\n\n`;
      if (carbItems.length > 0) list += `*Carbs:*\n${carbItems.map(i => `• ${i}`).join("\n")}\n\n`;
      if (vegItems.length > 0) list += `*Vegetables:*\n${vegItems.map(i => `• ${i}`).join("\n")}\n\n`;
      if (otherItems.length > 0) list += `*Other:*\n${otherItems.map(i => `• ${i}`).join("\n")}\n\n`;

      // Add what's missing based on their targets
      const totalProtein = topFoods.reduce((s, f) => s + f.prot * f.count, 0);
      const avgDailyProt = totalProtein / 7;
      const protTarget = user.proteinTarget || 120;
      if (avgDailyProt < protTarget * 0.7 && proteinItems.length < 3) {
        const budgetSuggestion = budget === "under_100" ? "pilchards (R12/tin) or eggs (R4/egg)" : "frozen chicken portions (R40/kg) or eggs";
        list += `⚠️ *Protein gap detected* — add more ${budgetSuggestion} to hit your ${protTarget}g target.\n\n`;
      }

      list += `_Type *shopping list* for a full budget grocery list._`;
      await logChat(user.id, message, list, "PERSONAL_GROCERY");
      return list;
    } catch (err) {
      console.error("[PERSONAL GROCERY]", err);
      return `Could not generate your personal grocery list. Type *shopping list* for a generic one.`;
    }
  }

  // ---- SUPPLEMENT TRACKING — "my supplements" / "supps" / "vitamins" ----
  if (m === "supplements" || m === "supps" || m === "my supplements" || m === "vitamins" || m === "my vitamins" || /\b(supplement|supps|vitamin|multivitamin|creatine|omega|magnesium|zinc|iron|collagen)\b/i.test(m)) {
    // Check if they are logging a supplement intake
    const logSupp = /\b(took|taken|had|drank)\b.*\b(supplement|supps|vitamin|creatine|omega|magnesium|zinc|iron|collagen|multivitamin|fish oil|whey|bcaa)\b/i.test(m)
      || /\b(supplement|supps|vitamin|creatine|omega|magnesium|zinc|iron|collagen|multivitamin|fish oil|whey|bcaa)\b.*\b(took|taken|done|logged|had)\b/i.test(m);

    if (logSupp) {
      await logChat(user.id, message, "Supplement logged", "SUPPLEMENT_LOG");
      const todayStart = sastDayStart();
      const todaySuppLogs = await db.select({ id: chatHistory.id }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "SUPPLEMENT_LOG"), gte(chatHistory.createdAt, todayStart)));
      const suppStreakLine = todaySuppLogs.length >= 2 ? ` Day ${todaySuppLogs.length} in a row — that's the habit.` : "";
      const suppReply = `Taken ✅${suppStreakLine}\n\nSame time every day beats the perfect supplement stack. Set a phone alarm and make it automatic.`;
      // Combined log ("2 litres of water and 10g of creatine"): this supplement handler
      // runs BEFORE the water handler in the pipeline, so without this the water half is
      // silently dropped. Log any co-occurring water here and lead with its confirmation.
      const waterCombined = await tryLogWater({ phone, message, m, user });
      return waterCombined ? `${waterCombined}\n\n---\n\n${suppReply}` : suppReply;
    }

    // Specific supplement question — give a targeted answer, not the whole guide
    const isCreatine = /\bcreatine\b/i.test(m);
    const isWhey = /\b(whey|protein powder|protein shake)\b/i.test(m);
    const isOmega = /\b(omega|fish oil)\b/i.test(m);
    const isMagnesium = /\bmagnesium\b/i.test(m);
    const isVitD = /\b(vitamin d|vit d|vitamin d3)\b/i.test(m);
    const isCollagen = /\bcollagen\b/i.test(m);
    const isZinc = /\bzinc\b/i.test(m);
    const isSpecific = isCreatine || isWhey || isOmega || isMagnesium || isVitD || isCollagen || isZinc;

    if (isSpecific && m !== "supplements" && m !== "supps" && m !== "my supplements") {
      const goal = user.goalType || "fat_loss";
      let reply = "";
      if (isCreatine) {
        reply = `Yes — creatine's the most proven one there is, and it works for fat loss as well as building.\n\n5g a day with water, any time, no loading phase. Buy plain monohydrate at Dis-Chem, about R150 a month — the fancy ones are the same thing at triple the price.`;
      } else if (isWhey) {
        const pTarget = user.proteinTarget || 120;
        reply = `Only if you can't get your ${pTarget}g from food — if chicken, eggs and pilchards are already in your week, you don't need it.\n\nIf you're short most days, one scoop after training closes the gap. Any plain whey from Dis-Chem does the job.`;
      } else if (isOmega) {
        reply = `Worth it for most people — joints and inflammation mainly.\n\n1–2g of EPA+DHA a day (read the label, not the "1000mg fish oil" on the front). Generic capsules from Clicks, R60–R80 a month.`;
      } else if (isMagnesium) {
        reply = `Good one for sleep, recovery and night-time cravings — most people are short on it.\n\nGet magnesium glycinate, not oxide, and take it before bed. R80–R120 a month.`;
      } else if (isVitD) {
        reply = `Worth it — most South Africans are short on it despite the sun, especially with an indoor job.\n\n2000–4000 IU a day with food. R50–R80 a month.`;
      } else if (isCollagen) {
        reply = `Decent for joints, not for building muscle — if you're over 35 or your knees complain, worth a try; otherwise food protein does more.\n\nHydrolysed peptides, 10–15g a day with something containing vitamin C.`;
      } else if (isZinc) {
        reply = `Most people get enough from red meat and eggs, so only worth it if you eat little or no meat.\n\n15–25mg a day — don't go higher, too much blocks copper absorption.`;
      }
      await logChat(user.id, message, reply, "SUPPLEMENT_GUIDE");
      return reply;
    }

    // Generic "supplements" query — give the full goal-specific guide
    const goal = user.goalType || "fat_loss";
    const budget = user.weeklyFoodBudget || "100_300";
    const name = user.name?.split(" ")[0] || "";

    let suppGuide = `*💊 Supplement Guide${name ? ` — ${name}` : ""}*\n\n`;
    suppGuide += `*Essential (everyone):*\n`;
    suppGuide += `• Multivitamin — R50-R80/month (Clicks or Dis-Chem)\n`;
    suppGuide += `• Vitamin D3 — especially if indoor job\n\n`;

    if (goal === "muscle_gain") {
      suppGuide += `*For muscle gain:*\n`;
      suppGuide += `• Creatine monohydrate 5g/day — R150/month (most evidence-backed supplement)\n`;
      suppGuide += `• Whey protein — only if you cannot hit ${user.proteinTarget || 120}g from food\n\n`;
    } else {
      suppGuide += `*For fat loss:*\n`;
      suppGuide += `• Magnesium glycinate — R80/month (sleep, recovery, cravings)\n`;
      suppGuide += `• Omega 3 / Fish oil — R60/month (inflammation, joint health)\n\n`;
    }

    if (budget === "under_100") {
      suppGuide += `_On a tight budget? Skip supplements — get your protein from eggs and pilchards, your vitamins from spinach and cabbage. Food first, always._`;
    } else {
      suppGuide += `_Log your supplements: say "took my creatine" or "had my vitamins" and I will track consistency._`;
    }

    await logChat(user.id, message, suppGuide, "SUPPLEMENT_GUIDE");
    return suppGuide;
  }

  return null;
}

/**
 * "I'm full, I can't eat any more today — what does that mean for my goal?"
 *
 * A real coaching question that deserves a real answer, built from THIS client's numbers, not
 * a platitude. One honest short day is not a problem; the trap is protein, which can't be
 * banked, and the rebound tomorrow. Deterministic — every number here is read, never guessed.
 */
async function fullForTodayReply(user: any): Promise<string> {
  const { recomputeTodayFoodTotals } = await import("./food-scanner");
  const t = await recomputeTodayFoodTotals(user.id).catch(() => null);
  const eaten = Math.round(t?.calories || 0);
  const prot = Math.round(t?.protein || 0);
  const calTarget = user.calorieTarget || 2000;
  const protTarget = user.proteinTarget || 120;
  const shortKcal = Math.max(0, calTarget - eaten);
  const shortProt = Math.max(0, protTarget - prot);
  const fn = (user.name || "").split(" ")[0];
  const hi = fn ? `${fn}, ` : "";

  const head = `${hi}being full is not a failure — appetite moves day to day and forcing food down is not the goal.\n\nToday: *${eaten} kcal* of ${calTarget} and *${prot}g protein* of ${protTarget}g.`;

  if (shortProt > 30) {
    return `${head}\n\n*What actually matters:* the calories you can let go — one short day changes nothing. Protein is the one that doesn't carry over: your body uses what it gets each day and can't bank the rest. You're ${shortProt}g short.\n\n*If you can manage one small thing:* a yoghurt, a glass of milk, or two boiled eggs. Liquid protein goes down when food won't.\n\n*Tomorrow:* eat normally. Don't add today's shortfall onto tomorrow — that swing is what makes people binge.`;
  }
  if (shortKcal > 500) {
    return `${head}\n\n*What it means:* you're ${shortKcal} kcal under. One day like this is fine — your body works on the weekly average, not one evening.\n\n*The thing to watch:* if it happens three or four days running, your body slows down to match and progress stalls. One day is nothing; a pattern is something.\n\n*Tomorrow:* eat normally. Never "make up" for a short day by eating less again.`;
  }
  return `${head}\n\n*What it means:* you're close enough — you've eaten roughly what you need and your protein is in. Stopping when you're full is exactly right.\n\n*Tomorrow:* normal day, no adjustment. This is what a good day looks like.`;
}
