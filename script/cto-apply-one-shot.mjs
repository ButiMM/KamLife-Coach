import fs from "node:fs";

const files = {
  responseGate: "server/verifiers/response-gate.ts",
  misc: "server/handlers/misc-commands.ts",
};

function replaceOnce(path, source, oldText, newText) {
  const n = source.split(oldText).length - 1;
  if (n !== 1) throw new Error(`${path}: expected one match, got ${n}`);
  return source.replace(oldText, newText);
}

let rg = fs.readFileSync(files.responseGate, "utf8");
const oldTrend = String.raw`const WEIGHT_TREND = /\b(?:down|up|lost|gained|dropped|added)\s+(?:about\s+|around\s+|roughly\s+)?\d[\d.,]*\s*kgs?\b|\byou(?:'re| are)\s+(?:losing|gaining|dropping)\b(?!\s+(?:strength|muscle|confidence|momentum|motivation|focus|interest|inches|cm|form|ground)\b)|\b(?:losing|gaining)\s+(?:weight|too\s+fast|quicker|faster)\b/i;`;
const newTrend = String.raw`const WEIGHT_TREND = /\b(?:scale|weight)\s+(?:is\s+)?(?:going\s+)?(?:up|down)\b|\b(?:down|up|lost|gained|dropped|added)\s+(?:about\s+|around\s+|roughly\s+)?\d[\d.,]*\s*kgs?\b|\byou(?:'re| are)\s+(?:losing|gaining|dropping)\b(?!\s+(?:strength|muscle|confidence|momentum|motivation|focus|interest|inches|cm|form|ground)\b)|\b(?:losing|gaining)\s+(?:weight|too\s+fast|quicker|faster)\b/i;`;
rg = replaceOnce(files.responseGate, rg, oldTrend, newTrend);
fs.writeFileSync(files.responseGate, rg);

let misc = fs.readFileSync(files.misc, "utf8");
const oldImports = `import { calculateTargets, waterTargetLitres } from "../targets";\n`;
const newImports = oldImports + `import { weightTrendUsable } from "../adaptive-targets";\nimport { readHealthState } from "../health-state";\n`;
misc = replaceOnce(files.misc, misc, oldImports, newImports);

const oldBlock = `      const first = logs[0].kg;\n      const latest = logs[logs.length - 1].kg;\n      const totalChange = latest - first;\n      const goal = user.goalType || "fat_loss";\n      const changeDir = totalChange < 0 ? \`Down \${Math.abs(totalChange).toFixed(1)}kg\` : totalChange > 0 ? \`Up \${totalChange.toFixed(1)}kg\` : "No change";\n      const verdict = goal === "fat_loss" && totalChange < -1 ? "Moving in the right direction." : goal === "muscle_gain" && totalChange > 0.5 ? "Scale is going up — keep fuelling." : goal === "fat_loss" && totalChange >= 0 ? "Scale hasn't moved yet — check food logging consistency." : "";`;
const newBlock = `      const first = logs[0].kg;\n      const latest = logs[logs.length - 1].kg;\n      const totalChange = latest - first;\n      const { sickSince, sickUntil } = readHealthState(user);\n      const trend = logs.length >= 2 ? weightTrendUsable({\n        count: logs.length,\n        newestAt: logs[logs.length - 1].at.getTime(),\n        oldestAt: logs[0].at.getTime(),\n        now: Date.now(),\n        sickSince: sickSince ? new Date(sickSince).getTime() : undefined,\n        sickUntil: sickUntil ? new Date(sickUntil).getTime() : undefined,\n      }) : { usable: false, why: "too_few" as const };\n      const goal = user.goalType || "fat_loss";\n      const changeDir = trend.usable\n        ? totalChange < 0 ? \`Down \${Math.abs(totalChange).toFixed(1)}kg\` : totalChange > 0 ? \`Up \${totalChange.toFixed(1)}kg\` : "No change"\n        : "Trend not called";\n      const verdict = !trend.usable\n        ? trend.why === "illness"\n          ? "I'm not going to call a trend off weigh-ins around your illness. Let's use clean morning weigh-ins."\n          : "I don't have enough clean weigh-ins yet to call a trend."\n        : goal === "fat_loss" && totalChange < -1 ? "Moving in the right direction."\n        : goal === "muscle_gain" && totalChange > 0.5 ? "Scale is up — keep fuelling."\n        : goal === "fat_loss" && totalChange >= 0 ? "Scale hasn't moved yet — check food logging consistency."\n        : "";`;
misc = replaceOnce(files.misc, misc, oldBlock, newBlock);

const oldReturn = '      return `*${name2 ? name2 + "\'s " : ""}Weight History*\\n\\n${recent}\\n\\n${changeDir} since you started. ${verdict}`.trim();';
const newReturn = '      const changeSummary = trend.usable ? `${changeDir} since you started.` : changeDir;\n      return `*${name2 ? name2 + "\'s " : ""}Weight History*\\n\\n${recent}\\n\\n${changeSummary} ${verdict}`.trim();';
misc = replaceOnce(files.misc, misc, oldReturn, newReturn);
fs.writeFileSync(files.misc, misc);
console.log("applied");
