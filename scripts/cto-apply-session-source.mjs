import fs from "node:fs";

function replaceOnce(path, source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${path}: ${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}

// 1) Session report parser: recognise ordinal weekly session reports and capture day type.
let p = "server/session-report.ts";
let s = fs.readFileSync(p, "utf8");
s = replaceOnce(p, s,
`export interface SessionReport {\n  /** They are telling us a session HAPPENED today (past tense, not a plan). */\n  trainedToday: boolean;\n  /** How it went, when they said. Null when they only reported the fact. */\n  feel: SessionFeel | null;\n  /** First session back after illness or a layoff — changes the coaching completely. */\n  returning: boolean;\n}`,
`export interface SessionReport {\n  /** They are telling us a session HAPPENED today (past tense, not a plan). */\n  trainedToday: boolean;\n  /** How it went, when they said. Null when they only reported the fact. */\n  feel: SessionFeel | null;\n  /** First session back after illness or a layoff — changes the coaching completely. */\n  returning: boolean;\n  /** Client-stated weekly session ordinal, when supplied (e.g. second workout this week). */\n  weekSessionNumber: number | null;\n  /** Client-stated split for this session, when supplied. */\n  dayType: "upper" | "lower" | null;\n}`,
"SessionReport interface");
s = replaceOnce(p, s,
`const FIRST_DAY_BACK =\n  /\\b(?:first|1st)\\s+(?:day|session|workout|time)\\s+back\\b|\\bback\\s+(?:in|at)\\s+(?:the\\s+)?gym\\b|\\bback\\s+to\\s+training\\b/i;\n`,
`const FIRST_DAY_BACK =\n  /\\b(?:first|1st)\\s+(?:day|session|workout|time)\\s+back\\b|\\bback\\s+(?:in|at)\\s+(?:the\\s+)?gym\\b|\\bback\\s+to\\s+training\\b/i;\nconst WEEK_SESSION = /\\b(?:my\\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th)\\s+(?:workout|session)\\s+(?:of|this)\\s+week\\b/i;\nconst DAY_TYPE = /\\b(upper|lower)\\s*(?:body|day)?\\b/i;\n\nfunction parseOrdinal(value: string): number {\n  const map: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, sixth: 6, "6th": 6 };\n  return map[value.toLowerCase()] || Number(value) || 0;\n}\n`,
"session parser constants");
s = replaceOnce(p, s,
`  const didTrain = TRAINED_PAST.test(s) || WENT_TO_GYM.test(s) || DID_SESSION.test(s) || FIRST_DAY_BACK.test(s);\n  if (!didTrain) return null;\n\n  // It has to be about TODAY. A bare "just finished my session" counts; "first day back"\n  // with no other day named counts too — nobody reports a comeback in the abstract.\n  if (!TODAY_REF.test(s) && !JUST_NOW.test(s) && !FIRST_DAY_BACK.test(s)) return null;\n\n  return { trainedToday: true, feel: readFeel(s), returning: RETURNING.test(s) };` ,
`  const weekMatch = s.match(WEEK_SESSION);\n  const didTrain = TRAINED_PAST.test(s) || WENT_TO_GYM.test(s) || DID_SESSION.test(s) || FIRST_DAY_BACK.test(s) || !!weekMatch;\n  if (!didTrain) return null;\n\n  // It has to be about TODAY. A bare "just finished my session" counts; weekly ordinal reports\n  // are current-turn reports too because the client is identifying the session they just did.\n  if (!TODAY_REF.test(s) && !JUST_NOW.test(s) && !FIRST_DAY_BACK.test(s) && !weekMatch) return null;\n\n  return {\n    trainedToday: true,\n    feel: readFeel(s),\n    returning: RETURNING.test(s),\n    weekSessionNumber: weekMatch ? parseOrdinal(weekMatch[1]) : null,\n    dayType: (s.match(DAY_TYPE)?.[1]?.toLowerCase() as "upper" | "lower" | undefined) || null,\n  };`,
"session report return");

s = replaceOnce(p, s,
`  return { script: fallbacks[milestoneType], emotion };\n}`,
`  return { script: fallbacks[milestoneType], emotion };\n}`,
"noop anchor");

s = replaceOnce(p, s,
`export function sessionReportReply(r: SessionReport, firstName = "", totalSessions?: number): string {\n  const fn = firstName ? \`${firstName}, \` : "";\n  const tally = totalSessions && totalSessions > 0\n    ? \` That's *\${totalSessions} session\${totalSessions === 1 ? "" : "s"}* logged.\`\n    : "";\n  const logged = \`✅ \${fn}logged today's session.\${tally}\`;`,
`export function sessionReportReply(r: SessionReport, firstName = "", totalSessions?: number, weekSession?: number): string {\n  const fn = firstName ? \`${firstName}, \` : "";\n  const tally = weekSession && weekSession > 0\n    ? \` That's session *\${weekSession} this week*.\`\n    : totalSessions && totalSessions > 0\n      ? \` That's *\${totalSessions} session\${totalSessions === 1 ? "" : "s"}* logged.\`\n      : "";\n  const split = r.dayType ? \` *\${r.dayType} day*.\` : "";\n  const logged = \`✅ \${fn}logged today's session.\${tally}\${split}\`;`,
"session reply signature");
fs.writeFileSync(p, s);

// 2) Workout prose path: use actual weekly session count when available.
p = "server/handlers/workout.ts";
s = fs.readFileSync(p, "utf8");
s = replaceOnce(p, s,
`import { applyRetroSessionState } from "../day-ledger";`,
`import { applyRetroSessionState, sessionsThisCalendarWeek } from "../day-ledger";`,
"day-ledger import");
s = replaceOnce(p, s,
`  if (existing.length > 0) {\n    const dupe = sessionReportReply(report, firstName, user.totalWorkoutsCompleted || 0)\n      .replace(/^✅[^\\n]*\\n\\n/, \`✅ \${firstName ? firstName + ", " : ""}today's session is already logged.\\n\\n\`);`,
`  if (existing.length > 0) {\n    const weekSession = report.weekSessionNumber || await sessionsThisCalendarWeek(user.id).catch(() => undefined);\n    const dupe = sessionReportReply(report, firstName, undefined, weekSession)\n      .replace(/^✅[^\\n]*\\n\\n/, \`✅ \${firstName ? firstName + ", " : ""}today's session is already logged.\\n\\n\`);`,
"duplicate session reply");
s = replaceOnce(p, s,
`  const reply = sessionReportReply(report, firstName, newTotal);`,
`  const weekSession = report.weekSessionNumber || await sessionsThisCalendarWeek(user.id).catch(() => undefined);\n  const reply = sessionReportReply(report, firstName, undefined, weekSession);`,
"prose session reply");
fs.writeFileSync(p, s);

// 3) GPT weekly training summary: use authoritative workoutLogs for current week.
p = "server/gpt.ts";
s = fs.readFileSync(p, "utf8");
s = replaceOnce(p, s,
`    const [recentChats, recentWeights, monthWeights, recentSteps, monthWorkouts, monthProtein] = await Promise.all([`,
`    const [recentChats, recentWeights, monthWeights, recentSteps, weekWorkouts, monthWorkouts, monthProtein] = await Promise.all([`,
"GPT Promise.all destructuring");
s = replaceOnce(p, s,
`      db.select({ count: sql<number>\`COUNT(*)::int\` })\n        .from(workoutLogs)\n        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, twentyEightDaysAgo)))\n        .catch(() => [{ count: 0 }]),`,
`      db.select({ loggedAt: workoutLogs.loggedAt }).from(workoutLogs)\n        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo)))\n        .orderBy(desc(workoutLogs.loggedAt)),\n      db.select({ count: sql<number>\`COUNT(*)::int\` })\n        .from(workoutLogs)\n        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, twentyEightDaysAgo)))\n        .catch(() => [{ count: 0 }]),`,
"GPT workout queries");
s = replaceOnce(p, s,
`    const trainingLogs = recentChats.filter(c =>\n      DONE_PATTERN.test((c.messageIn || "").toLowerCase().trim()) || c.intent === "WORKOUT_LOG"\n    );\n    const lastTraining = trainingLogs[0];`,
`    const trainingLogs = weekWorkouts;\n    const lastTraining = trainingLogs[0];`,
"GPT training source");
fs.writeFileSync(p, s);

// 4) Existing tracking suite: exact ordinal live case.
p = "script/tracking-contract-tests.ts";
s = fs.readFileSync(p, "utf8");
const marker = `  /**\n   * STAGE 3 OF THE CONTRACT — ONE WRITE OWNER, AND EVERY CONVERSATIONAL DOOR GOES THROUGH IT.`;
const insert = `  /**\n   * WEEK SESSION IDENTITY — ordinal reports must reach the session owner.\n   */\n  {\n    const { parseSessionReport } = await import("../server/session-report");\n    const r = parseSessionReport("Did my second workout of the week. It was a lower day.");\n    if (!r?.trainedToday || r.weekSessionNumber !== 2 || r.dayType !== "lower") {\n      failures.push("ordinal weekly workout report did not resolve to session 2 / lower");\n    }\n  }\n\n`;
const markerCount = s.split(marker).length - 1;
if (markerCount !== 1) throw new Error(`tracking contract marker count=${markerCount}`);
s = s.replace(marker, insert + marker);
fs.writeFileSync(p, s);

console.log("session truth convergence patch applied");
