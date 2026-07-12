// Onboarding intake parsers (2026-07-12) — pure, unit-tested helpers for the two new
// free-text questions Kam captures manually: foods loved/hated, and the 3-month dream +
// biggest struggle. Kept out of onboarding.ts so the parsing can be regression-tested
// (the onboarding state machine itself has no automated coverage, so the logic that
// interprets a client's own words must be locked here).

/** Split a "foods you love / can't stand" answer into likes and dislikes. Lenient: if
 *  the split is unclear, everything is treated as likes; "skip"/empty returns nulls. */
export function parseFoodPreferences(raw: string): { foodLikes: string | null; foodDislikes: string | null } {
  const t = (raw || "").trim();
  if (/^(skip|none|nothing|n\/?a|no)$/i.test(t) || t.length <= 1) return { foodLikes: null, foodDislikes: null };
  const dislikeMatch = t.match(/\b(can'?t stand|cannot stand|hate|don'?t (?:like|enjoy)|not a fan of|dislike|avoid)\b\s*[:\-]?\s*(.+)$/i);
  if (dislikeMatch) {
    const foodDislikes = dislikeMatch[2].trim().replace(/[.!]+$/, "") || null;
    const before = t.slice(0, dislikeMatch.index).trim();
    const foodLikes = before.replace(/\b(love|like|enjoy|favou?rites?|i eat|mostly)\b/gi, "").replace(/[,:\-\s]+$/, "").trim() || null;
    return { foodLikes, foodDislikes };
  }
  const foodLikes = t.replace(/^(i )?(love|like|enjoy|mostly eat|eat)\b\s*/i, "").trim() || t;
  return { foodLikes, foodDislikes: null };
}

/** Split a "3-month dream + biggest struggle" answer. The whole thing is the dream by
 *  default; if a struggle marker is present, that clause is captured separately too. */
export function parseVisionAnswer(raw: string): { dreamGoal: string | null; biggestStruggle: string | null } {
  const t = (raw || "").trim();
  let dreamGoal: string | null = t.length > 1 ? t : null;
  let biggestStruggle: string | null = null;
  const struggleMatch = t.match(/\b(struggle (?:with|is)|my (?:biggest )?(?:struggle|issue|problem|weakness)|hardest (?:part|thing)|i can'?t (?:stop|resist)|worst (?:habit|part))\b\s*[:\-]?\s*(.+)$/i);
  if (struggleMatch) {
    biggestStruggle = t.slice(struggleMatch.index).trim() || null;
    const dreamPart = t.slice(0, struggleMatch.index).trim().replace(/[.,:\-\s]+$/, "");
    if (dreamPart.length > 2) dreamGoal = dreamPart;
  }
  return { dreamGoal, biggestStruggle };
}
