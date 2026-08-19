import { parseMessyIntake } from "./understanding/messy-intake";
/**
 * UNLOGGED NOTICE — never silently drop food the client named. Pure, unit-tested.
 *
 * (2026-07-27 live) "Had South African breakfast from macdonalds. But I had extra 2 patties
 * and extra 2 eggs with it" → the coach logged ONLY the eggs and patties (479 kcal) and
 * dropped the McDonald's breakfast itself without a word. The client spent twelve messages
 * trying to find out whether it had been logged.
 *
 * A branded/restaurant meal the scanner can't price must be SAID OUT LOUD, not swallowed.
 * The rule: if the message names a place we know and nothing from that place got logged,
 * tell the client plainly and ask for the one detail that would fix it.
 */

// Places whose meals are real food but rarely resolve to a table item on their own.
const PLACES: Array<{ re: RegExp; name: string; stem: string }> = [
  // Prefix-matched (no trailing \b) so plurals and SA spellings land: mcdonalds, macdonalds.
  { re: /\bma?c\s?donald/i, name: "McDonald's", stem: "donald" },
  { re: /\bmaccas\b/i, name: "McDonald's", stem: "donald" },
  { re: /\bkfc\b/i, name: "KFC", stem: "kfc" },
  { re: /\bnando/i, name: "Nando's", stem: "nando" },
  { re: /\bsteers\b/i, name: "Steers", stem: "steers" },
  { re: /\bwimpy\b/i, name: "Wimpy", stem: "wimpy" },
  { re: /\bdebonair/i, name: "Debonairs", stem: "debonair" },
  { re: /\bchicken licken\b/i, name: "Chicken Licken", stem: "licken" },
  { re: /\bocean basket\b/i, name: "Ocean Basket", stem: "basket" },
  { re: /\bspur\b/i, name: "Spur", stem: "spur" },
  { re: /\broman'?s? pizza\b/i, name: "Roman's Pizza", stem: "roman" },
  { re: /\bburger king\b/i, name: "Burger King", stem: "burger king" },
  { re: /\bgal+itos\b/i, name: "Galito's", stem: "alito" },
  { re: /\bkauai\b/i, name: "Kauai", stem: "kauai" },
  { re: /\bfishaway/i, name: "Fishaways", stem: "fishaway" },
];

/**
 * A short line naming what was NOT logged, or "" when nothing needs saying.
 * `loggedNames` are the items that DID get logged (their names as shown to the client).
 */
export function unloggedPlaceNotice(message: string, loggedNames: string[]): string {
  const lo = (message || "").toLowerCase();
  const place = PLACES.find(p => p.re.test(lo));
  if (!place) return "";
  // If something logged already references the place, it WAS captured — say nothing.
  const logged = loggedNames.join(" ").toLowerCase();
  if (logged.includes(place.stem)) return "";
  return `⚠️ I could not price the *${place.name}* item itself, so it is NOT in the total above. Tell me what it was (e.g. "big breakfast" or "burger and chips") and I'll add it.`;
}

/**
 * GENERAL never-drop check: substantive words the client wrote that made it into NOTHING we
 * logged. Restaurants are handled above; this is everything else — a food the table doesn't
 * know and the supplement couldn't price. Returns the words, or [] when nothing was dropped.
 */
const NOISE = new Set([
  "i","me","my","had","ate","have","having","eating","was","were","is","are","for","at","in","on",
  "to","and","or","with","some","a","an","the","of","also","just","plus","about","around","only",
  "too","today","yesterday","this","that","it","its","them","then","after","before","very","really",
  "all","mixed","cooked","raw","grilled","fried","boiled","steamed","baked","roasted","hot","cold",
  "fresh","leftover","homemade","breakfast","lunch","dinner","supper","snack","meal","morning",
  "evening","afternoon","night","brunch","big","large","small","little","extra","full","half",
  "whole","double","piece","pieces","slice","slices","cup","cups","bowl","plate","portion","serving",
  "gram","grams","from","but","then","more","made","make","got","get","went","there","here","been",
  // Geography / brand residue — "South African breakfast from McDonald's" is NOT four unpriced foods
  // (live 2026-08-19: "could not price south, african"). Movement words are steps, not meals.
  "south","southern","african","africa","american","style",
  "mcdonald","mcdonalds","macdonald","macdonalds","maccas",
  "mocha","coffee","shop","latte","cappuccino",
  "walked","walking","steps","step","thousand","hundred","three","four","five",
  "so","this","morning","afternoon",
]);
/**
 * Is the client telling us how they FEEL, not just what they ate? (2026-08-04, Slice 2.)
 *
 * One owner for one question, because it is asked from two places that both got it wrong in
 * the same way: the unpriced-food notice read "last, feel, like, ruined" as four menu items,
 * and the food clarifier answered "work is stressing me out and I ate takeaways" with "can you
 * describe it as something like chicken breast and rice". Two lists would drift apart within a
 * week; this one is the shared answer.
 *
 * It is deliberately narrow. It gates the two places that ANSWER A FEELING WITH AN AUDIT —
 * it does not decide whether to log, and it never suppresses a reply.
 */
export function carriesFeelingClause(text: string): boolean {
  return /\b(i feel|i'm feeling|im feeling|i felt|feel like|feeling like|i think i|ruined|failed|guilty|ashamed|disappointed|gave up|giving up|fell off|messed up|stressing me|so stressed|really stressed|depressed|anxious|can'?t cope)\b/i.test(text || "");
}

/**
 * Does this message REPORT hunger, right now? Sibling of carriesFeelingClause above: both answer
 * "what state is the client telling us they are in", and both are read by callers that must not
 * route on it. Added 2026-08-12 for symptom persistence — "I'm hungry" and "I've been hungry
 * every afternoon for six days" are different states, and the second cannot exist until the
 * occurrences are recorded.
 *
 * Deliberately NARROW. Not a past explanation ("I ate it because I was hungry"), not advice
 * about hunger, not a question about it. Over-capturing would manufacture the very persistence
 * the doctrine is meant to detect, which would be worse than not detecting it at all.
 */
export function reportsHunger(text: string): boolean {
  const t = String(text || "").toLowerCase();
  if (/\b(was|were|had been)\s+(so\s+|really\s+)?hungry\b/.test(t)) return false;
  if (/\bhow (do|can) i\b/.test(t)) return false; // asking how to stop being hungry — the coach answers
  return /\b(i(?:'| a)?m|i am|im|feeling|still|always|constantly)\s+(so\s+|really\s+|very\s+|permanently\s+)?(hungry|starving|ravenous)\b/.test(t)
    || /\b(always|constantly|so)\s+hungry\b/.test(t)
    || /\bcan'?t\s+(stop\s+eating|control\s+(my\s+)?(cravings|hunger))\b/.test(t)
    || /\bcravings?\s+(are|is)\s+(bad|out of control|killing me)\b/.test(t);
}

/**
 * Are they asking why the weight is not moving? The one question the deficit evidence exists to
 * answer honestly. Deliberately narrow: this gates a weekly aggregate plus a weigh-in read, so it
 * must not fire on every mention of the word "weight" ("my weight training", "weight of the bar").
 * It lives here beside `reportsHunger` because that is where the message detectors this system
 * counts already live — a second home for the same kind of predicate is how they drift.
 */
export function asksAboutWeightProgress(text: string): boolean {
  const t = String(text || "").toLowerCase();
  if (/\bweight (training|session|room|bar|belt|vest|plates?)\b/.test(t)) return false;
  return /\b(not|isn'?t|ain'?t|haven'?t|hasn'?t|won'?t|nothing)\b[^.!?]{0,40}\b(losing|lost|moving|moved|dropping|budging|shifting|going down)\b/.test(t)
    || /\b(why|how come)\b[^.!?]{0,50}\b(no|not|still|stuck|plateau|same weight)\b/.test(t)
    || /\b(stuck|plateau(ed|ing)?|stalled)\b/.test(t)
    || /\bscale (hasn'?t|has not|isn'?t|is not|won'?t)\b/.test(t)
    || /\b(am i|are we) (actually )?(losing|in a deficit)\b/.test(t);
}

/**
 * WORDS THAT BELONG TO ANOTHER FACT ARE NOT UNPRICED FOOD (Cut 1).
 *
 * The NOISE list above has been growing one screenshot at a time — "south", "african", "walked",
 * "thousand", "three", "four", "five" were each added after a client was asked to price them.
 * That list can never finish, because the real question is not "is this word food-ish" but "did
 * something else in this note already claim it".
 *
 * Now that one turn commits every event, the note reaching the scanner is the WHOLE note, so
 * "eight thousand steps" and "I'm exhausted" and "I trained chest" arrive intact. The parser
 * already attributed those spans to steps, feeling and workout. Anything it claimed is removed
 * here rather than appended to a stopword list that grows forever.
 */
function spansClaimedByOtherFacts(message: string): string {
  const r = parseMessyIntake(message);
  const claimed = r.intents
    .filter(i => i.kind === "steps_report" || i.kind === "feeling")
    .map(i => i.text);
  // A reported session is a fact too, but it has no intent span — take the clause it sits in.
  if (r.hasWorkoutReport) {
    for (const clause of String(message).split(/[.!?,]|\band\b/i)) {
      if (/\b(trained|training|worked\s+out|workout|session|gym|benched|squatted|deadlifted|chest|back|legs?|arms?|push|pull)\b/i.test(clause)) {
        claimed.push(clause);
      }
    }
  }
  return claimed.join(" ").toLowerCase();
}

/** Is this leftover word already on the log under another form (potatoes/potato, veggies/veg)? */
function coveredByLogged(word: string, logged: string): boolean {
  const w = (word || "").toLowerCase();
  if (!w) return true;
  if (logged.includes(w)) return true;
  const stem = w.endsWith("oes") && w.length > 5 ? w.slice(0, -2)           // potatoes → potato
    : w.endsWith("ies") && w.length > 5 ? w.slice(0, -3)                    // veggies → vegg
    : w.endsWith("es") && w.length > 4 ? w.slice(0, -2)
    : w.endsWith("s") && w.length > 4 ? w.slice(0, -1)
    : w;
  if (stem.length >= 4 && logged.includes(stem)) return true;
  if (stem.length >= 3 && logged.includes(stem)) return true;
  // Mixed veggies logged as "Mixed" / "Roast potato" — the leftover is the same plate.
  if (/^vegg/.test(w) && /\b(veg|mixed)\b/.test(logged)) return true;
  if (w === "roast" && /roast/.test(logged)) return true;
  return false;
}

export function unloggedFoodWords(message: string, loggedNames: string[]): string[] {
  const logged = loggedNames.join(" ").toLowerCase();
  const otherFacts = spansClaimedByOtherFacts(message);
  const words = (message || "").toLowerCase()
    .replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 3 && !NOISE.has(w) && !otherFacts.includes(w));
  const dropped = words.filter(w => !coveredByLogged(w, logged));
  return [...new Set(dropped)].slice(0, 4);
}

/**
 * CLARIFY, DON'T JUST CONFESS (2026-07-28, third-party review). Naming what we could not price
 * was already correct — silence would be worse. But it dead-ends: the client is told something
 * is missing and left to work out the fix. Asking instead turns a coverage gap into a coaching
 * moment, gets the meal logged, and hands us the exact words real people use — which is the only
 * honest way to grow the food table. "Do not let perfect coverage block the cohort. Let perfect
 * handling of uncertainty block it."
 *
 * The question is deliberately answerable with one word.
 */
export function clarifyPlaceAsk(placeName: string): string {
  return `⚠️ I could not price the *${placeName}* item, so it's not in the total yet.\n\nWhat was it — the breakfast, a burger, chicken and chips? One or two words and I'll add it.`;
}

export function clarifyFoodAsk(words: string[], opts?: { branded?: boolean }): string {
  const list = words.join(", ");
  // TWO DIFFERENT LEFTOVERS, TWO DIFFERENT QUESTIONS.
  //
  // Branded/takeaway residue must not get a kitchen question — live 2026-08-19, a McDonald's
  // breakfast was already logged and the coach still asked "fried or grilled?". The fix removed
  // the kitchen question for EVERY leftover, which broke the case it exists for: "bunny chow and
  // skopo" are real foods the table cannot price, and the only two things that change their
  // number are how much and how it was cooked. One live screenshot, applied globally, silently
  // took the useful question away from every genuine unknown.
  const ask = opts?.branded
    ? `What was that item, in a few words (e.g. "big breakfast" or "2 eggs and toast")? I'll add it.`
    : `Two things and I'll add it: how much, and was it fried or grilled?`;
  return `⚠️ I could not price *${list}* — not in the total yet.\n\n${ask}`;
}

/**
 * One honest line naming what we could not log, or "" when everything landed.
 * `ask` (default) turns the confession into a question the client can answer in one word.
 */
export function unloggedFoodNotice(message: string, loggedNames: string[], ask = true): string {
  const lo = (message || "").toLowerCase();
  // A FEELING IS NOT AN UNPRICED FOOD (2026-08-04, caught by the gauntlet).
  //
  // "I had a burger and chips last night, I feel like I ruined everything" came back with
  // "⚠️ I could not price *last, feel, like, ruined*". The burger and the chips both priced
  // fine. Those four "foods" are the sentence in which he told us he felt he had ruined
  // everything — read as menu items, and answered with "was it fried or grilled?".
  //
  // The mechanism is unloggedFoodWords: every leftover word over three letters that is not in
  // NOISE is assumed to be a food. NOISE cannot be completed — that is an infinite list of
  // English, and extending it word by word is the whack-a-mole this codebase has a guard
  // against. So the gate is on the CLAUSE instead: when someone is telling us how they feel,
  // we do not audit their vocabulary for missing calories. A genuinely unpriced food in an
  // emotional message is now silently uncounted, and that is the right trade — a slightly
  // low total costs them nothing, and being asked to itemise their shame costs us the client.
  if (carriesFeelingClause(lo)) return "";
  const place = PLACES.find(p => p.re.test(lo));
  const loggedJoined = loggedNames.join(" ").toLowerCase();
  if (place && !loggedJoined.includes(place.stem)) {
    return ask ? clarifyPlaceAsk(place.name) : unloggedPlaceNotice(message, loggedNames);
  }
  // Place meal already on the log — do not audit leftover geography words as missing food.
  if (place && loggedJoined.includes(place.stem)) {
    return "";
  }
  const words = unloggedFoodWords(message, loggedNames);
  if (words.length < 2) return "";               // one stray word is usually not a food
  return ask
    ? clarifyFoodAsk(words, { branded: !!place })
    : `⚠️ I could not price *${words.join(", ")}* — that part is NOT in the total. Tell me roughly what it was and I'll add it.`;
}
