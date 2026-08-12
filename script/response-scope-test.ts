import { classifyResponseScope, isLocalModification } from "../server/response-scope";

type Case = { name: string; input: string; expected: "micro" | "macro"; local?: boolean };

const cases: Case[] = [
  { name: "egg substitution is micro", input: "Can I use eggs instead?", expected: "micro", local: true },
  { name: "chicken substitution is micro", input: "Can I use pilchards instead of chicken?", expected: "micro", local: true },
  { name: "local what-about is micro", input: "What about eggs?", expected: "micro", local: true },
  { name: "explicit full updated list is macro", input: "Show me the full updated grocery list", expected: "macro" },
  { name: "explicit rebuild is macro", input: "Rebuild my grocery list", expected: "macro" },
];

for (const c of cases) {
  const actual = classifyResponseScope(c.input);
  if (actual !== c.expected) throw new Error(`${c.name}: expected ${c.expected}, got ${actual}`);
  if (c.local !== undefined && isLocalModification(c.input) !== c.local) {
    throw new Error(`${c.name}: local modification flag mismatch`);
  }
}

console.log(`response-scope-test: ${cases.length}/${cases.length} passed`);
