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
export function unloggedFoodWords(message: string, loggedNames: string[]): string[] {
  const logged = loggedNames.join(" ").toLowerCase();
  const words = (message || "").toLowerCase()
    .replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 3 && !NOISE.has(w));
  const dropped = words.filter(w => !logged.includes(w.slice(0, Math.max(4, w.length - 1))));
  return [...new Set(dropped)].slice(0, 4);
}

/** One honest line naming what we could not log, or "" when everything landed. */
export function unloggedFoodNotice(message: string, loggedNames: string[]): string {
  const place = unloggedPlaceNotice(message, loggedNames);
  if (place) return place;                       // the specific case wins
  const words = unloggedFoodWords(message, loggedNames);
  if (words.length < 2) return "";               // one stray word is usually not a food
  return `⚠️ I could not price *${words.join(", ")}* — that part is NOT in the total. Tell me roughly what it was and I'll add it.`;
}
