/**
 * Pricing-source guard (closes the "truth drifts out of the single source" gap).
 *
 * shared/pricing.ts is the ONE source of truth for price (currently R199). The
 * recurring failure mode is a stale hardcoded fallback creeping back into a
 * dashboard or message — e.g. `metrics?.pricePerUser ?? 149` — so the UI quietly
 * shows the wrong price the moment a metrics payload is missing a field. That is
 * exactly how a dashboard ended up rendering R149 while the product charged R199.
 *
 * This script fails CI if shipping code (client/src, server, shared) reintroduces:
 *   1. a numeric-literal fallback for a price field  (`pricePerUser ?? 149`)
 *   2. a known stale price STRING                    (`R149`, `R99`)
 *
 * The canonical shared/pricing.ts is exempt (it legitimately defines the price and
 * carries a "Never hardcode R149" warning comment). Docs are NOT scanned — the
 * finance docs are prose with their own modelled figures, reconciled separately.
 *
 * Run: npx tsx script/check-pricing.ts   (wired into `npm test`)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["client/src", "server", "shared"];
const EXEMPT = new Set(["shared/pricing.ts"]); // the canonical source defines the price

// Anti-patterns. Each comes with a human-readable explanation for the failure msg.
const RULES: { re: RegExp; why: string }[] = [
  {
    re: /pricePerUser\s*\?\?\s*\d/,
    why: "price fallback uses a numeric literal — use `?? PRICING.monthlyPriceZAR`",
  },
  {
    re: /\bR\s?149\b/,
    why: "stale hardcoded price string R149 — import from shared/pricing.ts",
  },
  {
    re: /\bR\s?99\b/,
    why: "stale hardcoded price string R99 — import from shared/pricing.ts",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap(r => walk(r));
const violations: string[] = [];

for (const file of files) {
  if (EXEMPT.has(file)) continue;
  const lines = readFileSync(file, "utf-8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push(`  ✗ ${file}:${i + 1} — ${rule.why}\n      ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("pricing guard: FAILED — stale/hardcoded price found in shipping code:");
  console.error(violations.join("\n"));
  console.error("\nAll prices must come from shared/pricing.ts (PRICING.monthlyPriceZAR).");
  process.exit(1);
}

console.log(`pricing guard: ${files.length} files OK (no stale price hardcodes)`);
process.exit(0);
