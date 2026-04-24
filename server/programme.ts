// ============================================================
// KAMLIFE PROGRAMME LIBRARY
// All workout programme content and builder functions
// ============================================================

// ============================================================
// TYPE DEFINITIONS
// ============================================================

export type Exercise = {
  name: string;
  sets: string;
  description: string;
  mistake: string;
  modification: string;
  youtube?: string;
};

// ============================================================
// GYM — 3-DAY FULL BODY (FULL EQUIPMENT)
// ============================================================

const GYM_FULL_DAY_A: Exercise[] = [
  {
    name: "Barbell Squat or Leg Press",
    sets: "3x10",
    description: "Feet shoulder width. Lower until thighs parallel to floor. Drive through heels to stand. Keep chest tall and core braced throughout the movement.",
    mistake: "Heels rising off the floor or knees caving inward. Push knees out over toes and keep weight through your heels.",
    modification: "Leg Press if no barbell available or if you have lower back pain.",
    youtube: "https://www.youtube.com/results?search_query=barbell+squat+form+tutorial",
  },
  {
    name: "Barbell Bench Press or Chest Press Machine",
    sets: "3x10",
    description: "Bar to lower chest. Press until arms are almost fully extended. Lower the bar slowly over 2 seconds. Feet flat on floor, shoulder blades pinched together.",
    mistake: "Bouncing the bar off your chest. Lower it under control and pause briefly at the bottom.",
    modification: "Dumbbell press if no barbell is available.",
    youtube: "https://www.youtube.com/results?search_query=barbell+bench+press+form+tutorial",
  },
  {
    name: "Lat Pulldown",
    sets: "3x10",
    description: "Pull the bar down to your upper chest. Drive your elbows down and back. Squeeze your shoulder blades hard together at the bottom. Return slowly under control.",
    mistake: "Pulling with your arms instead of your back. Think about driving your elbows toward your back pockets.",
    modification: "Resistance band pulldown if no cable machine is available.",
    youtube: "https://www.youtube.com/results?search_query=lat+pulldown+tutorial+form",
  },
  {
    name: "Romanian Deadlift",
    sets: "3x10",
    description: "Hinge at the hips, push your bum back. Lower until you feel a strong hamstring stretch. Drive hips forward to stand. Back must stay flat throughout.",
    mistake: "Rounding the lower back at the bottom. Only go as deep as your flexibility allows while keeping a flat back.",
    modification: "Reduce range of motion if you have tight hamstrings — depth comes with time.",
    youtube: "https://www.youtube.com/results?search_query=romanian+deadlift+form+tutorial",
  },
  {
    name: "Dumbbell Shoulder Press",
    sets: "3x10",
    description: "Dumbbells at shoulder height, palms facing forward. Press overhead until arms are nearly extended. Lower slowly back to starting position.",
    mistake: "Arching your lower back excessively as you press. Brace your core and keep your ribs down.",
    modification: "Seated press for lower back support.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+shoulder+press+tutorial+form",
  },
];

const GYM_FULL_DAY_B: Exercise[] = [
  {
    name: "Hip Thrust (Barbell or Machine)",
    sets: "3x12",
    description: "Upper back resting on bench or in machine. Drive hips up explosively. Squeeze glutes hard at the top and hold for 1 full second. Lower slowly.",
    mistake: "Using your lower back instead of your glutes. Focus on squeezing your bum at the top — if you feel it in your back, reduce weight.",
    modification: "Glute bridge flat on the floor if no bench is available.",
    youtube: "https://www.youtube.com/results?search_query=barbell+hip+thrust+tutorial+form",
  },
  {
    name: "Incline Dumbbell Press",
    sets: "3x10",
    description: "Bench set to 30–45 degrees. Press dumbbells up and slightly inward. Full range of motion — lower until dumbbells are beside your chest. Control the descent.",
    mistake: "Elbows flaring too wide. Keep them at roughly 45 degrees from your torso.",
    modification: "Flat bench press if incline is not available.",
    youtube: "https://www.youtube.com/results?search_query=incline+dumbbell+press+tutorial+form",
  },
  {
    name: "Seated Cable Row",
    sets: "3x10",
    description: "Pull the handle in to your lower chest. Squeeze your shoulder blades hard together and hold briefly. Return slowly — full stretch at the front. Stay upright.",
    mistake: "Leaning too far back or rocking your torso to generate momentum. Keep your back still.",
    modification: "Dumbbell bent-over row if no cable machine is available.",
    youtube: "https://www.youtube.com/results?search_query=seated+cable+row+tutorial+form",
  },
  {
    name: "Bulgarian Split Squat",
    sets: "3x10 each leg",
    description: "Back foot elevated on bench. Front foot placed far forward. Lower your back knee toward the floor. Drive up through your front heel. Keep torso upright.",
    mistake: "Front knee caving inward. Keep it tracking straight over your middle toe throughout.",
    modification: "Regular lunge if balance is a problem. Progress to elevated over time.",
    youtube: "https://www.youtube.com/results?search_query=bulgarian+split+squat+tutorial+form",
  },
  {
    name: "Face Pull",
    sets: "3x15",
    description: "Cable set at face height with rope attachment. Pull rope to your face with elbows high and wide. Squeeze your rear delts hard at the end position. Return slowly.",
    mistake: "Pulling too low or using too much momentum. This is a shoulder health exercise — use light weight and focus on the squeeze.",
    modification: "Rear delt dumbbell fly lying face down on an incline bench if no cable available.",
    youtube: "https://www.youtube.com/results?search_query=face+pull+cable+tutorial+form",
  },
];

const GYM_FULL_DAY_C: Exercise[] = [
  {
    name: "Hack Squat or Leg Press",
    sets: "3x10",
    description: "Aim for a deeper range of motion than Day A. Feet positioned slightly closer together for more quad focus. Control the descent over 2 seconds.",
    mistake: "Not reaching full depth. Go as deep as your mobility allows while keeping lower back against the pad.",
    modification: "Leg Press with a wider stance if Hack Squat is not available.",
    youtube: "https://www.youtube.com/results?search_query=hack+squat+machine+tutorial+form",
  },
  {
    name: "Overhead Press (Barbell or Machine)",
    sets: "3x10",
    description: "Press straight overhead until arms are nearly locked. Core tight and ribs down throughout. Lower slowly back to shoulder height.",
    mistake: "Leaning back excessively to get the bar overhead. Keep your torso upright and brace hard.",
    modification: "Seated dumbbell press if you have shoulder mobility restrictions.",
    youtube: "https://www.youtube.com/results?search_query=overhead+press+barbell+form+tutorial",
  },
  {
    name: "Chest-Supported Row or Barbell Row",
    sets: "3x10",
    description: "Chest resting on incline bench (chest-supported). Pull dumbbells up toward your hips. Squeeze your back hard at the top. Lower slowly. Eliminates lower back involvement.",
    mistake: "Using momentum to swing the weight up. If you cannot do it strict, reduce the weight.",
    modification: "Single arm dumbbell row with knee on bench if chest-supported bench is not available.",
    youtube: "https://www.youtube.com/results?search_query=chest+supported+dumbbell+row+tutorial",
  },
  {
    name: "Leg Curl Machine",
    sets: "3x12",
    description: "Full range of motion — curl heels all the way toward your glutes. Slow lowering phase of 3 seconds. Squeeze hamstrings hard at the top.",
    mistake: "Hips rising off the pad to assist the movement. Keep your hips pinned down throughout.",
    modification: "Nordic curl on the floor — both challenging and effective.",
    youtube: "https://www.youtube.com/results?search_query=leg+curl+machine+tutorial+form",
  },
  {
    name: "Tricep Cable Pushdown",
    sets: "3x12",
    description: "Elbows pinned firmly at your sides. Push down until arms are straight. Squeeze triceps hard at the bottom. Return slowly under control.",
    mistake: "Elbows drifting forward during the movement. If they move, reduce the weight.",
    modification: "Tricep dips off a bench if no cable machine is available.",
    youtube: "https://www.youtube.com/results?search_query=tricep+cable+pushdown+tutorial+form",
  },
];

// ============================================================
// GYM — 3-DAY FULL BODY DUMBBELL-ONLY
// (For Planet Fitness, basic gyms, no barbell/cable)
// ============================================================

const GYM_DUMBBELL_DAY_A: Exercise[] = [
  {
    name: "Goblet Squat",
    sets: "3x12",
    description: "Hold one dumbbell vertically at your chest. Feet shoulder width, toes slightly out. Lower until thighs are parallel. Keep elbows tracking inside your knees. Drive through heels.",
    mistake: "Heels rising off the floor. Keep your full foot flat and drive through the whole foot.",
    modification: "Squat to a chair if knees are weak — stand up from the chair with control.",
    youtube: "https://www.youtube.com/results?search_query=goblet+squat+dumbbell+tutorial+form",
  },
  {
    name: "Dumbbell Bench Press",
    sets: "3x10",
    description: "Lie on a flat bench. Dumbbells held at chest height. Press up until arms are nearly extended. Lower slowly through full range of motion. Feet flat on the floor.",
    mistake: "Elbows flaring out wide. Keep them at roughly 45 degrees from your torso.",
    modification: "Floor press if no bench is available — lie flat on the floor.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+bench+press+tutorial+form",
  },
  {
    name: "Dumbbell Row (each arm)",
    sets: "3x10 each arm",
    description: "One knee on bench for support. Pull dumbbell from a full hang up to your hip. Squeeze your back hard at the top. Lower slowly under control.",
    mistake: "Rotating your torso to pull the weight up. Keep hips square and let only your arm move.",
    modification: "Both arms bent-over row standing if no bench is available.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+single+arm+row+tutorial",
  },
  {
    name: "Dumbbell Romanian Deadlift",
    sets: "3x10",
    description: "Dumbbells in front of thighs. Hinge at hips pushing bum back. Lower along your shins until you feel a strong hamstring stretch. Drive hips forward to return.",
    mistake: "Rounding your lower back. Only go as deep as a flat back allows.",
    modification: "Reduce the range of motion while your flexibility builds over time.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+romanian+deadlift+tutorial+form",
  },
  {
    name: "Dumbbell Shoulder Press",
    sets: "3x10",
    description: "Dumbbells at shoulder height, palms facing forward. Press overhead until arms are nearly extended. Lower slowly back to starting position. Keep core braced.",
    mistake: "Arching your lower back excessively as you press. Brace your core and keep ribs down.",
    modification: "Seated press for lower back support.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+shoulder+press+tutorial+form",
  },
];

