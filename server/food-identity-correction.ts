/**
 * IDENTITY CORRECTION — "the rice was white not brown".
 *
 * (2026-07-27 live, and the hole was still open hours after the rename bug was fixed.) The
 * product could correct a QUANTITY ("2 eggs not 3") and could remove an ingredient ("no
 * butter"), but had no way to say "you logged the wrong FOOD". That message reached the
 * meaning engine, which read it as a deletion and tried to remove the meal; the destructive
 * bouncer vetoed the delete and replied "nothing removed" — an answer to a question nobody
 * asked, on top of a correction that never landed.
 *
 * Three shapes, all common in speech:
 *   "the rice was white not brown"      subject + right + wrong
 *   "it was tuna not pilchards"          right + wrong
 *   "that's white rice not brown rice"   right + wrong, both fully qualified
 *
 * Pure — no DB, no model. The caller resolves the foods and rewrites the log. Unit-tested.
 */

export interface IdentityCorrection {
  /** What they actually ate ("white", "tuna", "white rice"). */
  right: string;
  /** What the coach logged instead ("brown", "pilchards", "brown rice"). */
  wrong: string;
  /** The food being qualified, when they named it ("rice"). Empty when they didn't. */
  subject: string;
}

// Three explicit frames. Deliberately NOT a bare "A not B" — that shape matches ordinary
// sentences ("I did not train") and the cost of a false positive here is rewriting someone's
// food log, so the correction must be framed as one.
const WITH_SUBJECT = /\bthe\s+([\w-]+(?:\s+[\w-]+)?)\s+(?:was|were|is|are)\s+([\w][\w\s-]{0,20}?)\s*,?\s*\bnot\b\s+([\w][\w\s-]{0,20}?)\s*(?:$|[,.!?])/i;
const NO_SUBJECT = /\b(?:it|that|this|they|those)\s*(?:'?s|was|were|is|are)\s+([\w][\w\s-]{0,20}?)\s*,?\s*\bnot\b\s+([\w][\w\s-]{0,20}?)\s*(?:$|[,.!?])/i;
// The reversed order people also use: "not brown, it was white".
const REVERSED = /\bnot\s+([\w][\w\s-]{0,20}?)\s*(?:,|\.)\s*(?:it\s+(?:was|is)|it'?s|that\s+was)\s+([\w][\w\s-]{0,20}?)\s*(?:$|[,.!?])/i;

// Words that mean the sentence isn't a food substitution at all.
const NOT_A_SWAP = /\bnot\s+(?:sure|really|going|yet|today|hungry|feeling|well|good|bad|much|many|able|allowed|logged|counted|eating|that)\b|\bwhy not\b|\bnot\s+\d/i;

// Neither half of a food swap is ever a verb or a feeling — this is what keeps "I did not
// train, it was hard" and "it was fine not great" out of the log-rewriting path.
// ("full" is deliberately absent — "full cream milk" is a real food, and the "I'm full"
// reading is already caught by NOT_A_SWAP and the fullness handler in food-commands.)
const NOT_A_FOOD = /^(?:i|we|you|he|she|they|train|trained|training|eat|ate|eating|go|going|went|do|did|doing|work|worked|feel|felt|know|think|want|need|sure|fine|ok|okay|good|great|bad|hard|easy|better|worse|right|wrong|done|ready|late|early|hungry|sick|tired)\b/i;

const STRIP = /^(?:a|an|the|some|my|it|that|this)\s+/i;

function clean(s: string): string {
  return (s || "").trim().toLowerCase().replace(STRIP, "").replace(/\s+/g, " ").trim();
}

/**
 * Read "X not Y" as a correction of what was logged. Returns null when the sentence isn't
 * one — "I'm not sure", "not today", "I did not train" and quantity corrections all fall through.
 */
export function parseIdentityCorrection(message: string): IdentityCorrection | null {
  const s = (message || "").trim();
  if (!s || !/\bnot\b/i.test(s)) return null;
  if (NOT_A_SWAP.test(s)) return null;

  const ws = WITH_SUBJECT.exec(s);
  if (ws) {
    const subject = clean(ws[1]), right = clean(ws[2]), wrong = clean(ws[3]);
    return valid(right, wrong) ? { right, wrong, subject } : null;
  }

  const ns = NO_SUBJECT.exec(s);
  if (ns) {
    const right = clean(ns[1]), wrong = clean(ns[2]);
    return valid(right, wrong) ? { right, wrong, subject: "" } : null;
  }

  const rev = REVERSED.exec(s);
  if (rev) {
    const wrong = clean(rev[1]), right = clean(rev[2]);
    return valid(right, wrong) ? { right, wrong, subject: "" } : null;
  }

  return null;
}

function valid(right: string, wrong: string): boolean {
  if (!right || !wrong || right === wrong) return false;
  // A pure number on either side is a QUANTITY correction — parseQuantityCorrection owns those.
  if (/^\d+(\.\d+)?$/.test(right) || /^\d+(\.\d+)?$/.test(wrong)) return false;
  if (NOT_A_FOOD.test(right) || NOT_A_FOOD.test(wrong)) return false;
  if (right.split(" ").length > 4 || wrong.split(" ").length > 4) return false;
  return true;
}

/**
 * The food names to search for, most specific first. "the rice was white not brown" should
 * look for "white rice" before bare "white" (which is not a food at all).
 */
export function correctionCandidates(c: IdentityCorrection): { rightNames: string[]; wrongNames: string[] } {
  const withSubject = (w: string) => (c.subject && !w.includes(c.subject) ? [`${w} ${c.subject}`, w] : [w]);
  return { rightNames: withSubject(c.right), wrongNames: withSubject(c.wrong) };
}

/**
 * IS THIS NEW LOG AN AMENDMENT OF THAT OLDER ONE? (2026-08-06, live on the founder's phone.)
 *
 * His day showed "Bread, Eggs, Fish fingers — ~948 kcal" AND "Bread, Eggs, Avocado, Coffee
 * (black), Fish fingers — ~1073 kcal": one breakfast counted twice, roughly 950 phantom
 * calories, because he added the avo and the coffee and the whole meal was re-logged with the
 * additions instead of the additions being added to it.
 *
 * The exact-match dedupe at the write door cannot see this — an amendment has a different
 * rawMessage AND a different kcal, which is the whole point of it. So the question that
 * actually separates "they added something" from "they ate again" is containment.
 *
 * Deliberately strict, in both directions:
 *   - every earlier item must appear in the new list, so two different meals never merge;
 *   - the new list must be strictly LARGER, so an identical repeat falls to the exact dedupe
 *     and a real second helping of the same thing is still counted twice, correctly.
 *
 * Substring matching both ways, because the same food arrives named differently by different
 * paths ("coffee" from the scanner, "Coffee (black)" from vision).
 *
 * Pure and here rather than in food-context so the rule is unit-testable on its own, next to
 * the other question about what a logged food actually IS.
 */
export function isMealAmendment(olderItems: string[], newerItems: string[]): boolean {
  const older = olderItems.map(s => s.toLowerCase().trim()).filter(Boolean);
  const newer = newerItems.map(s => s.toLowerCase().trim()).filter(Boolean);
  if (older.length === 0 || newer.length < 2) return false;
  if (older.length >= newer.length) return false;
  return older.every(o => newer.some(n => n.includes(o) || o.includes(n)));
}

/**
 * "ACTUALLY, THAT WAS YESTERDAY" — a correction of the DAY, not a new meal (2026-08-10, P0.1).
 *
 * That sentence had no owner anywhere in the product. It fell past every handler to the model,
 * which replied "Sorry Kam, I didn't quite catch that 🙂" with three buttons, and the meal stayed
 * on the wrong day — so every total and average built on it was silently wrong from then on.
 *
 * A MOVE, not a LOG: it points at an existing entry ("that", "it", "the last one") and names no
 * food. "I had rice yesterday" names a food and is a retroactive LOG, which already works, so
 * the caller also requires that no food is named before acting. It lives here, with the other
 * corrections, because the question it answers is "what shape of fix is this?" — parseMealDate
 * in utils.ts stays the single owner of "which day", and this asks the caller to consult it.
 */
const MOVE_FRAME = /\b(?:actually|no|sorry|oops|wait|correction)\b[,.!]?\s*(?:that|it|this|those)\s*(?:'s|s|was|were|is|are)\b|\bmove\s+(?:that|it|this|the\s+last\s+(?:one|meal|entry)|that\s+meal)\s+to\b|\b(?:that|it|this)\s+(?:was|were)\s+(?:actually\s+)?(?:on\s+)?(?=\w)/i;
export function isMealDateMove(message: string, namesAnotherDay: boolean): boolean {
  return namesAnotherDay && MOVE_FRAME.test(String(message || "").toLowerCase());
}

/**
 * NEVER DELETE ON A PROMISE (2026-08-07).
 *
 * Two correction branches could not compute the new numbers — a photo meal stores no per-item
 * macros, and some foods have no per-serving portion — so they deleted the row and asked the
 * client to send it again. That is a promise, and a promise is not a replacement. On the
 * founder's phone the row went at 11:51, the re-send never came, the day read zero by 11:55,
 * and the coach then told him he had logged nothing all day.
 *
 * So the row is HELD instead: it stays in the table, with its original numbers, until the
 * replacement is actually written. The hold is a pointer on the user — the same
 * awaitingInputType mechanism every other pending answer uses — carrying the row, when the
 * hold started, and WHICH FOOD is expected back.
 *
 * The expected food is what makes this safe. Without it, the next meal of the day would
 * overwrite the held row and lose the first meal a different way. A log that does not mention
 * the expected food is a different meal: it inserts normally and the hold is dropped.
 *
 * Fifteen minutes, then the hold is ignored. A correction the client walked away from must not
 * capture their supper.
 */
const HOLD = "meal_replace:";
const HOLD_WINDOW_MS = 15 * 60 * 1000;

/** The pointer to store on users.awaiting_input_type while a row waits for its replacement. */
export function holdForReplacement(rowId: string, expectFood: string): string {
  // A colon-delimited token, so it is built as one — a template string here reads like a
  // sentence to both a human and the authorship guard, and it is neither.
  return [HOLD + rowId, Date.now(), (expectFood || "").toLowerCase().slice(0, 40)].join(":");
}

/** PURE: read a hold pointer. Returns null when there isn't one, it has expired, or the new log
 *  does not mention the food the hold is waiting for. */
export function readHold(marker: string | null | undefined, newFoodText: string, now = Date.now()):
  { rowId: string; expectFood: string } | null {
  const s = String(marker || "");
  if (!s.startsWith(HOLD)) return null;
  const parts = s.slice(HOLD.length).split(":");
  const rowId = parts[0] || "";
  const at = Number(parts[1] || 0);
  const expectFood = (parts.slice(2).join(":") || "").trim();
  if (!rowId || !at || now - at > HOLD_WINDOW_MS) return null;
  const hay = (newFoodText || "").toLowerCase();
  const stem = expectFood.replace(/e?s$/, "");
  if (expectFood && !(hay.includes(expectFood) || (stem.length >= 3 && hay.includes(stem)))) return null;
  return { rowId, expectFood };
}

/**
 * The replacement has arrived: overwrite the held row and release the hold. Returns the row id
 * so the caller suppresses its insert exactly as it does for an amendment, or null to insert.
 *
 * Fail-open in one direction only. If anything here goes wrong the caller INSERTS, which
 * double-counts one meal — a wrong number. The alternative failure is deleting first and losing
 * the meal, which is the bug this exists to end.
 */
export async function replaceHeldMeal(
  userId: string,
  newFoodText: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  try {
    const { db } = await import("./db");
    const { mealLogs, users } = await import("../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    // The hold reads its own storage. A caller that had to fetch awaiting_input_type first knew
    // where a hold lives, which is this module's business and nobody else's.
    const [owner] = await db.select({ awaiting: users.awaitingInputType }).from(users)
      .where(eq(users.id, userId)).limit(1);
    const held = readHold(owner?.awaiting, newFoodText);
    if (!held) return null;
    const [row] = await db.select({ id: mealLogs.id, kcal: mealLogs.kcalInt }).from(mealLogs)
      .where(and(eq(mealLogs.id, held.rowId), eq(mealLogs.userId, userId))).limit(1);
    if (!row) return null;                                    // already gone — insert instead
    await db.update(mealLogs).set({ ...patch, corrected: true }).where(eq(mealLogs.id, row.id));
    await db.update(users).set({ awaitingInputType: null }).where(eq(users.id, userId));
    console.log(`[MEAL_HOLD] replaced held row ${String(row.id).slice(0, 8)} (${row.kcal || 0} kcal → ${patch.kcalInt}) `
      + `expected="${held.expectFood}" user=...${userId.slice(-6)}`);
    return String(row.id);
  } catch (e) {
    console.warn("[MEAL_HOLD] replace failed, caller will insert:", (e as any)?.message);
    return null;
  }
}

/**
 * Find a recent meal this log AMENDS and update it in place. Returns its id, or null when this
 * is genuinely a new meal and the caller should insert.
 *
 * The DB work lives beside the rule so the whole "is this the same meal again?" question has
 * one owner. The caller still owns cache invalidation, because it owns the caches.
 *
 * Fail-open: any error returns null and the caller inserts, which is the old behaviour. A
 * broken dedupe must never lose a client's meal.
 */
export async function amendRecentMeal(
  userId: string,
  newItemNames: string[],
  patch: Record<string, unknown>,
): Promise<string | null> {
  if (newItemNames.length < 2) return null;
  try {
    const { db } = await import("./db");
    const { mealLogs } = await import("../shared/schema");
    const { eq, and, gte, desc } = await import("drizzle-orm");
    // 30 minutes: long enough to remember an avocado, short enough that tonight's supper can
    // never absorb this morning's toast.
    const rows = await db.select({ id: mealLogs.id, items: mealLogs.items })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, new Date(Date.now() - 30 * 60 * 1000))))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(6);
    const namesOf = (raw: unknown): string[] => (Array.isArray(raw) ? raw : [])
      .map((i: any) => String(i?.name || i?.foodName || "")).filter(Boolean);
    const hit = rows.find(r => isMealAmendment(namesOf(r.items), newItemNames));
    if (!hit) return null;
    await db.update(mealLogs).set({ ...patch, corrected: true }).where(eq(mealLogs.id, hit.id));
    console.log(`[MEAL_LOG] AMENDED an existing entry instead of double-logging — user=...${userId.slice(-6)}`);
    return String(hit.id);
  } catch (e) {
    console.warn("[MEAL_AMEND] failed, caller will insert:", (e as any)?.message);
    return null;
  }
}
