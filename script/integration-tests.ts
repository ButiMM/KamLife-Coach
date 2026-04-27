/**
 * Integration tests for media pipeline and food scanner logic.
 * Self-contained: pure functions are inlined so no DB/network required.
 * Mirrors the production implementations in food-scanner.ts, chat-log.ts,
 * and coach-guardrails.ts — if you change those, update these tests.
 *
 * Run: npx tsx script/integration-tests.ts
 * Exits non-zero on any failure.
 */

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (err: any) {
    failed++;
    failures.push(`  ✗ ${name}\n    ${err.message}`);
  }
}

// ── Inlined pure functions (mirrors production, no DB deps) ──────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyMediaFailure(stage: string, rawError?: unknown): string {
  const msg = String(rawError || "").toLowerCase();
  if (msg.includes("timeout")) return `${stage.toUpperCase()}_TIMEOUT`;
  if (msg.includes("401") || msg.includes("403")) return `${stage.toUpperCase()}_AUTH`;
  if (msg.includes("codec") || msg.includes("mime") || msg.includes("format")) return `${stage.toUpperCase()}_FORMAT`;
  return `${stage.toUpperCase()}_FAIL`;
}

function buildMediaTrace(phone: string, mediaType: string): string {
  const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "").slice(-6) || "unknown";
  return `m_${Date.now().toString(36)}_${cleanPhone}_${(mediaType || "unknown").replace(/[^\w]/g, "").slice(0, 12)}`;
}

function parseFoodLogTotalsFromMessageOut(messageOut: string): { calories: number; protein: number } | null {
  if (!messageOut) return null;
  const totalLine = messageOut.match(/\*(?:Meal|Day) total:\s*~?(\d+)\s*kcal\s*\|\s*~?(\d+)g\s*protein\*/i);
  if (totalLine) {
    return { calories: parseInt(totalLine[1], 10), protein: parseInt(totalLine[2], 10) };
  }
  return null;
}

// Minimal food data subset for fuzzy-matching tests
const TEST_FOODS = [
  { name: "Pasta (spaghetti)", aliases: ["pasta", "spaghetti", "spaghetti pasta"] },
  { name: "Dates", aliases: ["dates", "date"] },
  { name: "Pap (stiff maize porridge)", aliases: ["pap", "stiff pap", "maize porridge"] },
  { name: "Eggs", aliases: ["eggs", "egg", "boiled eggs", "scrambled eggs", "fried eggs"] },
  { name: "Chicken breast", aliases: ["chicken breast", "chicken fillet", "grilled chicken", "chicken"] },
  { name: "Sweet potato", aliases: ["sweet potato", "sweet potatoes", "sweet patata"] },
  { name: "Brown rice", aliases: ["brown rice"] },
  { name: "White rice", aliases: ["white rice", "rice"] },
];

const FUZZY_BLACKLIST = new Set([
  "just", "had", "have", "having", "that", "this", "with", "from", "for",
  "past", "days", "havent", "trained", "training", "three", "down",
  "flat", "week", "weeks", "month", "months", "motivated", "motivation",
  "unmotivated", "struggling", "struggle", "missed", "missing",
]);

function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb; if (lb === 0) return la;
  const dp: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) for (let j = 1; j <= lb; j++) {
    const cost = a[i-1] === b[j-1] ? 0 : 1;
    dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
  }
  return dp[la][lb];
}

function maxDistance(len: number): number {
  if (len <= 4) return 0; if (len <= 6) return 1; return 2;
}

function scanFoodsTest(msg: string): string[] {
  const lower = msg.toLowerCase();
  const matched: string[] = [];
  for (const food of TEST_FOODS) {
    const all = [food.name.toLowerCase(), ...food.aliases];
    let hit = "";
    for (const alias of all) {
      const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, "i");
      if (re.test(lower) && alias.length > hit.length) hit = alias;
    }
    if (hit) matched.push(food.name);
  }
  if (matched.length > 0) return matched;
  // Fuzzy pass
  const words = lower.replace(/[^a-z\s]/g, "").split(/\s+/).filter(w => w.length >= 4 && !FUZZY_BLACKLIST.has(w));
  for (const food of TEST_FOODS) {
    if (matched.includes(food.name)) continue;
    const all = [food.name.toLowerCase(), ...food.aliases];
    let bestScore = Infinity;
    for (const word of words) {
      for (const alias of all) {
        if (alias.split(/\s+/).length !== 1) continue;
        const lenRatio = Math.min(word.length, alias.length) / Math.max(word.length, alias.length);
        if (lenRatio < 0.8) continue;
        const dist = levenshtein(word, alias);
        if (dist <= maxDistance(alias.length) && dist < bestScore) bestScore = dist;
      }
    }
    if (bestScore < Infinity) matched.push(food.name);
  }
  return matched;
}

// ── Tests ────────────────────────────────────────────────────────────────────

