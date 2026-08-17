import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.cwd(), "server/understanding/meaning-engine.ts");
const source = fs.readFileSync(target, "utf8");

// These phrases encode the old "always intervene" coach and directly conflict with
// CONTINUE / INVESTIGATE. The guard is deliberately string-based so it can catch a prompt
// regression before an LLM test ever runs.
const forbidden = [
  /use it to CHANGE something/i,
  /ALWAYS CLOSE WITH THE NEXT COMMITMENT/i,
];

for (const pattern of forbidden) {
  if (pattern.test(source)) {
    throw new Error(`decision-doctrine-guard: forbidden legacy instruction found: ${pattern}`);
  }
}

console.log(`decision-doctrine-guard: ${forbidden.length}/${forbidden.length} legacy rules absent`);