const GYM_DUMBBELL_DAY_B: Exercise[] = [
  {
    name: "Hip Thrust with Dumbbell",
    sets: "3x12",
    description: "Upper back on bench. Dumbbell or weight plate balanced on your hips. Drive hips up explosively. Squeeze glutes hard at the top. Lower slowly.",
    mistake: "Using your lower back instead of your glutes. If you feel it in your back, that is the wrong muscle doing the work.",
    modification: "Bodyweight glute bridge flat on the floor.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+hip+thrust+tutorial+form",
  },
  {
    name: "Incline Dumbbell Press",
    sets: "3x10",
    description: "Bench at 30–45 degrees. Press dumbbells up and slightly inward. Full range of motion. Control the descent over 2 seconds.",
    mistake: "Elbows flaring too wide. Keep them at roughly 45 degrees from your torso.",
    modification: "Flat bench press if incline is not available.",
    youtube: "https://www.youtube.com/results?search_query=incline+dumbbell+press+tutorial+form",
  },
  {
    name: "Bent Over Dumbbell Row",
    sets: "3x10",
    description: "Hinge forward until torso is roughly parallel to the floor. Pull both dumbbells up to your lower chest simultaneously. Squeeze shoulder blades together hard. Lower slowly.",
    mistake: "Rounding your back to reach the floor. Hinge from the hips and keep your back flat.",
    modification: "Chest-supported row lying on an incline bench to remove lower back stress.",
    youtube: "https://www.youtube.com/results?search_query=bent+over+dumbbell+row+tutorial+form",
  },
  {
    name: "Dumbbell Bulgarian Split Squat",
    sets: "3x10 each leg",
    description: "Hold dumbbells at sides. Back foot elevated on bench. Front foot far forward. Lower back knee toward floor. Drive through front heel to rise. Torso upright.",
    mistake: "Front knee caving inward. Keep it tracking straight over your middle toe.",
    modification: "Regular lunge if balance is a problem — progress to elevated position over time.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+bulgarian+split+squat+tutorial",
  },
  {
    name: "Lateral Raise",
    sets: "3x15",
    description: "Light dumbbells at sides. Arms slightly bent. Raise to shoulder height only. Lower slowly over 2 seconds. Do not shrug your shoulders up.",
    mistake: "Using momentum to swing the weights up. If you cannot control the lowering phase, reduce weight.",
    modification: "One arm at a time while holding something for balance.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+lateral+raise+tutorial+form",
  },
];

const GYM_DUMBBELL_DAY_C: Exercise[] = [
  {
    name: "Dumbbell Goblet Squat (heavier)",
    sets: "3x12",
    description: "Same mechanics as Day A but use a heavier dumbbell. Focus on depth and control. Slow the descent to 3 seconds. Really feel the quad stretch at the bottom.",
    mistake: "Rushing to get through reps. The controlled lowering phase is where the muscle gets built.",
    modification: "Box squat to a bench if depth is a problem.",
    youtube: "https://www.youtube.com/results?search_query=goblet+squat+dumbbell+tutorial+form",
  },
  {
    name: "Dumbbell Floor Press",
    sets: "3x10",
    description: "Lie flat on the floor. Dumbbells at chest height. Press up. Lower slowly until your triceps touch the floor. Pause briefly. Press again. Full range within floor limits.",
    mistake: "Bouncing your triceps off the floor to generate momentum. Pause at the bottom and press from a dead stop.",
    modification: "Regular dumbbell press on a bench if available.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+floor+press+tutorial+form",
  },
  {
    name: "Single Arm Row",
    sets: "3x10 each arm",
    description: "One knee on bench for support. Pull dumbbell from a full hang to your hip. Focus on a slow 3-second lowering phase. Squeeze the back hard at the top.",
    mistake: "Rushing the lowering phase. The eccentric is as important as the pull — control it.",
    modification: "Seated cable row if available and you prefer bilateral.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+single+arm+row+tutorial",
  },
  {
    name: "Dumbbell Hip Thrust",
    sets: "3x12",
    description: "Upper back on bench. Heavier dumbbell than Day B. Drive hips up. Squeeze hard at the top for 1 second. Lower slowly under control.",
    mistake: "Not achieving full hip extension at the top. Push until your body is in a straight line from knees to shoulders.",
    modification: "Bodyweight hip thrust if heavier dumbbell is too much.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+hip+thrust+tutorial",
  },
  {
    name: "Tricep Overhead Extension",
    sets: "3x12",
    description: "Hold one dumbbell overhead with both hands gripping the top plate. Lower the dumbbell behind your head by bending at the elbows. Extend back up. Elbows stay close to head.",
    mistake: "Elbows flaring out wide as you lower. Keep them pointing forward throughout.",
    modification: "Tricep dips off a bench if overhead extension causes shoulder discomfort.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+overhead+tricep+extension+tutorial",
  },
];

// ============================================================
// GYM — FEMALE GLUTE-FOCUS PROGRAMME
// (3 days, for users with primaryFocusArea === "glutes_legs")
// ============================================================

const GYM_GLUTES_DAY_A: Exercise[] = [
  {
    name: "Barbell Hip Thrust",
    sets: "4x12",
    description: "This is your primary movement. Upper back on bench. Bar padded on hips. Drive hips up explosively. Squeeze glutes hard for 1 full second at the top. Lower slowly over 2 seconds.",
    mistake: "Pushing through your lower back instead of your glutes. If your lower back is sore, that is wrong — focus on the bum squeeze at the top.",
    modification: "Bodyweight or dumbbell hip thrust if no barbell or pad available.",
    youtube: "https://www.youtube.com/results?search_query=barbell+hip+thrust+tutorial+glutes",
  },
  {
    name: "Romanian Deadlift",
    sets: "3x10",
    description: "Hinge back and feel your hamstrings stretch. Drive through your hips to stand. The hamstring stretch is what activates the glutes — do not rush the bottom position.",
    mistake: "Rounding your lower back at the bottom. Only go as deep as a flat back allows.",
    modification: "Reduce range of motion until your form is solid, then increase depth gradually.",
    youtube: "https://www.youtube.com/results?search_query=romanian+deadlift+form+tutorial+glutes",
  },
  {
    name: "Sumo Squat",
    sets: "3x12",
    description: "Wide stance with toes pointed out at 45 degrees. Lower down between your legs. Squeeze glutes hard at the top of each rep. Targets inner thighs and glutes together.",
    mistake: "Knees caving inward as you lower. Push your knees out actively over your toes.",
    modification: "Goblet sumo squat holding one dumbbell at your chest.",
    youtube: "https://www.youtube.com/results?search_query=sumo+squat+glutes+tutorial+form",
  },
  {
    name: "Cable Kickback",
    sets: "3x15 each leg",
    description: "Ankle strap on cable machine. Hinge slightly forward holding the machine. Drive your leg back and up. Squeeze glute hard at the peak. Control the return.",
    mistake: "Using momentum or swinging your leg. This is an isolation exercise — slow it down and feel every rep.",
    modification: "Donkey kick on all fours on the floor if no cable machine.",
    youtube: "https://www.youtube.com/results?search_query=cable+kickback+glutes+tutorial+form",
  },
  {
    name: "Hip Abduction Machine",
    sets: "3x15",
    description: "Sit in machine. Push knees apart against the resistance. Squeeze glutes at the end position. Slow and controlled return. Do not use momentum.",
    mistake: "Leaning forward to use hip flexors instead of letting the glutes do the work. Sit upright.",
    modification: "Side-lying leg raise on the floor if no machine available.",
    youtube: "https://www.youtube.com/results?search_query=hip+abduction+machine+tutorial+glutes",
  },
];

