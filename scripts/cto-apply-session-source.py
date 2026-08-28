from pathlib import Path
import re


def sub_once(path, pattern, replacement, label, flags=re.MULTILINE):
    p = Path(path)
    s = p.read_text()
    out, n = re.subn(pattern, lambda _m: replacement, s, count=1, flags=flags)
    if n != 1:
        raise RuntimeError(f"{path}: {label}: expected 1 match, found {n}")
    p.write_text(out)

sub_once(
    "server/session-report.ts",
    r'(export interface SessionReport \{.*?returning: boolean;\n\})',
    '''export interface SessionReport {
  /** They are telling us a session HAPPENED today (past tense, not a plan). */
  trainedToday: boolean;
  /** How it went, when they said. Null when they only reported the fact. */
  feel: SessionFeel | null;
  /** First session back after illness or a layoff — changes the coaching completely. */
  returning: boolean;
  /** Client-stated weekly session ordinal, when supplied. */
  weekSessionNumber: number | null;
  /** Client-stated split for this session, when supplied. */
  dayType: "upper" | "lower" | null;
}''',
    "SessionReport interface", re.DOTALL,
)

sub_once(
    "server/session-report.ts",
    r'const FIRST_DAY_BACK =\n  /.*?training\\b/i;\n',
    '''const FIRST_DAY_BACK =
  /\\b(?:first|1st)\\s+(?:day|session|workout|time)\\s+back\\b|\\bback\\s+(?:in|at)\\s+(?:the\\s+)?gym\\b|\\bback\\s+to\\s+training\\b/i;
const WEEK_SESSION = /\\b(?:my\\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th)\\s+(?:workout|session)\\s+(?:of|this)\\s+week\\b/i;
const DAY_TYPE = /\\b(upper|lower)\\s*(?:body|day)?\\b/i;

function parseOrdinal(value: string): number {
  const map: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, sixth: 6, "6th": 6 };
  return map[value.toLowerCase()] || Number(value) || 0;
}
''',
    "session constants", re.DOTALL,
)

sub_once(
    "server/session-report.ts",
    r'  const didTrain = TRAINED_PAST\.test\(s\).*?return \{ trainedToday: true, feel: readFeel\(s\), returning: RETURNING\.test\(s\) \};',
    '''  const weekMatch = s.match(WEEK_SESSION);
  const didTrain = TRAINED_PAST.test(s) || WENT_TO_GYM.test(s) || DID_SESSION.test(s) || FIRST_DAY_BACK.test(s) || !!weekMatch;
  if (!didTrain) return null;

  if (!TODAY_REF.test(s) && !JUST_NOW.test(s) && !FIRST_DAY_BACK.test(s) && !weekMatch) return null;

  return {
    trainedToday: true,
    feel: readFeel(s),
    returning: RETURNING.test(s),
    weekSessionNumber: weekMatch ? parseOrdinal(weekMatch[1]) : null,
    dayType: (s.match(DAY_TYPE)?.[1]?.toLowerCase() as "upper" | "lower" | undefined) || null,
  };''',
    "session parser body", re.DOTALL,
)

sub_once(
    "server/session-report.ts",
    r'export function sessionReportReply\(r: SessionReport, firstName = "", totalSessions\?: number\): string \{.*?const logged = `✅ \$\{fn\}logged today\'s session\.\$\{tally\}`;',
    '''export function sessionReportReply(r: SessionReport, firstName = "", totalSessions?: number, weekSession?: number): string {
  const fn = firstName ? `${firstName}, ` : "";
  const tally = weekSession && weekSession > 0
    ? ` That's session *${weekSession} this week.`
    : totalSessions && totalSessions > 0
      ? ` That's *${totalSessions} session${totalSessions === 1 ? "" : "s"}* logged.`
      : "";
  const split = r.dayType ? ` *${r.dayType} day*.` : "";
  const logged = `✅ ${fn}logged today's session.${tally}${split}`;''',
    "session reply signature", re.DOTALL,
)

sub_once(
    "server/handlers/workout.ts",
    r'import \{ applyRetroSessionState \} from "\.\./day-ledger";',
    'import { applyRetroSessionState, sessionsThisCalendarWeek } from "../day-ledger";',
    "day ledger import",
)
sub_once(
    "server/handlers/workout.ts",
    r'const dupe = sessionReportReply\(report, firstName, user\.totalWorkoutsCompleted \|\| 0\)',
    'const weekSession = report.weekSessionNumber || await sessionsThisCalendarWeek(user.id).catch(() => undefined);\n    const dupe = sessionReportReply(report, firstName, undefined, weekSession)',
    "duplicate session reply",
)
sub_once(
    "server/handlers/workout.ts",
    r'const reply = sessionReportReply\(report, firstName, newTotal\);',
    'const weekSession = report.weekSessionNumber || await sessionsThisCalendarWeek(user.id).catch(() => undefined);\n  const reply = sessionReportReply(report, firstName, undefined, weekSession);',
    "prose session reply",
)

sub_once(
    "server/gpt.ts",
    r'const \[recentChats, recentWeights, monthWeights, recentSteps, monthWorkouts, monthProtein\] = await Promise\.all\(\[',
    'const [recentChats, recentWeights, monthWeights, recentSteps, weekWorkouts, monthWorkouts, monthProtein] = await Promise.all([',
    "GPT destructuring",
)
sub_once(
    "server/gpt.ts",
    r'db\.select\(\{ count: sql<number>`COUNT\(\*\)::int` \} \)\n        \.from\(workoutLogs\)\n        \.where\(and\(eq\(workoutLogs\.userId, user\.id\), gte\(workoutLogs\.loggedAt, twentyEightDaysAgo\)\)\)\n        \.catch\(\(\) => \[\{ count: 0 \}\]\),',
    '''db.select({ loggedAt: workoutLogs.loggedAt }).from(workoutLogs)
        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo)))
        .orderBy(desc(workoutLogs.loggedAt)),
      db.select({ count: sql<number>`COUNT(*)::int` })
        .from(workoutLogs)
        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, twentyEightDaysAgo)))
        .catch(() => [{ count: 0 }]),''',
    "GPT workout queries", re.DOTALL,
)
sub_once(
    "server/gpt.ts",
    r'const trainingLogs = recentChats\.filter\(c =>\n      DONE_PATTERN\.test\(\(c\.messageIn \|\| ""\)\.toLowerCase\(\)\.trim\(\)\) \|\| c\.intent === "WORKOUT_LOG"\n    \);\n    const lastTraining = trainingLogs\[0\];',
    'const trainingLogs = weekWorkouts;\n    const lastTraining = trainingLogs[0];',
    "GPT training source",
)

sub_once(
    "script/tracking-contract-tests.ts",
    r'  /\*\*\n   \* STAGE 3 OF THE CONTRACT — ONE WRITE OWNER, AND EVERY CONVERSATIONAL DOOR GOES THROUGH IT\.',
    '''  /**
   * WEEK SESSION IDENTITY — ordinal reports must reach the session owner.
   */
  {
    const { parseSessionReport } = await import("../server/session-report");
    const r = parseSessionReport("Did my second workout of the week. It was a lower day.");
    if (!r?.trainedToday || r.weekSessionNumber !== 2 || r.dayType !== "lower") {
      failures.push("ordinal weekly workout report did not resolve to session 2 / lower");
    }
  }

  /**
   * STAGE 3 OF THE CONTRACT — ONE WRITE OWNER, AND EVERY CONVERSATIONAL DOOR GOES THROUGH IT.''',
    "tracking contract insertion",
)

print("session source convergence patch applied")
