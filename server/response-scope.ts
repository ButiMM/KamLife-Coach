/**
 * Response scope for local-vs-global modifications.
 * Pure classifier: no DB, model, clock, or handler ownership.
 *
 * Local changes should receive a local answer. Full reconstruction is reserved
 * for an explicit request for the complete state.
 */
export type ResponseScope = "micro" | "macro";

const MACRO_PATTERNS = [
  /\b(update|rebuild|regenerate|refresh|show|give|send)\b.*\b(full|entire|complete|whole|updated)\b.*\b(list|plan|menu|groceries?)\b/i,
  /\b(full|complete|entire|whole)\b.*\b(updated\s+)?(grocery|shopping)\s+list\b/i,
  /\b(update|rebuild|regenerate|show|give|send)\b.*\b(my\s+)?(grocery|shopping)\s+list\b/i,
  /\bshow\s+me\s+(the\s+)?(whole|full|complete)\b/i,
];

const MICRO_PATTERNS = [
  /\bcan\s+i\s+use\s+.+\s+instead\b/i,
  /\b(use|swap|replace|substitute)\b.+\binstead\b/i,
  /\bwhat\s+about\s+.+\b/i,
  /\bis\s+.+\s+okay\s+instead\b/i,
];

export function classifyResponseScope(message: string): ResponseScope {
  const text = (message || "").trim();
  if (!text) return "micro";
  if (MACRO_PATTERNS.some(re => re.test(text))) return "macro";
  if (MICRO_PATTERNS.some(re => re.test(text))) return "micro";
  return "micro";
}

export function isLocalModification(message: string): boolean {
  return classifyResponseScope(message) === "micro" && MICRO_PATTERNS.some(re => re.test(message || ""));
}
