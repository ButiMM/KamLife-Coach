/**
 * MACRO STATUS — deterministic answer to "how are my fats/carbs/protein looking?"
 *
 * (2026-07-23 live) The card showed Fat 88/86g — OVER — and the engine answered "around
 * 100g, within a reasonable range": a different number than the card AND the wrong verdict,
 * because the model estimated instead of reading the ledger. A macro-status question is a
 * NUMBERS question; numbers come from ONE source (todayRows: day-ledger + the same targets
 * the card draws) and the verdict is arithmetic, never vibes. Pure — unit-tested.
 */

export interface MacroStatusRow { label: string; current: number; target: number; unit: string; overIsBad?: boolean }

// Which macro is the client asking about? null = not a macro-status question.
export function whichMacroAsked(m: string): "Fat" | "Carbs" | "Protein" | "Macros" | null {
  const s = (m || "").toLowerCase();
  if (!/\b(how|is|are|am i|what|where|check|status|looking|doing|over|under|left|bad|ok|okay|fine|too (?:much|many|high))\b/.test(s)) return null;
  // Must be about THEIR day ("my fats", "carbs today"), never food composition
  // ("how much protein in eggs") or general nutrition questions.
  if (!/\b(my|today|so far|for the day|am i|have i|do i)\b/.test(s)) return null;
  if (/\b(?:in|per|for)\s+(?!the day\b|my\b|today\b)[a-z]/.test(s) && !/\blooking|over|under|left|bad|ok(?:ay)?\b/.test(s)) return null;
  const fat = /\b(fats?|fat intake)\b/.test(s);
  const carb = /\b(carbs?|carbohydrates?)\b/.test(s);
  const prot = /\bprotein\b/.test(s);
  const macro = /\bmacros?\b/.test(s);
  // "how are my macros" or several named at once → the full rundown.
  if (macro || [fat, carb, prot].filter(Boolean).length > 1) return "Macros";
  if (fat) return "Fat";
  if (carb) return "Carbs";
  if (prot) return "Protein";
  return null;
}

function line(r: MacroStatusRow): string {
  const over = r.current - r.target;
  const pct = r.target > 0 ? r.current / r.target : 0;
  if (r.overIsBad && over > 0) {
    const sev = pct > 1.25 ? "that's well over — worth pulling back" : "right at the ceiling, ease off it for the rest of today";
    return `*${r.label}: ${r.current}${r.unit} of ${r.target}${r.unit}* — ⚠️ ${over}${r.unit} over. ${sev}.`;
  }
  if (!r.overIsBad && over >= 0) return `*${r.label}: ${r.current}${r.unit} of ${r.target}${r.unit}* — ✅ target hit.`;
  return `*${r.label}: ${r.current}${r.unit} of ${r.target}${r.unit}* — ${Math.abs(over)}${r.unit} still available.`;
}

// The one honest answer. `which` from whichMacroAsked; rows from todayRows (the card's own
// numbers) — so the reply and the card CANNOT disagree, by construction.
export function macroStatusReply(rows: MacroStatusRow[], which: "Fat" | "Carbs" | "Protein" | "Macros", name?: string): string {
  const hi = name ? `${name}, ` : "";
  const core = rows.filter(r => ["Calories", "Protein", "Carbs", "Fat"].includes(r.label));
  if (which === "Macros") {
    return `${hi}today so far:\n${core.map(line).join("\n")}`;
  }
  const r = core.find(x => x.label === which);
  if (!r) return `${hi}I don't have a ${which.toLowerCase()} target set for you yet.`;
  const others = which !== "Protein" ? core.find(x => x.label === "Protein") : core.find(x => x.label === "Calories");
  const extra = others ? `\n${line(others)}` : "";
  return `${hi}straight from your log:\n${line(r)}${extra}`;
}
