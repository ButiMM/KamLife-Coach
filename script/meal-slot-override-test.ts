import { explicitMealSlotWins } from "../server/understanding/executor";

type Case = { name: string; input: string | undefined | null; expected: string | undefined };

const cases: Case[] = [
  { name: "explicit lunch survives a morning clock", input: "lunch", expected: "lunch" },
  { name: "explicit dinner survives a morning clock", input: "dinner", expected: "dinner" },
  { name: "explicit supper survives a morning clock", input: "supper", expected: "supper" },
  { name: "absent slot remains a clock-fallback case", input: undefined, expected: undefined },
];

for (const c of cases) {
  const actual = explicitMealSlotWins(c.input);
  if (actual !== c.expected) {
    throw new Error(`${c.name}: expected ${String(c.expected)}, got ${String(actual)}`);
  }
}

console.log(`meal-slot-override-test: ${cases.length}/${cases.length} passed`);
