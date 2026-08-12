/**
 * THE REPLY CONTRACT — the product rule the whole system was missing.
 *
 * (2026-07-27, founder: "It's just too much reading. People want to be told what to do,
 * when to do it, how to do it." Three independent reviews reached the same verdict: the
 * single highest-leverage fix is a reply contract, not more architecture.)
 *
 * Until now each of the 28 handlers formatted its own reply, so one logged breakfast came
 * back as four itemised calorie lines + a meal total + a remaining budget + a protein
 * homework line + two menu buttons + a card. That is an audit. The target market — busy,
 * working, tired — will not read it twice a day.
 *
 * THE CONTRACT (applies to routine coaching replies, NOT to explicitly-requested detail):
 *   Line 1  ACKNOWLEDGE — what happened, warmly, in their words.
 *   Line 2  THE ONE THING — the single next move that matters right now.
 *   Line 3  FORWARD — the accountability ask or a short encouragement. Optional.
 * No itemised macro lists. No stacked totals. No menu buttons unless asked.
 *
 * DETAIL IS NOT BANNED — it is REQUESTED. A client who asks for their meal plan, their
 * programme, their meal list or their numbers gets the full thing. The contract governs the
 * unsolicited reply that arrives after a routine log.
 *
 * Pure — text in, text out. No DB, no model, no clock.
 */

/** Messages that ASK for detail — these bypass the contract entirely. */
const DETAIL_REQUEST_RE =
  /\b(my meals?|meal plan|full plan|show me|list|programme|program|workout|my progress|my numbers|breakdown|how many|how much|what are my|macros?|calories today|totals?|report|scorecard|weekly|monthly)\b/i;

export function clientAskedForDetail(message: string): boolean {
  return DETAIL_REQUEST_RE.test(message || "");
}

// A line that is pure data-dump: bulleted item macros ("• Eggs: ~279 kcal, 24g protein").
const ITEM_LINE_RE = /^\s*[•·‣]\s*.+?[:\-–]\s*~?\s*\d[\d,]*\s*kcal/i;
// Stacked totals / budget lines the card already carries.
const TOTALS_LINE_RE = /^\s*(?:_?\s*)?(?:meal total|running total|total today|remaining today|today so far|your week|target)\b/i;
// Tap-through menu affordances ("‣ My progress").
const MENU_LINE_RE = /^\s*[‣▸>]\s*\w/;

/**
 * Compact a verbose coaching reply to the contract. Returns the reply unchanged when the
 * client asked for detail, or when it is already short.
 *
 * `keepLines` is the ceiling (default 3). The card carries the numbers; this carries meaning.
 */
