/**
 * THE ACTION INTERFACE — Phase 1 of the real inversion (2026-07-19).
 *
 * The whole architecture in one sentence: *the LLM does not touch the database — it
 * REQUESTS an action, and deterministic code validates and performs it.* This file is
 * that contract. Coach K stops being a talker behind ten keyword handlers and becomes
 * the decision-maker: it reads a message, decides what it MEANS, and emits ONE typed
 * CoachAction. The deterministic executor (next increment) performs it. Law 4 holds —
 * the model proposes, `validateAction` disposes.
 *
 * `validateAction` is the Tool Permission Gate: it takes raw, untrusted model output and
 * returns a SAFE action or falls back to JUST_REPLY. Every number is clamped to a sane
 * range; every enum is whitelisted; a malformed LOG_MEAL becomes JUST_REPLY rather than a
 * fabricated log. Nothing the model can emit can crash, corrupt, or over-write state.
 *
 * Pure and dependency-free so it is fully unit-testable and safe to import anywhere.
 * NOT yet wired to the live pipeline — wiring + replay proof is the next increment, and
 * it stays behind a flag until it beats the current system on replay for five days.
 */

// The meal slots the logger understands (mirrors utils.slotFromSastHour's output).
const MEAL_SLOTS = new Set(["breakfast", "lunch", "dinner", "snack", "night meal"]);

export type MealItem = { name: string; kcal: number; protein: number };

export type CoachAction =
  // Pure conversation — the default and the safe fallback. Coach K just talks.
  | { type: "JUST_REPLY" }
  // Record a meal the client reported. Coach K supplies the parsed items + slot; the
  // executor writes them. needsConfirmation flips on when Coach K is unsure (a treat, a
  // vague amount) — the executor asks one question instead of silently logging.
  | { type: "LOG_MEAL"; items: MealItem[]; meal: string; retro?: string; needsConfirmation: boolean }
  | { type: "REMOVE_LAST_MEAL" }
  | { type: "SHOW_MEALS" }
  | { type: "SHOW_WORKOUT" }
  | { type: "LOG_STEPS"; count: number }
  | { type: "LOG_WATER"; litres: number }
  | { type: "LOG_WEIGHT"; kg: number }
  | { type: "SET_SICK"; days: number }
  | { type: "END_SICK" };

export type CoachActionType = CoachAction["type"];

// The OpenAI tool schema Coach K emits against — the concrete interface. One tool per
// action; the model picks exactly one (or none → JUST_REPLY). Descriptions are the
// contract the model reads, so they carry the safety intent (confirm when unsure, never
// invent numbers, food logging is exact).
export const COACH_ACTION_TOOLS = [
  { type: "function", function: { name: "log_meal", description: "Record a meal the client REPORTED eating (past tense: 'I had', 'ate'). Provide each food's name, kcal and protein from the known SA food data — never invent figures. Set needs_confirmation=true when the amount is vague or it's a treat, so we ask instead of guessing. Do NOT call this for a question ('can I eat X?') or a plan ('I'll have X later').",
    parameters: { type: "object", required: ["items"], properties: {
      items: { type: "array", items: { type: "object", required: ["name", "kcal", "protein"], properties: { name: { type: "string" }, kcal: { type: "number" }, protein: { type: "number" } } } },
      meal: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack", "night meal"] },
      retro: { type: "string", description: "a past day if they said one, e.g. 'yesterday'" },
      needs_confirmation: { type: "boolean" },
    } } } },
  { type: "function", function: { name: "remove_last_meal", description: "The client wants their most recent logged meal removed/undone.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "show_meals", description: "The client wants to SEE today's logged meals list.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "show_workout", description: "The client wants today's workout or their programme.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "log_steps", description: "The client REPORTED a step count for today.", parameters: { type: "object", required: ["count"], properties: { count: { type: "number" } } } } },
  { type: "function", function: { name: "log_water", description: "The client REPORTED drinking water (in litres).", parameters: { type: "object", required: ["litres"], properties: { litres: { type: "number" } } } } },
  { type: "function", function: { name: "log_weight", description: "The client REPORTED a body-weight reading (in kg).", parameters: { type: "object", required: ["kg"], properties: { kg: { type: "number" } } } } },
  { type: "function", function: { name: "set_sick", description: "The client says they are sick/unwell and cannot train. days = how long they'll rest (parse 'until Monday', '3 days'); default 3 if unstated.", parameters: { type: "object", required: ["days"], properties: { days: { type: "number" } } } } },
  { type: "function", function: { name: "end_sick", description: "The client says they are better/back and ready to resume.", parameters: { type: "object", properties: {} } } },
] as const;

function clampNum(v: unknown, lo: number, hi: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : NaN;
}

