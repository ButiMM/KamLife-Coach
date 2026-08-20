/**
 * SA STREET & INFORMAL EATING — the real way most of our clients eat.
 *
 * Not the mall chains (that's restaurants.ts) — the taxi rank, the spaza, the vendor on the
 * corner, the shisa nyama, the tavern plate. A kota, chicken livers, a shisa nyama plate,
 * vetkoek and mince, a gatsby. This is where being "in tune with the client's daily life"
 * actually shows. We NEVER shame these foods — they're cheap, real, and cultural. We coach
 * the SMART version of what they're already buying: more protein, less of the chip-bomb,
 * a lean swap, an honest portion. Goal decides the emphasis.
 *
 * Macros are close estimates for a standard street portion — "~", never lab-exact. Logging a
 * kota still goes to the SA food database (842 foods); THIS is the "what should I get" guide.
 */

import type { FoodConstraints } from "./food-swaps";

export interface StreetDish {
  name: string;
  aliases: string[];
  kcal: number;      // typical street portion
  protein: number;
  verdict: "win" | "ok" | "careful"; // how it sits for a goal, before the smart move
  // The smart move, written as coach talk. {cut} shown to fat-loss/recomp, {bulk} to muscle-gain.
  smartCut: string;
  smartBulk: string;
}

export const STREET_FOODS: StreetDish[] = [
  { name: "Kota / Spatlho", aliases: ["kota", "spatlho", "sphatlho", "bunny (kota)", "quarter loaf"],
    kcal: 1100, protein: 25, verdict: "careful",
    smartCut: "The chips inside are the calorie bomb, not the bread. Ask for *less chips, extra russian or a fried egg* — that swaps empty carbs for protein. Atchar is fine (it's veg). Eat half now, half later and you've halved it without missing out.",
    smartBulk: "Great cheap post-training fuel — get the *egg AND russian/vienna* in it for protein, keep the chips, skip drowning it in extra cheese and mayo. This one actually works for building on a budget." },
  { name: "Chicken livers", aliases: ["chicken liver", "chicken livers", "peri livers", "peri-peri livers", "livers"],
    kcal: 300, protein: 30, verdict: "win",
    smartCut: "One of the best things you can buy on the street — huge protein, iron, cheap. Ask for it *less oily/buttery*, pair with pap or one slice of bread. This is a proper win.",
    smartBulk: "Cheap, high-protein, iron-rich — a serious win. Have it with pap and bread for the carbs to build on. Get a double portion of livers if you can." },
  { name: "Shisa nyama plate", aliases: ["shisa nyama", "shisanyama", "chesa nyama", "braai plate", "braai meat", "grilled meat"],
    kcal: 700, protein: 45, verdict: "win",
    smartCut: "Honestly one of the best street options — it's grilled protein. Go for the *leaner cuts (chicken, lean beef)* over fatty wors and chops, load the *chakalaka and salad*, and keep the pap to about one fist. Sorted.",
    smartBulk: "Perfect building food — grilled meat and pap. Take a bigger pap portion here, mix chicken and beef, chakalaka on top. Enjoy the wors too, just not only the fatty cuts." },
  { name: "Bunny chow", aliases: ["bunny chow", "bunny", "quarter bunny", "half bunny"],
    kcal: 850, protein: 28, verdict: "ok",
    smartCut: "Go *bean or chicken* bunny over mutton — leaner. Eat the curry and some of the bread, but you don't have to finish the whole loaf — that bread is most of the calories.",
    smartBulk: "Mutton or chicken bunny is solid fuel — eat the whole thing on a training day. The curry protein plus the bread carbs is a real meal." },
  { name: "Vetkoek & mince", aliases: ["vetkoek", "amagwinya", "magwinya", "fat cake", "fatcake", "fat cakes", "vetkoek and mince", "vetkoek mince"],
    kcal: 450, protein: 14, verdict: "careful",
    smartCut: "The mince is good protein — it's the *fried dough* that adds up. Have *one, not two*, and load the mince over the bread. If it's plain amagwinya, add a protein (egg or russian) so it's not just fried carbs.",
    smartBulk: "Fine cheap fuel around training — the curried mince brings the protein. Two vetkoek plus mince is a real meal on a hard day; just don't make plain fatcakes an everyday breakfast." },
  { name: "Gatsby", aliases: ["gatsby", "gatsbys"],
    kcal: 1500, protein: 40, verdict: "careful",
    smartCut: "A full gatsby is built to *share* — get a *quarter or half*, choose the *steak or chicken* filling over polony/fried, and ask for less chips. Split it with someone and you're fine.",
    smartBulk: "A half-gatsby (steak or chicken) is a big honest meal on a training day. Full one is a lot even for building — box the rest for later rather than forcing it all down." },
  { name: "Boerewors roll", aliases: ["boerewors roll", "wors roll", "boerie roll", "boerie"],
    kcal: 500, protein: 20, verdict: "ok",
    smartCut: "Wors is fatty but it's real protein. *One roll, not two*, pile on the *onion and tomato relish* (that's your veg), skip the extra sauce. Grand as an occasional one.",
    smartBulk: "Solid quick protein and carbs — have two on a big day. Add the relish and you've even got some veg in there." },
  { name: "Russian & chips", aliases: ["russian and chips", "russian & chips", "russian", "vienna and chips", "vienna", "russian chips"],
    kcal: 800, protein: 18, verdict: "careful",
    smartCut: "The *chips* are the problem here, not the sausage. Ask for a *smaller chips* (or share them), and drink *water, not a fizzy* — that alone saves a couple hundred calories. The russian is processed but it's protein.",
    smartBulk: "Fine quick fuel around training — the sausage and chips give you protein and carbs. Add an egg or a second russian for more protein and you've got a proper builder's meal." },
  { name: "Walkie / smiley / offal", aliases: ["walkie", "walkies", "runaways", "chicken feet", "smiley", "sheep head", "skopo", "mogodu", "tripe", "mala mogodu"],
    kcal: 350, protein: 28, verdict: "win",
    smartCut: "Traditional, cheap, and high protein — no shame here, it's real food. Watch the *fattier ones* (skopo, mogodu can be rich), keep the portion to a fist or two, pair with a little pap. Good iron and collagen.",
    smartBulk: "Cheap high-protein traditional food — great for building on a budget. Have it with a decent pap portion for the carbs to grow on." },
  { name: "Grilled street chicken", aliases: ["grilled chicken", "braai chicken", "street chicken", "quarter chicken", "half chicken", "chicken and pap", "chicken pap"],
    kcal: 550, protein: 40, verdict: "win",
    smartCut: "Grilled beats fried every time — go for it. *Pull the skin off* to drop the fat, keep pap to one fist, add chakalaka or salad. Clean, cheap, high protein.",
    smartBulk: "Great builder — grilled chicken and pap is a classic muscle meal. Keep the skin for the extra calories on a training day, bigger pap portion, chakalaka on top." },
];