const GYM_GLUTES_DAY_B: Exercise[] = [
  {
    name: "Leg Press (wide stance)",
    sets: "3x12",
    description: "Feet placed wide and high on the platform. This position shifts focus from quads to glutes. Full range of motion — lower until knees reach your chest.",
    mistake: "Letting knees cave inward as you press. Push them out over your toes throughout.",
    modification: "Sumo squat if no leg press machine is available.",
    youtube: "https://www.youtube.com/results?search_query=leg+press+wide+stance+glutes+tutorial",
  },
  {
    name: "Chest Press Machine or Bench Press",
    sets: "3x10",
    description: "Upper body balance work. Adjust seat so handles are at chest height. Press forward until arms nearly extended. Return slowly. Keep back against the pad.",
    mistake: "Shrugging shoulders up during the press. Keep them down and back.",
    modification: "Dumbbell press on a flat bench if machine not available.",
    youtube: "https://www.youtube.com/results?search_query=chest+press+machine+tutorial+form",
  },
  {
    name: "Lat Pulldown",
    sets: "3x10",
    description: "Upper back balance work. Pull bar to your upper chest. Drive elbows down and back. Squeeze shoulder blades. Creates the upper body shape that complements leg development.",
    mistake: "Pulling with your arms instead of driving your elbows down. Think elbows to back pockets.",
    modification: "Resistance band pulldown if no cable machine.",
    youtube: "https://www.youtube.com/results?search_query=lat+pulldown+tutorial+form",
  },
  {
    name: "Walking Lunge",
    sets: "3x12 each leg",
    description: "Hold dumbbells at sides. Take a long stride forward — long stride hits the glutes, short stride hits the quads. Drive through your front heel to step through.",
    mistake: "Taking short steps which removes glute involvement. Step long and feel the stretch in the front hip.",
    modification: "Static lunge staying on the spot if balance is a problem.",
    youtube: "https://www.youtube.com/results?search_query=walking+lunge+dumbbell+tutorial+glutes",
  },
  {
    name: "Shoulder Press",
    sets: "3x10",
    description: "Upper body balance. Dumbbells at shoulder height. Press overhead. Lower slowly. Core braced. Creates the shoulder width that gives the hourglass proportion.",
    mistake: "Arching lower back excessively. Brace your core and keep ribs down.",
    modification: "Seated press for lower back support.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+shoulder+press+tutorial+form",
  },
];

const GYM_GLUTES_DAY_C: Exercise[] = [
  {
    name: "Romanian Deadlift (heavier)",
    sets: "3x12",
    description: "Heavier than Day A. Really focus on the hamstring stretch at the bottom and the glute activation as you drive your hips through. This builds the glute-hamstring tie-in.",
    mistake: "Thinking of this as a back exercise. It is a hip hinge — the hips do the work, not the back.",
    modification: "Dumbbell RDL if no barbell available.",
    youtube: "https://www.youtube.com/results?search_query=romanian+deadlift+heavier+posterior+chain",
  },
  {
    name: "Leg Curl Machine",
    sets: "3x12",
    description: "Full range of motion. Curl heels toward your glutes. Squeeze at the top. Slow 3-second lowering phase. Strong hamstrings directly support glute development.",
    mistake: "Rushing the lowering phase. The eccentric is where the muscle builds — do not waste it.",
    modification: "Nordic curl on the floor — very challenging but highly effective.",
    youtube: "https://www.youtube.com/results?search_query=leg+curl+machine+tutorial+hamstrings",
  },
  {
    name: "Cable Pull Through",
    sets: "3x15",
    description: "Face away from the cable machine. Rope between your legs. Hinge forward, then drive your hips through to stand. Pure hip hinge movement for glutes and hamstrings.",
    mistake: "Squatting down instead of hinging. Push your hips back like you are trying to touch the wall behind you.",
    modification: "Kettlebell or dumbbell swing if no cable machine — same movement pattern.",
    youtube: "https://www.youtube.com/results?search_query=cable+pull+through+tutorial+glutes",
  },
  {
    name: "Step Up",
    sets: "3x10 each leg",
    description: "Use a high box or bench. Place one foot fully on top. Drive through your front heel to step up. Squeeze glute at the top before lowering. Do not push off the back foot.",
    mistake: "Pushing off the back foot to help get up. All the force must come through the front leg.",
    modification: "Lower box or step if balance is a problem. Regular lunge as an alternative.",
    youtube: "https://www.youtube.com/results?search_query=step+up+exercise+glutes+tutorial+form",
  },
  {
    name: "Hip Abduction Machine (burnout)",
    sets: "3x20",
    description: "End of session burnout set. Slow and squeeze every single rep. Do not rush. This finishes off the glute medius — the muscle responsible for the outer glute shape.",
    mistake: "Using momentum to swing the weight out. Slow controlled reps only — momentum makes this exercise useless.",
    modification: "Side-lying clamshells on the floor as a replacement.",
    youtube: "https://www.youtube.com/results?search_query=hip+abduction+machine+burnout+glutes",
  },
];

// ============================================================
// FEMALE COMPLETE PROGRAMME
// Covers all 6 areas: shoulders, back, arms, glutes, hamstrings, calves
// 3 days/week — glute/posterior emphasis with full upper body balance
// ============================================================

export const FEMALE_DAY_A = `*Day A — Glutes + Shoulders + Arms*
Rest 60 sec between sets | 55–65 min

1. *Hip Thrust* — 4×12
Drive hips up, squeeze bum hard at top, lower slow

2. *Sumo Squat* — 3×12
Wide stance, toes out. Push knees out over toes

3. *Machine Shoulder Press* — 3×10
Press up, lower slow. Keep core tight

4. *Cable Lateral Raise* — 3×15 each arm
Raise to shoulder height. Control the weight down

5. *Bicep Curl* — 3×12
Full range. Squeeze at top. Elbows stay at your sides

6. *Tricep Pushdown* — 3×12
Push down, squeeze triceps. Elbows locked to ribs

7. *Standing Calf Raise* — 3×15
Full stretch down, full press up. Pause at top

Reply *DONE* when finished.

_Form videos:_
1. Hip Thrust: https://www.youtube.com/results?search_query=barbell+hip+thrust+tutorial+form
2. Sumo Squat: https://www.youtube.com/results?search_query=sumo+squat+glutes+tutorial
3. Shoulder Press: https://www.youtube.com/results?search_query=machine+shoulder+press+tutorial
4. Lateral Raise: https://www.youtube.com/results?search_query=cable+lateral+raise+tutorial
5. Bicep Curl: https://www.youtube.com/results?search_query=dumbbell+bicep+curl+tutorial
6. Tricep Pushdown: https://www.youtube.com/results?search_query=cable+tricep+pushdown+tutorial
7. Calf Raise: https://www.youtube.com/results?search_query=standing+calf+raise+tutorial`;

export const FEMALE_DAY_B = `*Day B — Back + Hamstrings*
Rest 75 sec between sets | 55–65 min

1. *Romanian Deadlift* — 3×10
Push bum back, lower until hamstring stretch. Back stays flat

2. *Leg Curl Machine* — 3×12
Curl heels to bum. Squeeze. Lower slow (3 seconds)

3. *Lat Pulldown* — 4×10
Pull to chest. Drive elbows down and back

4. *Seated Cable Row* — 4×10
Pull to belly. Squeeze shoulder blades. Sit tall

5. *Cable Kickback* — 3×15 each leg
Drive leg back, squeeze glute at top. Slow reps

6. *Face Pull* — 3×15
Pull rope to face, elbows high. Squeeze at end

7. *Seated Calf Raise* — 3×15
Full stretch down, full press up. Pause at top

Reply *DONE* when finished.

_Form videos:_
1. Romanian Deadlift: https://www.youtube.com/results?search_query=romanian+deadlift+tutorial+glutes
2. Leg Curl: https://www.youtube.com/results?search_query=leg+curl+machine+tutorial
3. Lat Pulldown: https://www.youtube.com/results?search_query=lat+pulldown+tutorial
4. Cable Row: https://www.youtube.com/results?search_query=seated+cable+row+tutorial
5. Cable Kickback: https://www.youtube.com/results?search_query=cable+kickback+glutes+tutorial
6. Face Pull: https://www.youtube.com/results?search_query=face+pull+cable+tutorial
7. Calf Raise: https://www.youtube.com/results?search_query=seated+calf+raise+tutorial`;

export const FEMALE_DAY_C = `*Day C — Full Body + Glutes*
Rest 75 sec between sets | 55–65 min

1. *Hip Thrust (heavier)* — 4×10
Go heavier than Day A. Squeeze hard at top

2. *Leg Press (wide stance)* — 3×12
Feet wide and high. Press through heels. Full range

3. *Incline Dumbbell Press* — 3×10
Bench at 30–45 degrees. Lower to chest, press up

4. *Hip Abduction Machine* — 3×15
Push knees apart. Squeeze. Sit tall, no leaning

5. *Cable Lateral Raise* — 3×12 each arm
Raise to shoulder height. Light weight, control it

6. *Hammer Curl* — 3×12
Palms face each other. Elbows pinned to sides

7. *Standing Calf Raise* — 3×15
Full stretch down, full press up. Add weight from last week

Reply *DONE* when finished.

_Form videos:_
1. Hip Thrust: https://www.youtube.com/results?search_query=barbell+hip+thrust+tutorial
2. Leg Press: https://www.youtube.com/results?search_query=leg+press+wide+stance+glutes+tutorial
3. Incline Press: https://www.youtube.com/results?search_query=incline+dumbbell+press+tutorial
4. Hip Abduction: https://www.youtube.com/results?search_query=hip+abduction+machine+tutorial
5. Lateral Raise: https://www.youtube.com/results?search_query=cable+lateral+raise+tutorial
6. Hammer Curl: https://www.youtube.com/results?search_query=hammer+curl+dumbbell+tutorial
7. Calf Raise: https://www.youtube.com/results?search_query=standing+calf+raise+tutorial`;

// ============================================================
// LEGACY GYM STRINGS (kept for backward compat with getKamlifeProgramme)
// ============================================================