/**
 * THE TOOL PERMISSION GATE (Law 4). Untrusted model output → a safe CoachAction, or
 * JUST_REPLY on anything malformed. Accepts either the OpenAI tool-call name form
 * ({ name, args }) or a plain { type, ... } object, so it validates whatever shape the
 * caller hands it. Never throws, never trusts a raw number, never fabricates a log.
 */
export function validateAction(raw: any): CoachAction {
  if (!raw || typeof raw !== "object") return { type: "JUST_REPLY" };
  // Normalise the tool-call name form to a type tag.
  const NAME_TO_TYPE: Record<string, CoachActionType> = {
    log_meal: "LOG_MEAL", remove_last_meal: "REMOVE_LAST_MEAL", show_meals: "SHOW_MEALS",
    show_workout: "SHOW_WORKOUT", log_steps: "LOG_STEPS", log_water: "LOG_WATER",
    log_weight: "LOG_WEIGHT", set_sick: "SET_SICK", end_sick: "END_SICK",
  };
  const a = raw.args && typeof raw.args === "object" ? raw.args : raw;
  const type: string = raw.type || NAME_TO_TYPE[String(raw.name || "").toLowerCase()] || "";

  switch (type) {
    case "REMOVE_LAST_MEAL": return { type: "REMOVE_LAST_MEAL" };
    case "SHOW_MEALS": return { type: "SHOW_MEALS" };
    case "SHOW_WORKOUT": return { type: "SHOW_WORKOUT" };
    case "END_SICK": return { type: "END_SICK" };
    case "LOG_STEPS": {
      const count = clampNum(a.count, 1, 100_000);
      return Number.isFinite(count) ? { type: "LOG_STEPS", count: Math.round(count) } : { type: "JUST_REPLY" };
    }
    case "LOG_WATER": {
      const litres = clampNum(a.litres, 0.1, 15);
      return Number.isFinite(litres) ? { type: "LOG_WATER", litres: Math.round(litres * 10) / 10 } : { type: "JUST_REPLY" };
    }
    case "LOG_WEIGHT": {
      // Weight feeds the trend/auto-adjust engine, so an out-of-range value is a MISPARSE
      // to reject, not to clamp — logging a false 25kg is worse than logging nothing.
      const kg = Number(a.kg);
      return Number.isFinite(kg) && kg >= 25 && kg <= 400 ? { type: "LOG_WEIGHT", kg: Math.round(kg * 10) / 10 } : { type: "JUST_REPLY" };
    }
    case "SET_SICK": {
      const days = clampNum(a.days ?? a.sickDays, 1, 14);
      return Number.isFinite(days) ? { type: "SET_SICK", days: Math.round(days) } : { type: "JUST_REPLY" };
    }
    case "LOG_MEAL": {
      const items: MealItem[] = (Array.isArray(a.items) ? a.items : [])
        .map((it: any) => ({
          name: String(it?.name || "").replace(/\s+/g, " ").trim().slice(0, 60),
          kcal: clampNum(it?.kcal, 0, 5000),
          protein: clampNum(it?.protein, 0, 400),
        }))
        .filter((it: MealItem) => it.name.length > 0 && Number.isFinite(it.kcal) && Number.isFinite(it.protein));
      // No valid food survived validation → never fabricate a log; just talk.
      if (items.length === 0) return { type: "JUST_REPLY" };
      const mealRaw = String(a.meal || "").toLowerCase().trim();
      const meal = MEAL_SLOTS.has(mealRaw) ? mealRaw : "snack";
      const retro = typeof a.retro === "string" && a.retro.trim() ? a.retro.trim().slice(0, 20) : undefined;
      return { type: "LOG_MEAL", items, meal, retro, needsConfirmation: !!(a.needs_confirmation ?? a.needsConfirmation) };
    }
    default:
      return { type: "JUST_REPLY" };
  }
}

/** One-line human summary of an action — for the audit/replay log the inversion needs. */
export function describeAction(action: CoachAction): string {
  switch (action.type) {
    case "JUST_REPLY": return "reply only (no action)";
    case "LOG_MEAL": return `log ${action.items.length} item(s) as ${action.meal}${action.retro ? ` (${action.retro})` : ""}${action.needsConfirmation ? " — confirm first" : ""}`;
    case "REMOVE_LAST_MEAL": return "remove last meal";
    case "SHOW_MEALS": return "show today's meals";
    case "SHOW_WORKOUT": return "show workout / programme";
    case "LOG_STEPS": return `log ${action.count} steps`;
    case "LOG_WATER": return `log ${action.litres}L water`;
    case "LOG_WEIGHT": return `log ${action.kg}kg`;
    case "SET_SICK": return `set sick for ${action.days} day(s)`;
    case "END_SICK": return "end sick / resume";
  }
}
