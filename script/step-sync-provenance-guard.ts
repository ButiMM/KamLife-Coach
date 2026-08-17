import fs from "node:fs";

const route = fs.readFileSync("server/routes/health-sync.ts", "utf8");
const schema = fs.readFileSync("shared/schema.ts", "utf8");
if (!/provenance:\s*['\"]health_sync['\"]/.test(route)) throw new Error("health-sync provenance missing");
if (!/provenance:\s*text\("provenance"\)/.test(schema)) throw new Error("step provenance schema field missing");
if (!/resolvedDay:\s*text\("resolved_day"\)/.test(schema)) throw new Error("step resolved-day schema field missing");
console.log("step-sync-provenance-guard: 3/3 passed");
