/**
 * proactive-gate.ts — Last-line sanity check for every outbound message.
 *
 * Catches template-rendering failures before they reach a client: a meal nudge
 * that says "You ate undefined kcal", a streak line of "NaN-day streak", or an
 * unrendered "${name}". These come from a null/undefined slipping into a string
 * template — rare, but at scale they WILL happen, and one is enough to break
 * trust. Pure function, zero deps, never throws.
 */

export interface OutboundCheck {
  safe: boolean;
  reason: string;
}

// Unambiguous template-leak markers. None of these legitimately appear in a
// South African fitness coaching message, so matching one means a bug rendered
// a broken value into the text.
const LEAK_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bundefined\b/i, label: "literal 'undefined'" },
  { re: /\bNaN\b/, label: "literal 'NaN'" },
  { re: /\[object Object\]/i, label: "'[object Object]'" },
  { re: /\$\{[^}]*\}/, label: "unrendered ${...} template" },
  { re: /\bnull\b\s*(kcal|g protein|kg|steps|kj|sessions?|days?)/i, label: "'null' before a unit" },
  { re: /(kcal|protein|kg|steps|sessions?|days?)\s*:?\s*\bnull\b/i, label: "unit followed by 'null'" },
  { re: /\bNaN\s*(kcal|g|kg|steps|%)/i, label: "'NaN' before a unit" },
];

/**
 * Check an outbound message body for emptiness and template leaks.
 * Returns { safe: true } for any normal message.
 */
export function checkOutboundMessage(body: string | null | undefined): OutboundCheck {
  try {
    if (body == null || typeof body !== "string") {
      return { safe: false, reason: "body is null/undefined or not a string" };
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      return { safe: false, reason: "empty body" };
    }
    for (const { re, label } of LEAK_PATTERNS) {
      if (re.test(body)) {
        return { safe: false, reason: `template leak: ${label}` };
      }
    }
    return { safe: true, reason: "" };
  } catch {
    // Never block a send because the checker itself errored — fail-open.
    return { safe: true, reason: "" };
  }
}
