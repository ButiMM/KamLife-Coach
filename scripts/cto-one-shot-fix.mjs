import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, source, pattern, replacement, label) {
  const matches = source.match(pattern) || [];
  if (matches.length !== 1) throw new Error(`${path}: expected exactly one ${label}, found ${matches.length}`);
  return source.replace(pattern, replacement);
}

const responsePath = "server/verifiers/response-gate.ts";
let responseGate = readFileSync(responsePath, "utf8");
responseGate = replaceOnce(
  responsePath,
  responseGate,
  /^const WEIGHT_TREND = .*;$/m,
  String.raw`const WEIGHT_TREND = /\b(?:scale\s+(?:is\s+)?(?:going\s+)?(?:up|down)|weight\s+(?:is\s+)?(?:going\s+)?(?:up|down)|down|up|lost|gained|dropped|added)\s+(?:about\s+|around\s+|roughly\s+)?\d[\d.,]*\s*kgs?\b|\b(?:scale|weight)\s+(?:is\s+)?(?:going\s+)?(?:up|down)\b|\byou(?:'re| are)\s+(?:losing|gaining|dropping)\b(?!\s+(?:strength|muscle|confidence|momentum|motivation|focus|interest|inches|cm|form|ground)\b)|\b(?:losing|gaining)\s+(?:weight|too\s+fast|quicker|faster)\b/i;`,
  "WEIGHT_TREND declaration",
);
writeFileSync(responsePath, responseGate);

const miscPath = "server/handlers/misc-commands.ts";
let misc = readFileSync(miscPath, "utf8");
misc = replaceOnce(
  miscPath,
  misc,
  /^      return `\*\$\{name2 \? name2 \+ "'s " : ""\}Weight History\*\\n\\n\$\{recent\}\\n\\n\$\{changeDir\} since you started\. \$\{verdict\}`\.trim\(\);$/m,
  "      const changeSummary = trend.usable ? `${changeDir} since you started.` : changeDir;\n      return `*${name2 ? name2 + \"'s \" : \"\"}Weight History*\\n\\n${recent}\\n\\n${changeSummary} ${verdict}`.trim();",
  "weight history return",
);
writeFileSync(miscPath, misc);

console.log("one-shot patch corrected");
