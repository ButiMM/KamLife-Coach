/**
 * CARD PREVIEW — look at what the client is actually sent.
 *
 * (2026-07-29, from a 15-minute call with a real client: "it's confusing in terms of the
 * calories… for a person trying to lose weight it needs to be simpler.")
 *
 * Every card defect this product has had was found by the founder squinting at a WhatsApp
 * screenshot after a client had already received it. This renders both versions of the same
 * day, side by side as files, before anyone is sent anything.
 *
 * Run: npx tsx script/card-preview.ts [outputDir]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderMacroCard, type MacroRow } from "../server/macro-card";
import { dayStatusPill, nextMoveLine, coachingHint, distinctHint, cardProse } from "../server/macro-card-attach";

const outDir = process.argv[2] || ".";
mkdirSync(outDir, { recursive: true });

// A real fat-loss day, mid-afternoon: calories fine, protein behind. The commonest state there is.
const rows: MacroRow[] = [
  { label: "Calories", current: 1180, target: 1750, unit: "kcal", overIsBad: true },
  { label: "Protein", current: 71, target: 130, unit: "g" },
  { label: "Carbs", current: 132, target: 180, unit: "g", overIsBad: true },
  { label: "Fat", current: 39, target: 58, unit: "g", overIsBad: true },
];

const verdict = dayStatusPill(rows, false);
const move = nextMoveLine(rows, false);
const hint = distinctHint(coachingHint(rows, false), move);

for (const numbersOff of [false, true]) {
  const png = renderMacroCard({
    title: "Chicken and rice",
    subtitle: "Meal logged",
    pill: verdict.text,
    pillTone: verdict.tone,
    rows,
    numbersOff,
    nextMove: cardProse(move, numbersOff),
    hint: cardProse(hint, numbersOff),
  });
  const name = numbersOff ? "card-number-free.png" : "card-with-numbers.png";
  writeFileSync(join(outDir, name), png);
  console.log(`${name}  ${(png.length / 1024).toFixed(0)} KB`);
}

console.log(`\nSame day, same bars, same verdict ("${verdict.text}"), same instruction.`);
console.log(`The number-free one is what every client gets unless they ask to see figures.`);