export const BEGINNER_GYM_PROGRAMME = `*Full Body — Beginner (3 days/week)*
3 sets of 10 reps each | Rest 60 sec | 45–55 min

1. *Squat or Leg Press* — 3×10
Lower until thighs level. Push through heels. Chest up

2. *Bench Press or Chest Press Machine* — 3×10
Bar to chest. Press up. Lower slow (2 seconds)

3. *Lat Pulldown* — 3×10
Pull to chest. Elbows down and back. Squeeze

4. *Romanian Deadlift* — 3×10
Push bum back. Lower until hamstring stretch. Back flat

5. *Shoulder Press* — 3×10
Press overhead. Lower slow. Keep core tight

Each session: try 1 more rep. Hit 12 reps? Add small weight, drop to 10.

Reply *DONE* when finished.

_Form videos:_
1. Squat: https://www.youtube.com/results?search_query=barbell+squat+form+tutorial
2. Bench Press: https://www.youtube.com/results?search_query=bench+press+form+tutorial
3. Lat Pulldown: https://www.youtube.com/results?search_query=lat+pulldown+tutorial
4. Romanian Deadlift: https://www.youtube.com/results?search_query=romanian+deadlift+tutorial
5. Shoulder Press: https://www.youtube.com/results?search_query=dumbbell+shoulder+press+tutorial`;

export const INTERMEDIATE_GYM_UPPER = `*Upper Body — Intermediate*
4 sets | Rest 75 sec | 55–65 min

1. *Chest Press* — 4×10
Feel the chest working. Lower slow (2 sec)

2. *Seated Cable Row* — 4×10
Pull to belly. Squeeze shoulder blades. Sit tall

3. *Lat Pulldown* — 4×10
Full stretch at top, squeeze at bottom

4. *Shoulder Press* — 4×10
Press up controlled. No bouncing at bottom

5. *Cable Lateral Raise* — 3×15
Raise to shoulder height. Lower slow

6. *Tricep Pushdown* — 3×15
Elbows at sides. Push down, squeeze

7. *Cable Bicep Curl* — 3×15
Elbows fixed. Squeeze at top. Full range

Reply *DONE* when finished.

_Form videos:_
1. Chest Press: https://www.youtube.com/results?search_query=chest+press+machine+tutorial
2. Cable Row: https://www.youtube.com/results?search_query=seated+cable+row+tutorial
3. Lat Pulldown: https://www.youtube.com/results?search_query=lat+pulldown+tutorial
4. Shoulder Press: https://www.youtube.com/results?search_query=shoulder+press+machine+tutorial
5. Lateral Raise: https://www.youtube.com/results?search_query=cable+lateral+raise+tutorial
6. Tricep Pushdown: https://www.youtube.com/results?search_query=tricep+cable+pushdown+tutorial
7. Bicep Curl: https://www.youtube.com/results?search_query=cable+bicep+curl+tutorial`;

export const INTERMEDIATE_GYM_LOWER = `*Lower Body — Intermediate*
4 sets | Rest 75 sec | 55–65 min

1. *Hack Squat or Leg Press* — 4×10
Go deep. Control the way down. Press through heels

2. *Leg Extension* — 4×12
Squeeze quads hard at top. Lower slow

3. *Leg Curl* — 4×12
Full range. Slow lowering. Heavier than last time

4. *Hip Thrust* — 4×12
Drive hips up. Squeeze glutes hard at top

5. *Seated Calf Raise* — 4×15
Full stretch down, full press up. High reps

6. *Cable Crunch* — 3×15
Rope behind head. Crunch down, squeeze abs

Reply *DONE* when finished.

_Form videos:_
1. Hack Squat: https://www.youtube.com/results?search_query=hack+squat+machine+tutorial
2. Leg Extension: https://www.youtube.com/results?search_query=leg+extension+machine+tutorial
3. Leg Curl: https://www.youtube.com/results?search_query=leg+curl+machine+tutorial
4. Hip Thrust: https://www.youtube.com/results?search_query=hip+thrust+machine+tutorial
5. Calf Raise: https://www.youtube.com/results?search_query=seated+calf+raise+tutorial
6. Cable Crunch: https://www.youtube.com/results?search_query=cable+crunch+tutorial`;

export const HOME_PROGRAMME_GUIDE = `*Home Workout — No Gym Needed*
3 sets each | Rest 60 sec | 40–50 min

1. *Squat* — 3×15
Feet shoulder width. Go down until thighs level. Push up through heels

2. *Push-Up* — 3×10
Hands shoulder width. Body straight. Chest to floor, push up

3. *Glute Bridge* — 3×15
Lie on back. Push hips up. Squeeze bum at top. Hold 2 sec

4. *Reverse Lunge* — 3×10 each leg
Step back, lower knee to floor. Push up through front heel

5. *Table Row* — 3×10
Lie under a table. Grip edge. Pull chest up. Squeeze back

6. *Plank* — 3×30 seconds
Body straight. Core tight. Breathe steady

Getting easy? Add reps. Still easy? Move to harder version.

Reply *DONE* when finished.

_Form videos:_
1. Squat: https://www.youtube.com/watch?v=aclHkVaku9U
2. Push-Up: https://www.youtube.com/watch?v=IODxDxX7oi4
3. Glute Bridge: https://www.youtube.com/results?search_query=glute+bridge+tutorial
4. Lunge: https://www.youtube.com/results?search_query=reverse+lunge+tutorial
5. Table Row: https://www.youtube.com/results?search_query=table+row+home+workout+tutorial
6. Plank: https://www.youtube.com/results?search_query=plank+shoulder+tap+tutorial`;

// ============================================================
// EXERCISE LIBRARY — kept for backward compat (buildDayWorkoutForType)
// ============================================================

