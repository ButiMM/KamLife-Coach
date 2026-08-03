/**
 * CARD POLICY — who owns the next move, the card or the text.
 *
 * (2026-07-28, founder, looking at one real meal log: "what the hell is going on here?")
 *
 * He was right to ask. A single log told him to eat one more protein meal FIVE TIMES:
 *
 *   text head       "still room for one solid meal today"
 *   text assessment "On target. Finish it: one protein meal left."
 *   text nudge      "Good protein hit. 36g more to go today."
 *   card next move  "Eat more today — add a proper meal"
 *   card footer     "36g protein to go — a proper protein meal closes it."
 *
 * Five components, none of which knows the other four exist. Each is individually reasonable.
 * Together they are a coach repeating itself at someone who is tired and just wants to know
 * whether they're fine — the precise opposite of "it should feel easy". It is also where the
 * "Good protein hit" / "36g more to go" contradiction comes from: two components describing the
 * same protein number, one looking at what was eaten and one at what's left.
 *
 * THE RULE: exactly one surface gives the day's instruction, and when a card is coming, the card
 * is that surface. The text confirms the log and stops. This module owns that decision so it
 * cannot be re-litigated in five places — which is how it got to five places.
 *
 * Pure — no DB, no model. Unit-tested.
 */

import { getGoalProfile } from "./goal-profiles";

/** Below this a card is not rendered at all — a full macro card for a black coffee. */
export const CARD_MIN_KCAL = 50;

/**
 * Will a card be attached to this log? Must agree with macroCardMarker exactly — if these two
 * ever disagree, the text suppresses its instruction and no card arrives to replace it, which
 * leaves the client with no guidance at all. Both read this function; neither re-implements it.
 */
export function cardWillAttach(user: any, mealKcal: number, hasBaseUrl: boolean): boolean {
  if (!hasBaseUrl) return false;
  if (!((mealKcal || 0) >= CARD_MIN_KCAL)) return false;
  if (!getGoalProfile(user?.goalType).usesMacros) return false;   // wellness → no card, ever
  return Number(user?.calorieTarget) > 0 && Number(user?.proteinTarget) > 0;
}

// THE DUMP WINDOW (2026-08-03, founder: "they don't send it when they're eating, they send it
// when it's convenient — long voice notes, or bundles of photos of things they ate yesterday").
//
// The product assumed a client logs one meal at a time, as they eat it. They do not. They dump
// the whole day at 9pm: six photos in ninety seconds. Each one was a separate log, so each one
// rendered its own full macro card — six near-identical pictures of the same day's totals,
// arriving in a row. That is a receipt printer, not a coach.
//
// One dump, one card: the FIRST log in a window gets the picture, the rest are logged silently
// and roll into the same day's numbers. Nothing is lost — every meal still counts, the card the
// client does see is simply the most complete one. In-memory and short-lived on purpose; a
// restart at worst costs one extra card, never a log.
const _lastCard = new Map<string, number>();
export const DUMP_WINDOW_MS = 4 * 60_000;

export function noteCardSent(userId: string, at = Date.now()): void {
  if (!userId) return;
  _lastCard.set(userId, at);
  if (_lastCard.size > 5000) _lastCard.clear();
}

/** True → a card went to this client moments ago; this log is part of the same dump. */
export function cardSuppressedByDump(userId: string, at = Date.now()): boolean {
  const last = _lastCard.get(userId);
  return last !== undefined && at - last < DUMP_WINDOW_MS;
}

/** Test/ops hook — clear the dump memory. */
export function _resetDumpWindow(): void { _lastCard.clear(); }
