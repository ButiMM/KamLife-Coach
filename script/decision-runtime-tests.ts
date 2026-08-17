import { deriveRuntimeDecision } from "../server/understanding/state";

const baseHunger = {
  progress: {
    avgDailyProtein: 0,
    proteinTarget: 120,
    proteinRatio: null,
    adherence: null,
    steps: null,
    weeklyKgChange: null,
    avgDailyKcal: null,
    calorieTarget: null,
    restrictionRatio: null,
    bottleneck: null,
  },
  hunger: { distinctDays: 0, windowDays: 7, persistent: false },
  dataDays: 0,
  confidence: "weak" as any,
  evidenceState: "insufficient_data" as const,
};

const baseDeficit = {
  calorieTarget: 1800,
  avgKcal7d: 1800,
  loggedDays7d: 7,
  intakeRatio: 1,
  expectedKgPerWeek: -0.45,
  observedKgPerWeek: -0.42,
  gapKgPerWeek: 0.03,
  gapIsMaterial: false,
  foodDataConfidence: "verified" as any,
  estimatedShare: 0,
  confidence: "usable" as const,
};

const cases = [
  {
    name: "no material signal stays CONTINUE",
    input: { deficitEvidence: baseDeficit },
    expected: "CONTINUE",
  },
  {
    name: "material usable deficit gap becomes CHANGE",
    input: { deficitEvidence: { ...baseDeficit, gapIsMaterial: true, gapKgPerWeek: 0.30 } },
    expected: "CHANGE",
  },
  {
    name: "material problem without usable intake evidence becomes INVESTIGATE",
    input: {
      deficitEvidence: {
        ...baseDeficit,
        gapIsMaterial: true,
        confidence: "trend_only" as const,
        avgKcal7d: null,
        loggedDays7d: 2,
      },
    },
    expected: "INVESTIGATE",
  },
  {
    name: "persistent hunger with thin evidence becomes INVESTIGATE",
    input: { hungerEvidence: baseHunger },
    mutate: (x: any) => ({ ...x, hungerEvidence: { ...baseHunger, evidenceState: "insufficient_data", hunger: { distinctDays: 4, windowDays: 7, persistent: true } } }),
    expected: "INVESTIGATE",
  },
  {
    name: "adequate-protein persistent hunger stays investigative",
    input: { hungerEvidence: { ...baseHunger, confidence: "usable" as any, evidenceState: "adequate_protein_persistent_hunger" as const, hunger: { distinctDays: 5, windowDays: 7, persistent: true } } },
    expected: "INVESTIGATE",
  },
  {
    name: "referral outranks every coaching decision",
    input: { deficitEvidence: { ...baseDeficit, gapIsMaterial: true }, requiresReferral: true },
    expected: "REFER",
  },
] as const;

for (const c of cases) {
  const input = "mutate" in c ? c.mutate(c.input) : c.input;
  const actual = deriveRuntimeDecision(input as any).state;
  if (actual !== c.expected) throw new Error(`${c.name}: expected ${c.expected}, got ${actual}`);
}

console.log(`decision-runtime-tests: ${cases.length}/${cases.length} passed`);