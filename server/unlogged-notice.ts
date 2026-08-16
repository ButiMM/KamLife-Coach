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
 * IS THIS CLAUSE ABOUT THEIR BODY OR THEIR DAY, RATHER THAN THEIR PLATE? (2026-08-16.)
 *
 * The sibling carriesFeelingClause could not answer for the sentence that actually shipped:
 * "2 eggs and pap for breakfast, chicken and rice for lunch, my back is sore and I didn't
 * sleep." Nothing in that names a feeling in the words the feeling test knows, so the food
 * dump's leftover vocabulary — back, sore, sleep — was audited as unpriced FOOD and the client
 * was asked whether it was fried or grilled. It is also, separately, the half of the message
 * that matters most to them.
 *
 * Same doctrine as its sibling, and the same deliberate narrowness: it gates the two places
 * that would otherwise try to PRICE the client's body, and it decides nothing about routing,
 * logging, or who answers. A clause is only dropped when it is positively recognised as body
 * or life talk — everything unrecognised is kept, so the failure direction is today's
 * behaviour rather than a lost meal.
 */
export function aboutTheirBodyNotThePlate(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (carriesFeelingClause(t)) return true;
  return /\b(sore|stiff|aching|aches?|pains?|painful|cramp\w*|headache|nausea|nauseous|dizzy|exhausted|shattered|tired|flu|fever|period|slept|sleeping|insomnia|stressed|anxious|overtime|deadline|shift|missed (?:the )?(?:gym|session|workout|training)|skipped (?:the )?(?:gym|session|workout|training)|didn'?t sleep|couldn'?t sleep|no sleep)\b/.test(t);
}

/**
 * THE HALF OF THE MESSAGE THAT IS ABOUT FOOD. One owner, because two callers price text and
 * both were pricing the client's back.
 *
 * `keep` is the caller's veto — it is handed each flagged clause and returns true when the
 * clause really does carry food ("I was so tired I ate a whole pizza"). Without a veto nothing
 * that names food can be lost, because the caller who knows how to recognise food is the one
 * who supplies it: the notice checks what it logged, the scanner path asks the scanner.
 */
export function plateClausesOnly(message: string, keep: (clause: string) => boolean = () => false): string {
  const clauses = String(message || "").split(/(?<=[.!?;\n])|,\s+|\s+\band then\b\s+|\s+\bbut\b\s+/i);
  const kept = clauses.filter(c => !aboutTheirBodyNotThePlate(c) || keep(c.toLowerCase()));
  const text = kept.join(" ").replace(/\s+/g, " ").trim();
  return text || String(message || "");
}

export function unloggedFoodWords(message: string, loggedNames: string[]): string[] {
  const logged = loggedNames.join(" ").toLowerCase();
  const words = (message || "").toLowerCase()
    .replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 3 && !NOISE.has(w));
  const dropped = words.filter(w => !logged.includes(w.slice(0, Math.max(4, w.length - 1))));
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

export function clarifyFoodAsk(words: string[]): string {
  const list = words.join(", ");
  return `⚠️ I could not price *${list}* — not in the total yet.\n\nRoughly how much was it, and was it fried or grilled? Tell me and I'll add it properly.`;
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
  // The same trade as the feeling gate above, applied clause by clause: the body-and-day half
  // of a food dump is not audited for missing calories. A clause that carries something we DID
  // log is kept, so "so tired I ate a whole pizza" is still read for its pizza.
  const plate = plateClausesOnly(lo, c => loggedNames.some(n => n && c.includes(n.toLowerCase())));
  const words = unloggedFoodWords(plate, loggedNames);
  if (words.length < 2) return "";               // one stray word is usually not a food
  return ask
    ? clarifyFoodAsk(words)
    : `⚠️ I could not price *${words.join(", ")}* — that part is NOT in the total. Tell me roughly what it was and I'll add it.`;
}
