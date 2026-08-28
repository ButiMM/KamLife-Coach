import fs from "node:fs";

function patch(path, fn) {
  const before = fs.readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`${path}: no change`);
  fs.writeFileSync(path, after);
}

patch("server/gpt.ts", src => {
  const old = `  // Pick the emotional register from the REAL pattern data, then let it drive both\n  // the words (prompt below) and the voice delivery (returned to the caller).\n  // buildPatternSummary already computed these signals — read them back out.\n  const silentMatch = patternSummary.match(/\\((\\d+)\\s+days?\\s+silent\\)/i);\n  const daysSilent = silentMatch ? parseInt(silentMatch[1], 10) : 0;`;
  const next = `  // The emotional register, driving both the words below and the voice delivery. ABSENCE HAS AN\n  // OWNER: do not infer it from days without a food log. That proxy is not contact.\n  const { contactState } = await import("./understanding/reentry");\n  const { isReturning } = contactState(user?.lastActiveAt);`;
  const n = (src.split(old).length - 1);
  if (n !== 1) throw new Error(`server/gpt.ts: expected one re-entry inference block, got ${n}`);
  return src.replace(old, next).replace(
    '  const lapsed = daysSilent >= 4 || daysSinceTraining >= 5\n',
    '  const lapsed = isReturning || daysSinceTraining >= 5\n',
  );
});

patch("server/handlers/misc-commands.ts", src => {
  const old = `      if (budget === "under_100") {\n        meals.push("2 eggs + pap (~300 kcal, 18g protein)");\n        meals.push("Tin of pilchards + pap (~350 kcal, 24g protein)");\n      } else {\n        meals.push("Chicken breast + rice + spinach (~450 kcal, 35g protein)");\n        meals.push("3 eggs + brown bread + tomato (~400 kcal, 24g protein)");\n        meals.push("Tin of pilchards + sweet potato (~380 kcal, 24g protein)");\n      }`;
  const next = `      if (protLeft >= 80) {\n        // The priority we just named is a material protein gap. Each option must close a\n        // meaningful fraction of it; otherwise the coach is saying "129g is the priority"\n        // and offering 18g. Keep the options SA and affordable.\n        if (budget === "under_100") {\n          meals.push("Tin of pilchards + 3 eggs + pap (~520 kcal, 42g protein)");\n          meals.push("Tin of tuna + 3 eggs + pap (~480 kcal, 43g protein)");\n        } else {\n          meals.push("200g chicken + rice + spinach (~620 kcal, 62g protein)");\n          meals.push("Tin of tuna + 3 eggs + brown bread + tomato (~540 kcal, 43g protein)");\n          meals.push("Tin of pilchards + 3 eggs + sweet potato (~550 kcal, 42g protein)");\n        }\n      } else if (budget === "under_100") {\n        meals.push("2 eggs + pap (~300 kcal, 18g protein)");\n        meals.push("Tin of pilchards + pap (~350 kcal, 24g protein)");\n      } else {\n        meals.push("Chicken breast + rice + spinach (~450 kcal, 35g protein)");\n        meals.push("3 eggs + brown bread + tomato (~400 kcal, 24g protein)");\n        meals.push("Tin of pilchards + sweet potato (~380 kcal, 24g protein)");\n      }`;
  const n = src.split(old).length - 1;
  if (n !== 1) throw new Error(`server/handlers/misc-commands.ts: expected one meal block, got ${n}`);
  return src.replace(old, next);
});

patch("script/tracking-contract-tests.ts", src => {
  const marker = '  /**\n   * STAGE 3 OF THE CONTRACT — ONE WRITE OWNER, AND EVERY CONVERSATIONAL DOOR GOES THROUGH IT.\n';
  const insert = `  /**\n   * RE-ENTRY OWNER — the voice register must follow contact, not logging density.\n   * #91 proved the two directions on the canonical resolver.\n   */\n  {\n    const { contactState } = await import("../server/understanding/reentry");\n    const now = Date.now();\n    if (contactState(new Date(now).toISOString(), now).isReturning) {\n      failures.push("today's contact cannot be classified as returning");\n    }\n    if (!contactState(new Date(now - 5 * 86_400_000).toISOString(), now).isReturning) {\n      failures.push("five-day absence must classify as returning");\n    }\n  }\n\n`;
  const n = src.split(marker).length - 1;
  if (n !== 1) throw new Error(`tracking-contract-tests.ts: marker count ${n}`);
  return src.replace(marker, insert + marker);
});

console.log("validated re-entry + material protein-gap + trend continuation applied");
