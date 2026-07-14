const { runDrillNightly } = await import("../server/scheduler/jobs/drill-nightly");
await runDrillNightly();
console.log("job returned cleanly");
