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
  String.raw`const WEIGHT_TREND = /\\b(?:scale\\s+(?:is\\s+)?(?:going\\s+)?(?:up|down)|weight\\s+(?:is\\s+)?(?:going\\s+)?(?:up|down)|down|up|lost|gained|dropped|added)\\s+(?:about\\s+|around\\s+|roughly\\s+)?\\d[\\d.,]*\\s*kgs?\\b|\\b(?:scale|weight)\\s+(?:is\\s+)?(?:going\\s+)?(?:up|down)\\b|\\byou(?:'re| are)\\s+(?:losing|gaining|dropping)\\b(?!\\s+(?:strength|muscle|confidence|momentum|motivation|focus|interest|inches|cm|form|ground)\\b)|\\b(?:losing|gaining)\\s+(?:weight|too\\s+fast|quicker|faster)\\b/i;`,
  "WEIGHT_TREND declaration",
);
writeFileSync(responsePath, responseGate);

const miscPath = "server/handlers/misc-commands.ts";
let misc = readFileSync(miscPath, "utf8");
misc = replaceOnce(
  miscPath,
  misc,
  /^import \{ calculateTargets, waterTargetLitres \} from "\.\.\/targets";$/m,
  'import { calculateTargets, waterTargetLitres } from "../targets";\nimport { weightTrendUsable } from "../adaptive-targets";\nimport { readHealthState } from "../health-state";',
  "target imports",
);

const oldWeight = /      const first = logs\[0\]\.kg;\n      const latest = logs\[logs\.length - 1\]\.kg;\n      const totalChange = latest - first;\n      const goal = user\.goalType \|\| "fat_loss";\n      const changeDir = totalChange < 0 \? `Down \$\{Math\.abs\(totalChange\)\.toFixed\(1\)\}kg` : totalChange > 0 \? `Up \$\{totalChange\.toFixed\(1\)\}kg` : "No change";\n      const verdict = goal === "fat_loss" && totalChange < -1 \? "Moving in the right direction\." : goal === "muscle_gain" && totalChange > 0\.5 \? "Scale is going up — keep fuelling\." : goal === "fat_loss" && totalChange >= 0 \? "Scale hasn't moved yet — check food logging consistency\." : "";/m;
const newWeight = `      const first = logs[0].kg;\n      const latest = logs[logs.length - 1].kg;\n      const totalChange = latest - first;\n      const { sickSince, sickUntil } = readHealthState(user);\n      const trend = logs.length >= 2 ? weightTrendUsable({\n        count: logs.length,\n        newestAt: logs[logs.length - 1].at.getTime(),\n        oldestAt: logs[0].at.getTime(),\n        now: Date.now(),\n        sickSince: sickSince ? new Date(sickSince).getTime() : undefined,\n        sickUntil: sickUntil ? new Date(sickUntil).getTime() : undefined,\n      }) : { usable: false, why: "too_few" as const };\n      const goal = user.goalType || "fat_loss";\n      const changeDir = trend.usable\n        ? totalChange < 0 ? \`Down \${Math.abs(totalChange).toFixed(1)}kg\` : totalChange > 0 ? \`Up \${totalChange.toFixed(1)}kg\` : "No change"\n        : "Trend not called";\n      const verdict = !trend.usable\n        ? trend.why === "illness"\n          ? "I'm not going to call a trend off weigh-ins around your illness. Let's use clean morning weigh-ins."\n          : "I don't have enough clean weigh-ins yet to call a trend."\n        : goal === "fat_loss" && totalChange < -1 ? "Moving in the right direction."\n        : goal === "muscle_gain" && totalChange > 0.5 ? "Scale is up — keep fuelling."\n        : goal === "fat_loss" && totalChange >= 0 ? "Scale hasn't moved yet — check food logging consistency."\n        : "";`;
misc = replaceOnce(miscPath, misc, oldWeight, newWeight, "weight verdict block");
writeFileSync(miscPath, misc);

console.log("one-shot patch applied: final trend recognition + evidence-bound weight writer");
