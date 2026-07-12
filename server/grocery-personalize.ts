/**
 * GROCERY LIST PERSONALIZATION (2026-07-12, Kam: "our grocery list… they need to be
 * so comprehensive, they need to know the user").
 *
 * The shopping list in shopping-lists.ts is a strong PRESCRIPTIVE engine (budget × week
 * × goal). That's exactly right for a brand-new client who doesn't know what to eat —
 * they came for guidance, so we lead. This module adds the ADAPTIVE layer on top: once
 * a client has actually logged some meals, we read what they really eat and reshape the
 * list around it — keep their good staples, swap their junk, fill the gaps.
 *
 * Graceful degradation, invisible to the user:
 *   • 0–2 distinct foods logged  → no personalization block; the prescriptive template
 *     stands alone (the beginner still gets told exactly what to buy).
 *   • 3+ distinct foods          → a short, warm "I've been watching what you eat" block
 *     is prepended so the list feels like it knows them.
 *
 * The classifier + builder are PURE (unit-tested in script/unit-tests.ts). Only
 * getRecentFoodProfile touches the DB, via a lazy import so pure callers/tests don't
 * pull in a database connection.
 */

import { suggestSwap } from "./food-swaps";

export type FoodProfileItem = { name: string; count: number };
export type FoodProfile = { topFoods: FoodProfileItem[]; distinctCount: number };

// Below this many distinct logged foods, a client is too new to personalise for —
// we don't claim to "know" them (that would ring false). Instead they get a calm,
// reassuring base-camp message. At/above it, the list adapts to what they log.
export const MIN_DISTINCT_FOR_PERSONALIZATION = 3;

// How much we actually know a client, from their logging. Drives the TONE of the
// grocery message so we never overwhelm a beginner nor patronise a rich logger.
// (2026-07-12, Kam: "we need to know if they are a rich logger… calm down, we've
// got you covered… make it frictionless, don't overwhelm them.")
export type LoggerType = "new" | "learning" | "established";

export function loggerType(distinctCount: number): LoggerType {
  if (distinctCount < MIN_DISTINCT_FOR_PERSONALIZATION) return "new";
  if (distinctCount < 7) return "learning";
  return "established";
}

// Plain keyword classes — a gogo's logged foods, not a nutrition database. SA names
// included (morogo, pap, samp, mielie, naartjie). First match wins, protein first.
const PROTEIN_RE = /\b(egg|eggs|chicken|beef|mince|steak|fish|hake|snoek|tuna|pilchard|sardine|mutton|lamb|pork|chop|liver|bean|beans|lentil|yoghurt|yogurt|amasi|cottage cheese|biltong|tofu|milk|whey|protein|nyama|inyama)\b/i;
const VEG_RE = /\b(spinach|morogo|imifino|cabbage|broccoli|carrot|tomato|onion|pepper|butternut|pumpkin|lettuce|salad|cucumber|green bean|greenbean|veg|veges|veggies|kale|beetroot|mushroom|avo|avocado|chakalaka)\b/i;
const WHOLECARB_RE = /\b(oats|brown rice|brown bread|sweet potato|samp|umngqusho|whole ?wheat|wholewheat|quinoa|barley|pap|maize|mielie|mieliepap|phutu)\b/i;
const FRUIT_RE = /\b(banana|apple|orange|berry|berries|mango|grape|pear|naartjie|paw ?paw|watermelon|guava|peach|fruit)\b/i;

export type LoggedFoodClass = "protein" | "veg" | "wholecarb" | "fruit" | "other";

export function classifyLoggedFood(name: string): LoggedFoodClass {
  const n = name || "";
  if (PROTEIN_RE.test(n)) return "protein";
  if (VEG_RE.test(n)) return "veg";
  if (WHOLECARB_RE.test(n)) return "wholecarb";
  if (FRUIT_RE.test(n)) return "fruit";
  return "other";
}