/** Trigger words that mean "I'm eating informally / on the street", for the discovery guide. */
const STREET_CONTEXT = /\b(taxi rank|taxirank|rank|spaza|street|on the corner|by the station|vendor|hawker|shisa ?nyama|chesa nyama|tavern|shebeen|kasi|ekasi|township|informal|guys? on the street|lady on the corner|on the road)\b/i;

export function matchStreetDish(m: string): StreetDish | null {
  const lower = m.toLowerCase();
  for (const d of STREET_FOODS) {
    if (d.aliases.some((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower))) return d;
  }
  return null;
}

export function isStreetContext(m: string): boolean {
  return STREET_CONTEXT.test(m || "");
}

/** Goal-aware smart-order coaching for one street dish — short and human, no data dump. */
export function formatStreetDish(d: StreetDish, goal: string, c?: FoodConstraints): string {
  // A dish they cannot eat is not "order it smart" — it is the wrong dish (Cut 9). Said plainly
  // and once, then we point at what they CAN have rather than leaving them with nothing.
  if (c && !c.allows(`${d.name} ${d.aliases.join(" ")} ${d.smartCut}`)) {
    return `*${d.name}* — not one for you.\n\nThat one runs into ${c.terms.join(" / ")}, and you told me that. Tell me what else is on the counter and I'll pick the plate.`;
  }
  const bulking = goal === "muscle_gain";
  const move = bulking ? d.smartBulk : d.smartCut;
  const tag = d.verdict === "win" ? "💪 Good choice" : d.verdict === "ok" ? "👍 Workable" : "⚠️ Doable — order it smart";
  return `*${d.name}* — ${tag}\n\n${move}\n\n_Roughly ~${d.kcal} kcal · ~${d.protein}g protein for a normal portion. Snap a photo when you get it and I'll log it properly._`;
}

/** "What should I get at the taxi rank / on the street" — recommend the wins, flag the bombs. */
export function streetGuide(goal: string, c?: FoodConstraints): string {
  const bulking = goal === "muscle_gain";
  // THE BEST-BUYS LIST IS A RECOMMENDATION, so it is filtered rather than printed whole. Four
  // meat lines to a vegetarian is the pamphlet problem: correct in general, useless to them.
  const bestBuys = [
    "• Chicken livers — top pick, huge protein",
    "• Shisa nyama plate — grilled meat + pap + chakalaka",
    "• Grilled chicken and pap (pull the skin for fat loss)",
    "• Walkie / offal — traditional, cheap, high protein",
    "• Beans, chakalaka and pap — cheap, filling, real protein",
    "• Roasted mielies — the honest street carb",
  ].filter(l => !c || c.allows(l));
  return `Eating on the street — no problem, let's do it smart. 💪\n\n`
    + `*Best buys* (cheap, high protein):\n`
    + `${bestBuys.slice(0, 4).join("\n")}\n\n`
    + `*Order these smart:*\n`
    // FILTERED TOO (Cut 9). Leaving this block whole would have handed a vegetarian "vetkoek &
    // mince" two lines under a best-buys list we had just carefully cleaned for them — the
    // constraint has to hold across the WHOLE message or it reads as the coach forgetting
    // mid-sentence, which is worse than never knowing.
    + `${[
      `• Kota — ${bulking ? "get the egg + russian in it, great cheap fuel" : "less chips, add an egg, eat half now half later"}`,
      `• Vetkoek & mince — ${bulking ? "fine around training, mince is the protein" : "one not two, load the mince not the bread"}`,
      `• Gatsby — share it, pick steak/chicken over polony`,
    ].filter(l => !c || c.allows(l)).join("\n") || "• Tell me what's on the counter and I'll call it"}\n\n`
    + `The only real rule: *get some protein in every plate*, and don't let chips be the whole meal. Tell me what you're getting and I'll coach the exact order.`;
}