// escapeRegex
test("escapeRegex escapes dot", () => {
  assert.ok(escapeRegex("1.5kg").includes("\\."), "dot should be escaped");
});
test("escapeRegex escapes parens", () => {
  const r = escapeRegex("pap (stiff)");
  assert.ok(r.includes("\\(") && r.includes("\\)"), "parens should be escaped");
});
test("escapeRegex leaves plain words unchanged", () => {
  assert.equal(escapeRegex("chicken"), "chicken");
});

// parseFoodLogTotalsFromMessageOut
test("parseFoodLogTotalsFromMessageOut parses Meal total line", () => {
  const r = parseFoodLogTotalsFromMessageOut("*Meal total: ~420 kcal | ~28g protein*");
  assert.ok(r !== null && r.calories === 420 && r.protein === 28);
});
test("parseFoodLogTotalsFromMessageOut parses Day total line", () => {
  const r = parseFoodLogTotalsFromMessageOut("*Day total: ~1850 kcal | ~142g protein*");
  assert.ok(r !== null && r.calories === 1850 && r.protein === 142);
});
test("parseFoodLogTotalsFromMessageOut returns null for no match", () => {
  assert.equal(parseFoodLogTotalsFromMessageOut("Just had some food"), null);
});
test("parseFoodLogTotalsFromMessageOut handles empty string", () => {
  assert.equal(parseFoodLogTotalsFromMessageOut(""), null);
});

// Food scanner — key regression cases
test("scanner: 'eggs and pap' → matches both", () => {
  const r = scanFoodsTest("I had eggs and pap for breakfast");
  assert.ok(r.some(n => n.includes("Egg")), `expected eggs, got: ${r.join(", ")}`);
  assert.ok(r.some(n => n.includes("Pap")), `expected pap, got: ${r.join(", ")}`);
});
test("scanner: motivational lapse message → no food match (pasta false-positive fix)", () => {
  const r = scanFoodsTest("Haven't trained for 3 days, feeling down and unmotivated");
  assert.equal(r.length, 0, `expected no foods, got: ${r.join(", ")}`);
});
test("scanner: 'past few days' → pasta NOT matched", () => {
  const r = scanFoodsTest("I haven't been eating well for the past few days");
  assert.ok(!r.includes("Pasta (spaghetti)"), `pasta false positive: ${r.join(", ")}`);
});
test("scanner: 'days' → dates NOT matched", () => {
  const r = scanFoodsTest("I missed the last few days");
  assert.ok(!r.some(n => n === "Dates"), `dates false positive: ${r.join(", ")}`);
});
test("scanner: 'sweet potatoes' → sweet potato matched", () => {
  const r = scanFoodsTest("I had sweet potatoes with chicken");
  assert.ok(r.some(n => n.includes("Sweet potato")), `expected sweet potato, got: ${r.join(", ")}`);
});
test("scanner: 'chicken and rice' → both matched", () => {
  const r = scanFoodsTest("chicken and rice for lunch");
  assert.ok(r.some(n => n.includes("rice") || n.includes("Rice")), `expected rice, got: ${r.join(", ")}`);
  assert.ok(r.some(n => n.includes("Chicken")), `expected chicken, got: ${r.join(", ")}`);
});
test("scanner: 'training three days' → no food (training/three are blacklisted)", () => {
  const r = scanFoodsTest("I have been training three days a week");
  assert.ok(!r.some(n => n.includes("Pasta")), `pasta false positive: ${r.join(", ")}`);
});

// buildMediaTrace
test("buildMediaTrace returns non-empty string without spaces", () => {
  const t = buildMediaTrace("whatsapp:+27821234567", "audio/ogg");
  assert.ok(typeof t === "string" && t.length > 0 && !/\s/.test(t));
});
test("buildMediaTrace two calls with different phones are unique", () => {
  const t1 = buildMediaTrace("whatsapp:+27821234567", "audio/ogg");
  const t2 = buildMediaTrace("whatsapp:+27829999999", "audio/ogg");
  assert.notEqual(t1, t2, "different phones should produce different traces");
});

// classifyMediaFailure
test("classifyMediaFailure: timeout → TIMEOUT", () => {
  assert.ok(classifyMediaFailure("voice_transcribe", new Error("timeout_25000ms")).includes("TIMEOUT"));
});
test("classifyMediaFailure: 401 → AUTH", () => {
  assert.ok(classifyMediaFailure("image_download", "401 Unauthorized").includes("AUTH"));
});
test("classifyMediaFailure: 403 → AUTH", () => {
  assert.ok(classifyMediaFailure("audio_download", "403 Forbidden").includes("AUTH"));
});
test("classifyMediaFailure: codec → FORMAT", () => {
  assert.ok(classifyMediaFailure("voice_transcribe", "codec not supported").includes("FORMAT"));
});
test("classifyMediaFailure: unknown → FAIL with stage prefix", () => {
  const r = classifyMediaFailure("food_vision", "some unknown error");
  assert.ok(r.includes("FAIL") && r.startsWith("FOOD_VISION"));
});

// ── Results ──────────────────────────────────────────────────────────────────

console.log(`\nintegration-tests: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  console.log(failures.join("\n\n"));
  process.exit(1);
}
console.log("✓ all integration checks passed\n");
