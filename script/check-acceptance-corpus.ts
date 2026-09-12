import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.cwd(), "acceptance/messy-ten.json");
const data = JSON.parse(readFileSync(path, "utf8")) as {
  version?: number;
  baseline?: string;
  scenarios?: Array<{ id?: string; input?: string; properties?: string[] }>;
};

const requiredIds = [
  "return-after-absence",
  "illness",
  "restaurant",
  "grocery",
  "alcohol-intention",
  "batch-log",
  "retroactive-log",
  "correction",
  "shift-work",
  "sparse-weight",
];

const failures: string[] = [];
if (data.version !== 1) failures.push(`expected corpus version 1, got ${String(data.version)}`);
if (data.baseline !== "dc3c308c7fcdaf0bc62f207622c4ed738765f3d6") {
  failures.push(`baseline drift: ${String(data.baseline)}`);
}

const scenarios = data.scenarios ?? [];
const ids = new Set<string>();
for (const scenario of scenarios) {
  const id = String(scenario.id ?? "");
  if (!id) failures.push("scenario missing id");
  if (ids.has(id)) failures.push(`duplicate scenario id: ${id}`);
  ids.add(id);
  if (!scenario.input?.trim()) failures.push(`${id}: missing input`);
  if (!Array.isArray(scenario.properties) || scenario.properties.length === 0) {
    failures.push(`${id}: missing acceptance properties`);
  }
}

for (const id of requiredIds) {
  if (!ids.has(id)) failures.push(`missing required scenario: ${id}`);
}
if (scenarios.length !== requiredIds.length) {
  failures.push(`expected exactly ${requiredIds.length} Phase-1 scenarios, got ${scenarios.length}`);
}

if (failures.length) {
  console.error("ACCEPTANCE CORPUS CHECK FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`ACCEPTANCE CORPUS OK — ${scenarios.length} scenarios`);
