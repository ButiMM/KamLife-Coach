# KamLife Coach — Clinical & Precision Audit

_Last reviewed: 2026-07-12. Outward, whole-system review of the numbers that decide a
client's results. Question being answered: "the core math we didn't touch — is it
clinically correct?" Short answer: **yes, the foundation is clinically sound.** Details,
sources, and the honest gaps are below._

---

## 1. The verdict, up front

Every core formula maps to an accepted clinical or sports-science standard. Nothing in
the foundation is guessed or hand-waved. The recent precision work removed the real
danger — **the same number computed differently in different files** (step burn, water
target) — which is what actually produces contradictions a client can see. The
underlying science was already right.

| Core number | Formula in code | Accepted standard | Verdict |
|---|---|---|---|
| BMR | Mifflin-St Jeor | The current clinical gold standard for BMR estimation | ✅ Exact |
| TDEE activity | 1.2–1.5 multipliers | Standard activity factors (1.2 sedentary → 1.9 very active) | ✅ Sound, conservative |
| Fat-loss deficit | −400 M / −300 F / kcal | 0.5–1%/week loss is the recommended sustainable rate | ✅ Sound |
| Muscle-gain surplus | +400 M / +250 F | Lean-bulk surplus of 250–500 kcal | ✅ Sound |
| Calorie floors | 1500 M / 1200 F / 1800 BF | Clinical minimums below which health/milk supply suffer | ✅ Correct |
| Protein | 1.8–2.2 g/kg, adj. bodyweight | 1.6–2.2 g/kg; obesity dosed on adjusted (lean) mass | ✅ Genuinely clinical |
| Water | 33 ml/kg, 2.0 L floor | 30–35 ml/kg hydration guideline | ✅ Sound |
| Step burn | 0.04 kcal/step at 70 kg, weight-scaled | Walking cost ∝ body mass, ~0.04–0.05 kcal/step | ✅ Sound, conservative |
| Weight-loss rate bands | 0.5 / 1 / 1.5 / 2 %/week | 0.5–1%/week recommended; >1% risks muscle loss | ✅ Correct |
| Step-target easing | eased by BMI ≥30/35/40, age ≥60/70 | Appropriate for joint load & deconditioning | ✅ Sound |

---

## 2. Formula-by-formula, with sources

### BMR — Mifflin-St Jeor ✅ exact
```
Male:   10·kg + 6.25·cm − 5·age + 5
Female: 10·kg + 6.25·cm − 5·age − 161
```
This is the Mifflin-St Jeor equation verbatim — the most accurate published predictive
BMR equation for the general population, and what dietitians use as default. Not the
older, less accurate Harris-Benedict, and not the crude `weight × 22`.

### TDEE activity multipliers ✅ sound (deliberately conservative)
Office 1.3, retail/physical 1.5, domestic worker 1.45, retired 1.2, etc. Standard
activity factors run 1.2 (sedentary) to 1.9 (very active). Ours sit in the lower-middle
band. If anything they slightly **under**-estimate burn for a truly active person —
which is the safe direction for fat loss (a smaller assumed burn = we never accidentally
tell someone to eat at maintenance).

### Goal adjustment — the deficit/surplus ✅ sound
- Fat loss: −400 kcal (M), −300 (F). A ~400–500 kcal/day deficit ≈ 0.4–0.5 kg/week —
  squarely in the recommended sustainable range. The smaller female deficit protects
  hormonal health (women are more sensitive to aggressive restriction).
- Muscle gain: +400 (M), +250 (F). A lean-bulk surplus that builds muscle without
  excess fat gain.
- Breastfeeding: deficit capped at −200 and a +400 production bonus, floor 1800 kcal —
  protects milk supply. Clinically correct and appropriately cautious.

### Protein ✅ genuinely clinical (this one is better than most apps)
1.8–2.2 g/kg depending on goal/sex, and critically: for **BMI ≥ 30 it doses on
_adjusted_ bodyweight** (ideal at BMI 22 + 40% of the excess), not total mass. This is
the clinical obesity-dosing standard. It's why a 140 kg client is prescribed a real,
affordable ~150 g rather than a pointless, unaffordable 280 g. Ceiling 220 g matches the
evidence plateau (~2.2 g/kg). Elderly get *more* protein (sarcopenia), youth are capped
(don't overload growing bodies). All correct.

### Water ✅ sound
33 ml/kg is mid-range of the 30–35 ml/kg guideline; 2.0 L floor is sensible. (Now
single-source — see the precision fix that removed the 1.7 L-vs-2.0 L drift.)

### Step burn ✅ sound, conservative
0.04 kcal/step at 70 kg, scaled linearly by body weight — correct physiology (energy
cost of walking is proportional to the mass you move). Slightly conservative vs the
0.04–0.05 range, which is the safe side for a deficit.

### Weight-loss-rate bands ✅ correct
Excellent ≤0.5%/week, safe ≤1%, warn ≤1.5%, danger ≥2%. Matches the consensus that
0.5–1%/week preserves muscle and anything faster risks lean-mass loss and rebound.

---

## 3. The outward view — value across every level

The brief: "deliver a crazy amount of value from beginners to intermediate to advanced,
on all levels." Honest assessment of where we are per level.

### Beginner — **strong** 💪
This is where the product shines. Plain-language education (calories explained "like a
data bundle"), a prescriptive grocery list that leads, low realistic starting step
targets that ease for weight/age, the low-mobility accommodation, the "you're covered,
no stress" tone. A clueless beginner is genuinely held. Nothing urgent here.

### Intermediate — **strong** 💪
Food logging → live deficit tracking, the adaptive step target that right-sizes to
reality, weekly report card, SA shelf-swaps, progress photos + physique analysis. The
person who knows the basics and wants consistency is well served.

### Advanced — **the real gap** ⚠️
An experienced lifter will out-grow the current depth:
- **Macros beyond protein.** We target calories + protein precisely but don't give
  carb/fat targets or nutrient timing. Advanced cutters/bulkers want all three.
- **Progressive overload.** We log lifts, but there's no explicit week-over-week
  load/volume progression or deload logic surfaced to the user (Phase 3 set-bump is
  specced but deferred).
- **Training specificity.** Lagging-body-part analysis exists (good), but not RPE,
  volume landmarks, or periodisation an advanced user expects.

None of this is a *bug* — it's a ceiling. And it's the right ceiling to raise **only
after** the beginner/intermediate core is bulletproof, because that's where the market
volume and the churn risk are. Advanced users are the smallest cohort and the most
forgiving of "it doesn't do everything yet."

---

## 4. Recommendations — refine, then extend (priority order)

1. **Keep hardening the core** (in progress). The duplicated-formula sweep (step burn,
   water) is the highest-value precision work because it fixes visible contradictions.
   Remaining low-risk candidate: unify the scattered fallback defaults (`|| 8500`,
   `|| 1800`) so a target-less user never sees two different numbers — deferred as
   low-risk, do it when convenient, not urgently.
2. **Food/calorie database depth.** The biggest precision lever left on the core: widen
   and tighten the SA food table so text logs ("pap and chicken") resolve to accurate
   numbers without a model guess. Directly improves the deficit everyone lives by.
3. **Then, and only then, the advanced tier:** carb/fat targets, surfaced progressive
   overload, deloads. High value for a small cohort — worth it once the base is locked.

**Cost note:** none of the above requires more model spend. The precision wins are all
deterministic code. The food-DB work actually *reduces* cost (fewer GPT fallbacks on
text food logs). Value up, cost flat or down.