// Title-case a food name for display ("brown rice" → "Brown rice").
function pretty(name: string): string {
  const t = (name || "").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function prettyList(names: string[]): string {
  const p = names.map(pretty);
  if (p.length <= 1) return p.join("");
  if (p.length === 2) return `${p[0]} and ${p[1]}`;
  return `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
}

// The calm awareness line every not-yet-established client sees — it tells them, with
// zero prompting, that they can send their OWN list or use what's already at home. This
// is the discoverability Kam wants ("they're not gonna prompt… make them aware") kept to
// ONE line so it never overwhelms.
const OWN_LIST_AWARENESS = `📸 _Already have a list, or food in the fridge? Send me a photo — I'll build around what you've got. You don't start from scratch._`;

/**
 * The block prepended to the shopping list. NEVER null now — every client gets a calm,
 * reassuring message tuned to how much they log (loggerType):
 *   • new         → "you're covered, and I learn you as you log" + how to send their own list
 *   • learning    → adapts to their logs + a gentle "keep logging, this gets sharper"
 *   • established  → confident "I know your kitchen now" + full adaptation
 * Pure and unit-tested. Kept short on purpose — calm, not a wall of text.
 */
export function buildGroceryPersonalization(profile: FoodProfile, goalType?: string | null): string {
  const type = loggerType(profile?.distinctCount ?? 0);

  // NEW / cold start — no real data yet. Reassure, don't fake knowing them.
  if (type === "new") {
    return `*You're covered — no stress.* 🌱\nThis is a solid, quality base for your goal. As you log what you eat, I learn your tastes and shape it around you.\n${OWN_LIST_AWARENESS}`;
  }

  const foods = profile.topFoods.slice(0, 8);
  const classOf = (f: FoodProfileItem) => classifyLoggedFood(f.name);
  const classesSeen = new Set(foods.map(classOf));
  const lines: string[] = [];

  // 1. Name the GOOD foods they actually eat — proof we watched, and it keeps their
  //    real diet in the plan instead of overriding it with a generic template.
  const goodFaves = foods
    .filter(f => (["protein", "veg", "wholecarb"] as LoggedFoodClass[]).includes(classOf(f)))
    .slice(0, 3)
    .map(f => f.name);
  if (goodFaves.length) {
    lines.push(`✅ *Kept in* — you already eat ${prettyList(goodFaves)}, so I built the list around them.`);
  }

  // 2. First junk we can genuinely swap (reuses the deterministic SA shelf-swap engine).
  for (const f of foods) {
    const s = suggestSwap(f.name, goalType);
    if (s) {
      lines.push(`🔁 *One swap* — you keep logging ${pretty(f.name)}; grab ${s.swap} instead (${s.reason}).`);
      break;
    }
  }

  // 3. The biggest gap: protein and veg are the two that actually move the goal. Name
  //    whichever is missing from their logs, with the cheapest real fix.
  if (!classesSeen.has("veg")) {
    lines.push(`🥦 *Add veg* — I don't see it in your meals. Spinach, morogo or cabbage: cheap, filling, and it's what's missing.`);
  } else if (!classesSeen.has("protein")) {
    lines.push(`🥩 *Add protein* — your meals are light on it. Eggs and a tin of pilchards are the cheapest fix in SA.`);
  }

  // Header + footer tuned to how well we know them. Established loggers get quiet
  // confidence; learning loggers get a nudge that logging sharpens it. No overwhelm.
  if (type === "established") {
    const body = lines.length ? `\n${lines.join("\n")}` : "";
    return `*I know your kitchen now — this list is built for you:*${body}`;
  }
  // learning
  const body = lines.length ? `\n${lines.join("\n")}` : "";
  return `*Getting to know your eating — this is shaping up around you:*${body}\n_Keep logging your meals and this only gets sharper. I've got the basics covered either way._\n${OWN_LIST_AWARENESS}`;
}

/**
 * Read the client's real eating from the last `days` of meal logs. DB-touching, so the
 * import is lazy — pure importers (unit tests, the builder above) never pull in the pool.
 */
export async function getRecentFoodProfile(userId: string, days = 14): Promise<FoodProfile> {
  try {
    const { pool } = await import("./db");
    const since = new Date(Date.now() - days * 86_400_000);
    const { rows } = await pool.query<{ name: string; count: string }>(
      `SELECT lower(trim(item->>'name')) AS name, COUNT(*)::int AS count
         FROM meal_logs, jsonb_array_elements(items) AS item
        WHERE user_id=$1 AND logged_at > $2 AND items IS NOT NULL
          AND length(trim(coalesce(item->>'name',''))) > 1
        GROUP BY 1 ORDER BY count DESC, name ASC LIMIT 12`,
      [userId, since]
    );
    const topFoods = rows.map(r => ({ name: r.name, count: Number(r.count) })).filter(f => f.name);
    return { topFoods, distinctCount: topFoods.length };
  } catch (e: any) {
    console.warn("[GROCERY] food profile fetch failed:", e?.message);
    return { topFoods: [], distinctCount: 0 };
  }
}

/**
 * Convenience for the four shopping-list callers: fetch the profile and build the block
 * in one call. Returns null on cold start or any error (list still sends, just generic).
 */
export async function getGroceryPersonalization(userId: string, goalType?: string | null, foodDislikes?: string | null): Promise<string | null> {
  try {
    const profile = await getRecentFoodProfile(userId);
    const block = buildGroceryPersonalization(profile, goalType);
    // Honour the foods they told us at onboarding they can't stand — never on the list.
    const disliked = (foodDislikes || "").trim();
    if (disliked) {
      return `${block}\n🚫 *Left off* — you told me you're not a fan of ${disliked.replace(/[.]+$/, "")}. Say the word if you want a swap for anything else.`;
    }
    return block;
  } catch (e: any) {
    console.warn("[GROCERY] personalization failed:", e?.message);
    return null;
  }
}
