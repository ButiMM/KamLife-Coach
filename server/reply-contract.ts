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
const ITEM_LINE_RE = /^\s*[•·\-*]\s*.+?[:\-–]\s*~?\s*\d[\d,]*\s*kcal/i;
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
    const item = line.match(ITEM_LINE_RE) ? line.match(/^\s*[•·\-*]\s*([^:\-–]+)/) : null;
    if (item) { const n = item[1].replace(/[*_`]/g, "").trim(); if (n) foodNames.push(n); continue; }
    const tot = line.match(/^\s*\*?_?\s*meal total:?\*?_?\s*~?\s*([\d,]+)\s*kcal[^\d]*(\d+)?/i);
    if (tot) { mealTotal = `~${tot[1]} kcal${tot[2] ? ` | ${tot[2]}g protein` : ""}`; continue; }
    if (TOTALS_LINE_RE.test(line)) continue;
    if (MENU_LINE_RE.test(line)) continue;
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