export const WORKOUTS: Record<string, Record<string, Exercise[]>> = {
  gym: {
    push: [
      { name: "Bench Press", sets: "3x10", description: "Lie on bench. Bar or dumbbells at chest. Press up until arms extended. Lower slowly. Feet flat.", mistake: "Bouncing bar off chest.", modification: "Dumbbell press with neutral grip if shoulder pain." },
      { name: "Overhead Press", sets: "3x10", description: "Bar or dumbbells at shoulder height. Press straight overhead. Core tight throughout. Lower slowly.", mistake: "Excessive lower back arch.", modification: "Seated press if lower back pain." },
      { name: "Incline Dumbbell Press", sets: "3x10", description: "Bench at 30 to 45 degrees. Dumbbells at chest. Press up and slightly in. Lower slowly.", mistake: "Elbows flaring too wide.", modification: "Flat bench if incline not available." },
      { name: "Lateral Raise", sets: "3x15", description: "Light dumbbells. Arms slightly bent. Raise to shoulder height only. Lower slowly. Do not shrug.", mistake: "Using momentum or raising above shoulder height.", modification: "One arm at a time holding a support." },
      { name: "Tricep Pushdown", sets: "3x12", description: "Cable machine. Rope or bar. Elbows pinned to sides. Push down fully. Squeeze at bottom. Return slowly.", mistake: "Elbows moving or leaning forward.", modification: "Overhead tricep extension with one dumbbell." },
    ],
    pull: [
      { name: "Barbell Row", sets: "3x10", description: "Hinge forward back flat. Pull bar to lower chest. Squeeze shoulder blades hard at top. Lower slowly.", mistake: "Rounding back or using momentum.", modification: "Single dumbbell row with knee on bench if lower back pain." },
      { name: "Lat Pulldown", sets: "3x10", description: "Sit at machine. Pull bar to upper chest. Lean back slightly. Squeeze back. Return slowly.", mistake: "Pulling with arms not back.", modification: "Use lighter weight and focus on feeling the back." },
      { name: "Seated Cable Row", sets: "3x10", description: "Feet on platform. Slight lean back. Pull handle to lower chest. Squeeze. Return slowly.", mistake: "Leaning too far back or forward.", modification: "Resistance band row seated on floor." },
      { name: "Face Pull", sets: "3x15", description: "Cable at face height. Pull rope to face. Elbows high and wide. Squeeze rear delts.", mistake: "Pulling too low or using too much weight.", modification: "Rear delt dumbbell fly lying face down on bench." },
      { name: "Bicep Curl", sets: "3x12", description: "Dumbbells or bar. Elbows pinned at sides. Curl fully. Lower slowly. Do not swing.", mistake: "Swinging torso or elbows drifting forward.", modification: "Seated dumbbell curl to remove momentum." },
    ],
    legs: [
      { name: "Barbell Back Squat", sets: "3x10", description: "Bar on upper back. Feet shoulder width. Lower until thighs parallel. Drive through heels. Chest up.", mistake: "Heels rising or chest collapsing forward.", modification: "Goblet squat with dumbbell if back pain." },
      { name: "Romanian Deadlift", sets: "3x10", description: "Hold dumbbells. Hinge at hips pushing bum back. Lower until hamstring stretch. Drive hips forward to stand.", mistake: "Rounding lower back.", modification: "Reduce range of motion if back pain." },
      { name: "Leg Press", sets: "3x12", description: "Sit in machine. Feet shoulder width on platform. Lower until 90 degrees. Push through heels.", mistake: "Knees caving inward.", modification: "Wider foot position if knee pain." },
      { name: "Leg Curl", sets: "3x12", description: "Lie face down on machine. Curl heels toward bum. Squeeze at top. Lower slowly.", mistake: "Hips rising off pad.", modification: "Standing single-leg band curl." },
      { name: "Hip Thrust", sets: "3x12", description: "Upper back on bench. Bar or weight on hips. Push hips up. Squeeze glutes hard at top. Lower slowly.", mistake: "Using lower back instead of glutes.", modification: "Glute bridge on floor if no bench." },
    ],
    core: [
      { name: "Plank", sets: "3x45 seconds", description: "Forearms on floor. Body straight from head to heels. Squeeze stomach hard. Hold and breathe.", mistake: "Hips sagging or rising too high.", modification: "Drop knees to floor." },
      { name: "Cable Crunch", sets: "3x15", description: "Kneel at cable. Rope at head. Crunch stomach toward floor. Hold briefly. Return slowly.", mistake: "Pulling with arms or neck.", modification: "Crunch on floor with hands behind head." },
      { name: "Hanging Knee Raise", sets: "3x12", description: "Hang from bar. Bring knees to chest. Lower slowly. Do not swing.", mistake: "Swinging hips for momentum.", modification: "Lying knee raise on bench or floor." },
      { name: "Russian Twist", sets: "3x20", description: "Sit at 45 degrees. Feet lifted. Rotate side to side. Touch floor each side.", mistake: "Twisting shoulders only instead of core.", modification: "Feet on floor to reduce difficulty." },
      { name: "Incline Treadmill Walk", sets: "15 minutes", description: "Incline 8 to 12 percent. Brisk walking pace. Do not hold the rails. Burns fat without destroying recovery.", mistake: "Holding rails which reduces effectiveness.", modification: "Reduce incline if joint pain." },
    ],
  },
  home: {
    push: [
      { name: "Push Up", sets: "3x12", description: "Hands slightly wider than shoulders. Body straight. Lower chest to floor. Push back up explosively.", mistake: "Hips rising or elbows flaring 90 degrees.", modification: "Knees on floor if too hard." },
      { name: "Pike Push Up", sets: "3x10", description: "Hips high like a triangle. Lower head toward floor between hands. Push back up.", mistake: "Bending the knees or not going low enough.", modification: "Regular push up if too hard." },
      { name: "Diamond Push Up", sets: "3x10", description: "Hands together forming a diamond under chest. Lower chest to hands. Push back up.", mistake: "Elbows flaring out.", modification: "Knees on floor if too hard." },
      { name: "Chair Tricep Dip", sets: "3x12", description: "Hands on edge of sturdy chair behind you. Feet out. Bend elbows to lower body. Push back up.", mistake: "Elbows flaring wide — keep them back.", modification: "Bend knees to reduce difficulty." },
    ],
    pull: [
      { name: "Table Row", sets: "3x12", description: "Lie under sturdy table. Grip edge. Body straight. Pull chest up to table. Lower slowly.", mistake: "Hips dropping or only pulling with arms.", modification: "Bend knees to make easier." },
      { name: "Superman Hold", sets: "3x30 seconds", description: "Lie face down. Lift arms, chest, and legs off floor simultaneously. Hold. Squeeze back and glutes.", mistake: "Only lifting arms and not engaging the full back.", modification: "Lift arms only or legs only if too hard." },
      { name: "Resistance Band Row", sets: "3x12", description: "Anchor band at waist height. Step back. Pull band to lower chest. Squeeze shoulder blades.", mistake: "Pulling with arms not back.", modification: "Table row if no bands." },
      { name: "Doorframe Curl", sets: "3x12", description: "Stand in doorframe. Grip with underhand. Lean back slightly. Pull yourself toward the frame.", mistake: "Elbows drifting too wide.", modification: "Table row if doorframe not available." },
    ],
    legs: [
      { name: "Bodyweight Squat", sets: "3x20", description: "Feet shoulder width. Arms forward for balance. Lower like sitting on chair. Push through heels.", mistake: "Knees caving inward.", modification: "Hold chair for balance. Only lower halfway if knee pain." },
      { name: "Glute Bridge", sets: "3x20", description: "Lie on back. Knees bent feet flat. Push hips up. Squeeze glutes hard at top. Lower slowly.", mistake: "Pushing through toes instead of heels.", modification: "Single leg version when this becomes easy." },
      { name: "Reverse Lunge", sets: "3x12 each", description: "Step backward. Lower back knee toward floor. Push through front heel to return.", mistake: "Front knee caving inward.", modification: "Hold chair for balance. Reduce range if knee pain." },
      { name: "Bulgarian Split Squat", sets: "3x10 each", description: "Back foot elevated on chair. Front foot far forward. Lower back knee toward floor. Drive up through front heel.", mistake: "Front knee tracking inward.", modification: "Regular split squat without elevation if balance is a problem." },
      { name: "Wall Sit", sets: "3x45 seconds", description: "Back flat on wall. Thighs parallel to floor. Hold. Breathe. Do not let knees cave.", mistake: "Knees going past toes or not reaching parallel.", modification: "Reduce time or raise the seat angle." },
    ],
    core: [
      { name: "Plank", sets: "3x30 seconds", description: "Forearms on floor. Body straight. Squeeze stomach. Hold and breathe.", mistake: "Hips sagging.", modification: "Knees on floor." },
      { name: "Mountain Climbers", sets: "3x30 seconds", description: "Push up position. Drive knees to chest alternating quickly. Hips level.", mistake: "Hips bouncing up with each drive.", modification: "Slow the pace. Elevate hands on chair if wrists hurt." },
      { name: "Bicycle Crunch", sets: "3x20", description: "Lie on back. Hands behind head. Bring opposite elbow to knee alternating. Do not pull neck.", mistake: "Rushing and losing control of the movement.", modification: "Regular crunch if neck pain." },
      { name: "Dead Bug", sets: "3x10 each side", description: "Lie on back. Arms up. Knees at 90 degrees. Extend opposite arm and leg toward floor. Return. Alternate.", mistake: "Lower back arching off the floor.", modification: "Only extend the legs if arms-and-legs is too hard." },
      { name: "Hollow Body Hold", sets: "3x20 seconds", description: "Lie on back. Arms overhead. Lift legs and shoulders off floor. Press lower back into ground. Hold.", mistake: "Arching the lower back off the floor.", modification: "Bend knees or only raise legs." },
    ],
  },
  walk: {
    session: [
      { name: "Brisk Walk", sets: "Phase 1: 15min | Phase 2: 25min | Phase 3: 35min | Phase 4: 45min", description: "Walk fast enough to feel slightly breathless but still able to talk. Arms swinging. Posture tall.", mistake: "Walking too slowly. Comfortable pace does not burn fat.", modification: "Reduce pace if breathless to discomfort. Start shorter if needed." },
    ],
  },
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

export function getPhaseMultiplier(phase: number): { sets: string; reps: string; rest: string } {
  switch (phase) {
    case 1: return { sets: "3", reps: "10", rest: "60 seconds" };
    case 2: return { sets: "4", reps: "8", rest: "90 seconds" };
    case 3: return { sets: "4", reps: "6", rest: "120 seconds" };
    case 4: return { sets: "5", reps: "5", rest: "120 seconds" };
    case 5: return { sets: "3", reps: "10", rest: "60 seconds" };
    default: return { sets: "3", reps: "10", rest: "60 seconds" };
  }
}

export function getPhaseNames(): Record<number, string> {
  return { 1: "Foundation", 2: "Build", 3: "Push", 4: "Peak", 5: "Deload" };
}

/**
 * getDayType
 *
 * For gym users this maps programmeDayInWeek mod 3 to a full-body day slot label.
 * The old calendar-day logic has been removed — gym day type is now always based
 * on how many sessions the user has actually done, not what day of the week it is.
 *
 * For home users the function returns push/pull/legs/core/rest — these are used
 * for menu display labels only, not actual programme delivery.
 *
 * @param dowOverride  Pass user.programmeDayInWeek for gym users.
 *                     Pass new Date().getDay() for home display labels.
 */
export function getDayType(
  dowOverride?: number
): "push" | "pull" | "legs" | "core" | "rest" | "full_a" | "full_b" | "full_c" {
  if (dowOverride === undefined) {
    // Default: return based on calendar day for backward compat (home display only)
    const dow = new Date().getDay();
    const map: Array<"push" | "pull" | "legs" | "core" | "rest"> =
      ["rest", "push", "pull", "legs", "core", "push", "pull"];
    return map[dow];
  }

  // For gym users: map programmeDayInWeek to full-body day slot
  // day 1 (and 4, 7...) → full_a
  // day 2 (and 5, 8...) → full_b
  // day 3 (and 6, 9...) → full_c
  const slot = ((dowOverride - 1) % 3) + 1;
  if (slot === 1) return "full_a";
  if (slot === 2) return "full_b";
  return "full_c";
}

// ============================================================
// GYM PROGRAMME SELECTOR
// Returns the correct Exercise[] array for the given day slot and user profile
// ============================================================

function getGymDay(
  daySlot: 1 | 2 | 3,
  isDumbbell: boolean,
  isGlutesFocus: boolean
): Exercise[] {
  if (isGlutesFocus) {
    const map = { 1: GYM_GLUTES_DAY_A, 2: GYM_GLUTES_DAY_B, 3: GYM_GLUTES_DAY_C };
    return map[daySlot];
  }
  if (isDumbbell) {
    const map = { 1: GYM_DUMBBELL_DAY_A, 2: GYM_DUMBBELL_DAY_B, 3: GYM_DUMBBELL_DAY_C };
    return map[daySlot];
  }
  const map = { 1: GYM_FULL_DAY_A, 2: GYM_FULL_DAY_B, 3: GYM_FULL_DAY_C };
  return map[daySlot];
}

function daySlotLabel(slot: 1 | 2 | 3, isGlutesFocus: boolean, isDumbbell: boolean): string {
  if (isGlutesFocus) {
    return ["Glute Push Day A", "Upper + Light Lower B", "Posterior Chain Day C"][slot - 1];
  }
  if (isDumbbell) {
    return [`Dumbbell Full Body A`, `Dumbbell Full Body B`, `Dumbbell Full Body C`][slot - 1];
  }
  return [`Full Body A`, `Full Body B`, `Full Body C`][slot - 1];
}

function formatGymDay(
  exercises: Exercise[],
  label: string,
  phase: number,
  phaseName: string,
  week: number,
  multiplier: { sets: string; reps: string; rest: string }
): string {
  let out = `*Week ${week} — ${label}*\nRest ${multiplier.rest} between sets\n\n`;
  const ytLinks: string[] = [];
  for (let i = 0; i < exercises.length; i++) {
    const ex = exercises[i];
    const num = i + 1;
    // Short one-line cue — just the key thing to remember
    const shortCue = ex.description.split(". ").slice(0, 1).join(". ");
    out += `${num}. *${ex.name}* — ${ex.sets}\n${shortCue}\n\n`;
    const yt = ex.youtube || `https://www.youtube.com/results?search_query=${ex.name.replace(/\s+/g, "+")}+tutorial`;
    ytLinks.push(`${num}. ${ex.name}: ${yt}`);
  }
  out += `Reply *DONE* when finished.\n\n_Form videos:_\n${ytLinks.join("\n")}`;
  return out;
}

// ============================================================
// HOME WORKOUT DAYS (3-day rotating full body)
// ============================================================

type HomeEx = { name: string; setsReps: string; cue: string; mistake: string; yt: string };

const HOME_DAYS: Record<number, HomeEx[]> = {
  1: [
    {
      name: "Bodyweight Squat",
      setsReps: "3 sets of 15 reps",
      cue: "Feet shoulder width. Lower until thighs parallel. Drive through heels. Chest up.",
      mistake: "Knees caving inward. Push knees out over toes throughout.",
      yt: "https://www.youtube.com/watch?v=aclHkVaku9U",
    },
    {
      name: "Push Up",
      setsReps: "3 sets of 10 reps",
      cue: "Hands shoulder width. Body straight from head to heels. Lower chest to floor. Push up explosively.",
      mistake: "Hips sagging or rising. Keep body in one straight line.",
      yt: "https://www.youtube.com/watch?v=IODxDxX7oi4",
    },
    {
      name: "Glute Bridge",
      setsReps: "3 sets of 15 reps",
      cue: "Lie on back. Feet flat hip width. Drive hips to ceiling. Squeeze glutes hard at top. Lower slowly.",
      mistake: "Pushing through the lower back instead of the glutes. Drive hips, do not arch back.",
      yt: "https://www.youtube.com/watch?v=OUgsJ8-Vi0E",
    },
    {
      name: "Reverse Lunge",
      setsReps: "3 sets of 12 each leg",
      cue: "Stand tall. Step one foot back. Lower back knee toward floor. Push through front heel to return. Torso upright.",
      mistake: "Front knee travelling past toes. Keep shin vertical.",
      yt: "https://www.youtube.com/watch?v=xrPteyQLGAo",
    },
    {
      name: "Table Row",
      setsReps: "3 sets of 12 reps",
      cue: "Sit under a sturdy table. Grip edge. Body straight. Pull chest up to table. Lower slowly.",
      mistake: "Hips dropping. Keep body rigid like a plank throughout.",
      yt: "https://www.youtube.com/watch?v=PGRiMK_2jLI",
    },
    {
      name: "Plank",
      setsReps: "3 sets of 30 seconds",
      cue: "Forearms on floor. Body straight from head to heels. Squeeze stomach hard. Breathe steadily.",
      mistake: "Hips rising or sagging. Keep everything in one line.",
      yt: "https://www.youtube.com/watch?v=ASdvN_XEl_c",
    },
  ],
  2: [
    {
      name: "Jump Squat",
      setsReps: "3 sets of 12 reps",
      cue: "Feet shoulder width. Squat to parallel. Explode upward. Land softly with bent knees. Reset.",
      mistake: "Landing stiff-legged. Absorb through hips and knees on every landing.",
      yt: "https://www.youtube.com/watch?v=A-cFYGvaKfc",
    },
    {
      name: "Decline Push Up",
      setsReps: "3 sets of 10 reps",
      cue: "Feet on chair or couch. Hands on floor. Lower chest toward floor. Press back up. Body straight.",
      mistake: "Hips rising to compensate. Keep core tight so body stays in a straight line.",
      yt: "https://www.youtube.com/watch?v=SKPab2YC9AY",
    },
    {
      name: "Single Leg Glute Bridge",
      setsReps: "3 sets of 10 reps each leg",
      cue: "Lie on back. One knee bent foot flat. Extend opposite leg. Drive hips up through planted heel. Squeeze hard at top.",
      mistake: "Hips dropping to one side. Keep hips level throughout the movement.",
      yt: "https://www.youtube.com/results?search_query=single+leg+glute+bridge+tutorial",
    },
    {
      name: "Walking Lunge",
      setsReps: "3 sets of 12 each leg",
      cue: "Step forward into a lunge. Back knee almost touches floor. Drive front foot into ground and step through. Keep torso upright.",
      mistake: "Leaning forward. Keep chest up and shoulders back throughout.",
      yt: "https://www.youtube.com/results?search_query=walking+lunge+tutorial+form",
    },
    {
      name: "Door Frame Row",
      setsReps: "3 sets of 12 reps",
      cue: "Stand in door frame. Grip sides at chest height. Lean back. Pull chest to door frame. Squeeze shoulder blades.",
      mistake: "Using momentum to swing forward. Control the movement in both directions.",
      yt: "https://www.youtube.com/results?search_query=doorframe+row+exercise+bodyweight",
    },
    {
      name: "Plank Shoulder Tap",
      setsReps: "3 sets of 20 taps (10 each side)",
      cue: "High plank position. Tap opposite shoulder with one hand. Replace hand. Repeat other side. Hips still.",
      mistake: "Hips rocking side to side with each tap. Brace core hard to keep hips square.",
      yt: "https://www.youtube.com/results?search_query=plank+shoulder+tap+tutorial",
    },
  ],
  3: [
    {
      name: "Bulgarian Split Squat",
      setsReps: "3 sets of 10 reps each leg",
      cue: "Back foot on chair behind you. Front foot forward. Lower back knee toward floor. Drive through front heel to rise.",
      mistake: "Front knee caving in. Keep it tracking over your middle toe throughout.",
      yt: "https://www.youtube.com/results?search_query=bulgarian+split+squat+tutorial+form",
    },
    {
      name: "Diamond Push Up",
      setsReps: "3 sets of 8 reps",
      cue: "Hands form a diamond shape under chest. Lower chest to hands. Press up. Elbows stay close to body.",
      mistake: "Elbows flaring out. Keep them tucked tight to target triceps correctly.",
      yt: "https://www.youtube.com/results?search_query=diamond+push+up+tutorial+form",
    },
    {
      name: "Hip Thrust",
      setsReps: "3 sets of 15 reps",
      cue: "Upper back on couch or chair. Feet flat on floor. Drive hips to ceiling. Squeeze hard at top. Lower slowly.",
      mistake: "Not getting full hip extension at the top. Push all the way up until body is flat.",
      yt: "https://www.youtube.com/results?search_query=hip+thrust+bodyweight+tutorial+beginners",
    },
    {
      name: "Deficit Lunge",
      setsReps: "3 sets of 10 reps each leg",
      cue: "Stand on a step or book stack. Step one foot forward to the floor. Lower into deep lunge. Rise and repeat.",
      mistake: "Front knee collapsing inward. Keep knee tracking over toe at all times.",
      yt: "https://www.youtube.com/results?search_query=deficit+lunge+tutorial+form",
    },
    {
      name: "Resistance Band Row",
      setsReps: "3 sets of 12 reps",
      cue: "Anchor band at chest height. Hold handles. Step back. Pull elbows back past your sides. Squeeze shoulder blades together.",
      mistake: "Shrugging shoulders up during the pull. Keep shoulders down and back.",
      yt: "https://www.youtube.com/results?search_query=resistance+band+row+tutorial+form",
    },
    {
      name: "Plank with Leg Raise",
      setsReps: "3 sets of 10 reps each leg",
      cue: "Forearm plank. Lift one leg 6 inches off floor. Hold 2 seconds. Lower. Switch legs. Core braced throughout.",
      mistake: "Hips rotating with each leg raise. Keep hips perfectly level.",
      yt: "https://www.youtube.com/results?search_query=plank+leg+raise+tutorial+form",
    },
  ],
};

// ============================================================
// getKamlifeProgramme
// Returns a formatted string overview of the user's programme.
// For gym users, returns the appropriate 3-day full body programme
// based on mode (full equipment vs dumbbell) and focus area.
// ============================================================

export function getKamlifeProgramme(user: any, todayOnly = false): string {
  const mode = user.trainingMode || "home";
  const exp = (user.trainingExperience || "beginner").toLowerCase();
  const age = user.age || 30;
  const programmeWeek = user.programmeWeek || 1;
  const isYouth = age < 18;
  const isElderly = age >= 60;

  // Progressive walking target — ramps up over weeks, not static from day 1
  const baseSteps = user.stepsTarget || 10000;
  let progressiveSteps = baseSteps;
  if (programmeWeek <= 2) {
    progressiveSteps = Math.round(baseSteps * 0.7); // Week 1-2: 70%
  } else if (programmeWeek <= 4) {
    progressiveSteps = Math.round(baseSteps * 0.85); // Week 3-4: 85%
  }
  // Week 5+: full target

  // Age-aware prefix
  let prefix = "";
  if (isElderly && todayOnly) {
    prefix = `*Warm-up first (5 min):* Light walk or march in place. Arm circles. Gentle leg swings. Ankle rotations.\n\n`;
  }
  if (isYouth && todayOnly) {
    prefix = `*Quick warm-up:* 30 star jumps, 10 high knees each side, arm swings.\n\n`;
  }

  // Walking target footer for today's workout
  let walkingFooter = "";
  if (todayOnly) {
    walkingFooter = `\n\n*Walking today:* ${progressiveSteps.toLocaleString()} steps${programmeWeek <= 4 ? ` (building up — full target is ${baseSteps.toLocaleString()})` : ""}. Send a screenshot or tell me your count.`;
  }

  if (mode !== "gym" && mode !== "gym_dumbbell") return prefix + HOME_PROGRAMME_GUIDE + walkingFooter;

  const isDumbbell = mode === "gym_dumbbell";
  const isGlutesFocus = user.primaryFocusArea === "glutes_legs";

  // Elderly safety note appended to every todayOnly workout
  const elderlyNote = isElderly && todayOnly
    ? `\n\n_💡 Senior tip: Use lighter weights with higher reps (12-15). If any movement causes joint pain, skip it and do the modification instead. Rest as long as you need between sets._`
    : "";
  // Youth safety note
  const youthNote = isYouth && todayOnly
    ? `\n\n_💡 Focus on form, not weight. No maxing out. If you can't do the full reps with good form, go lighter. Building habits now = gains for life._`
    : "";
  const safetyNote = elderlyNote || youthNote;

  if (isDumbbell) {
    if (todayOnly) {
      const day = user.programmeDayInWeek || 1;
      const daySlot = (((day - 1) % 4) + 1);
      const slotClamped = (daySlot <= 3 ? daySlot : 1) as 1 | 2 | 3;
      const exercises = getGymDay(slotClamped, true, false);
      const label = daySlot === 4 ? "Dumbbell Full Body D (Volume)" : daySlotLabel(slotClamped, false, true);
      const phase = user.programmePhase || 1;
      const multiplier = getPhaseMultiplier(phase);
      const phaseName = getPhaseNames()[phase] || "Foundation";
      return prefix + formatGymDay(exercises, label, phase, phaseName, user.programmeWeek || 1, multiplier) + safetyNote + walkingFooter;
    }
    const dayA = formatGymDay(GYM_DUMBBELL_DAY_A, "Dumbbell Full Body A", 1, "Foundation", 1, getPhaseMultiplier(1));
    const dayB = formatGymDay(GYM_DUMBBELL_DAY_B, "Dumbbell Full Body B", 1, "Foundation", 1, getPhaseMultiplier(1));
    const dayC = formatGymDay(GYM_DUMBBELL_DAY_C, "Dumbbell Full Body C", 1, "Foundation", 1, getPhaseMultiplier(1));
    return `${dayA}\n\n---\n\n${dayB}\n\n---\n\n${dayC}`;
  }

  if (isGlutesFocus) {
    if (todayOnly) {
      const day = user.programmeDayInWeek || 1;
      const femaleSlot = (((day - 1) % 4) + 1);
      let workout = FEMALE_DAY_A;
      if (femaleSlot === 2) workout = FEMALE_DAY_B;
      else if (femaleSlot === 3) workout = FEMALE_DAY_C;
      // Day 4 — repeat Day A focus (glutes) with higher volume
      return prefix + workout + safetyNote + walkingFooter;
    }
    return `${FEMALE_DAY_A}\n\n---\n\n${FEMALE_DAY_B}\n\n---\n\n${FEMALE_DAY_C}`;
  }

  // Standard gym full equipment
  if (exp === "intermediate" || exp === "advanced") {
    if (todayOnly) {
      const day = user.programmeDayInWeek || 1;
      const workout = day % 2 === 0 ? INTERMEDIATE_GYM_LOWER : INTERMEDIATE_GYM_UPPER;
      return prefix + workout + safetyNote + walkingFooter;
    }
    return `${INTERMEDIATE_GYM_UPPER}\n\n---\n\n${INTERMEDIATE_GYM_LOWER}`;
  }

  if (todayOnly) {
    const day = user.programmeDayInWeek || 1;
    const daySlot = (((day - 1) % 4) + 1);
    // 4-day rotation: A, B, C, then repeat A for volume
    const slotClamped = (daySlot <= 3 ? daySlot : 1) as 1 | 2 | 3;
    const exercises = getGymDay(slotClamped, false, false);
    const label = daySlot === 4 ? "Full Body D (Volume)" : daySlotLabel(slotClamped, false, false);
    const phase = user.programmePhase || 1;
    const multiplier = getPhaseMultiplier(phase);
    const phaseName = getPhaseNames()[phase] || "Foundation";
    return prefix + formatGymDay(exercises, label, phase, phaseName, user.programmeWeek || 1, multiplier) + safetyNote + walkingFooter;
  }

  const dayA = formatGymDay(GYM_FULL_DAY_A, "Full Body A", 1, "Foundation", 1, getPhaseMultiplier(1));
  const dayB = formatGymDay(GYM_FULL_DAY_B, "Full Body B", 1, "Foundation", 1, getPhaseMultiplier(1));
  const dayC = formatGymDay(GYM_FULL_DAY_C, "Full Body C", 1, "Foundation", 1, getPhaseMultiplier(1));
  return `${dayA}\n\n---\n\n${dayB}\n\n---\n\n${dayC}`;
}

// ============================================================
// buildDayWorkout
// The primary function used to generate today's session for a user.
// Gym users: day type is derived from programmeDayInWeek mod 3 — NOT calendar day.
// Home users: rotating 3-day full body split.
// ============================================================

// Exercises that load specific body areas — used to filter when injured
const INJURY_EXERCISE_MAP: Record<string, string[]> = {
  knee: ["squat", "lunge", "jump squat", "split squat", "leg press", "leg extension", "step up", "box jump", "bulgarian"],
  shoulder: ["push up", "overhead press", "shoulder press", "lateral raise", "front raise", "military press", "arnold press", "bench press", "incline press", "decline push"],
  back: ["deadlift", "bent over row", "barbell row", "good morning", "superman", "back extension", "hyperextension"],
  hip: ["squat", "lunge", "deadlift", "hip thrust", "glute bridge", "split squat", "step up", "sumo"],
  wrist: ["push up", "bench press", "overhead press", "barbell curl", "front raise"],
  ankle: ["squat", "lunge", "jump squat", "calf raise", "box jump", "step up", "split squat"],
};

function filterInjuredExercises(exercises: HomeEx[], injuries: string): { safe: HomeEx[]; skipped: string[] } {
  if (!injuries || injuries === "none") return { safe: exercises, skipped: [] };
  const injuryLower = injuries.toLowerCase();
  const blockedPatterns: string[] = [];
  for (const [area, patterns] of Object.entries(INJURY_EXERCISE_MAP)) {
    if (injuryLower.includes(area)) blockedPatterns.push(...patterns);
  }
  if (blockedPatterns.length === 0) return { safe: exercises, skipped: [] };
  const safe: HomeEx[] = [];
  const skipped: string[] = [];
  for (const ex of exercises) {
    const nameLower = ex.name.toLowerCase();
    if (blockedPatterns.some(p => nameLower.includes(p))) {
      skipped.push(ex.name);
    } else {
      safe.push(ex);
    }
  }
  return { safe, skipped };
}

export function buildDayWorkout(user: any): string {
  const mode = user.trainingMode || "home";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const multiplier = getPhaseMultiplier(phase);
  const week = user.programmeWeek || 1;
  const day = user.programmeDayInWeek || 1;
  const isFemaleGluteFocus = user.primaryFocusArea === "glutes_legs";
  const isDumbbell = mode === "gym_dumbbell";
  const injuries = user.injuries || "none";

  // Walk-only users
  if (mode === "walk_only" || mode === "walk") {
    const duration =
      phase === 1 ? "15 minutes" :
      phase === 2 ? "25 minutes" :
      phase === 3 ? "35 minutes" : "45 minutes";
    return `*Phase ${phase}: ${phaseName} — Week ${week}*\nToday: Day ${day}\n\n*Brisk Walk — ${duration}*\nWalk fast enough to feel slightly breathless but still able to talk. Arms swinging. Posture tall. Do not stop unless necessary.\n\nSend DONE when finished.`;
  }

  // Home users — rotating 3-day full body with progressive week-based variation
  if (mode !== "gym" && mode !== "gym_dumbbell") {
    // Cycle weeks 5-8 back through 1-4 base so progression repeats but at higher phase multiplier
    const weekInCycle = ((week - 1) % 8) + 1; // 1..8 then repeats
    const daySlot = (((day - 1) % 3) + 1) as 1 | 2 | 3;
    let allExercises = [...HOME_DAYS[daySlot]];

    // Week-based variation: progressive overload and exercise swap
    const cyclePhase = weekInCycle; // 1-8 within the cycle
    if (cyclePhase === 2 && daySlot === 1) {
      // Swap Bodyweight Squat → Jump Squat
      allExercises = allExercises.map(ex =>
        ex.name === "Bodyweight Squat" ? { ...HOME_DAYS[2][0], setsReps: "3 sets of 10 reps" } : ex
      );
    } else if (cyclePhase === 3) {
      // Add 2 reps to every exercise
      allExercises = allExercises.map(ex => ({
        ...ex,
        setsReps: ex.setsReps.replace(/(\d+) reps/, (_, n) => `${Math.min(parseInt(n) + 2, 20)} reps`)
          .replace(/(\d+) seconds/, (_, n) => `${parseInt(n) + 10} seconds`),
      }));
    } else if (cyclePhase === 4) {
      // Swap middle exercises for novelty
      if (daySlot === 1 && HOME_DAYS[3].length > 2) {
        allExercises[2] = HOME_DAYS[3][2];
      } else if (daySlot === 2 && HOME_DAYS[1].length > 1) {
        allExercises[1] = HOME_DAYS[1][1];
      }
    } else if (cyclePhase === 5) {
      // Tempo week: slow eccentric (3 seconds down on every exercise)
      allExercises = allExercises.map(ex => ({
        ...ex,
        setsReps: ex.setsReps.replace(/(\d+) reps/, (_, n) => `${n} reps (3-sec lowering)`),
        cue: ex.cue + " Lower SLOWLY over 3 seconds — this is where the muscle builds.",
      }));
    } else if (cyclePhase === 6) {
      // Volume week: 4 sets instead of 3
      allExercises = allExercises.map(ex => ({
        ...ex,
        setsReps: ex.setsReps.replace(/^3 sets/, "4 sets"),
      }));
    } else if (cyclePhase === 7) {
      // Advanced week: use Day 3 exercises (hardest pool) regardless of day slot
      allExercises = [...HOME_DAYS[3]];
    } else if (cyclePhase === 8) {
      // Deload week: 2 sets, focus on form — important for recovery
      allExercises = allExercises.map(ex => ({
        ...ex,
        setsReps: ex.setsReps.replace(/^[34] sets/, "2 sets"),
        cue: ex.cue + " Deload week — focus on perfect form, not intensity.",
      }));
    }

    const { safe: exercises, skipped } = filterInjuredExercises(allExercises, injuries);
    const goal = user.goalType || "fat_loss";
    const goalNote = goal === "fat_loss"
      ? `_Fat loss tip: rest 45 seconds between sets (not 90). Higher heart rate = more calories burned._`
      : goal === "muscle_gain"
        ? `_Muscle tip: add reps each time — when you hit the top of the rep range easily, add a set next session._`
        : `_Recomp tip: push all sets to near-failure. The last 2 reps should feel hard._`;

    let workout = `*Week ${week} — Home Day ${daySlot}*\nRest ${multiplier.rest} between sets | 40–50 min total\n\n`;
    const ytLinks: string[] = [];
    for (let i = 0; i < exercises.length; i++) {
      const ex = exercises[i];
      const num = i + 1;
      const displaySetsReps = phase > 1 ? `${multiplier.sets} sets of ${multiplier.reps} reps` : ex.setsReps;
      workout += `${num}. *${ex.name}* — ${displaySetsReps}\n${ex.cue}\n\n`;
      ytLinks.push(`${num}. ${ex.name}: ${ex.yt}`);
    }
    if (skipped.length > 0) {
      workout += `⚠️ *Skipped due to ${injuries}:* ${skipped.join(", ")}. These return when you report recovery.\n\n`;
    }
    if (isFemaleGluteFocus && !skipped.some(s => s.toLowerCase().includes("glute"))) {
      workout += `*Glute Focus Add-on:* Add an extra set of Glute Bridge or Hip Thrust at the end. Slow the lowering phase to 3 seconds.\n\n`;
    }
    workout += `Reply *DONE* when finished.\n\n${goalNote}\n\n_Form videos:_\n${ytLinks.join("\n")}`;
    return workout;
  }

  // Female complete programme (shoulders/back/arms/glutes/hamstrings/calves)
  if (isFemaleGluteFocus) {
    const femaleSlot = (((day - 1) % 3) + 1);
    if (femaleSlot === 1) return FEMALE_DAY_A;
    if (femaleSlot === 2) return FEMALE_DAY_B;
    return FEMALE_DAY_C;
  }

  // 4-day upper/lower split — for intermediate/advanced gym users training 4+ days
  const trainingDays = user.trainingDaysPerWeek || 3;
  const exp = user.trainingExperience || "beginner";
  if (trainingDays >= 4 && (exp === "intermediate" || exp === "advanced")) {
    // Alternate upper/lower: odd days = upper, even days = lower
    const isUpperDay = day % 2 !== 0;
    return isUpperDay ? INTERMEDIATE_GYM_UPPER : INTERMEDIATE_GYM_LOWER;
  }

  // Gym users — ALWAYS use programmeDayInWeek mod 3 to pick day slot
  // Never use calendar day of week for gym sessions
  const daySlot = (((day - 1) % 3) + 1) as 1 | 2 | 3;
  const exercises = getGymDay(daySlot, isDumbbell, isFemaleGluteFocus);
  const label = daySlotLabel(daySlot, isFemaleGluteFocus, isDumbbell);
  return formatGymDay(exercises, label, phase, phaseName, week, multiplier);
}

// ============================================================
// buildDay1Workout / buildDay2Workout / buildDay3Workout
// Progressive delivery: Day 1 sent at onboarding, Day 2 after Day 1 DONE,
// Day 3 after Day 2 DONE.
// ============================================================

export function buildDay1Workout(user: any): string {
  return buildDayWorkout({ ...user, programmeDayInWeek: 1 });
}

export function buildDay2Workout(user: any): string {
  return buildDayWorkout({ ...user, programmeDayInWeek: 2 });
}

export function buildDay3Workout(user: any): string {
  return buildDayWorkout({ ...user, programmeDayInWeek: 3 });
}

// ============================================================
// buildFullProgramme
// Returns only Day 1 for new users (initial delivery at onboarding).
// Days 2 and 3 are sent progressively via buildDay2Workout / buildDay3Workout
// when the user logs DONE.
// ============================================================

export function buildFullProgramme(user: any): string {
  const mode = user.trainingMode || "home";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const week = user.programmeWeek || 1;

  if (mode !== "gym" && mode !== "gym_dumbbell") {
    // Home: deliver Day 1 only at onboarding
    const day1 = buildDayWorkout({ ...user, programmeDayInWeek: 1 });
    return `*Phase ${phase}: ${phaseName} — Week ${week} | Full Body Home Programme*\nTrain on non-consecutive days. Each session hits squat, push, hinge, pull, and core.\n\n${day1}`;
  }

  // Female programme: send Day A first
  const isFemaleGluteFocusFull = user.primaryFocusArea === "glutes_legs";
  if (isFemaleGluteFocusFull) {
    return `*Your 3-Day Programme — Shoulders, Back, Arms, Glutes, Hamstrings, Calves*\nTrain Monday, Wednesday, Friday or Tuesday, Thursday, Saturday. Never two days in a row.\n\n${FEMALE_DAY_A}`;
  }

  // 4-day upper/lower: send Upper (Day 1) first — Lower follows after DONE
  const trainingDays = user.trainingDaysPerWeek || 3;
  const exp = user.trainingExperience || "beginner";
  if (trainingDays >= 4 && (exp === "intermediate" || exp === "advanced")) {
    return `*4-Day Upper/Lower Split — Week ${week}*\nMonday + Thursday: Upper Body. Tuesday + Friday: Lower Body. Rest Wednesday, Saturday, Sunday.\n\n${INTERMEDIATE_GYM_UPPER}`;
  }

  // Gym: deliver Day 1 only — Days 2 and 3 follow after DONE is logged
  return buildDay1Workout(user);
}

// ============================================================
// buildDayWorkoutForType
// Backward-compatible function for forcing a specific day type.
// For home users returns today's full-body home session.
// For gym users returns the session for the specified type (legacy push/pull/legs).
// ============================================================

export function buildDayWorkoutForType(
  user: any,
  forcedType: "push" | "pull" | "legs" | "core"
): string {
  const mode = user.trainingMode || "home";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const multiplier = getPhaseMultiplier(phase);
  const week = user.programmeWeek || 1;
  const isFemaleGluteFocus = user.primaryFocusArea === "glutes_legs";

  if (mode !== "gym" && mode !== "gym_dumbbell") {
    return buildDayWorkout(user);
  }

  const library = WORKOUTS.gym;
  const dayLabel: Record<string, string> = {
    push: "Push Day",
    pull: "Pull Day",
    legs: "Legs Day",
    core: "Core Day",
  };
  const exercises = library[forcedType];
  const sessionExercises =
    forcedType === "legs" && isFemaleGluteFocus ? exercises : exercises.slice(0, 4);

  // Use the clean short format — same as formatGymDay
  let workout = `*Week ${week} — ${dayLabel[forcedType]}*\nRest ${multiplier.rest} between sets\n\n`;
  const ytLinks: string[] = [];
  for (let i = 0; i < sessionExercises.length; i++) {
    const ex = sessionExercises[i];
    const num = i + 1;
    const setsDisplay =
      ex.sets.includes("seconds") || ex.sets.includes("min")
        ? `${multiplier.sets}x${ex.sets.split("x").pop() || ex.sets}`
        : `${multiplier.sets}x${multiplier.reps}`;
    const shortCue = ex.description.split(". ").slice(0, 1).join(". ");
    workout += `${num}. *${ex.name}* — ${setsDisplay}\n${shortCue}\n\n`;
    const yt = `https://www.youtube.com/results?search_query=${ex.name.replace(/\s+/g, "+")}+tutorial`;
    ytLinks.push(`${num}. ${ex.name}: ${yt}`);
  }
  workout += `Reply *DONE* when finished.\n\n_Form videos:_\n${ytLinks.join("\n")}`;
  return workout;
}

// ============================================================
// WORKOUT_DONE_RESPONSES
// ============================================================

export const WORKOUT_DONE_RESPONSES = [
  (total: number, day: number) =>
    `Workout ${total} done. Day ${day} logged and banked. Rest, eat your protein, come back stronger.`,
  (total: number, day: number) =>
    `Session ${total} complete. Day ${day} in the books. Consistency over intensity — every single time.`,
  (total: number, _day: number) =>
    `${total} workouts done. You showed up when it was hard. That is the difference between clients who change and clients who talk about it.`,
  (total: number, _day: number) =>
    `Done. ${total} sessions logged. Your body is adapting right now, even if you cannot see it yet. Trust the process.`,
  (total: number, day: number) =>
    `Workout ${total} complete. Day ${day} ticked off. No shortcuts, no excuses. That is how Coach K clients do it.`,
  (total: number, _day: number) =>
    `${total} sessions and counting. You did not feel like it and you did it anyway. That is the whole game.`,
];
