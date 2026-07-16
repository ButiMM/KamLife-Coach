/**
 * MULTILINGUAL LOGGING BATTERY (Phase 3 acceptance bar).
 *
 * Our people log food, steps, workouts and weight in isiZulu, isiXhosa, Sesotho,
 * Setswana and Afrikaans — in text and voice transcripts. This battery proves the
 * front-door normalizer (classifyIntent, gpt-4o-mini) UNDERSTANDS those messages and
 * rephrases them into the canonical English form the deterministic loggers record. The
 * loggers themselves are already trusted; this checks the understanding step feeding them.
 *
 * It hits the LIVE model, so it is NOT part of the offline suite. Run it in the Railway
 * shell (or the nightly job) with a key:
 *     OPENAI_API_KEY=sk-... npx tsx script/multilingual-battery.ts
 *
 * A case PASSES when the intent is right AND every `mustContain` string is in the canonical
 * AND no `mustNotContain` string is (the hallucination brake — e.g. never invent "yesterday").
 */

const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
if (!key) {
  console.error("multilingual-battery: set OPENAI_API_KEY (this battery calls the live model).");
  process.exit(2);
}
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
const { classifyIntent } = await import("../server/gpt");

interface Case {
  lang: string;
  msg: string;
  intent: string;
  mustContain?: string[];    // lowercase substrings the canonical must include
  mustNotContain?: string[]; // the hallucination brake
}

const CASES: Case[] = [
  // ── food logs ──
  { lang: "isiZulu",   msg: "Ngidle ipapa nenyama namuhla",        intent: "FOOD_LOG", mustContain: ["pap", "meat"], mustNotContain: ["yesterday"] },
  { lang: "Sesotho",   msg: "Ke jele papa le nama",                intent: "FOOD_LOG", mustContain: ["pap", "meat"], mustNotContain: ["yesterday"] },
  { lang: "isiXhosa",  msg: "Nditye isonka namaqanda kusasa",      intent: "FOOD_LOG", mustContain: ["bread", "eggs"] },
  { lang: "isiZulu",   msg: "Ngidle inkukhu nerayisi izolo",       intent: "FOOD_LOG", mustContain: ["chicken", "rice", "yesterday"] },
  // ── steps ──
  { lang: "isiZulu",   msg: "Ngihambe izinyathelo eziyi-8000",     intent: "STEPS", mustContain: ["8000"], mustNotContain: ["yesterday"] },
  { lang: "Afrikaans", msg: "Ek het 10000 treë geloop gister",     intent: "STEPS", mustContain: ["10000", "yesterday"] },
  // ── workout ──
  { lang: "isiZulu",   msg: "Ngiqedile ukujima",                   intent: "WORKOUT_LOG", mustContain: ["workout done"] },
  // ── weight ──
  { lang: "isiZulu",   msg: "Namuhla ngingu-85kg",                 intent: "WEIGHT", mustContain: ["85"] },
  // ── question guard: a question that MENTIONS steps must NOT be logged ──
  { lang: "isiZulu",   msg: "Ingabe izinyathelo ezi-10000 zanele?", intent: "QUESTION" },
];

let passed = 0, failed = 0;

for (const c of CASES) {
  try {
    const r = await classifyIntent(c.msg);
    const canon = (r.canonical || "").toLowerCase();
    const issues: string[] = [];
    if (r.intent !== c.intent) issues.push(`intent ${r.intent} ≠ ${c.intent}`);
    for (const s of c.mustContain || []) if (!canon.includes(s.toLowerCase())) issues.push(`missing "${s}"`);
    for (const s of c.mustNotContain || []) if (canon.includes(s.toLowerCase())) issues.push(`hallucinated "${s}"`);
    const ok = issues.length === 0;
    if (ok) passed++; else failed++;
    console.log(`${ok ? "✅" : "❌"} [${c.lang}] "${c.msg}"`);
    console.log(`   → ${r.intent} | canonical: "${r.canonical || ""}"`);
    if (!ok) console.log(`   ⚠️  ${issues.join("; ")}`);
  } catch (e: any) {
    failed++;
    console.log(`❌ [${c.lang}] "${c.msg}" — ERROR: ${e?.message || e}`);
  }
}

console.log(`\nmultilingual-battery: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