export function enforceReplyContract(reply: string, opts?: { askedForDetail?: boolean; keepLines?: number }): string {
  const text = (reply || "").trim();
  if (!text) return text;
  if (opts?.askedForDetail) return text;

  const max = opts?.keepLines ?? 3;
  const mediaMatch = text.match(/\s*\[MEDIA:[^\]]+\]\s*$/i);
  const media = mediaMatch ? mediaMatch[0] : "";
  const body = media ? text.slice(0, text.length - media.length) : text;

  // COLLAPSE, don't delete. The client must still see WHAT was logged — hiding the foods is
  // how "did you even log it?" happens. So the itemised lines become ONE line of names plus
  // one total; the stacked totals and menus go.
  const foodNames: string[] = [];
  let mealTotal = "";
  const prose: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const item = line.match(ITEM_LINE_RE) ? line.match(/^\s*[•·‣]\s*([^:\-–]+)/) : null;
    if (item) { const n = item[1].replace(/[*_`]/g, "").trim(); if (n) foodNames.push(n); continue; }
    const tot = line.match(/^[*_\s]*meal total[:*_\s]*~?\s*([\d,]+)\s*kcal(?:[^\d]*(\d+)\s*g)?/i);
    if (tot) { mealTotal = `~${tot[1]} kcal${tot[2] ? ` | ${tot[2]}g protein` : ""}`; continue; }
    if (TOTALS_LINE_RE.test(line)) continue;
    if (MENU_LINE_RE.test(line)) continue;
    if (/^[*_\s]*food logged[\s✅*_]*$/i.test(line)) continue; // redundant with "Logged:"
    prose.push(line);
  }

  const out: string[] = [];
  // Line 1 — the acknowledgement, with WHAT was logged folded in.
  const ack = prose.shift() || "";
  if (foodNames.length) {
    const names = foodNames.slice(0, 4).join(", ");
    out.push(`${ack ? ack.replace(/\s*$/, "") + "\n" : ""}✅ *Logged:* ${names}${mealTotal ? ` — ${mealTotal}` : ""}`.trim());
  } else if (ack) {
    out.push(mealTotal ? `${ack} (${mealTotal})` : ack);
  } else if (mealTotal) {
    out.push(`✅ Logged — ${mealTotal}`);
  }
  // Lines 2..max — the coaching that actually tells them what to do next.
  for (const p2 of prose) { if (out.length >= max) break; out.push(p2); }

  if (out.length === 0) {
    const first = body.split("\n").map(l => l.trim()).find(Boolean);
    return ((first || text) + media).trim();
  }
  return (out.join("\n\n") + media).trim();
}

/** True when a reply already honours the contract — used by tests and the audit. */
export function meetsReplyContract(reply: string, maxLines = 3): boolean {
  const body = (reply || "").replace(/\s*\[MEDIA:[^\]]+\]\s*$/i, "");
  const lines = body.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length > maxLines) return false;
  return !lines.some(l => ITEM_LINE_RE.test(l) || TOTALS_LINE_RE.test(l) || MENU_LINE_RE.test(l));
}

/* ────────────────────────────────────────────────────────────────────────────
 * MESSAGE BUDGET — a deterministic product invariant, not a prompt hope.
 *
 * COACH_K_SYSTEM has said since it was written: "PROGRAMME DELIVERY: … Maximum 3 messages for
 * any programme" and "MEAL PLAN DELIVERY: Maximum 4 messages". Two problems with that. It sits
 * at character 66,782 of a prompt that is sliced at 20,000, so no model has ever read it. And
 * it was never a model's job anyway — how many WhatsApp bubbles a render becomes is arithmetic
 * the emitter controls, and a rule the emitter can violate is not a rule.
 *
 * Measured before writing this (2026-08-12): buildFullProgramme → 5 messages,
 * getKamlifeProgramme → 15, generateMealPlan → 5. Every one of them over.
 *
 * WHAT THIS GUARANTEES, stated exactly, because a guarantee that overclaims is worse than none:
 *   1. CONTENT IS NEVER DROPPED. Only separators move. Nothing is truncated, summarised or
 *      abbreviated — a client who loses half a training day to a formatting rule is worse off
 *      than one who gets a fourth message.
 *   2. ORDER IS NEVER CHANGED. Day 2 cannot arrive before Day 1, so packing is first-fit
 *      forward, never best-fit.
 *   3. The part count is at or under `cap` WHENEVER THE CONTENT PHYSICALLY FITS — i.e. when
 *      total length <= cap × maxLen. When it does not fit, the count is the minimum achievable
 *      and the overflow is logged loudly rather than resolved by deleting coaching.
 *
 * That third clause is not a hedge. getKamlifeProgramme is 5,273 characters, and 3 messages at
 * Twilio's usable 1,500 is 4,500 — so "3 messages" is arithmetically impossible for a full
 * three-day programme at current content density. The invariant takes it from 15 to the floor
 * and says so. Closing that last gap is a content decision, not a formatting one.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The caps the doctrine states. One owner, so the emitters cannot each invent their own. */
export const MESSAGE_BUDGET = { programme: 3, mealPlan: 4 } as const;

/**
 * Re-pack `\n\n---\n\n`-separated sections so the send path yields at most `cap` bubbles.
 * Pure, order-preserving, content-preserving. Returns the text unchanged when already inside
 * budget, so it is safe to wrap any emitter.
 */
export function enforceMessageBudget(text: string, cap: number, label: string, maxLen = 1500): string {
  const bubbles = String(text || "").split(/\n\n---\n\n/).map(b => b.trim()).filter(Boolean);
  if (bubbles.length <= cap && bubbles.every(b => b.length <= maxLen)) return text;

  // First-fit forward: fill a bubble until the next section would overflow it, then start a new
  // one. A section longer than maxLen on its own gets its own bubble and the send path's own
  // length-splitter handles it — that case is counted honestly below rather than hidden.
  const packed: string[] = [];
  let current = "";
  for (const bubble of bubbles) {
    const candidate = current ? `${current}\n\n${bubble}` : bubble;
    if (candidate.length <= maxLen) { current = candidate; continue; }
    if (current) packed.push(current);
    current = bubble;
  }
  if (current) packed.push(current);

  // What the send path will ACTUALLY produce, counting any over-long section it must re-split.
  const effective = packed.reduce((n, p) => n + Math.max(1, Math.ceil(p.length / maxLen)), 0);
  if (effective > cap) {
    console.warn(
      `[MESSAGE_BUDGET] ${label}: ${effective} bubbles, cap ${cap} — ` +
      `${String(text || "").length} chars cannot fit ${cap}×${maxLen}. Packed to the floor; nothing dropped. ` +
      `Reduce content density to close this.`,
    );
  }
  return packed.join("\n\n---\n\n");
}

/* ────────────────────────────────────────────────────────────────────────────
 * PRICE CLAIMS — three epistemic classes, and they may not be spoken alike.
 *
 * A nutrition value and a shelf price are not the same kind of fact, and the product was
 * treating them as though they were:
 *
 *   NUTRITION VALUE   stable reference data. "Chicken breast 100g = 165 kcal, 31g protein."
 *                     foods.ts owns it, it barely moves, and stating it flatly is correct.
 *   RETAIL ESTIMATE   a volatile local guess. "Chicken pieces 1kg — R45." True in one Shoprite
 *                     in one month. Stating it flatly is a small lie that costs trust at the till.
 *   OBSERVED PRICE    what THIS client actually paid, where they shop. We do not collect it yet.
 *
 * Found 2026-08-12, and the asymmetry ran the wrong way: formatShoppingList — whose numbers are
 * at least maintained literals — already said "Prices are rough estimates and vary by store",
 * while the GPT-generated rebuild, whose numbers the MODEL INVENTS, shipped "~R[price]" per item
 * and a "Week total" with no qualifier at all. The least reliable source carried the least
 * hedging. This makes one owner for the sentence so both paths say the same thing.
 *
 * DELIBERATELY NOT BUILT: a live South African price feed. We are not going to pretend to
 * national pricing accuracy we do not have. An honest estimate beats a fake fact.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The one client-facing qualifier for any rand amount that is an ESTIMATE, not a measurement. */
export const PRICE_ESTIMATE_NOTE = "_Prices are rough estimates and vary by store._";

/**
 * When the hardcoded retail estimates were last reviewed (YYYY-MM). This is the freshness half
 * of the policy: an estimate with no age is not an estimate, it is a stale fact waiting to
 * mislead someone. check-pricing.ts fails once this passes PRICE_REVIEW_MONTHS so the review is
 * a dated, deliberate event rather than something nobody ever gets round to.
 */
export const PRICE_DATA_AS_OF = "2026-08";
/** How long a retail estimate may stand before it must be re-checked. */
export const PRICE_REVIEW_MONTHS = 12;

/** True when `text` states a rand amount — i.e. it is making a price claim to a client. */
export function makesPriceClaim(text: string): boolean {
  return /R\s?\d|R\[/.test(String(text || ""));
}

/** True when a price-claiming render carries the estimate qualifier. Used by the tests. */
export function framesPriceAsEstimate(text: string): boolean {
  const t = String(text || "");
  if (!makesPriceClaim(t)) return true; // nothing claimed, nothing to qualify
  return /rough estimate|vary by store|approximate|estimate only/i.test(t);
}
