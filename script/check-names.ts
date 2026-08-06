/**
 * DISPLAY-NAME GUARD — the coach never addresses anyone by their full name again.
 *
 * (2026-07-29 sweep: "The scale is one data point, Thandi Mokoena.")
 *
 * getDisplayName() has existed since the start and encodes three rules a raw `user.name` does
 * not: take the FIRST name only, reject junk a client typed into the name question ("test",
 * "asdf", a single letter), and return "" rather than a placeholder when there is nothing
 * usable. 48 call sites interpolated `user.name` directly anyway, so the product addressed
 * people the way a bank SMS does, in the middle of sentences written to sound like a person.
 *
 * Those 48 are fixed. This freezes the rest. The remaining uses are mostly `user.name.split(" ")
 * [0]` — first-name-correct but still bypassing the junk-name rule — so the budget may fall and
 * must never rise. Same measure-freeze-migrate pattern as check-sast.ts.
 *
 * Run: npx tsx script/check-names.ts   (wired into `npm test`)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Frozen 2026-07-29 after removing every full-name-in-prose use. LOWER THIS, NEVER RAISE IT.
const BUDGET = 102;

/** Prose shapes that put a FULL name in front of a client. These may never come back at all. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/user\.name \? `, \$\{user\.name\}` : ""/, 'full name in prose — use commaName(user)'],
  [/user\.name \? ` \$\{user\.name\}` : ""/, 'full name in prose — use spaceName(user)'],
  [/user\.name \|\| "there"/, 'full name in prose — use getDisplayName(user) || "there"'],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

let total = 0;
const banned: string[] = [];

for (const file of walk("server")) {
  const lines = readFileSync(file, "utf-8").split("\n");
  lines.forEach((line, i) => {
    if (/getDisplayName|commaName|spaceName/.test(line)) return;
    for (const [re, why] of FORBIDDEN) {
      if (re.test(line)) banned.push(`  ✗ ${file}:${i + 1} — ${why}`);
    }
    total += (line.match(/user\.name(?!s)/g) || []).length;
  });
}

if (banned.length > 0) {
  console.error("display-name guard: FAILED — a client would be addressed by their FULL name:\n");
  console.error(banned.join("\n"));
  console.error("\nUse commaName(user) / spaceName(user) / getDisplayName(user) from server/utils.ts.");
  process.exit(1);
}

if (total > BUDGET) {
  console.error(`display-name guard: FAILED — ${total} raw \`user.name\` uses, budget ${BUDGET}.`);
  console.error("Every new one is a chance to greet somebody as \"Thandi Mokoena\".");
  console.error("Use getDisplayName(user) instead. Do not raise the budget.");
  process.exit(1);
}

if (total < BUDGET) {
  console.error(`display-name guard: ${total} raw uses, below the frozen ${BUDGET}. Lower BUDGET to ${total} in script/check-names.ts to lock the win in.`);
  process.exit(1);
}

console.log(`display-name guard: ${total} raw \`user.name\` uses, at budget (${BUDGET}) — migrate, never add.`);
