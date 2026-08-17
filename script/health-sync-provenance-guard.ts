import fs from "node:fs";

const migration = fs.readFileSync("migrations/0004_step_health_sync_provenance.sql", "utf8");
if (!/STEPS_AUTO_SYNC/.test(migration)) throw new Error("health-sync intent is not covered");
if (!/health_sync/.test(migration)) throw new Error("health_sync provenance is not assigned");
if (!/Africa\/Johannesburg/.test(migration)) throw new Error("SAST day ownership missing");
if (!/<= 300/.test(migration)) throw new Error("proximity guard missing");
console.log("health-sync-provenance-guard: 4/4 passed");
