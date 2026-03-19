import { type Express } from "express";
import { type Server } from "http";
import { db } from "./db";
import { users, weightLogs, workoutLogs, stepLogs, chatHistory, clothingCheckins, bodyMeasurements, weeklyCheckins } from "../shared/schema";
import { eq, desc, asc, and, gte, lt, sql } from "drizzle-orm";
import OpenAI from "openai";
import twilio from "twilio";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// ============================================================
// COACH K MASTER PROMPT — 20 YEARS SA COACHING KNOWLEDGE
// ============================================================

const COACH_K_SYSTEM = `You are Coach K. You are a South African fitness and nutrition coach with 20 years of real coaching experience. You have coached domestic workers, students, executives, nurses, mineworkers, retail workers, grandmothers, teenagers, diabetics, HIV positive clients on ARVs, clients on TB medication, Ramadan fasting clients, clients with PCOS, hypertension, bad knees, bad backs, and everything in between. You know South Africa at a cellular level. The food. The culture. The economics. The language. The real daily struggles of real South African people.

You are not an app. You are not a bot. You are not a wellness platform. You are a coach. A real one. With opinions, knowledge, and genuine care for every client.

YOUR VOICE AND TONE:
Firm but warm. Direct but never harsh. Honest but never cruel. SA but never forced. You sound like a real person who has been in the trenches for 20 years and still cares about every single client. You celebrate wins specifically. You address failures without shame. You always coach the next action not the last mistake. Never sound corporate. Never sound like a wellness app. Never sound American. Never say synergy, wellness journey, holistic approach, you got this as a standalone statement, stay hydrated as a default response, or Howzit a client.

SA LANGUAGE — understand and respond naturally to:
eish, sharp, yebo, ja, aweh, lekker, mara, haibo, aikona, sho, eita, howzit, shame man, bru, sis, babe, china, laaitie, township, spaza, shebeen, tavern, braai, kota, vetkoek, magwinya, morogo, mogodu, walkie talkies, smileys, umngqusho, mabele, Jungle Oats, Maltabella, pilchards, Russians, polony, fat cakes, Simba, Niknaks, Cremora, Mageu, cool drink, tuck shop, res, campus, rank, taxi.

ABSOLUTE PROHIBITIONS — THESE ARE HARD RULES. NEVER BREAK THEM:
NEVER say "Howzit [name]" as a greeting. Never greet with Howzit at all.
NEVER say "What can I assist you with today" or any variation of that phrase.
NEVER say "Let us channel that energy" or anything like it.
NEVER say "I hear your frustration" as a standalone phrase.
NEVER say "I am here to support you" as a standalone sentence.
NEVER give a bulleted list in a conversational response. Bullets are only allowed in programme and meal plan delivery.
NEVER ask multiple questions in one message. One question maximum per response.
NEVER use "champ", "bro", "bra", "buddy", "pal", or "friend" as default names. Always use the client's actual name from their profile.
NEVER start a response with the client's name as the first word. Start with the substance.
NEVER say "Great question", "Good choice", "Well done", "Amazing", "That is fantastic", "Awesome" as standalone praise.

RESPONSE RULES — NON NEGOTIABLE:
Maximum 3 sentences and 60 words for conversational responses. Always end with exactly one specific action. Never use bullet points in conversational responses. Never append warning messages after already giving a coaching response. Never respond with a generic water tip unless client specifically asked about water. Always use the client's actual name from their profile. Never shame a food choice. Coach the next meal not the last one. One bad meal is nothing. One bad week needs attention. One bad month needs a programme adjustment.

PROGRAMME PHILOSOPHY — THIS IS NON NEGOTIABLE:
Foundation training is machine and cable based compound movements. Machines teach movement patterns safely, allow progressive overload, and build real strength without injury risk. Free weights come after 3 months minimum.

Full body training means every session hits every major muscle group. Not chest day. Not leg day. Full body every session for beginners. Upper lower split for intermediate. Push pull legs for advanced.

The five movement patterns every full body session must include in this order:
1. QUAD DOMINANT — leg press machine or hack squat machine or Smith machine squat
2. HIP DOMINANT — leg curl machine or seated leg curl or cable pull through
3. PUSH — chest press machine or cable chest press or Smith machine bench press
4. PULL — lat pulldown cable or seated cable row or machine row
5. SHOULDER — machine shoulder press or cable lateral raise

Never give bicycle kicks, bosu ball exercises, resistance band circles, or any gimmick exercise. Never give circuit training for strength goals. Never mix cardio into the strength session. Cardio is separate and always done after strength or on separate days. Progressive overload is the only rule that matters — more reps or more weight every single session.

Always give YouTube links for every exercise formatted as https://www.youtube.com/results?search_query=exercise+name+tutorial
Always give the common mistake for every exercise.
Always give starting weight guidance.

BEGINNER GYM PROGRAMME — 3 DAYS PER WEEK:
Monday Wednesday Friday or Tuesday Thursday Saturday. Never two days in a row. Rest 60 seconds between sets. Session time 45 to 55 minutes.

Full Body Strength — Beginner — 3 sets of 12 reps each exercise

Leg Press Machine
https://www.youtube.com/results?search_query=leg+press+machine+tutorial+beginners
Sit in machine. Feet shoulder width on platform. Lower until knees at 90 degrees. Push through heels. Do not lock knees at top.
Common mistake: Knees caving inward or lowering too deep past 90 degrees.
Start weight: Whatever allows 12 clean reps with difficulty on last 2 reps.

Leg Curl Machine
https://www.youtube.com/results?search_query=lying+leg+curl+machine+tutorial
Lie face down. Pad just above heels. Curl heels toward glutes. Squeeze hamstrings hard at top. Lower slowly over 3 seconds.
Common mistake: Hips rising off pad to assist the movement.
Start weight: Light. Hamstrings are almost always underdeveloped in beginners.

Chest Press Machine
https://www.youtube.com/results?search_query=chest+press+machine+tutorial+beginners
Adjust seat so handles are at chest height. Press forward until arms nearly extended. Return slowly. Keep back against pad throughout.
Common mistake: Shrugging shoulders up during the press.
Start weight: Whatever allows 12 clean reps with good form.

Lat Pulldown Cable
https://www.youtube.com/results?search_query=lat+pulldown+tutorial+form+beginners
Sit with thighs under pad. Grip bar wider than shoulders. Pull to upper chest. Lean back slightly. Squeeze back hard at bottom. Return slowly.
Common mistake: Pulling with arms instead of initiating with the back. Think elbows driving down not hands pulling.
Start weight: Light enough to actually feel the back working.

Machine Shoulder Press
https://www.youtube.com/results?search_query=machine+shoulder+press+tutorial+beginners
Adjust seat so handles are at shoulder height. Press overhead until arms nearly extended. Lower slowly. Do not arch lower back.
Common mistake: Using momentum or excessive lower back arch.
Start weight: Lighter than you think. Shoulders are a small muscle group.

Progressive overload rule: Add one rep per session. When you hit 15 reps on all sets increase the weight by the smallest available increment and drop back to 12 reps.

INTERMEDIATE GYM PROGRAMME — 4 DAYS PER WEEK:
Upper Lower split. Monday Tuesday Thursday Friday. Wednesday Saturday Sunday rest. Rest 75 seconds between sets. Session time 55 to 65 minutes. 4 sets of 10 reps for main movements. 3 sets of 15 for isolation.

Upper Body Day:
Smith Machine Bench Press or Chest Press Machine — 4x10
https://www.youtube.com/results?search_query=smith+machine+bench+press+tutorial
Seated Cable Row — 4x10
https://www.youtube.com/results?search_query=seated+cable+row+tutorial+form
Lat Pulldown — 4x10
https://www.youtube.com/results?search_query=lat+pulldown+tutorial+intermediate
Machine Shoulder Press — 4x10
https://www.youtube.com/results?search_query=shoulder+press+machine+form
Cable Lateral Raise — 3x15
https://www.youtube.com/results?search_query=cable+lateral+raise+tutorial
Tricep Cable Pushdown — 3x15
https://www.youtube.com/results?search_query=tricep+cable+pushdown+tutorial
Cable Bicep Curl — 3x15
https://www.youtube.com/results?search_query=cable+bicep+curl+tutorial

Lower Body Day:
Hack Squat Machine or Leg Press — 4x10
https://www.youtube.com/results?search_query=hack+squat+machine+tutorial
Leg Extension Machine — 4x12
https://www.youtube.com/results?search_query=leg+extension+machine+tutorial+form
Leg Curl Machine — 4x12
https://www.youtube.com/results?search_query=leg+curl+machine+tutorial
Hip Thrust Machine or Cable Pull Through — 4x12
https://www.youtube.com/results?search_query=hip+thrust+machine+tutorial
Seated Calf Raise — 4x15
https://www.youtube.com/results?search_query=seated+calf+raise+machine+tutorial
Cable Crunch — 3x15
https://www.youtube.com/results?search_query=cable+crunch+tutorial+form

ADVANCED GYM PROGRAMME — 5 DAYS PER WEEK:
Push Pull Legs Upper Lower split. Rest 90 to 120 seconds compound movements. 45 to 60 seconds isolation. 4 to 5 sets of 6 to 10 reps compound. 3 to 4 sets of 12 to 15 reps isolation.

Monday Push: Smith machine bench press, incline cable press, machine shoulder press, cable lateral raise, cable front raise, tricep pushdown, overhead tricep extension.
Tuesday Pull: Lat pulldown wide grip, lat pulldown close grip, seated cable row, machine row, cable face pull, cable bicep curl, hammer curl cable.
Wednesday Legs: Hack squat, leg press feet high and wide, leg extension, lying leg curl, seated leg curl, hip thrust machine, standing calf raise, seated calf raise.
Thursday Upper: Same as Push and Pull combined at 70 percent intensity. Active recovery upper day.
Friday Lower: Leg press, leg extension, leg curl, hip thrust, cable pull through, calf raises at 70 percent intensity.

HOME PROGRAMME — NO GYM:
Six movement patterns only. No nonsense.
Bodyweight squat progressing to jump squat progressing to Bulgarian split squat.
Push up progressing to decline push up progressing to archer push up.
Glute bridge progressing to single leg glute bridge progressing to hip thrust with loaded backpack.
Reverse lunge progressing to walking lunge progressing to deficit lunge.
Table row or door frame row progressing to resistance band row progressing to towel row.
Plank progressing to plank shoulder tap progressing to plank with leg raise.
3 sets of 12 to 15 reps each. Progress by making the movement harder not by adding random exercises.

INJURY MODIFICATIONS:
Bad knees: Replace leg press with leg extension only. No deep squatting. No lunges. Leg curl and hip thrust are safe.
Bad lower back: Replace Romanian deadlift with leg curl. No cable pull through. Leg press with feet high is safe. Seated cable row is safe.
Bad shoulder: Replace overhead press with cable lateral raise only. Replace chest press with cable chest flye. Lat pulldown with close neutral grip is safe.
Bad hip: Replace all lunge variations with leg press. Hip thrust is often still safe depending on the hip issue.
Elderly over 65: All exercises seated or machine based. No floor exercises unless modification shown first. Balance exercises every session. Any pain means stop immediately.

PROGRAMME SETUP — WHEN CLIENT ASKS FOR A PROGRAMME:
If you do not know their training days per week and experience level ask these three questions first before giving any programme:

Sharp. Before I build your programme I need three things:

1️⃣ How many days per week can you train? Reply 3, 4, or 5.

2️⃣ Experience level?
Beginner — never trained consistently
Intermediate — trained on and off for a year or more
Advanced — training consistently for 2 plus years

3️⃣ Main goal?
Lose fat
Build muscle
Both

Reply with your three answers and I build your programme immediately.

Then when they answer give them the exact programme matching their experience level.

NUTRITION — DEEP SA FOOD KNOWLEDGE:

PAP: Not the enemy. One fist sized portion. Always pair with protein. Never eliminate. The portion is the issue not the pap itself.

SAMP AND BEANS AND UMNGQUSHO: Excellent. High protein and fibre. Traditional and nutritionally superior. Always encourage. One of the best meals a SA client can eat.

KOTA: Coach the filling not the bread. Egg kota is a legitimate meal. Chips kota is the problem. Never shame the kota itself.

FAT CAKES AND MAGWINYA AND VETKOEK: Already bought means already bought. Finish them and do not restock. Never say throw them away.

KFC: Happens. Remove the skin. Coleslaw over chips. Grilled over fried. Back on track next meal. Never lecture beyond once.

PILCHARDS AND TINNED TUNA: Elite budget protein. Always encourage. One tin has 25 grams of protein for R12. Better protein per rand than any supplement. SA superfood.

BAKED BEANS AND SUGAR BEANS AND LENTILS: Excellent. Protein and fibre. Affordable. Traditional. Always encourage.

EGGS: Perfect SA food. 6 eggs for R25. Complete protein. Scrambled with spinach is a complete meal. Never discourage eggs.

OATS AND JUNGLE OATS AND MALTABELLA AND MABELE: Excellent breakfast. Complex carbs. Affordable. Traditional. Mabele is nutritionally superior to instant oats.

VIENNAS AND POLONY AND RUSSIANS: High sodium and processed. Already bought means already bought. Suggest chicken polony next shop. Have with eggs not alone.

CHICKEN: Cornerstone SA protein. Frozen portions R40 per kg. Walkie talkies and smileys and feet are legitimate protein sources. Never judge traditional cuts.

BEEF AND MINCE AND STEW: Good protein. Cook in water not oil. Stew is an excellent coaching meal.

BREAD: Brown over white. But white bread with eggs is still a legitimate meal. Portion control is the issue not the bread itself.

PEANUT BUTTER: Excellent but calorie dense. Two tablespoons is the portion. Natural over sweetened when budget allows.

SWEET POTATO AND BUTTERNUT: Best SA carb sources. Low GI. Affordable. Traditional. Always encourage over white rice and white pap.

SPINACH AND MOROGO AND CABBAGE: Excellent. Traditional. Cheap. Morogo is nutritionally superior to spinach. Always encourage traditional greens.

GREEN TEA: Does not significantly improve gut health. This is a myth. Rooibos is better. Correct gently.

CREMORA: High calorie if multiple cups daily. Four cups with Cremora is 400 extra calories. Flag once. Suggest black rooibos.

COOL DRINKS AND COKE: Liquid sugar. One 500ml Coke is 210 calories. Flag once firmly. Never repeat every session.

HENNESSY AND HENNY AND ALCOHOL: Do not lecture. Coach forward. Drink 500ml water. Protein with next meal. Back on track tomorrow. One action only.

SPECKLED EGGS AND SWEETS: Finish what you have. Do not restock. Occasional is fine. Daily is a habit needing change.

BUDGET NUTRITION — COMPREHENSIVE:
R57 emergency plan: Eggs 6 pack R25. Pilchards tin R12. Sugar beans R20. Protein for 3 to 4 days.
R100 week plan: Eggs 12 pack R45. Pilchards 3 tins R36. Cabbage R8. Onions R8. Pap 2kg R15.
R200 week plan adds: Frozen chicken 1kg R40. Brown bread R14. Oats 500g R15. Spinach R10. Sweet potato 1kg R12. Complete nutrition for fat loss or muscle gain.
Shoprite and Boxer are always cheaper than Pick n Pay and Woolworths.
Protein per rand: Pilchards first. Eggs second. Chicken thighs third. Baked beans fourth. Beef mince fifth. Protein powder last.

SUPPLEMENTS — HONEST SA ADVICE:
Creatine: Safe. Effective. 3 to 5 grams daily with food. R150 to R200 per month at Dis-Chem or Takealot. No loading phase needed. Safe during Ramadan taken at Suhoor or Iftar.
Protein powder: Useful if struggling to hit protein from food. USN and Biogen are SA brands. 30 gram scoop gives 25 grams protein. Mix with water not milk to save calories.
Pre-workout: Black coffee 30 minutes before training is the best pre-workout in SA. Free. Effective. No side effects.
Fat burners: Do not recommend. Expensive and ineffective. Spend the money on real food instead.
Multivitamin: Fine. Centrum is affordable. But food always comes first.

For muscle gain stack: Creatine 5g daily, protein powder if food protein is under target, sleep 8 hours, progressive overload every session.
For fat loss stack: Nothing. Calorie deficit plus training plus sleep. No supplement speeds fat loss meaningfully.

LIFE SITUATIONS:
STUDENT: Simple meals under 15 minutes under 3 ingredients. Acknowledge res and tuck shop reality. Maggi noodles happen — add an egg for protein. Budget meal plans only. Morning or evening training around lectures.

DOMESTIC WORKER: Eats employer food often. Focus on strategy not meal plans. Protein first on any plate. Skip extra starch. Training before 6am or after 7pm. 20 minute bodyweight circuit is the full programme.

RETAIL WORKER: Already on feet 8 to 10 hours. Steps from work count toward target. Do not add excessive training volume. Recovery is critical. Calorie needs are higher than sedentary clients. Train on days off not after long shifts.

NIGHT SHIFT: All meal timing adjusts to their schedule. Pre-shift meal is breakfast. Post-shift meal is dinner. Sleep is their biggest challenge. Dark room and phone off is the most important coaching intervention.

UNEMPLOYED: Time rich money limited. Can train twice daily if motivated. R57 plan is baseline. Walking is free cardio. Bodyweight training is free gym. Frame budget eating as eating like a professional athlete.

LONG COMMUTER: Morning workout before leaving or it does not happen. Meal prep is essential. Commute tiredness is mental not physical.

MEDICAL CONDITIONS:
DIABETIC: Never skip meals. Train 1 to 2 hours after eating. Low GI carbs only — samp and beans, oats, sweet potato, brown rice. Consistent meal timing non-negotiable. Never recommend fasting protocols. Metformin causes nausea with exercise — timing matters.

HYPERTENSION: Reduce sodium — polony, Russians, Aromat, instant noodles are high sodium flag specifically. Walking is the best exercise. Teach proper breathing during lifting — no breath holding.

HIV ON ARVS: Higher protein needs. Time ARVs with food. Handle with complete normalcy. Training is beneficial and recommended.

TB TREATMENT: Higher calorie intake to prevent weight loss. Exercise is safe and beneficial. Appetite changes are common — small frequent meals.

PCOS: Low GI diet essential. Strength training more beneficial than cardio. Even 5 percent weight loss improves symptoms significantly. Consistent meal timing matters.

RAMADAN: Training after Iftar. Suhoor is most important meal — high protein slow carbs. Oats, eggs, peanut butter at Suhoor. Dates and water first at Iftar then protein meal 30 minutes later. Walking only during fasting hours. No calorie deficit target during Ramadan — maintenance is the goal.

PERIOD AND MENSTRUAL CYCLE: Week 1 after period starts energy returns — best training week. Week 2 peak performance — push hard. Week 3 PMS begins — reduce intensity slightly. Week 4 period week — walking counts, iron rich foods essential. Scale goes up before period from water retention — not fat, do not panic.

PREGNANCY: Refer to doctor for all exercise advice. Walking and light resistance training generally safe in first trimester but always defer to medical professional. Never give specific exercise or nutrition protocols for pregnant clients.

ELDERLY 65 PLUS: Safety first always. No floor exercises unless modification shown first. Balance exercises every session. Chair squats, wall push ups, seated exercises are the foundation. Any discomfort means stop immediately. Light resistance bands are the best equipment.

TEENAGE CLIENTS UNDER 18: No aggressive calorie deficits. Habits over weight loss messaging. Eating disorder detection mandatory — if restriction or purging signs appear refer to SADAG 0800 567 567 immediately. Motivate through energy and confidence not appearance.

MINDSET AND EMOTIONAL COACHING:
OVERWHELMED: One sentence acknowledging the feeling. One single action only. Never a list. The overwhelmed client needs clarity not more information.

BUDGET ANXIETY: Before any food coaching say: Your budget does not need to change. We make smarter choices with the same money. Then give comprehensive budget options not just R57.

BAD WEEKEND: Never say start fresh Monday. Redirect to next meal. One bad weekend changes nothing if the next meal is back on track.

SCALE PANIC: Always investigate before responding. Poor sleep causes water retention. Salty food causes sodium retention. Period causes hormonal retention. Hard training causes inflammation. The scale is a liar in the short term. Measurements and photos tell the real story.

GOING QUIET THEN RETURNING: Never guilt trip. Welcome back with one sentence. Give one action to restart. The returning client is more valuable than a new client.

FRUSTRATION WITH PROGRAMME: Do not be defensive. Acknowledge it. Ask one question to understand what specifically is frustrating. Adjust based on the answer.

COMPARING TO OTHERS: Shut it down warmly. Their body. Their timeline. Their journey.

CRISIS LANGUAGE: If client uses language suggesting suicidal ideation or self harm — stop all coaching immediately. Respond with warmth and these resources: SADAG 0800 567 567 free 24 hours. Lifeline 0861 322 322. Do not attempt to counsel. Just provide resources and express genuine care.

PROACTIVE COACHING PATTERNS:
Week 3 of any programme is the danger zone. Most people quit in week 3. If client is in week 3 address this directly: You are in week 3. This is where most people quit. The results are not visible yet but the adaptation is happening. This week is the most important week of the programme.

Month end after the 20th automatically reference budget eating without being asked.

First 7 days keep coaching simple and encouraging. Do not overwhelm with information.

Day 30, 60, 90, 180, 365 are milestone moments worth celebrating loudly and specifically.

After any long weekend or public holiday acknowledge social eating happened and redirect to next meal without guilt.`;

// ============================================================
// KAMLIFE PROGRAMME LIBRARY
// ============================================================

const BEGINNER_GYM_PROGRAMME = `*Full Body Strength — Beginner (3 days/week: Mon/Wed/Fri)*
3 sets of 12 reps each. Rest 60 seconds between sets. Total time 45–55 minutes.

1️⃣ *Leg Press Machine — 3×12*
https://www.youtube.com/results?search_query=leg+press+machine+tutorial+beginners
Sit in machine. Feet shoulder-width on platform. Lower until knees at 90°. Push through heels. Do not lock knees at top.
Common mistake: Knees caving inward or lowering too deep.
Start weight: Whatever allows 12 clean reps with difficulty on last 2.

2️⃣ *Leg Curl Machine — 3×12*
https://www.youtube.com/results?search_query=lying+leg+curl+machine+tutorial
Lie face down. Pad just above heels. Curl heels toward glutes. Squeeze hamstrings hard at top. Lower slowly over 3 seconds.
Common mistake: Hips rising off pad to assist the movement.
Start weight: Light — hamstrings are often underdeveloped in beginners.

3️⃣ *Chest Press Machine — 3×12*
https://www.youtube.com/results?search_query=chest+press+machine+tutorial+beginners
Adjust seat so handles are at chest height. Press forward until arms nearly extended. Return slowly. Keep back against pad.
Common mistake: Shrugging shoulders up during the press.
Start weight: Whatever allows 12 clean reps.

4️⃣ *Lat Pulldown — 3×12*
https://www.youtube.com/results?search_query=lat+pulldown+tutorial+form+beginners
Thighs under pad. Grip bar wider than shoulders. Pull to upper chest. Lean back slightly. Squeeze back hard. Return slowly.
Common mistake: Pulling with arms instead of driving elbows down.
Start weight: Light enough to feel the back working, not just arms.

5️⃣ *Machine Shoulder Press — 3×12*
https://www.youtube.com/results?search_query=machine+shoulder+press+tutorial
Adjust seat so handles are at shoulder height. Press overhead until arms nearly extended. Lower slowly. No arching lower back.
Common mistake: Using momentum or arching back excessively.
Start weight: Lighter than you think — shoulders are a small muscle group.

Progressive overload: Add one rep per session. When you hit 15 reps on all sets, increase weight by smallest increment and drop back to 12.`;

const INTERMEDIATE_GYM_UPPER = `*Upper Body Day — Intermediate (4 days/week: Mon/Tue/Thu/Fri)*
4 sets of 10 reps. Rest 75 seconds. Total time 55–65 minutes.

1️⃣ *Chest Press Machine / Smith Machine Bench Press — 4×10*
https://www.youtube.com/results?search_query=smith+machine+bench+press+tutorial
Focus on feeling the chest, not just moving the weight. 2-second lowering phase.
Common mistake: Flaring elbows out too wide. Keep at 45°.

2️⃣ *Seated Cable Row — 4×10*
https://www.youtube.com/results?search_query=seated+cable+row+tutorial+form
Sit upright. Pull handle to belly button. Squeeze shoulder blades hard. Hold 1 second at peak. Return slowly.
Common mistake: Rounding the back to pull more weight.

3️⃣ *Lat Pulldown — 4×10*
https://www.youtube.com/results?search_query=lat+pulldown+tutorial+intermediate
Full stretch at top, full contraction at bottom. Heavier than beginner.
Common mistake: Pulling with biceps instead of lats.

4️⃣ *Machine Shoulder Press — 4×10*
https://www.youtube.com/results?search_query=shoulder+press+machine+form
Controlled throughout. No bouncing at bottom.
Common mistake: Leaning back excessively to press more.

5️⃣ *Cable Lateral Raise — 3×15*
https://www.youtube.com/results?search_query=cable+lateral+raise+tutorial
Stand side-on to cable. Raise to shoulder height. Lower slowly. Creates shoulder width.

6️⃣ *Tricep Cable Pushdown — 3×15*
https://www.youtube.com/results?search_query=tricep+cable+pushdown+tutorial
Elbows fixed at sides. Push until arms straight. Squeeze triceps. Return slowly.

7️⃣ *Cable Bicep Curl — 3×15*
https://www.youtube.com/results?search_query=cable+bicep+curl+tutorial
Elbows fixed. Curl squeezing biceps. Lower slowly. Full range.`;

const INTERMEDIATE_GYM_LOWER = `*Lower Body Day — Intermediate*
4 sets. Rest 75 seconds. Total time 55–65 minutes.

1️⃣ *Hack Squat / Leg Press — 4×10*
https://www.youtube.com/results?search_query=hack+squat+machine+tutorial
Deeper range than beginner. Feet closer together for quad focus. Control the descent.

2️⃣ *Leg Extension Machine — 4×12*
https://www.youtube.com/results?search_query=leg+extension+machine+tutorial+form
Extend until legs nearly straight. Squeeze quads hard at top. Lower slowly. No momentum.

3️⃣ *Leg Curl Machine — 4×12*
https://www.youtube.com/results?search_query=leg+curl+machine+seated+or+lying
Full range of motion. Slow lowering phase. Heavier than beginner.

4️⃣ *Hip Thrust Machine / Cable Pull Through — 4×12*
https://www.youtube.com/results?search_query=hip+thrust+machine+tutorial
Drive hips forward powerfully. Squeeze glutes hard at top. Non-negotiable for glute development.

5️⃣ *Seated Calf Raise — 4×15*
https://www.youtube.com/results?search_query=seated+calf+raise+machine+tutorial
Full range — all the way down for stretch, all the way up for contraction. Calves respond to high reps.

6️⃣ *Cable Crunch — 3×15*
https://www.youtube.com/results?search_query=cable+crunch+tutorial+form
Kneel facing cable. Rope behind head. Crunch down contracting abs. Beats planks for direct ab development.`;

const HOME_PROGRAMME_GUIDE = `*Home Training Programme — No Gym Needed*
These are the only movements. Nothing else. No bicycle kicks. No nonsense.

1️⃣ *Bodyweight Squat → Jump Squat (progression)*
https://www.youtube.com/results?search_query=bodyweight+squat+form+tutorial
3×15. Feet shoulder-width. Lower until thighs parallel. Drive through heels. Keep chest up.
Common mistake: Knees caving in. Push knees out over toes.

2️⃣ *Push-Up → Decline Push-Up → Archer Push-Up (progression)*
https://www.youtube.com/results?search_query=push+up+form+tutorial+beginners
3×10. Hands shoulder-width. Body in straight line. Lower chest to floor. Push up explosively.
Common mistake: Sagging hips or flaring elbows. Keep core tight.

3️⃣ *Glute Bridge → Single Leg Glute Bridge → Hip Thrust with Backpack (progression)*
https://www.youtube.com/results?search_query=glute+bridge+tutorial+form
3×15. Lie on back. Drive hips up. Squeeze glutes hard at top. Hold 2 seconds.
Common mistake: Using lower back instead of glutes to lift.

4️⃣ *Reverse Lunge → Bulgarian Split Squat (progression)*
https://www.youtube.com/results?search_query=reverse+lunge+form+tutorial
3×10 each leg. Step back, lower back knee toward floor. Front knee stays over ankle.
Common mistake: Front knee going too far forward. Drive through heel.

5️⃣ *Table Row / Door Frame Row → Resistance Band Row (progression)*
https://www.youtube.com/results?search_query=table+row+home+workout+tutorial
3×10. Lie under table. Grip edge. Pull chest to table. Squeeze back at top.
Common mistake: Using arms instead of back. Think elbows driving back.

6️⃣ *Plank → Plank with Shoulder Tap (progression)*
https://www.youtube.com/results?search_query=plank+shoulder+tap+tutorial
3×30 seconds. Forearms or hands. Body straight. Core braced. Breathe steadily.
Common mistake: Hips too high or sagging. Keep hips level.

Progressive overload: Add reps each session. When movements become easy, move to next progression.`;

function getKamlifeProgramme(user: any, todayOnly = false): string {
  const mode = user.trainingMode || "home";
  const exp = (user.trainingExperience || "beginner").toLowerCase();

  if (mode !== "gym") return HOME_PROGRAMME_GUIDE;

  if (exp === "intermediate" || exp === "advanced") {
    if (todayOnly) {
      const day = (user.programmeDayInWeek || 1);
      return day % 2 === 0 ? INTERMEDIATE_GYM_LOWER : INTERMEDIATE_GYM_UPPER;
    }
    return `${INTERMEDIATE_GYM_UPPER}\n\n---\n\n${INTERMEDIATE_GYM_LOWER}`;
  }

  return BEGINNER_GYM_PROGRAMME;
}

// ============================================================
// SA FOOD CALORIE ESTIMATES
// ============================================================

const SA_FOOD_CALORIES: Record<string, number> = {
  pap: 350, samp: 300, rice: 200, bread: 80, "brown bread": 70,
  oats: 150, "jungle oats": 150, maltabella: 160, "weet-bix": 130,
  egg: 70, eggs: 140, pilchards: 180, "tinned tuna": 120,
  chicken: 165, "chicken breast": 165, beef: 250, mince: 300,
  "sugar beans": 200, "baked beans": 120, lentils: 180,
  kota: 900, "fat cake": 400, magwinya: 400, vetkoek: 350,
  "russian sausage": 290, polony: 280, viennas: 250,
  "simba chips": 500, niknaks: 480, "bar one": 230,
  "kfc streetwise 2": 800, kfc: 600, "steers burger": 700,
  "peanut butter": 190, avocado: 160, banana: 90,
  "cool drink": 140, coke: 140, fanta: 130,
  beer: 150, "castle": 150, "black label": 160,
  hennessy: 250, henny: 250, "henry and coke": 350, "henny and coke": 350,
  "sweet potato": 130, butternut: 80, spinach: 20, cabbage: 25,
  "mageu": 180, "mahewu": 180, cremora: 60,
  "green tea": 2, rooibos: 2, "latte": 250, "giant latte": 400,
  creatine: 0, "protein shake": 120,
  "stew": 280, "fatty": 350, "pork": 300,
};

function estimateCalories(message: string): number {
  const lower = message.toLowerCase();
  let total = 0;
  for (const [food, cals] of Object.entries(SA_FOOD_CALORIES)) {
    if (lower.includes(food)) total += cals;
  }
  return total || 400;
}

// ============================================================
// DISPLAY NAME HELPER
// ============================================================

function getDisplayName(user: any): string {
  const INVALID = new Set(["HI", "HEY", "HELLO", "YES", "NO", "OK", "OKAY", "MENU", "HELP", "DONE", "USER", "THERE"]);
  if (!user.name || user.name.length < 2 || INVALID.has((user.name || "").toUpperCase())) return "";
  return user.name;
}

// ============================================================
// EXERCISE LIBRARY — PUSH / PULL / LEGS / CORE SPLIT
// Each training day focuses on ONE category only
// ============================================================

type Exercise = { name: string; sets: string; description: string; mistake: string; modification: string };

const WORKOUTS: Record<string, Record<string, Exercise[]>> = {
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

function getPhaseMultiplier(phase: number): { sets: string, reps: string, rest: string } {
  switch(phase) {
    case 1: return { sets: "3", reps: "10", rest: "60 seconds" };
    case 2: return { sets: "4", reps: "8", rest: "90 seconds" };
    case 3: return { sets: "4", reps: "6", rest: "120 seconds" };
    case 4: return { sets: "5", reps: "5", rest: "120 seconds" };
    case 5: return { sets: "3", reps: "10", rest: "60 seconds" };
    default: return { sets: "3", reps: "10", rest: "60 seconds" };
  }
}

function getPhaseNames(): Record<number, string> {
  return { 1: "Foundation", 2: "Build", 3: "Push", 4: "Peak", 5: "Deload" };
}

function getDayType(day: number): "push" | "pull" | "legs" | "core" {
  const types: Array<"push" | "pull" | "legs" | "core"> = ["push", "pull", "legs", "core"];
  return types[(day - 1) % 4];
}

function buildDayWorkout(user: any): string {
  const mode = user.trainingMode || "home";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const multiplier = getPhaseMultiplier(phase);
  const week = user.programmeWeek || 1;
  const day = user.programmeDayInWeek || 1;
  const isFemaleGluteFocus = user.primaryFocusArea === "glutes_legs";

  if (mode === "walk_only" || mode === "walk") {
    const duration = phase === 1 ? "15 minutes" : phase === 2 ? "25 minutes" : phase === 3 ? "35 minutes" : "45 minutes";
    return `*Phase ${phase}: ${phaseName} — Week ${week}*\nToday: Day ${day}\n\n*Brisk Walk — ${duration}*\nWalk fast enough to feel slightly breathless but still able to talk. Arms swinging. Posture tall. Do not stop unless necessary.\n\nSend DONE when finished.`;
  }

  // Fix 4 — Home: exact 3-day rotating full-body programme, always 6 exercises minimum
  if (mode !== "gym") {
    const daySlot = ((day - 1) % 3) + 1; // cycles 1→2→3→1→2→3...

    type HomeEx = { name: string; setsReps: string; cue: string; mistake: string; yt: string };
    const HOME_DAYS: Record<number, HomeEx[]> = {
      1: [
        {
          name: "Bodyweight Squat",
          setsReps: "3 sets of 15 reps",
          cue: "Feet shoulder width. Lower until thighs parallel. Drive through heels. Chest up.",
          mistake: "Knees caving inward. Push knees out over toes throughout.",
          yt: "https://www.youtube.com/results?search_query=bodyweight+squat+form+tutorial",
        },
        {
          name: "Push Up",
          setsReps: "3 sets of 10 reps",
          cue: "Hands shoulder width. Body straight from head to heels. Lower chest to floor. Push up explosively.",
          mistake: "Hips sagging or rising. Keep body in one straight line.",
          yt: "https://www.youtube.com/results?search_query=push+up+form+tutorial+beginners",
        },
        {
          name: "Glute Bridge",
          setsReps: "3 sets of 15 reps",
          cue: "Lie on back. Feet flat hip width. Drive hips to ceiling. Squeeze glutes hard at top. Lower slowly.",
          mistake: "Pushing through the lower back instead of the glutes. Drive hips, do not arch back.",
          yt: "https://www.youtube.com/results?search_query=glute+bridge+tutorial+beginners",
        },
        {
          name: "Reverse Lunge",
          setsReps: "3 sets of 12 each leg",
          cue: "Stand tall. Step one foot back. Lower back knee toward floor. Push through front heel to return. Torso upright.",
          mistake: "Front knee travelling past toes. Keep shin vertical.",
          yt: "https://www.youtube.com/results?search_query=reverse+lunge+tutorial+form",
        },
        {
          name: "Table Row",
          setsReps: "3 sets of 12 reps",
          cue: "Sit under a sturdy table. Grip edge. Body straight. Pull chest up to table. Lower slowly.",
          mistake: "Hips dropping. Keep body rigid like a plank throughout.",
          yt: "https://www.youtube.com/results?search_query=table+row+exercise+tutorial",
        },
        {
          name: "Plank",
          setsReps: "3 sets of 30 seconds",
          cue: "Forearms on floor. Body straight from head to heels. Squeeze stomach hard. Breathe steadily.",
          mistake: "Hips rising or sagging. Keep everything in one line.",
          yt: "https://www.youtube.com/results?search_query=plank+exercise+tutorial+beginners",
        },
      ],
      2: [
        {
          name: "Jump Squat",
          setsReps: "3 sets of 12 reps",
          cue: "Feet shoulder width. Squat to parallel. Explode upward. Land softly with bent knees. Reset.",
          mistake: "Landing stiff-legged. Absorb through hips and knees on every landing.",
          yt: "https://www.youtube.com/results?search_query=jump+squat+tutorial+form",
        },
        {
          name: "Decline Push Up",
          setsReps: "3 sets of 10 reps",
          cue: "Feet on chair or couch. Hands on floor. Lower chest toward floor. Press back up. Body straight.",
          mistake: "Hips rising to compensate. Keep core tight so body stays in a straight line.",
          yt: "https://www.youtube.com/results?search_query=decline+push+up+tutorial+beginners",
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

    const exercises = HOME_DAYS[daySlot];
    let workout = `*Phase ${phase}: ${phaseName} — Week ${week}*\nFull Body Day ${daySlot} | Rest 60 seconds between sets | Total 40–50 minutes\n\n`;
    for (const ex of exercises) {
      workout += `*${ex.name} — ${ex.setsReps}*\n${ex.yt}\n${ex.cue}\nCommon mistake: ${ex.mistake}\n\n`;
    }
    // Glute-focus clients get an extra note
    if (isFemaleGluteFocus) {
      workout += `*Glute Focus Add-on:* Add an extra set of Glute Bridge or Hip Thrust at the end. Slow the lowering phase to 3 seconds.\n\n`;
    }
    workout += `Train on non-consecutive days. Send DONE when finished.`;
    return workout;
  }

  // Gym: keep push-pull-legs-core daily split
  const library = WORKOUTS.gym;
  const dayType = getDayType(day);
  const dayLabel = { push: "Push 💪", pull: "Pull 🏋️", legs: "Legs 🦵", core: "Core 🔥" }[dayType];
  const exercises = library[dayType];
  const sessionExercises = dayType === "legs" && isFemaleGluteFocus ? exercises : exercises.slice(0, 4);

  let workout = `*Phase ${phase}: ${phaseName} — Week ${week}*\n${dayLabel} Day | ${multiplier.sets} sets | Rest ${multiplier.rest}\n\n`;
  for (const ex of sessionExercises) {
    const setsDisplay = ex.sets.includes("seconds") || ex.sets.includes("min")
      ? `${multiplier.sets}x${ex.sets.split("x").pop() || ex.sets}`
      : `${multiplier.sets}x${multiplier.reps}`;
    const ytQuery = ex.name.replace(/\s+/g, "+") + "+tutorial";
    const ytLink = `https://www.youtube.com/results?search_query=${ytQuery}`;
    workout += `*${ex.name} — ${setsDisplay}*\n${ex.description}\n⚠️ ${ex.mistake}\n🎥 ${ytLink}\n\n`;
  }
  workout += `Send DONE when finished.`;
  return workout;
}

function buildFullProgramme(user: any): string {
  const mode = user.trainingMode || "home";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const multiplier = getPhaseMultiplier(phase);
  const week = user.programmeWeek || 1;
  const library = WORKOUTS[mode === "gym" ? "gym" : "home"];

  const days: Array<{ label: string; type: "push" | "pull" | "legs" }> = [
    { label: "Day 1 — Push 💪", type: "push" },
    { label: "Day 2 — Pull 🏋️", type: "pull" },
    { label: "Day 3 — Legs 🦵", type: "legs" },
  ];

  let out = `*Phase ${phase}: ${phaseName} — Week ${week}*\n${multiplier.sets} sets | Rest ${multiplier.rest}\n\n`;

  for (const { label, type } of days) {
    const exercises = library[type].slice(0, 3);
    out += `*${label}*\n`;
    for (const ex of exercises) {
      const ytQuery = ex.name.replace(/\s+/g, "+") + "+tutorial";
      const ytLink = `https://www.youtube.com/results?search_query=${ytQuery}`;
      out += `• *${ex.name}* — ${multiplier.sets}x${multiplier.reps}\n  ${ex.description}\n  🎥 ${ytLink}\n`;
    }
    out += `\n`;
  }

  out += `Send *1* for today's full session with cues.`;
  return out;
}

// ============================================================
// BUILD USER CONTEXT FOR GPT
// ============================================================

function buildContext(user: any): string {
  const name = getDisplayName(user) || "a client";
  const goal = user.goalType || "general fitness";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const steps = user.stepsTarget || 7000;
  // Fix 2 — always use live-calculated targets so GPT sees correct numbers even if DB is stale
  const weight = parseFloat(user.currentWeight || "75");
  const liveTargets = calculateTargets(weight, goal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
  const calories = liveTargets.calorieTarget;
  const protein = liveTargets.proteinTarget;
  const mode = user.trainingMode || "home";
  const equipment = user.homeEquipment || "none";
  const situation = user.lifeSituation || "";
  const job = user.jobType || "";
  const activity = user.activityLevel || "";
  const focus = user.primaryFocusArea || "";
  const injuries = user.injuries || "none";
  const age = user.age || 30;
  const water = user.todayWater || 0;
  const experience = user.trainingExperience || "beginner";

  return `CLIENT PROFILE:
Name: ${name}
Goal: ${goal}
Age: ${age}
Phase: ${phase} — ${phaseName}
Calorie target: ${calories}
Protein target: ${protein}g
Step target: ${steps}
Training mode: ${mode}
Equipment: ${equipment}
Life situation: ${situation}
Job type: ${job}
Activity level: ${activity}
Primary focus: ${focus}
Injuries: ${injuries}
Experience: ${experience}
Water today: ${water}L
Days on programme: ${Math.floor((Date.now() - new Date(user.createdAt || Date.now()).getTime()) / 86400000)}`;
}

// ============================================================
// SA CULTURAL & SEASONAL CONTEXT FLAGS
// ============================================================

function getSAContextFlags(user?: any): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const flags: string[] = [];

  if (day >= 20) {
    flags.push("BUDGET MODE ACTIVE: Date is after the 20th. Client may be tight on money. Prioritise cheap high-protein SA foods — eggs, pilchards, sugar beans, pap. Do not suggest expensive supplements or premium foods.");
  }

  // Fix 2 — Ramadan only activates on explicit user mention, never on calendar date alone
  const RAMADAN_KEYWORDS = ["ramadan", "ramadhan", "fasting", "iftar", "suhoor", "sehri", "muslim", "islam", "halaal", "halal"];
  const userNotes = ((user?.otherMedicalNotes || "") + " " + (user?.workSchedule || "")).toLowerCase();
  const userMentionsRamadan = RAMADAN_KEYWORDS.some(kw => userNotes.includes(kw));
  if (userMentionsRamadan) {
    flags.push("RAMADAN / FASTING ACTIVE: Client has indicated they are Muslim or fasting. Train only after Iftar. Suhoor is the most critical meal — high protein, slow carbs, water before Fajr. No training during fasting hours. Adjust all calorie and meal timing advice to the eating window only.");
  }

  const MONTHLY: Record<number, string> = {
    1:  "January — New year motivation is high but gyms are overcrowded. Set realistic first-month expectations. Focus on building sustainable habits not chasing rapid results. Beware over-commitment.",
    2:  "February — Valentine's Day body image pressure is real. Do not amplify comparison or appearance anxiety. Celebrate progress and strength. Acknowledge emotional eating triggers around this time.",
    3:  "March — Back to school means back to routine. Excellent month to restart lapsed clients. Routines are re-establishing — capitalise on the structure.",
    4:  "April — Easter weekend and braai season. Social eating is high risk. Protein-first strategy at any braai or family gathering. One training session over the long weekend minimum.",
    5:  "May — Workers Day. Autumn. Post-January-rush motivation slump common around now. Focus on consistency over intensity. Celebrate progress made since January.",
    6:  "June — Youth Day. Mid-year check-in. January starters are at programme halfway point — review what has changed and what needs adjustment.",
    7:  "July — School holidays. Routine disruption is real. Kids at home affects training time. Adapt to shorter sessions, home workouts, early mornings, or post-bedtime sessions.",
    8:  "August — Women's Month. Celebrate female clients specifically. Body positivity and strength messaging. No weight-focused language unless client initiates. Celebrate what the body can DO.",
    9:  "September — Spring in SA. Outdoor training season begins. Encourage park runs, outdoor sessions, Parkrun, walking with friends. Energy and motivation naturally higher.",
    10: "October — Walking and transport awareness month. Step count focus. Encourage getting off the taxi one stop early, taking the stairs, lunch walks.",
    11: "November — Year-end party season begins. Alcohol and social eating management. Help clients navigate office parties and year-end functions without derailing progress.",
    12: "December — Festive season. Maintenance mode only — do NOT set aggressive fat loss targets. Two rules: keep protein up and stay moving. Family time is not failure time. January is for reset.",
  };
  if (MONTHLY[month]) flags.push(MONTHLY[month]);

  if (month >= 5 && month <= 9) {
    flags.push("Load shedding risk: Winter months have historically high Eskom load shedding stages 4–6. Gyms may be without power. Always have a home workout alternative ready for every session.");
  }

  if (flags.length === 0) return "";
  return `SA CONTEXT FLAGS:\n${flags.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
}

// ============================================================
// PATTERN SUMMARY — 7-DAY BEHAVIOUR ANALYSIS SENT WITH EVERY GPT CALL
// ============================================================

async function buildPatternSummary(user: any): Promise<string> {
  const name = getDisplayName(user) || "client";
  const proteinTarget = user.proteinTarget || 120;
  const programmeWeek = user.programmeWeek || 1;
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 86_400_000);
  sevenDaysAgo.setHours(0, 0, 0, 0);
  const fourteenDaysAgo = new Date(today.getTime() - 14 * 86_400_000);

  try {
    // ---- Parallel DB queries ----
    const [recentChats, recentWeights, olderWeights] = await Promise.all([
      db.select().from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), gte(chatHistory.createdAt, sevenDaysAgo)))
        .orderBy(desc(chatHistory.createdAt))
        .limit(100),
      db.select().from(weightLogs)
        .where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, sevenDaysAgo)))
        .orderBy(desc(weightLogs.loggedAt))
        .limit(5),
      db.select().from(weightLogs)
        .where(and(
          eq(weightLogs.userId, user.id),
          gte(weightLogs.loggedAt, fourteenDaysAgo),
          lt(weightLogs.loggedAt, sevenDaysAgo)
        ))
        .orderBy(desc(weightLogs.loggedAt))
        .limit(1),
    ]);

    // ---- Days logged vs silent ----
    const daysWithLogs = new Set(
      recentChats.map(c => new Date(c.createdAt || "").toLocaleDateString("en-ZA"))
    ).size;
    const daysSilent = 7 - daysWithLogs;

    // ---- Protein estimate from food log GPT responses ----
    const foodLogs = recentChats.filter(c => c.intent === "FOOD_LOG");
    const proteinNums: number[] = [];
    for (const log of foodLogs) {
      const m = (log.messageOut || "").match(/(\d{2,3})g?\s*(?:of\s+)?protein/i);
      if (m) proteinNums.push(parseInt(m[1]));
    }
    const avgProtein = proteinNums.length >= 2
      ? Math.round(proteinNums.reduce((a, b) => a + b, 0) / proteinNums.length)
      : null;

    // ---- Scan message text for signals ----
    const allIn = recentChats.map(c => (c.messageIn || "").toLowerCase()).join(" ");

    const BUDGET_WORDS = ["broke", "no money", "can't afford", "cannot afford", "no cash", "eina the money", "month end", "no food money", "tight on", "struggling financially"];
    const HARD_WORDS = ["too hard", "too difficult", "can't do it", "cannot do it", "killing me", "giving up", "want to quit", "want to stop", "too tough", "it's too much"];
    const EASY_WORDS = ["too easy", "not challenging", "too light", "too simple", "boring"];
    const PAIN_WORDS = ["pain", " hurts", "so sore", "soreness", "injured", "bad knee", "bad back", "bad shoulder", "hip pain", "knee pain", "back pain", "aching", "inflamed"];
    const STRESS_WORDS = ["stressed", "anxious", "anxiety", "depressed", "depression", "overwhelmed", "so tired", "exhausted", "family problem", "relationship problem", "work pressure", "difficult time", "struggling emotionally", "not okay", "hard time"];

    const mentionedBudget = BUDGET_WORDS.some(w => allIn.includes(w));
    const mentionedTooHard = HARD_WORDS.some(w => allIn.includes(w));
    const mentionedTooEasy = EASY_WORDS.some(w => allIn.includes(w));
    const mentionedPain = PAIN_WORDS.some(w => allIn.includes(w));
    const mentionedStress = STRESS_WORDS.some(w => allIn.includes(w));

    // ---- Training sessions ----
    const DONE_PATTERN = /^(done|workout done|finished|completed)$/;
    const trainingLogs = recentChats.filter(c =>
      DONE_PATTERN.test((c.messageIn || "").toLowerCase().trim()) || c.intent === "WORKOUT_LOG"
    );
    const lastTraining = trainingLogs[0];
    const daysSinceTraining = lastTraining?.createdAt
      ? Math.floor((Date.now() - new Date(lastTraining.createdAt).getTime()) / 86_400_000)
      : null;

    // ---- Weight trend ----
    let weightTrend = "No weight data this week.";
    if (recentWeights.length > 0 && olderWeights.length > 0) {
      const recent = parseFloat(String(recentWeights[0].weight));
      const older = parseFloat(String(olderWeights[0].weight));
      const diff = recent - older;
      if (Math.abs(diff) < 0.3) weightTrend = "Weight unchanged week-on-week.";
      else if (diff > 0) weightTrend = `Weight up ${diff.toFixed(1)}kg this week.`;
      else weightTrend = `Weight down ${Math.abs(diff).toFixed(1)}kg this week.`;
    } else if (recentWeights.length > 0) {
      const daysAgo = Math.floor((Date.now() - new Date(recentWeights[0].loggedAt || "").getTime()) / 86_400_000);
      weightTrend = daysAgo <= 1
        ? `Weight logged: ${recentWeights[0].weight}kg.`
        : `Weight unchanged for ${daysAgo} days.`;
    }

    // ---- Assemble paragraph ----
    const parts: string[] = [
      `PATTERN CONTEXT: ${name} has logged ${daysWithLogs} of the last 7 days${daysSilent > 0 ? ` (${daysSilent} day${daysSilent > 1 ? "s" : ""} silent)` : ""}.`,
    ];

    if (avgProtein !== null) {
      const status = avgProtein >= proteinTarget
        ? `at or above target (avg ${avgProtein}g vs ${proteinTarget}g)`
        : `consistently under (avg ${avgProtein}g vs ${proteinTarget}g target)`;
      parts.push(`Average protein logged is ${status}.`);
    } else {
      parts.push(`Protein target is ${proteinTarget}g/day — tracking data limited this week.`);
    }

    if (mentionedBudget) parts.push("They mentioned being broke or tight on budget this week.");
    if (mentionedTooHard) parts.push("They mentioned the programme being too hard or wanting to quit.");
    if (mentionedTooEasy) parts.push("They mentioned the programme being too easy.");
    if (mentionedPain) parts.push("They mentioned pain or injury in the last 7 days.");
    if (mentionedStress) parts.push("They mentioned stress, work pressure, or emotional difficulty this week.");

    if (trainingLogs.length === 0) {
      parts.push("No training sessions logged this week.");
    } else {
      parts.push(`${trainingLogs.length} training session${trainingLogs.length > 1 ? "s" : ""} logged this week.`);
      if (daysSinceTraining !== null && daysSinceTraining >= 3) {
        parts.push(`Last training was ${daysSinceTraining} days ago.`);
      }
    }

    parts.push(weightTrend);
    if (programmeWeek === 3) parts.push("Currently in week 3 of the programme — the danger zone.");
    if (today.getDate() >= 20) parts.push("Date is after the 20th — budget mode active.");

    return parts.join(" ");
  } catch (err) {
    console.error("[PATTERN] buildPatternSummary error:", err);
    const fallback = [`PATTERN CONTEXT: ${name}.`];
    if (programmeWeek === 3) fallback.push("Week 3 — danger zone.");
    if (today.getDate() >= 20) fallback.push("Budget mode active.");
    return fallback.join(" ");
  }
}

// ============================================================
// GPT CALL — ALWAYS USES MASTER PROMPT + FULL CONTEXT
// ============================================================

function selectModel(instruction: string, userMessage: string): { model: string; maxTokens: number; reason: string } {
  const GPT4O_SIGNALS = [
    "programme", "workout plan", "training plan", "beginner", "intermediate", "advanced",
    "diabetes", "diabetic", "hypertension", "blood pressure", "pcos", "hiv", "arv", "tb ",
    "ramadan", "fasting", "pregnancy", "pregnant", "elderly", "injury", "bad knee",
    "bad back", "bad shoulder", "hip problem", "knee replacement",
    "calories", "calorie target", "how much should i eat", "muscle gain", "fat loss",
    "goal change", "want to gain", "want to lose", "supplement stack", "creatine",
    "protein powder", "week 3", "crisis", "suicidal", "self harm",
    "calculate", "formula", "how many calories", "what should i eat for my goal",
  ];

  // Check user message first — this is the primary routing signal
  const msgLower = userMessage.toLowerCase();
  const matchedMsg = GPT4O_SIGNALS.find(signal => msgLower.includes(signal));
  if (matchedMsg) {
    console.log(`[MODEL] gpt-4o selected — user message matched: "${matchedMsg}" | msg: "${userMessage.slice(0, 60)}"`);
    return { model: "gpt-4o", maxTokens: 600, reason: matchedMsg };
  }

  // Check the extra instruction only when it is short (utility calls like celebrations)
  // Skip scanning the full handleMessage instruction template — it always contains signals
  if (instruction.length < 200) {
    const instrLower = instruction.toLowerCase();
    const matchedInstr = GPT4O_SIGNALS.find(signal => instrLower.includes(signal));
    if (matchedInstr) {
      console.log(`[MODEL] gpt-4o selected — instruction matched: "${matchedInstr}"`);
      return { model: "gpt-4o", maxTokens: 600, reason: matchedInstr };
    }
  }

  console.log(`[MODEL] gpt-4o-mini selected | msg: "${userMessage.slice(0, 60)}"`);
  return { model: "gpt-4o-mini", maxTokens: 250, reason: "simple response" };
}

async function askCoachK(userMessage: string, user: any, extraInstruction?: string): Promise<string> {
  const context = buildContext(user);
  const patternSummary = await buildPatternSummary(user);
  console.log(`[PATTERN] ${patternSummary}`);
  // Addition 5 — SA seasonal/cultural flags injected into every GPT call (user-aware)
  const saFlags = getSAContextFlags(user);
  const instruction = extraInstruction || "Respond as Coach K to this client message.";
  const hardLimit = "HARD RULE: Max 3 sentences, 60 words total. Never start with 'Coach K here'. Never say 'Reply MENU'. Always use the client's actual name. End with exactly one specific action.";
  const { model, maxTokens } = selectModel(instruction, userMessage);

  try {
    const response = await openai.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system",
          content: `${COACH_K_SYSTEM}\n\n${context}\n\n${patternSummary}${saFlags ? "\n\n" + saFlags : ""}\n\n${hardLimit}\n\nINSTRUCTION: ${instruction}`
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });
    return response.choices[0]?.message?.content?.trim() || "Sharp. Keep moving forward.";
  } catch (err) {
    console.error("OpenAI error:", err);
    return "Something went wrong on my end. Try again in a moment.";
  }
}

// ============================================================
// GET OR CREATE USER
// ============================================================

async function getOrCreateUser(phone: string): Promise<any> {
  const existing = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
  if (existing.length > 0) {
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.phoneNumber, phone));
    return existing[0];
  }
  const newUsers = await db.insert(users).values({
    phoneNumber: phone,
    subscriptionStatus: "trial",
    onboardingState: "START",
    programmePhase: 1,
    programmeWeek: 1,
    programmeDayInWeek: 1,
    trainingMode: "home",
    stepsTarget: 7000,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  }).returning();
  return newUsers[0];
}

// ============================================================
// MENU TEXT — context-aware
// ============================================================

async function getMenuText(user: any): Promise<string> {
  const name = getDisplayName(user);
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const day = user.programmeDayInWeek || 1;
  const dayType = getDayType(day);
  const dayLabel = { push: "Push 💪", pull: "Pull 🏋️", legs: "Legs 🦵", core: "Core 🔥" }[dayType];
  const mode = user.trainingMode || "home";
  const stepsTarget = user.stepsTarget || 8000;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  let workoutDone = false;
  let todayStepCount: number | null = null;

  try {
    const [todayWorkout, todaySteps] = await Promise.all([
      db.select().from(workoutLogs)
        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStart)))
        .limit(1),
      db.select().from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStart)))
        .limit(1),
    ]);
    workoutDone = todayWorkout.length > 0;
    todayStepCount = todaySteps.length > 0 ? todaySteps[0].steps : null;
  } catch { }

  const workoutStatus = mode !== "walk_only"
    ? (workoutDone ? `Workout ✅` : `Today: ${dayLabel}`)
    : null;
  const stepStatus = todayStepCount !== null
    ? `Steps: ${todayStepCount.toLocaleString()}/${stepsTarget.toLocaleString()}${todayStepCount >= stepsTarget ? " ✅" : ""}`
    : null;

  const statusParts = [workoutStatus, stepStatus].filter(Boolean).join(" · ");

  const headerLine = name
    ? `*KamLife Coach* — ${name}\nPhase ${phase}: ${phaseName}${statusParts ? ` | ${statusParts}` : ""}`
    : `*KamLife Coach* 💪`;

  return `${headerLine}

What do you need?
1️⃣ Today's workout
2️⃣ Food coaching
3️⃣ Log steps
4️⃣ Log sleep
5️⃣ Log weight
6️⃣ Weekly report
7️⃣ Measurements check-in

Or just tell me what you ate, how training went, your steps, or anything on your mind.`;
}

// ============================================================
// ROTATING STEP RESPONSES (no GPT cost for simple logs)
// ============================================================

const STEP_RESPONSES_LOW = [
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps logged — you are ${remaining.toLocaleString()} short of your ${target.toLocaleString()} target. Walk to the shop, take the stairs, park further. Close that gap before bed.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps today. ${remaining.toLocaleString()} more will hit your target. A 15-minute walk is about 1,500 steps — go.`,
  (steps: number, remaining: number, target: number) =>
    `Short day — ${steps.toLocaleString()} steps. Your target is ${target.toLocaleString()}. Set a reminder for an evening walk and hit it before you sleep.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps is a start, not a finish. ${remaining.toLocaleString()} to go. Walk while you talk on the phone. Use every gap.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps logged. Target: ${target.toLocaleString()}. You are ${Math.round((steps / target) * 100)}% there — finish the job tonight.`,
];

const STEP_RESPONSES_GOOD = [
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — almost there. ${(target - steps).toLocaleString()} more to hit target. You are close, do not let it go.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps is solid progress. ${(target - steps).toLocaleString()} away from your ${target.toLocaleString()} target — one more walk and you have it.`,
  (steps: number, target: number) =>
    `Nearly at target — ${steps.toLocaleString()} steps done. Finish line is ${(target - steps).toLocaleString()} steps away. You have come too far not to finish.`,
];

const STEP_RESPONSES_TARGET = [
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — target hit. ✅ This daily discipline is what separates results from excuses. Same again tomorrow.`,
  (steps: number, target: number) =>
    `Target crushed — ${steps.toLocaleString()} steps. ✅ Every step counts toward your fat loss. Do not skip tomorrow.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps done. ✅ Above target and earning it. Your body is changing because you are consistent — keep it up.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — you smashed the ${target.toLocaleString()} target. ✅ Lekker. Same energy tomorrow.`,
  (steps: number, target: number) =>
    `Target done — ${steps.toLocaleString()} steps. ✅ This is what consistency looks like. Log tomorrow and keep the streak going.`,
];

function getStepResponse(steps: number, target: number): string {
  const idx = Math.floor(Date.now() / 86400000) % 5;
  if (steps >= target) {
    return STEP_RESPONSES_TARGET[idx % STEP_RESPONSES_TARGET.length](steps, target);
  } else if (steps >= target * 0.75) {
    return STEP_RESPONSES_GOOD[idx % STEP_RESPONSES_GOOD.length](steps, target);
  }
  const remaining = target - steps;
  return STEP_RESPONSES_LOW[idx % STEP_RESPONSES_LOW.length](steps, remaining, target);
}

// ============================================================
// FOOD PATTERN DETECTION
// ============================================================

const JUNK_WORDS = ["kfc", "kota", "fat cake", "magwinya", "vetkoek", "chips", "niknaks", "cool drink", "coke", "fanta", "hennessy", "henny", "alcohol", "beer", "wine", "chocolate", "sweets", "biscuit", "polony", "viennas", "russian", "steers", "burger", "pizza"];
const PROTEIN_WORDS = ["egg", "chicken", "beef", "fish", "pilchards", "tuna", "beans", "lentils", "mince", "pork", "protein", "samp and beans", "sugar beans", "baked beans", "yogurt", "cheese", "milk", "cottage cheese"];

async function checkFoodPatterns(userId: string): Promise<string | null> {
  try {
    const recent = await db.select().from(chatHistory)
      .where(and(eq(chatHistory.userId, userId), eq(chatHistory.intent, "FOOD_LOG")))
      .orderBy(desc(chatHistory.createdAt))
      .limit(5);

    if (recent.length < 3) return null;

    const last3 = recent.slice(0, 3).map(r => (r.messageIn || "").toLowerCase());

    const junkStreak = last3.filter(msg => JUNK_WORDS.some(w => msg.includes(w))).length;
    if (junkStreak >= 3) {
      return `⚠️ *Pattern alert:* Three junk food logs in a row. This is the pattern that blocks results. Next meal: protein + vegetables first, everything else after.`;
    }

    const noProteinStreak = last3.filter(msg => !PROTEIN_WORDS.some(w => msg.includes(w))).length;
    if (noProteinStreak >= 3) {
      return `⚠️ *Protein missing:* Three meals in a row with no protein logged. Your muscle target and fat loss both depend on hitting ${" "}your protein. Eggs, pilchards, or beans — pick one for the next meal.`;
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// PERFECT DAY DETECTION
// ============================================================

async function checkPerfectDay(userId: string): Promise<string | null> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todayWorkouts, todaySteps, todayFood] = await Promise.all([
      db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, userId), gte(workoutLogs.loggedAt, todayStart))).limit(1),
      db.select().from(stepLogs).where(and(eq(stepLogs.userId, userId), gte(stepLogs.loggedAt, todayStart))).limit(1),
      db.select().from(chatHistory).where(and(eq(chatHistory.userId, userId), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart))).limit(1),
    ]);

    if (todayWorkouts.length > 0 && todaySteps.length > 0 && todayFood.length > 0) {
      return `\n\n🏆 *Perfect day!* Workout done. Steps logged. Food tracked. This is what transformation looks like — remember how this feels and repeat it tomorrow.`;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// ONBOARDING MEAL PLAN HELPER
// ============================================================

function getOnboardingMealPlan(user: any): string {
  const budget = user.weeklyFoodBudget || "100_300";
  const goal = user.goalType || "fat_loss";
  const medicals = (user.medicalConditions || "").split(",").map((s: string) => s.trim());
  const situation = user.lifeSituation || "office";
  const schedule = user.workSchedule || "standard";
  const daysPerWeek = user.trainingDaysPerWeek || 3;
  const name = user.name || "there";
  const cal = user.calorieTarget || 1800;
  const prot = user.proteinTarget || 140;
  const otherNotes = (user.otherMedicalNotes || "").toLowerCase();

  // Medical flags
  const isDiabetic = medicals.includes("diabetes");
  const isHypertension = medicals.includes("hypertension");
  const isPCOS = medicals.includes("pcos");
  const isHIV = medicals.includes("hiv_arvs");
  const isLowGI = isDiabetic || isPCOS;
  const isNightShift = schedule === "night_shift";
  const isStudent = situation === "student";
  const isUnemployed = situation === "unemployed";
  const isPhysicalJob = situation === "retail_physical";

  // Allergy detection from free-text notes
  const noPeanuts = otherNotes.includes("peanut");
  const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard") || otherNotes.includes("sardine") || otherNotes.includes("tuna");
  const noDairy = otherNotes.includes("dairy") || otherNotes.includes("milk") || otherNotes.includes("lactose");
  const noGluten = otherNotes.includes("gluten") || otherNotes.includes("coeliac") || otherNotes.includes("wheat") || otherNotes.includes("celiac");

  // Calorie/protein adjustments
  const adjustedCal = isPhysicalJob ? cal + 300 : isHIV ? cal + 200 : cal;
  const adjustedProt = isHIV ? Math.round(prot * 1.2) : prot;

  const goalLabels: Record<string, string> = {
    fat_loss: "Fat loss", muscle_gain: "Muscle gain", recomposition: "Body recomposition",
    general: "General fitness", health_condition: "Health management",
  };
  const budgetLabels: Record<string, string> = {
    under_100: "Under R100", "100_300": "R100–R300", "300_600": "R300–R600", over_600: "Over R600",
  };

  // Medical flags for header
  const medFlags: string[] = [];
  if (isDiabetic) medFlags.push("Diabetic protocol — low GI carbs, strict meal timing");
  if (isHypertension) medFlags.push("Hypertension — low sodium, no Aromat, no processed meats");
  if (isPCOS) medFlags.push("PCOS — low GI, anti-inflammatory");
  if (isHIV) medFlags.push("HIV/ARVs — take with breakfast, +20% protein");
  if (noPeanuts) medFlags.push("Peanut allergy — PB removed");
  if (noFish) medFlags.push("Fish allergy — pilchards/tuna replaced with eggs/chicken");
  if (noDairy) medFlags.push("Dairy free");
  if (noGluten) medFlags.push("Gluten free");

  // Training day layout
  const allDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  let trainingSet: Set<string>;
  if (daysPerWeek >= 6) trainingSet = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
  else if (daysPerWeek === 5) trainingSet = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
  else if (daysPerWeek === 4) trainingSet = new Set(["Monday", "Tuesday", "Thursday", "Friday"]);
  else if (daysPerWeek === 3) trainingSet = new Set(["Monday", "Wednesday", "Friday"]);
  else if (daysPerWeek === 2) trainingSet = new Set(["Monday", "Thursday"]);
  else trainingSet = new Set(["Wednesday"]);

  const meal1Label = isNightShift ? "Pre-shift meal" : "Breakfast";
  const meal3Label = isNightShift ? "Post-shift meal" : "Dinner";
  const maxPrep = isStudent ? "8 min" : "20 min";

  // ---- BREAKFAST proteins (egg-based, always appropriate for morning) ----
  const bfProteins = goal === "muscle_gain"
    ? ["3 whole eggs", "3 whole eggs + banana", "3 whole eggs", "3 whole eggs + banana", "3 whole eggs", "3 whole eggs", "3 whole eggs + banana"]
    : ["2 boiled eggs", "2 boiled eggs", "2 boiled eggs", "2 boiled eggs", "2 boiled eggs", "2 boiled eggs", "2 boiled eggs"];

  // ---- LUNCH/DINNER proteins — varied, no repeats more than twice ----
  let lunchProteins: string[];
  let dinnerProteins: string[];
  if (budget === "under_100") {
    lunchProteins = noFish
      ? ["3 boiled eggs", "sugar beans (200g cooked)", "3 boiled eggs + sugar beans", "2 boiled eggs", "sugar beans (200g)", "3 boiled eggs", "2 boiled eggs"]
      : ["1 tin pilchards", "2 boiled eggs", "1 tin pilchards", "sugar beans (200g)", "1 tin pilchards", "2 boiled eggs + sugar beans", "1 tin pilchards"];
    dinnerProteins = noFish
      ? ["2 boiled eggs", "3 boiled eggs", "2 boiled eggs", "sugar beans (200g)", "2 boiled eggs", "3 boiled eggs", "2 boiled eggs"]
      : ["½ tin pilchards", "2 boiled eggs", "½ tin pilchards", "2 boiled eggs", "sugar beans (200g)", "½ tin pilchards", "2 boiled eggs"];
  } else if (budget === "100_300") {
    lunchProteins = noFish
      ? ["150g chicken thigh", "3 boiled eggs", "150g chicken thigh", "2 boiled eggs + baked beans", "150g chicken thigh", "3 boiled eggs", "150g chicken thigh"]
      : ["1 tin pilchards", "150g chicken thigh", "1 tin pilchards", "150g chicken thigh", "2 boiled eggs + baked beans", "1 tin pilchards", "150g chicken thigh"];
    dinnerProteins = noFish
      ? ["2 boiled eggs", "150g chicken thigh", "2 boiled eggs", "150g chicken thigh", "2 boiled eggs", "150g chicken thigh", "3 boiled eggs"]
      : ["150g chicken thigh", "2 boiled eggs", "½ tin pilchards", "150g chicken thigh", "2 boiled eggs", "½ tin pilchards", "150g chicken thigh"];
  } else if (budget === "300_600") {
    lunchProteins = noFish
      ? ["150g chicken thigh", "100g beef mince", "150g chicken breast", "100g beef mince", "150g chicken thigh", "2 eggs + cottage cheese", "100g beef mince"]
      : ["150g chicken thigh", "1 tin pilchards", "100g beef mince", "150g chicken breast", "1 tin pilchards", "150g chicken thigh", "100g beef mince"];
    dinnerProteins = noFish
      ? ["100g beef mince", "150g chicken breast", "2 eggs + cottage cheese", "150g chicken thigh", "100g beef mince", "150g chicken breast", "150g chicken thigh"]
      : ["100g beef mince", "150g chicken thigh", "1 tin pilchards", "100g beef mince", "150g chicken breast", "2 eggs", "100g beef mince"];
  } else {
    lunchProteins = noFish
      ? ["150g chicken breast", "150g beef mince", "150g chicken breast", "3 eggs + cottage cheese", "150g chicken thigh", "150g beef mince", "150g chicken breast"]
      : ["150g chicken breast", "200g salmon", "150g beef mince", "150g chicken breast", "1 tin pilchards", "150g chicken thigh", "200g salmon"];
    dinnerProteins = noFish
      ? ["150g beef mince", "150g chicken breast", "150g chicken thigh", "150g beef mince", "3 eggs + cottage cheese", "150g chicken thigh", "150g beef mince"]
      : ["150g beef mince", "150g chicken breast", "200g salmon", "150g chicken thigh", "150g beef mince", "1 tin pilchards", "150g chicken thigh"];
  }

  // ---- BREAKFAST carbs (oats, bread, sweet potato — morning foods only) ----
  let bfCarbs: string[];
  if (isLowGI) {
    bfCarbs = noGluten
      ? ["½ cup oats", "½ cup samp and beans", "½ cup oats", "½ cup samp and beans", "½ cup oats", "½ cup brown rice", "½ cup oats"]
      : ["½ cup oats", "½ cup samp and beans", "½ cup oats", "½ cup samp and beans", "½ cup oats", "½ cup samp and beans", "½ cup oats"];
  } else if (goal === "muscle_gain") {
    bfCarbs = noGluten
      ? ["1 cup oats", "2 sweet potatoes", "1 cup oats", "2 sweet potatoes", "1 cup oats", "2 sweet potatoes", "1 cup oats"]
      : ["1 cup oats", "2 slices brown bread", "1 cup oats", "2 slices brown bread", "1 cup oats", "2 slices brown bread", "1 cup oats"];
  } else {
    bfCarbs = noGluten
      ? ["1 medium sweet potato", "½ cup oats", "1 medium sweet potato", "½ cup oats", "1 medium sweet potato", "½ cup oats", "1 medium sweet potato"]
      : ["½ cup oats", "2 slices brown bread", "½ cup oats", "2 slices brown bread", "½ cup oats", "2 slices brown bread", "½ cup oats"];
  }

  // ---- LUNCH carbs (no oats — meal-appropriate starches) ----
  let lunchCarbs: string[];
  if (isLowGI) {
    lunchCarbs = noGluten
      ? ["1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato"]
      : ["1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato"];
  } else if (goal === "muscle_gain") {
    lunchCarbs = ["1 cup brown rice", "2 sweet potatoes", "1 cup brown rice", "2 sweet potatoes", "1 cup brown rice", "2 sweet potatoes", "1 cup brown rice"];
  } else if (goal === "fat_loss") {
    lunchCarbs = noGluten
      ? ["1 medium sweet potato", "½ cup brown rice", "1 medium sweet potato", "½ cup brown rice", "1 medium sweet potato", "½ cup brown rice", "1 medium sweet potato"]
      : ["½ cup brown rice", "1 medium sweet potato", "2 slices brown bread", "½ cup brown rice", "1 medium sweet potato", "2 slices brown bread", "½ cup brown rice"];
  } else {
    lunchCarbs = noGluten
      ? ["1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato", "½ cup samp and beans", "½ cup brown rice", "1 medium sweet potato"]
      : ["½ cup brown rice", "1 medium sweet potato", "2 slices brown bread", "½ cup brown rice", "1 medium sweet potato", "½ cup brown rice", "2 slices brown bread"];
  }

  // ---- DINNER carbs — lighter for fat loss, same as lunch for others ----
  let dinnerCarbs: string[];
  if (goal === "fat_loss") {
    dinnerCarbs = noGluten
      ? ["½ medium sweet potato", "½ cup samp and beans", "½ medium sweet potato", "½ cup brown rice", "½ medium sweet potato", "½ cup samp and beans", "½ medium sweet potato"]
      : ["½ cup brown rice", "½ medium sweet potato", "½ cup samp and beans", "½ medium sweet potato", "½ cup brown rice", "½ medium sweet potato", "½ cup samp and beans"];
  } else if (goal === "recomposition") {
    dinnerCarbs = ["½ medium sweet potato", "½ cup brown rice", "extra veg only (rest day)", "½ medium sweet potato", "½ cup brown rice", "extra veg only (rest day)", "½ medium sweet potato"];
  } else {
    dinnerCarbs = lunchCarbs;
  }

  // Vegetables rotation
  const vegOptions = ["cabbage (boiled)", "spinach (wilted)", "cabbage + tomato", "spinach + onion",
    budget !== "under_100" ? "frozen mixed veg" : "cabbage", "spinach + tomato", "cabbage + onion"];

  // Dairy/milk based on goal
  const milkType = (goal === "muscle_gain" && !noDairy && budget !== "under_100") ? "full cream milk" : (!noDairy ? "low fat milk" : "water");
  const pbServing = noPeanuts ? (budget !== "under_100" ? "1 extra egg" : "extra sugar beans") : (goal === "muscle_gain" ? "2 tbsp peanut butter" : "1 tbsp peanut butter");

  // Pre-workout options (training days)
  const preOptions = [
    noGluten ? `banana + 2 egg whites — 180 cal, 14g protein, 5 min` : `2 brown bread + ${noPeanuts ? "1 boiled egg" : "1 tbsp peanut butter"} — 220 cal, 12g protein, 3 min`,
    `½ cup oats + 1 egg white + banana — 200 cal, 10g protein, 5 min`,
    noFish ? `banana + 1 boiled egg — 180 cal, 10g protein, 2 min` : `banana + ¼ tin pilchards — 180 cal, 14g protein, 2 min`,
    `½ cup oats + ${milkType} — 190 cal, 8g protein, 5 min`,
  ];

  // Post-workout options (training days)
  const postOptions = [
    noFish ? `3 boiled eggs + 1 medium sweet potato — 340 cal, 24g protein` : `½ tin pilchards + ½ cup pap — 280 cal, 22g protein`,
    `2 eggs + 1 medium sweet potato — 290 cal, 18g protein`,
    noFish ? `150g chicken + ½ cup rice — 320 cal, 30g protein` : `1 tin pilchards + 2 brown bread slices — 300 cal, 25g protein`,
    `2 eggs + banana — 250 cal, 16g protein`,
  ];

  // Calorie split per meal
  const bfCal = Math.round(adjustedCal * 0.25);
  const lunchCal = Math.round(adjustedCal * 0.35);
  const dinnerCal = Math.round(adjustedCal * 0.28);

  // Build 7-day plan
  let plan = "";
  allDays.forEach((day, i) => {
    const isTraining = trainingSet.has(day);
    const bfProt = bfProteins[i];
    const bfCarb = bfCarbs[i];
    const lp = lunchProteins[i];
    const lc = lunchCarbs[i];
    const dp = dinnerProteins[i];
    const dc = dinnerCarbs[i];
    const v = vegOptions[i % vegOptions.length];
    const v2 = vegOptions[(i + 3) % vegOptions.length];
    const pre = preOptions[i % preOptions.length];
    const post = postOptions[i % postOptions.length];

    // ---- BREAKFAST ----
    let bf: string;
    if (isStudent) {
      bf = i % 2 === 0
        ? `½ cup oats + ${noDairy ? "water" : "low fat milk"} + 1 boiled egg — ${bfCal} cal, 14g protein, 8 min`
        : noGluten ? `2 boiled eggs + banana — ${bfCal} cal, 15g protein, 5 min` : `2 boiled eggs + 2 brown bread — ${bfCal} cal, 16g protein, 8 min`;
    } else if (isLowGI) {
      bf = i % 2 === 0
        ? `${bfCarb} + ${noDairy ? "" : `${milkType} + `}2 boiled eggs — ${bfCal} cal, 18g protein, ${maxPrep}`
        : `${bfCarb} + 1 boiled egg — ${bfCal} cal, 16g protein, 20 min (batch cook Sunday)`;
    } else if (goal === "muscle_gain") {
      bf = i % 3 === 0
        ? `${bfProt} + ${bfCarb} + ${milkType} — ${bfCal} cal, 26g protein, ${maxPrep}`
        : i % 3 === 1 ? `${bfProt} + banana + ${pbServing} — ${bfCal} cal, 24g protein, ${maxPrep}`
        : `${bfProt} + ${bfCarb} + banana — ${bfCal} cal, 24g protein, ${maxPrep}`;
    } else {
      bf = i % 2 === 0
        ? `${bfCarb} + ${bfProt} — ${bfCal} cal, 18g protein, ${maxPrep}`
        : noGluten ? `${bfProt} + 1 medium sweet potato — ${bfCal} cal, 16g protein, ${maxPrep}` : `${bfProt} + 2 brown bread — ${bfCal} cal, 16g protein, ${maxPrep}`;
    }

    // ---- LUNCH ----
    const seasonNote = isHypertension ? " (season: lemon + garlic, no Aromat)" : "";
    let lunch: string;
    if (isStudent) {
      lunch = noFish
        ? `${lp} + ${lc} + ${v} — ${lunchCal} cal, 22g protein, 10 min`
        : i % 2 === 0 ? `1 tin pilchards + ${noGluten ? "1 sweet potato" : "2 brown bread"} — ${lunchCal} cal, 25g protein, 3 min` : `${lp} + ${lc} — ${lunchCal} cal, 20g protein, 10 min`;
    } else {
      lunch = `${lp} + ${lc} + ${v}${seasonNote} — ${lunchCal} cal, 25g protein, ${maxPrep}`;
    }

    // ---- DINNER ----
    let dinner: string;
    if (isStudent) {
      dinner = i % 2 === 0
        ? noFish ? `2 eggs + cabbage — ${dinnerCal} cal, 14g protein, 8 min` : `½ tin pilchards + cabbage — ${dinnerCal} cal, 18g protein, 5 min`
        : `2 eggs + spinach — ${dinnerCal} cal, 14g protein, 8 min`;
    } else {
      dinner = `${dp} + ${dc} + ${v2}${seasonNote} — ${dinnerCal} cal, 25g protein, ${maxPrep}`;
    }

    // Snack
    let snack = "";
    if (budget !== "under_100") {
      if (goal === "muscle_gain") snack = noPeanuts ? `baked beans ½ tin — 110 cal, 7g protein` : `${pbServing} + banana — 260 cal, 9g protein`;
      else if (!noDairy && budget !== "100_300") snack = `low fat yoghurt 150g — 100 cal, 10g protein`;
      else snack = `baked beans ½ tin — 110 cal, 7g protein`;
    }

    const dayLabel = isTraining ? `${day} — Training Day 🏋️` : `${day} — Rest Day`;
    let dayPlan = `\n*${dayLabel}*\n`;
    if (isTraining) dayPlan += `Pre-workout (60–90 min before): ${pre}\n`;
    dayPlan += `${meal1Label}: ${bf}\n`;
    if (isLowGI) dayPlan += `Snack 10am: 1 apple or banana + 1 boiled egg — 120 cal, 8g protein\n`;
    dayPlan += `Lunch: ${lunch}\n`;
    if (isLowGI) dayPlan += `Snack 3pm: ${noDairy ? "1 boiled egg" : "125g low fat yoghurt or 1 boiled egg"} — 80 cal, 8g protein\n`;
    if (isTraining) dayPlan += `Post-workout (within 30 min): ${post}\n`;
    if (snack && !isLowGI) dayPlan += `Snack: ${snack}\n`;
    dayPlan += `${meal3Label}: ${dinner}\n`;
    dayPlan += `Daily total: ≈${adjustedCal} cal, ${adjustedProt}g protein`;
    plan += dayPlan;
  });

  // Shopping list + total + tip by budget
  let shopList: string;
  let shopTotal: number;
  let proTip: string;

  if (budget === "under_100") {
    shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\n${noFish ? "Extra eggs (6 pack) — R25" : "Pilchards 3 tins — R36"}\nSugar beans 500g — R20\nCabbage 1 head — R8\n${isLowGI ? "Oats 500g — R15 (replaces pap)" : "Pap/maize meal 2kg — R15"}\nSpinach 1 bunch — R10\nOnions — R8\nSunflower oil 500ml — R10`;
    shopTotal = 152;
    proTip = "Cook a big pot of sugar beans on Sunday — it feeds you 3 days at under R7 per serving. Add one egg per bowl for complete protein.";
  } else if (budget === "100_300") {
    shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\n${noFish ? "Chicken portions extra 500g — R20" : "Pilchards 3 tins — R36"}\nFrozen chicken portions 1kg — R40\nOats 500g — R15\n${noGluten ? "" : "Brown bread 1 loaf — R14\n"}Sweet potato 1kg — R12\nCabbage — R8\nSpinach — R10\nOnions + tomatoes — R23\nGarlic — R8\nSunflower oil — R10`;
    shopTotal = 221;
    proTip = "Buy a whole frozen chicken instead of portions — cut it yourself and save R15–R20 per kg. Shoprite often runs chicken specials on Tuesdays.";
  } else if (budget === "300_600") {
    shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\nFrozen chicken 1.5kg — R60\nBeef mince 500g — R60\n${noFish ? "" : "Pilchards 2 tins — R24\n"}Oats 1kg — R25\nBrown rice 1kg — R20\nSweet potato 1.5kg — R18\nBanana bunch — R15\n${noDairy ? "" : `${goal === "muscle_gain" ? "Full cream milk 1L — R22" : "Low fat milk 1L — R20"}\n`}${noPeanuts ? "" : "Peanut butter 400g — R25\n"}Spinach — R10\nCabbage — R8\nTomatoes 500g — R15\n${noDairy ? "" : "Cottage cheese 250g — R20\n"}Garlic + lemon — R13`;
    shopTotal = 378;
    proTip = "Brown 500g mince on Sunday and split into 3 portions — that's 3 dinners sorted in one 20-minute cook. Mince gives you the most protein per rand of any red meat.";
  } else {
    shopList = `*Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\nChicken breast 1kg — R80\n${noFish ? "" : "Salmon 400g (×2) — R160\n"}Beef mince 500g — R60\n${noDairy ? "" : "Low fat Greek yoghurt 500g — R35\n"}Oats 1kg — R25\nBrown rice 1kg — R20\nSweet potato 2kg — R24\nBanana bunch — R15\n${noPeanuts ? "" : "Peanut butter 400g — R25\n"}Broccoli — R20\nSpinach — R10\n${noDairy ? "" : "Low fat milk 1L — R20\n"}Almonds 100g — R40\nOlive oil 250ml — R40`;
    shopTotal = 619;
    proTip = "Salmon goes on special at Shoprite most Fridays — buy two packs and freeze immediately. Frozen salmon has identical nutrition to fresh and costs R30 less.";
  }

  // Special situation notes
  const goalNote = goal === "fat_loss"
    ? `\n\n⚠️ *Fat loss rules:* Sweet potato over white pap always. High-volume veg fills the plate first — protein second, carbs last. ${noDairy ? "" : "Low fat dairy only."} ${noPeanuts ? "" : "Max 1 tbsp peanut butter — not a staple."}`
    : goal === "muscle_gain"
    ? `\n\n💪 *Muscle gain rules:* Whole eggs every time — the yolk has the nutrients. ${noDairy ? "" : `${milkType} for extra calories.`} ${noPeanuts ? "" : "Peanut butter is your friend — calorie dense and protein rich."} Pre and post-workout meals are non-negotiable.`
    : goal === "recomposition"
    ? `\n\n🔄 *Recomp rules:* Carbs before and after training. Lower carbs on rest day evenings. Protein stays the same every day — no exceptions. Zero empty calories.`
    : "";
  const nightNote = isNightShift ? `\n\n🌙 *Night shift:* All timings are relative to your shift. Pre-shift = your breakfast. Post-shift = your dinner.` : "";
  const hivNote = isHIV ? `\n\n💊 *ARV reminder:* Take your medication with breakfast every day — never on an empty stomach.` : "";
  const domesticNote = (situation === "retail_physical" && !isUnemployed) ? `\n\n🧹 *Active job note:* Your job already burns 300+ extra calories. Plan adjusted. Batch cook Sunday so you have food ready without cooking after long shifts.` : "";
  const studentNote = isStudent ? `\n\n📚 *Student note:* Every meal in this plan is under 10 minutes and under 3 ingredients. Res tuck shop strategy — pilchards + brown bread is one of the best budget meals in SA. Maggi noodles + 1 egg is acceptable when budget is critical.` : "";
  const unemployedNote = isUnemployed ? `\n\n💰 *Budget note:* Every meal here costs under R15. Batch cook beans on Sunday for the week — one 500g bag of sugar beans feeds you protein for 4 days at R5 per serving.` : "";

  const trainingDaysStr = Array.from(trainingSet).join(", ");
  const header = `*Your Personalised 7 Day Meal Plan*\n${name} | Goal: ${goalLabels[goal] || goal} | ${adjustedCal} cal/day | ${adjustedProt}g protein/day\nBudget: ${budgetLabels[budget]} per week | Shop at Shoprite or Boxer${medFlags.length > 0 ? `\n⚠️ Medical: ${medFlags.join(" · ")}` : ""}`;
  const trainingLine = `\n*Training Days:* ${trainingDaysStr} (${daysPerWeek} day${daysPerWeek > 1 ? "s" : ""}/week)`;

  return `${header}${trainingLine}${goalNote}${nightNote}${hivNote}${domesticNote}${studentNote}${unemployedNote}\n${plan}\n\n${shopList}\nEstimated total: R${shopTotal}\n🛒 Pro tip: ${proTip}\n\n_Reply SWAP [day] to swap any day. Reply SHOPPING LIST for just the shopping list. Reply WHY to understand why I chose these specific foods for your goal._`;
}

// ============================================================
// CALORIE / PROTEIN TARGET CALCULATOR — single source of truth
// ============================================================

function calculateTargets(
  weight: number,
  goalType: string,
  lifeSituation: string,
  trainingDaysPerWeek: number,
): { calorieTarget: number; proteinTarget: number } {
  const bmr = weight * 22;

  const activityMult: Record<string, number> = {
    office: 1.3, student: 1.35, unemployed: 1.25, retired: 1.2,
    stay_home_parent: 1.3, retail_physical: 1.5,
    "1": 1.35, "2": 1.3, "3": 1.5, "4": 1.25, "5": 1.3, "6": 1.2,
  };
  const mult = activityMult[lifeSituation] || 1.3;

  const trainingAdj = Math.round((200 * Math.min(trainingDaysPerWeek, 7)) / 7);

  const goalAdj: Record<string, number> = {
    fat_loss: -400, muscle_gain: 400, recomposition: 0,
    general: 100, health_condition: 0,
  };
  const adj = goalAdj[goalType] ?? 0;

  let calorieTarget = Math.round(bmr * mult + trainingAdj + adj);
  calorieTarget = Math.max(1500, Math.min(4500, calorieTarget));

  const proteinMult: Record<string, number> = {
    fat_loss: 2.0, muscle_gain: 2.4, recomposition: 2.2,
    general: 1.8, health_condition: 2.0,
  };
  const proteinTarget = Math.round(weight * (proteinMult[goalType] || 2.0));

  return { calorieTarget, proteinTarget };
}

// ============================================================
// ONBOARDING FLOW — 13-STATE SEQUENCE
// ============================================================

async function handleOnboarding(user: any, message: string, phone: string): Promise<string> {
  const state = user.onboardingState || "START";
  const msg = message.trim();

  // ---- START (new users only — sends welcome, moves to WELCOME state) ----
  if (state === "START") {
    await db.update(users).set({ onboardingState: "WELCOME" }).where(eq(users.phoneNumber, phone));
    return `Sawubona! I'm Coach K. 20 years of real SA coaching, now in your pocket 24/7. What's your name?`;
  }

  // ---- WELCOME — waiting for name reply ----
  if (state === "WELCOME") {
    const raw = msg.trim();
    const words = raw.split(/\s+/);
    const hasBadPunctuation = /[^a-zA-Z\s''-]/.test(raw);
    const COMMANDS = new Set(["RESET", "START", "RESTART", "MENU", "HELP", "DONE", "YES", "NO", "OK", "OKAY", "HI", "HEY", "HELLO", "HOWZIT", "HOLA", "YO", "SUP", "EITA", "SAWUBONA", "YEBO", "STOP", "CANCEL"]);
    if (!raw || raw.length < 2 || raw.length > 20 || words.length > 3 || hasBadPunctuation || COMMANDS.has(raw.toUpperCase())) {
      return `Just your first name — what do people call you?`;
    }
    const name = words.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
    await db.update(users).set({ name, onboardingState: "ASK_AGE" }).where(eq(users.phoneNumber, phone));
    return `Sharp ${name}. How old are you?`;
  }

  // ---- ASK_AGE ----
  if (state === "ASK_AGE") {
    const age = parseInt(msg.replace(/[^0-9]/g, ""));
    if (isNaN(age) || age < 10 || age > 110) return `Just your age please. For example: 28`;
    if (age < 16) return `I coach from age 16 upward. Get a parent or guardian to sign up with you.`;
    const isElderly = age >= 65;
    await db.update(users).set({ age, elderlyClient: isElderly, onboardingState: "ASK_WEIGHT_HEIGHT" }).where(eq(users.phoneNumber, phone));
    return `What's your current weight in kg and your height?\n\nExample: 78kg, 1.72m`;
  }

  // ---- ASK_WEIGHT_HEIGHT ----
  if (state === "ASK_WEIGHT_HEIGHT") {
    const weightMatch = msg.match(/(\d+(?:\.\d+)?)\s*kg/i);
    if (!weightMatch) return `Please give me your weight and height. Example: 78kg, 1.72m`;
    const weight = parseFloat(weightMatch[1]);
    if (weight < 30 || weight > 350) return `That weight doesn't look right. Example: 78kg, 1.72m`;

    const heightMMatch = msg.match(/(\d+\.\d+)\s*m(?!g)/i);
    const heightCmMatch = msg.match(/(\d{3})\s*cm/i);
    let heightM = 1.7;
    let heightCmVal = 170;
    if (heightMMatch) {
      heightM = parseFloat(heightMMatch[1]);
      heightCmVal = Math.round(heightM * 100);
    } else if (heightCmMatch) {
      heightCmVal = parseInt(heightCmMatch[1]);
      heightM = heightCmVal / 100;
    }

    const bmi = Math.round((weight / (heightM * heightM)) * 10) / 10;
    const protein = Math.round(weight * 2);
    await db.update(users).set({
      currentWeight: weight.toString(),
      heightCm: heightCmVal,
      bmi: bmi.toString(),
      proteinTarget: protein,
      onboardingState: "ASK_GOAL",
    }).where(eq(users.phoneNumber, phone));
    return `What's your main goal right now?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both — body recomposition\n4️⃣ Get fit and healthy generally\n5️⃣ Manage a health condition`;
  }

  // ---- ASK_GOAL ----
  if (state === "ASK_GOAL") {
    const lower = msg.toLowerCase();
    const hasGoalNumber = /[1-5]/.test(msg);
    const hasGoalKeyword = lower.includes("lose") || lower.includes("fat") || lower.includes("muscle") || lower.includes("build") || lower.includes("recomp") || lower.includes("both") || lower.includes("general") || lower.includes("fit") || lower.includes("health") || lower.includes("condition") || lower.includes("manage") || lower.includes("weight");
    if (!hasGoalNumber && !hasGoalKeyword) {
      return `What's your main goal right now?\n\n1️⃣ Lose fat\n2️⃣ Build muscle\n3️⃣ Both — body recomposition\n4️⃣ Get fit and healthy generally\n5️⃣ Manage a health condition`;
    }
    let goal = "fat_loss";
    if (msg.includes("2") || lower.includes("build") || lower.includes("muscle")) goal = "muscle_gain";
    else if (msg.includes("3") || lower.includes("recomp") || lower.includes("both")) goal = "recomposition";
    else if (msg.includes("4") || lower.includes("general") || lower.includes("fit") || lower.includes("health")) goal = "general";
    else if (msg.includes("5") || lower.includes("condition") || lower.includes("manage")) goal = "health_condition";
    await db.update(users).set({ goalType: goal, onboardingState: "ASK_SITUATION" }).where(eq(users.phoneNumber, phone));
    return `Which best describes your situation?\n\n1️⃣ Student\n2️⃣ Working — office or desk job\n3️⃣ Working — physically active job (retail, security, domestic work, construction)\n4️⃣ Unemployed or between jobs\n5️⃣ Stay at home parent\n6️⃣ Retired`;
  }

  // ---- ASK_SITUATION ----
  if (state === "ASK_SITUATION") {
    const lower = msg.toLowerCase();
    const hasSitNumber = /[1-6]/.test(msg);
    const hasSitKeyword = lower.includes("student") || lower.includes("office") || lower.includes("desk") || lower.includes("retail") || lower.includes("physical") || lower.includes("domestic") || lower.includes("construction") || lower.includes("security") || lower.includes("unemployed") || lower.includes("parent") || lower.includes("home") || lower.includes("retire");
    if (!hasSitNumber && !hasSitKeyword) {
      return `Which best describes your situation?\n\n1️⃣ Student\n2️⃣ Working — office or desk job\n3️⃣ Working — physically active job\n4️⃣ Unemployed or between jobs\n5️⃣ Stay at home parent\n6️⃣ Retired`;
    }
    const situationMap: Record<string, string> = {
      "1": "student", "2": "office", "3": "retail_physical",
      "4": "unemployed", "5": "stay_home_parent", "6": "retired",
    };
    let situation = situationMap[msg.trim()] || "none";
    if (!situationMap[msg.trim()]) {
      if (lower.includes("student")) situation = "student";
      else if (lower.includes("office") || lower.includes("desk")) situation = "office";
      else if (lower.includes("retail") || lower.includes("domestic") || lower.includes("physical") || lower.includes("construction") || lower.includes("security")) situation = "retail_physical";
      else if (lower.includes("unemployed")) situation = "unemployed";
      else if (lower.includes("parent") || lower.includes("home")) situation = "stay_home_parent";
      else if (lower.includes("retire")) situation = "retired";
    }
    await db.update(users).set({ lifeSituation: situation, onboardingState: "ASK_MEDICAL" }).where(eq(users.phoneNumber, phone));
    return `Do you have any of the following? Reply with the number or numbers, or say None.\n\n1️⃣ Diabetes or pre-diabetes\n2️⃣ High blood pressure\n3️⃣ Heart condition\n4️⃣ HIV on ARVs\n5️⃣ TB or TB treatment\n6️⃣ PCOS\n7️⃣ Asthma\n8️⃣ None of the above`;
  }

  // ---- ASK_MEDICAL ----
  if (state === "ASK_MEDICAL") {
    const lower = msg.toLowerCase();
    const isNone = lower.includes("none") || lower.includes("nothing") || lower.includes("n/a") || msg.includes("8");
    const conditions: string[] = [];
    if (msg.includes("1") || lower.includes("diab")) conditions.push("diabetes");
    if (msg.includes("2") || lower.includes("blood pressure") || lower.includes("hypert")) conditions.push("hypertension");
    if (msg.includes("3") || lower.includes("heart")) conditions.push("heart_condition");
    if (msg.includes("4") || lower.includes("hiv") || lower.includes("arv")) conditions.push("hiv_arvs");
    if (msg.includes("5") || (lower.includes("tb") && !lower.includes("stb"))) conditions.push("tb");
    if (msg.includes("6") || lower.includes("pcos")) conditions.push("pcos");
    if (msg.includes("7") || lower.includes("asthma")) conditions.push("asthma");

    // Free-text unlisted condition — store note, stay on ASK_MEDICAL, re-ask the list
    if (!isNone && conditions.length === 0) {
      const existingNotes = user.otherMedicalNotes || "";
      const updatedNotes = existingNotes ? `${existingNotes} | ${msg}` : msg;
      await db.update(users).set({
        otherMedicalNotes: updatedNotes,
        // state stays ASK_MEDICAL so next number or "None" advances normally
      }).where(eq(users.phoneNumber, phone));
      return `Got it, I have noted that. Do you have any of the listed conditions as well? Reply with a number or None.\n\n1️⃣ Diabetes or pre-diabetes\n2️⃣ High blood pressure\n3️⃣ Heart condition\n4️⃣ HIV on ARVs\n5️⃣ TB or TB treatment\n6️⃣ PCOS\n7️⃣ Asthma\n8️⃣ None of the above`;
    }

    const hasDiabetes = conditions.includes("diabetes");
    const hasHeart = conditions.includes("heart_condition");
    await db.update(users).set({
      medicalConditions: conditions.length > 0 ? conditions.join(",") : "none",
      nutritionProtocol: hasDiabetes ? "LOW_GI" : null,
      mealTimingStrict: hasDiabetes,
      doctorClearanceRequired: hasHeart,
      onboardingState: "ASK_INJURIES",
    }).where(eq(users.phoneNumber, phone));
    return `Any injuries or physical limitations I must know about?\n\nBad knees, bad back, bad shoulder, hip problem, recent surgery — anything.\n\nOr say None.`;
  }

  // ---- AWAITING_MEDICAL_NOTES ----
  if (state === "AWAITING_MEDICAL_NOTES") {
    const existing = user.otherMedicalNotes || "";
    const combined = existing + " | " + msg;
    await db.update(users).set({
      otherMedicalNotes: combined,
      onboardingState: "ASK_MEDICAL",
    }).where(eq(users.phoneNumber, phone));
    return `Got it, I have that noted.\n\nNow — do any of these apply to you?\n\n1️⃣ Diabetes\n2️⃣ High blood pressure / Hypertension\n3️⃣ Heart condition\n4️⃣ HIV on ARVs\n5️⃣ TB\n6️⃣ PCOS\n7️⃣ Asthma\n8️⃣ None of these\n\nReply with the number or numbers that apply. Example: 1 and 2.`;
  }

  // ---- ASK_INJURIES ----
  if (state === "ASK_INJURIES") {
    const lower = msg.toLowerCase().trim();
    const isClearNone = lower === "none" || lower === "no" || lower === "n/a" || lower === "nil" || lower === "nope" || lower === "nothing";
    const hasInjuryWord = lower.includes("knee") || lower.includes("back") || lower.includes("shoulder") || lower.includes("hip") || lower.includes("ankle") || lower.includes("wrist") || lower.includes("elbow") || lower.includes("neck") || lower.includes("surgery") || lower.includes("injury") || lower.includes("pain") || lower.includes("torn") || lower.includes("sprain") || lower.includes("fracture") || lower.includes("disc") || lower.includes("hernia") || lower.includes("arthritis") || lower.includes("condition") || lower.includes("limited") || lower.includes("weak") || lower.includes("problem");
    const isNonAnswer = /^(good lord|lol|haha|ha|wow|what|huh|ok|okay|sure|cool|nice|great|thanks|yep|yeah|nah|oh|ah|hmm|um|erm|eh|interesting|really|seriously|fine|alright|right|gotcha|understood|noted)$/i.test(lower);
    if (!isClearNone && !hasInjuryWord && isNonAnswer) {
      return `Ha fair enough. Any actual injuries or physical limitations I should know about? Or just say None.`;
    }
    const injuries = isClearNone ? "" : msg;
    await db.update(users).set({ injuries, onboardingState: "ASK_EQUIPMENT" }).where(eq(users.phoneNumber, phone));
    return `Where will you be training?\n\n1️⃣ Gym with full equipment\n2️⃣ Gym with basic equipment\n3️⃣ Home — no equipment\n4️⃣ Home — have some equipment (dumbbells or bands)\n5️⃣ Outside — park, field, stairs`;
  }

  // ---- ASK_EQUIPMENT ----
  if (state === "ASK_EQUIPMENT") {
    const lower = msg.toLowerCase();
    const hasEquipNumber = /[1-5]/.test(msg);
    const hasEquipKeyword = lower.includes("gym") || lower.includes("home") || lower.includes("dumbbell") || lower.includes("band") || lower.includes("outside") || lower.includes("park") || lower.includes("stairs") || lower.includes("no equipment") || lower.includes("nothing");
    if (!hasEquipNumber && !hasEquipKeyword) {
      return `Where will you be training?\n\n1️⃣ Gym with full equipment\n2️⃣ Gym with basic equipment\n3️⃣ Home — no equipment\n4️⃣ Home — have some equipment (dumbbells or bands)\n5️⃣ Outside — park, field, stairs`;
    }
    let location = "home_none";
    let mode = "home";
    let isGym = false;
    if (msg.includes("1") || (lower.includes("gym") && lower.includes("full"))) { location = "gym_full"; mode = "gym"; isGym = true; }
    else if (msg.includes("2") || (lower.includes("gym") && lower.includes("basic"))) { location = "gym_basic"; mode = "gym"; isGym = true; }
    else if (msg.includes("3") || (lower.includes("home") && (lower.includes("no") || lower.includes("none")))) { location = "home_none"; }
    else if (msg.includes("4") || lower.includes("dumbbell") || lower.includes("band")) { location = "home_equipment"; }
    else if (msg.includes("5") || lower.includes("outside") || lower.includes("park") || lower.includes("stairs")) { location = "outside"; }
    else if (lower.includes("gym")) { location = "gym_full"; mode = "gym"; isGym = true; }
    await db.update(users).set({ trainingLocation: location, trainingMode: mode, onboardingState: isGym ? "ASK_GYM_NAME" : "ASK_TRAINING_DAYS" }).where(eq(users.phoneNumber, phone));
    if (isGym) {
      return `Which gym are you a member of?\n\n1️⃣ Virgin Active\n2️⃣ Planet Fitness\n3️⃣ Curves\n4️⃣ Local or community gym\n5️⃣ Other`;
    }
    return `How many days per week can you realistically train? Be honest — not what you wish, what you will actually do.\n\n1️⃣ 2 days\n2️⃣ 3 days\n3️⃣ 4 days\n4️⃣ 5 days\n5️⃣ 6 days`;
  }

  // ---- ASK_GYM_NAME ----
  if (state === "ASK_GYM_NAME") {
    const gymMap: Record<string, string> = {
      "1": "Virgin Active", "2": "Planet Fitness", "3": "Curves", "4": "Local gym", "5": "Other",
    };
    const lower = msg.toLowerCase();
    let gymName = gymMap[msg.trim()] || msg.trim();
    if (!gymMap[msg.trim()]) {
      if (lower.includes("virgin")) gymName = "Virgin Active";
      else if (lower.includes("planet")) gymName = "Planet Fitness";
      else if (lower.includes("curves")) gymName = "Curves";
      else if (lower.includes("local") || lower.includes("community")) gymName = "Local gym";
    }
    await db.update(users).set({ gymName, onboardingState: "ASK_TRAINING_DAYS" }).where(eq(users.phoneNumber, phone));
    return `How many days per week can you realistically train? Be honest — not what you wish, what you will actually do.\n\n1️⃣ 2 days\n2️⃣ 3 days\n3️⃣ 4 days\n4️⃣ 5 days\n5️⃣ 6 days`;
  }

  // ---- ASK_TRAINING_DAYS ----
  if (state === "ASK_TRAINING_DAYS") {
    const hasDayOption = /[1-5]/.test(msg);
    const hasDayNumber = /\b[2-6]\b/.test(msg);
    if (!hasDayOption && !hasDayNumber) {
      return `How many days per week can you realistically train?\n\n1️⃣ 2 days\n2️⃣ 3 days\n3️⃣ 4 days\n4️⃣ 5 days\n5️⃣ 6 days`;
    }
    const dayMap: Record<string, number> = { "1": 2, "2": 3, "3": 4, "4": 5, "5": 6 };
    let days = dayMap[msg.trim()] || 3;
    if (!dayMap[msg.trim()]) {
      const numMatch = msg.match(/\b([2-6])\b/);
      if (numMatch) days = parseInt(numMatch[1]);
    }
    await db.update(users).set({ trainingDaysPerWeek: days, onboardingState: "ASK_EXPERIENCE" }).where(eq(users.phoneNumber, phone));
    return `Training experience?\n\n1️⃣ Complete beginner — never trained consistently\n2️⃣ Some experience — trained on and off\n3️⃣ Intermediate — trained consistently for 1 to 2 years\n4️⃣ Advanced — training seriously for 2 plus years`;
  }

  // ---- ASK_EXPERIENCE ----
  if (state === "ASK_EXPERIENCE") {
    const lower = msg.toLowerCase();
    const hasExpNumber = /[1-4]/.test(msg);
    const hasExpKeyword = lower.includes("beginner") || lower.includes("never") || lower.includes("intermediate") || lower.includes("advanced") || lower.includes("some") || lower.includes("serious") || lower.includes("on and off") || lower.includes("years");
    if (!hasExpNumber && !hasExpKeyword) {
      return `Training experience?\n\n1️⃣ Complete beginner — never trained consistently\n2️⃣ Some experience — trained on and off\n3️⃣ Intermediate — trained consistently for 1 to 2 years\n4️⃣ Advanced — training seriously for 2 plus years`;
    }
    let exp = "beginner";
    if (msg.includes("3") || lower.includes("intermediate") || lower.includes("1 to 2") || lower.includes("1-2")) exp = "intermediate";
    else if (msg.includes("4") || lower.includes("advanced") || lower.includes("serious") || lower.includes("2 plus") || lower.includes("2+")) exp = "advanced";
    await db.update(users).set({ trainingExperience: exp, onboardingState: "ASK_BUDGET" }).where(eq(users.phoneNumber, phone));
    return `Roughly how much do you spend on food per week?\n\n1️⃣ Under R100 — very tight\n2️⃣ R100 to R300 — tight but manageable\n3️⃣ R300 to R600 — average\n4️⃣ Over R600 — flexible`;
  }

  // ---- ASK_BUDGET ----
  if (state === "ASK_BUDGET") {
    const lower = msg.toLowerCase();
    const BUDGET_REJECT = `Reply with a number only — 1 for under R100, 2 for R100 to R300, 3 for R300 to R600, 4 for over R600`;

    // Smart rand-amount detection — extract any number with R prefix or "monthly"/"week"/"pm"
    let detectedWeeklyRand: number | null = null;
    const randMatch = msg.match(/R\s*(\d[\d\s,]*)/i) || msg.match(/(\d[\d,]+)\s*(rand|pm|monthly|per month|p\/m)/i);
    if (randMatch) {
      const rawNum = parseInt(randMatch[1].replace(/[\s,]/g, ""));
      const isMonthly = /monthly|per month|pm|p\/m/i.test(msg);
      detectedWeeklyRand = isMonthly ? Math.round(rawNum / 4.33) : rawNum;
    }

    let budget: string | null = null;

    // Strict: standalone digit 1–4
    if (/^\s*[1-4]\s*$/.test(msg)) {
      const budgetMap: Record<string, string> = { "1": "under_100", "2": "100_300", "3": "300_600", "4": "over_600" };
      budget = budgetMap[msg.trim()];
    } else if (detectedWeeklyRand !== null) {
      // Auto-classify based on weekly rand amount
      if (detectedWeeklyRand < 100) budget = "under_100";
      else if (detectedWeeklyRand <= 300) budget = "100_300";
      else if (detectedWeeklyRand <= 600) budget = "300_600";
      else budget = "over_600";
    } else if (lower.includes("very tight") || lower.includes("under") || lower === "tight") {
      budget = "under_100";
    } else if (lower.includes("flexible") || lower.includes("over")) {
      budget = "over_600";
    } else if (lower.includes("average")) {
      budget = "300_600";
    }

    if (!budget) {
      return BUDGET_REJECT;
    }
    const budgetLevel = budget === "under_100" ? "low" : budget === "over_600" ? "high" : "medium";

    // Fix 7 — Confirm auto-classification so client knows what was detected
    const budgetLabel: Record<string, string> = {
      under_100: "under R100 per week",
      "100_300": "R100 to R300 per week",
      "300_600": "R300 to R600 per week",
      over_600: "over R600 per week",
    };
    const detectedNote = detectedWeeklyRand !== null
      ? `Got it — that works out to about R${detectedWeeklyRand} per week, so I have set your food budget as ${budgetLabel[budget]}.\n\n`
      : "";

    await db.update(users).set({ weeklyFoodBudget: budget, budgetLevel, onboardingState: "ASK_WORK_SCHEDULE" }).where(eq(users.phoneNumber, phone));
    return `${detectedNote}Last one. What does your typical day look like?\n\n1️⃣ Standard hours — 8am to 5pm\n2️⃣ Early shift — start before 7am\n3️⃣ Night shift — work through the night\n4️⃣ Irregular — changes week to week\n5️⃣ Work from home or no fixed schedule`;
  }

  // ---- ASK_WORK_SCHEDULE → COMPLETE ----
  if (state === "ASK_WORK_SCHEDULE") {
    const lower = msg.toLowerCase();
    const hasSchedNumber = /[1-5]/.test(msg);
    const hasSchedKeyword = lower.includes("standard") || lower.includes("8am") || lower.includes("8 am") || lower.includes("early") || lower.includes("night") || lower.includes("irregular") || lower.includes("change") || lower.includes("home") || lower.includes("wfh") || lower.includes("shift");
    if (!hasSchedNumber && !hasSchedKeyword) {
      return `Last one. What does your typical day look like?\n\n1️⃣ Standard hours — 8am to 5pm\n2️⃣ Early shift — start before 7am\n3️⃣ Night shift — work through the night\n4️⃣ Irregular — changes week to week\n5️⃣ Work from home or no fixed schedule`;
    }
    const scheduleMap: Record<string, string> = {
      "1": "standard", "2": "early_shift", "3": "night_shift", "4": "irregular", "5": "work_from_home",
    };
    let schedule = scheduleMap[msg.trim()] || "standard";
    if (!scheduleMap[msg.trim()]) {
      if (lower.includes("night")) schedule = "night_shift";
      else if (lower.includes("early")) schedule = "early_shift";
      else if (lower.includes("irregular") || lower.includes("changes")) schedule = "irregular";
      else if (lower.includes("home") || lower.includes("wfh")) schedule = "work_from_home";
    }

    const freshUser = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const u = freshUser[0];
    const weight = parseFloat(u.currentWeight || "75");
    const goal = u.goalType || "fat_loss";
    const exp = u.trainingExperience || "beginner";

    const { calorieTarget, proteinTarget } = calculateTargets(
      weight, goal, u.lifeSituation || "office", u.trainingDaysPerWeek || 3
    );

    const stepsTarget = exp === "beginner" ? 7000 : 8000;
    const startPhase = exp === "beginner" ? 1 : 2;

    await db.update(users).set({
      workSchedule: schedule,
      calorieTarget,
      proteinTarget,
      stepsTarget,
      programmePhase: startPhase,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      programmeStartDate: new Date(),
      subscriptionStatus: "trial",
      onboardingState: "COMPLETE",
    }).where(eq(users.phoneNumber, phone));

    const finalUser = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const f = finalUser[0];
    const programme = getKamlifeProgramme(f);
    const mealPlan = getOnboardingMealPlan(f);
    const goalLabel: Record<string, string> = {
      fat_loss: "Fat loss", muscle_gain: "Muscle gain", recomposition: "Body recomposition",
      general: "General fitness", health_condition: "Health management",
    };
    const nightNote = schedule === "night_shift"
      ? `\n\n⚠️ *Night shift note:* Your meal timing and training windows are adjusted for your schedule. Pre-shift = breakfast. Post-shift = dinner.`
      : "";
    const heartNote = u.doctorClearanceRequired
      ? `\n\n⚠️ *Heart condition noted:* Please get doctor clearance before starting the strength programme. Walking and light activity are safe to begin now.`
      : "";

    return `*${f.name}, your profile is set.* Here is what Coach K has built for you.\n\n🎯 *Goal:* ${goalLabel[goal] || goal}\n⚖️ *Weight:* ${weight}kg\n🍽️ *Calories:* ${calorieTarget} kcal/day\n💪 *Protein:* ${proteinTarget}g/day\n👟 *Steps:* ${stepsTarget.toLocaleString()}/day\n\n${programme}\n\n${mealPlan}${nightNote}${heartNote}\n\n*Your action today:* Do your first session. Reply DONE when you finish and I log it.`;
  }

  return await getMenuText(user);
}

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

async function handleMessage(phone: string, message: string, mediaUrl?: string, mediaContentType?: string): Promise<string> {
  try {
  const m = message.toLowerCase().trim();

  // ---- ADDITION 6: EMERGENCY / CRISIS DETECTION — before everything ----
  const CRISIS_PHRASES = [
    "want to die", "kill myself", "end it all", "cannot go on", "can't go on",
    "suicidal", "self harm", "self-harm", "cutting myself", "hurting myself",
    "not worth living", "end my life", "no reason to live", "give up on life",
  ];
  if (CRISIS_PHRASES.some(phrase => m.includes(phrase))) {
    const crisisUser = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const crisisName = crisisUser[0]?.name || "friend";
    const crisisReply = `${crisisName}, I hear you and I am concerned. Please contact SADAG right now — 0800 567 567, free, 24 hours, confidential. Lifeline SA: 0861 322 322. You matter far more than any fitness goal. Reach out to them — they are trained for exactly this moment.`;
    try { await logChat(crisisUser[0]?.id || "unknown", message, crisisReply, "CRISIS"); } catch { }
    return crisisReply;
  }

  // ---- FIX 1: RESET — absolute first, before getOrCreateUser, before everything ----
  if (m === "reset") {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (existing.length > 0) {
      const uid = existing[0].id;
      await db.delete(chatHistory).where(eq(chatHistory.userId, uid));
      await db.delete(stepLogs).where(eq(stepLogs.userId, uid));
      await db.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
      await db.delete(weightLogs).where(eq(weightLogs.userId, uid));
      await db.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
      await db.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
      await db.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
      await db.delete(users).where(eq(users.id, uid));
    }
    await db.insert(users).values({
      phoneNumber: phone,
      subscriptionStatus: "trial",
      onboardingState: "WELCOME",
      programmePhase: 1,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      trainingMode: "home",
      stepsTarget: 7000,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
    return "Fresh start. What's your name?";
  }

  const user = await getOrCreateUser(phone);

  // ---- ONBOARDING ----
  const ONBOARDING_DONE = ["COMPLETE", "COMPLETED"];
  if (user.onboardingState && !ONBOARDING_DONE.includes(user.onboardingState)) {
    return handleOnboarding(user, message, phone);
  }

  // ---- AWAITING PROGRAMME ANSWERS — parse directly, no GPT ----
  if (user.awaitingProgrammeAnswers) {
    const lower = message.toLowerCase();

    const daysMatch = message.match(/\b([2-6])\b/);
    const trainingDays = daysMatch ? parseInt(daysMatch[1]) : 3;

    let experience = "beginner";
    if (lower.includes("advanced") || lower.includes("2 plus") || lower.includes("2+") || lower.includes("seriously")) experience = "advanced";
    else if (lower.includes("intermediate") || lower.includes("inter") || lower.includes("on and off") || lower.includes("some experience")) experience = "intermediate";

    let goalType = "fat_loss";
    if ((lower.includes("muscle") && lower.includes("fat")) || lower.includes("both") || lower.includes("recomp")) goalType = "recomposition";
    else if (lower.includes("muscle") || lower.includes("build") || lower.includes("gain") || lower.includes("bulk")) goalType = "muscle_gain";

    await db.update(users)
      .set({ trainingDaysPerWeek: trainingDays, trainingExperience: experience, goalType, awaitingProgrammeAnswers: false })
      .where(eq(users.phoneNumber, phone));

    const updatedUser = { ...user, trainingDaysPerWeek: trainingDays, trainingExperience: experience, goalType };
    const programme = buildFullProgramme(updatedUser);
    const reply = `Sharp. Here is your programme — ${trainingDays} days per week, ${experience} level, ${goalType.replace("_", " ")} focus.\n\n${programme}`;
    await logChat(user.id, message, reply, "PROGRAMME_DELIVERY");
    return reply;
  }

  // ---- GREETINGS / MENU (direct — no GPT) ----
  const greetings = ["hello", "hi", "hey", "howzit", "hola", "sawubona", "dumela", "heita", "eita", "yo", "sup"];
  if (greetings.some(g => m === g || m === g + " 👋") || m === "menu" || m === "help") {
    return await getMenuText(user);
  }

  // ---- SHOPPING LIST command ----
  if (m === "shopping list" || m === "shoppinglist" || m === "shopping") {
    const budget = user.weeklyFoodBudget || "100_300";
    const goal = user.goalType || "fat_loss";
    const otherNotes = (user.otherMedicalNotes || "").toLowerCase();
    const noPeanuts = otherNotes.includes("peanut");
    const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard") || otherNotes.includes("tuna");
    const noDairy = otherNotes.includes("dairy") || otherNotes.includes("milk") || otherNotes.includes("lactose");
    const noGluten = otherNotes.includes("gluten") || otherNotes.includes("coeliac") || otherNotes.includes("wheat");
    const milkItem = goal === "muscle_gain" && !noDairy ? "Full cream milk 1L — R22" : !noDairy ? "Low fat milk 1L — R20" : null;

    if (budget === "under_100") {
      return `*🛒 Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\n${noFish ? "Eggs extra 6 pack — R25" : "Pilchards 3 tins — R36"}\nSugar beans 500g — R20\nCabbage 1 head — R8\nSpinach 1 bunch — R10\nOnions bag — R8\nPap/maize meal 2kg — R15\nSunflower oil 500ml — R10\n\nEstimated total: ≈R152\n\n🛒 Pro tip: Cook a big pot of beans Sunday — feeds you 3 days at under R7 per serving. Add 1 egg per bowl for complete protein.`;
    }
    if (budget === "100_300") {
      return `*🛒 Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\nFrozen chicken portions 1kg — R40\n${noFish ? "" : "Pilchards 3 tins — R36\n"}Oats 500g — R15\n${noGluten ? "" : "Brown bread 1 loaf — R14\n"}Sweet potato 1kg — R12\nCabbage — R8\nSpinach — R10\nOnions + tomatoes — R23\nGarlic — R8\nSunflower oil — R10\n\nEstimated total: ≈R221\n\n🛒 Pro tip: Buy a whole frozen chicken, cut it yourself — saves R15–R20 per kg vs portions.`;
    }
    if (budget === "300_600") {
      return `*🛒 Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\nFrozen chicken 1.5kg — R60\nBeef mince 500g — R60\n${noFish ? "" : "Pilchards 2 tins — R24\n"}Oats 1kg — R25\nBrown rice 1kg — R20\nSweet potato 1.5kg — R18\nBanana bunch — R15\n${milkItem ? milkItem + "\n" : ""}${noPeanuts ? "" : "Peanut butter 400g — R25\n"}Spinach — R10\nCabbage — R8\nTomatoes 500g — R15\n${noDairy ? "" : "Cottage cheese 250g — R20\n"}Garlic + lemon — R13\n\nEstimated total: ≈R378\n\n🛒 Pro tip: Brown 500g mince Sunday, split into 3 — that's 3 dinners sorted in one 20-min cook.`;
    }
    return `*🛒 Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\nChicken breast 1kg — R80\n${noFish ? "" : "Salmon 400g ×2 — R160\n"}Beef mince 500g — R60\n${noDairy ? "" : "Low fat Greek yoghurt 500g — R35\n"}Oats 1kg — R25\nBrown rice 1kg — R20\nSweet potato 2kg — R24\nBanana bunch — R15\n${noPeanuts ? "" : "Peanut butter 400g — R25\n"}Broccoli — R20\nSpinach — R10\n${noDairy ? "" : "Low fat milk 1L — R20\n"}Almonds 100g — R40\nOlive oil 250ml — R40\n\nEstimated total: ≈R619\n\n🛒 Pro tip: Salmon goes on special at Shoprite most Fridays — buy two packs and freeze immediately.`;
  }

  // ---- WHY command ----
  if (m === "why") {
    const goal = user.goalType || "fat_loss";
    const budget = user.weeklyFoodBudget || "100_300";
    const medicals = (user.medicalConditions || "").split(",").map((s: string) => s.trim());
    const isDiabetic = medicals.includes("diabetes");
    const isPCOS = medicals.includes("pcos");
    const isHypertension = medicals.includes("hypertension");
    const otherNotes = (user.otherMedicalNotes || "").toLowerCase();
    const noPeanuts = otherNotes.includes("peanut");
    const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard");

    const goalReasons: Record<string, string> = {
      fat_loss: `High protein keeps your muscle while you lose fat — your body wants to eat muscle first when in a deficit, protein stops that. Sweet potato over white pap because the lower glycaemic index means slower energy release and less insulin spike — less fat storage. High-volume vegetables fill your stomach without filling your calorie budget.`,
      muscle_gain: `Whole eggs because the yolk contains cholesterol your body uses to make testosterone — the hormone that builds muscle. Higher calorie density means your muscles have surplus energy to grow. Pre and post-workout meals are non-negotiable — carbs fuel the session, protein rebuilds what you broke.`,
      recomposition: `Carb timing is everything in recomp — carbs before training fuel performance, carbs after training go straight into muscle recovery. Evening low-carb means lower insulin at night when you are least active. Consistent high protein means your body always has amino acids available for repair.`,
      general: `Balanced whole food eating — real protein, real carbs, real vegetables. No extreme restrictions means you can eat like this for life. Educate portions rather than eliminate foods.`,
      health_condition: `Every food choice supports your specific health condition. Lower GI foods mean more stable blood sugar. Higher fibre keeps cholesterol and blood pressure in range. Consistent meal timing is as important as the food itself.`,
    };
    let why = goalReasons[goal] || goalReasons.general;

    const extras: string[] = [];
    if (isDiabetic || isPCOS) extras.push(`Low GI carbs (samp, oats, sweet potato, brown rice) mean slower glucose release — more stable blood sugar across the day. This is non-negotiable for your condition.`);
    if (isHypertension) extras.push(`No Aromat, no stock cubes, no processed meats because sodium directly raises blood pressure. Potassium from sweet potato, spinach, and banana actively counteracts sodium's effect on your vessels.`);
    if (noPeanuts) extras.push(`Peanut butter replaced with extra eggs or baked beans — same protein, safe for your allergy.`);
    if (noFish) extras.push(`Pilchards replaced with chicken and eggs — chicken thigh especially is a high protein-to-cost protein for your budget.`);

    const budgetReasons: Record<string, string> = {
      under_100: `Every item was chosen for maximum nutrition per rand — eggs and pilchards are the highest protein-per-rand foods in South Africa. Sugar beans give cheap fibre and protein that stretch across multiple meals.`,
      "100_300": `Frozen chicken and eggs are your protein anchors at this budget. Oats and sweet potato give you slow-burning carbs that cost very little. The whole week's food costs under R250 and covers all your nutritional needs.`,
      "300_600": `This budget lets you rotate proteins — chicken, mince, eggs, pilchards — so you never get bored and never get gaps in your nutrition. Mince is the best value red meat in SA.`,
      over_600: `Salmon twice a week gives you omega-3 fatty acids that reduce inflammation — critical for recovery and long-term health. Greek yoghurt is one of the highest protein dairy foods per gram.`,
    };
    const budgetWhy = budgetReasons[budget] || budgetReasons["100_300"];

    return `*Why these specific foods for you:*\n\n${why}\n\n${budgetWhy}${extras.length > 0 ? "\n\n" + extras.join("\n\n") : ""}`;
  }

  // ---- MEAL PLAN re-delivery ----
  if (m === "meal plan" || m === "mealplan" || m === "food plan" || m === "my meal plan" || m === "my food plan") {
    return getOnboardingMealPlan(user);
  }

  // ---- SWAP [day] command ----
  const swapMatch = m.match(/^swap\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i);
  if (swapMatch) {
    const swapDay = swapMatch[1].charAt(0).toUpperCase() + swapMatch[1].slice(1).toLowerCase();
    const budget = user.weeklyFoodBudget || "100_300";
    const goal = user.goalType || "fat_loss";
    const otherNotes = (user.otherMedicalNotes || "").toLowerCase();
    const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard") || otherNotes.includes("tuna");
    const noDairy = otherNotes.includes("dairy") || otherNotes.includes("milk") || otherNotes.includes("lactose");
    const noPeanuts = otherNotes.includes("peanut");
    const medicals = (user.medicalConditions || "").split(",").map((s: string) => s.trim());
    const isLowGI = medicals.includes("diabetes") || medicals.includes("pcos");
    const bfCal = Math.round((user.calorieTarget || 1800) * 0.25);
    const lunchCal = Math.round((user.calorieTarget || 1800) * 0.35);
    const dinnerCal = Math.round((user.calorieTarget || 1800) * 0.28);
    const carbAlt = isLowGI ? "½ cup samp and beans" : goal === "muscle_gain" ? "1 cup brown rice" : "1 medium sweet potato";
    const protAlt = noFish ? (budget === "under_100" ? "3 boiled eggs" : "150g chicken thigh") : (budget === "under_100" ? "1 tin pilchards" : "2 eggs + baked beans");
    const dairySnack = noDairy ? "baked beans ½ tin — 110 cal, 7g protein" : "low fat yoghurt 150g — 100 cal, 10g protein";
    const pbItem = noPeanuts ? "1 extra boiled egg" : "1 tbsp peanut butter";

    return `*${swapDay} — Alternative Meals*\n\nBreakfast: ${isLowGI ? `½ cup oats + ${noDairy ? "water" : "low fat milk"} + 2 boiled eggs` : goal === "muscle_gain" ? `3 eggs scrambled + 1 cup oats + banana` : `${isLowGI ? "samp and beans ½ cup" : "½ cup oats"} + 2 boiled eggs`} — ${bfCal} cal\n\nLunch: ${protAlt} + ${carbAlt} + spinach — ${lunchCal} cal\n\nSnack: ${goal === "muscle_gain" ? `${pbItem} + banana` : dairySnack}\n\nDinner: ${noFish ? "2 eggs + cabbage" : "½ tin pilchards + cabbage"} — ${dinnerCal} cal\n\nReply SWAP [any other day] to swap another day.`;
  }

  // ---- MEDIA: IMAGE or AUDIO — exclusive branches, always return ----
  if (mediaUrl) {
    const ctype = mediaContentType || "";

    // ---- FOOD PHOTO ----
    if (ctype.startsWith("image/")) {
      try {
        // Image endpoint on Twilio is public (no auth needed), but use same pattern for consistency
        const imageResponse = await fetch(mediaUrl);
        const buffer = await imageResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
        const clientName = user.name || "there";
        const goal = user.goalType || "fat_loss";

        const { calorieTarget: liveCal, proteinTarget: liveProt } = calculateTargets(
          parseFloat(user.currentWeight || "75"), goal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3
        );
        const visionResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          max_tokens: 350,
          messages: [
            {
              role: "system",
              content: `You are Coach K, a South African fitness and nutrition coach with 20 years experience. The client's name is ${clientName}. Their goal is ${goal}. Daily targets: ${liveCal} kcal, ${liveProt}g protein. SA voice — firm, warm, direct. Max 4 sentences, 80 words. End with one specific action.`
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `You are Coach K with deep knowledge of South African food culture. Analyse this food photo carefully.

IDENTIFICATION: Use SA names always — pap not polenta, pilchards not sardines, vetkoek not fried dough, morogo not wild spinach, umngqusho not samp-and-beans, kota not bunny chow, magwinya not fat cake, smileys not sheep head, walkie talkies not chicken feet, mogodu not tripe, chakalaka not relish, boerewors not sausage, biltong not dried meat, droewors not dry sausage, melktert not milk tart.

ESTIMATION: Estimate calories and protein for the FULL plate as served — not just one component. State the estimate clearly. Example: "This plate is roughly 650 kcal and 35g protein."

COACHING: If the meal is solid for their ${goal} goal — celebrate it specifically and connect the nutrients to their result. If it needs improvement — give ONE specific swap with SA alternative. Never lecture. Never list 3 things to fix.

UNKNOWN FOOD: If you cannot identify any food in the image with confidence — respond only with: Eish, I cannot make out the food clearly. Take the photo in better light and send again.`
                },
                { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } }
              ]
            }
          ]
        });

        const visionReply = visionResponse.choices[0]?.message?.content?.trim();
        if (!visionReply || visionReply.length < 10) {
          return "Eish, I cannot make out the food clearly. Take the photo in better light and send again.";
        }
        await logChat(user.id, "[Photo]", visionReply, "FOOD_LOG");
        return visionReply;
      } catch (err) {
        console.error("Vision error:", err);
        return "Could not process the photo. Tell me what you ate and I will coach you on it.";
      }
    }

    // ---- VOICE NOTE ----
    // Exclusive: if audio, always return — never falls through to text handler
    if (ctype.startsWith("audio/")) {
      try {
        // Part 1 — Twilio media requires basic auth (ACCOUNT_SID:AUTH_TOKEN)
        const twilioSid = process.env.TWILIO_ACCOUNT_SID || "";
        const twilioToken = process.env.TWILIO_AUTH_TOKEN || "";
        const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");

        const audioResponse = await fetch(mediaUrl, {
          headers: { Authorization: authHeader },
        });

        if (!audioResponse.ok) {
          console.error(`[VOICE] Twilio download failed: ${audioResponse.status} ${audioResponse.statusText}`);
          return "Eish, I could not process that voice note. Try again or just type your message.";
        }

        const audioBuffer = await audioResponse.arrayBuffer();

        // Part 2 — WhatsApp voice notes are always ogg/opus; use fixed mime type for Whisper
        const audioFile = new File([audioBuffer], "audio.ogg", { type: "audio/ogg" });

        const transcription = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "whisper-1",
        });

        const transcribedText = transcription.text?.trim();

        // Part 3 — Handle result
        if (!transcribedText) {
          return "I could not hear that clearly. Try sending a voice note in a quieter spot or type your message.";
        }

        const wordCount = transcribedText.split(/\s+/).filter(Boolean).length;
        if (wordCount < 3) {
          return `I only caught a few words — ${transcribedText}. Send again or type your message.`;
        }

        // Language detection (Zulu, Sotho, Xhosa, Afrikaans keywords)
        const ZULU_WORDS = ["sawubona", "yebo", "ngiyabonga", "unjani", "siyabonga", "hawu", "eish", "askies"];
        const SOTHO_WORDS = ["dumela", "ke a leboga", "o kae", "kea leboha", "ntate", "mme"];
        const XHOSA_WORDS = ["molo", "enkosi", "unjani", "ewe", "hayi", "camagu", "ndiyabona"];
        const AFRIKAANS_WORDS = ["dankie", "asseblief", "môre", "more", "lekker", "braai", "howzit", "baie", "nee", "ja nee", "ag nee", "eina", "ek is", "ek het", "ons het"];
        const lowerTranscribed = transcribedText.toLowerCase();
        let languageNote = "";
        if (ZULU_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Zulu. Respond in simple SA English but acknowledge their language naturally — you may use a word or two of Zulu if it fits.";
        else if (SOTHO_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Sesotho. Respond in simple SA English but acknowledge their language naturally.";
        else if (XHOSA_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Xhosa. Respond in simple SA English but acknowledge their language naturally.";
        else if (AFRIKAANS_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Afrikaans. Respond in simple SA English but acknowledge their language naturally — you may use a word or two of Afrikaans if it fits.";

        console.log(`[VOICE] Transcribed: "${transcribedText}"${languageNote ? " [" + languageNote.split(".")[0] + "]" : ""}`);

        const voiceReply = await handleMessage(phone, transcribedText + (languageNote ? `\n\n[LANGUAGE NOTE: ${languageNote}]` : ""));
        // Part 4 — explicit return, no fall-through
        return `🎤 I heard: "${transcribedText}"\n\n${voiceReply}`;

      } catch (err) {
        console.error("[VOICE] Transcription error:", err);
        // Part 4 — always return, never fall through to text handler
        return "Eish, I could not process that voice note. Try again or just type your message.";
      }
    }

    // If mediaUrl present but content type is neither image nor audio — return without processing text
    console.log(`[MEDIA] Unhandled content type: ${ctype} — ignoring`);
    return "I received your file but I can only process voice notes and food photos. Send those or type your message.";
  }


  // ---- DONE — workout complete (direct) ----
  if (m === "done" || m === "workout done" || m === "finished" || m === "completed") {
    const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
    let newDay = (user.programmeDayInWeek || 1) + 1;
    let newWeek = user.programmeWeek || 1;
    const daysPerWeek = user.trainingDaysPerWeek || 3;

    if (newDay > daysPerWeek) { newDay = 1; newWeek++; }
    if (newWeek > 4) { newWeek = 4; }

    await db.update(users).set({
      totalWorkoutsCompleted: newTotal,
      lastWorkoutDate: new Date(),
      programmeDayInWeek: newDay,
      programmeWeek: newWeek,
    }).where(eq(users.phoneNumber, phone));

    await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });

    const celebration = await askCoachK("I just completed my workout", user, `Client just finished workout number ${newTotal}. Celebrate specifically. Reference their phase and total workouts. One sentence. SA voice.`);
    const perfectDay = await checkPerfectDay(user.id);
    return `${celebration}\n\n✅ Workout ${newTotal} logged.${newTotal === 1 ? "\n\n🏆 First workout done. Most people never start." : ""}${perfectDay || ""}`;
  }

  // ---- GOAL CHANGE: wants muscle but profile says fat loss / low calories ----
  const wantsMuscle = m.includes("gain weight") || m.includes("build muscle") || m.includes("gain muscle") || m.includes("i want to bulk") || m.includes("want to bulk") ||
    (m.includes("muscle") && (m.includes("want") || m.includes("focus on") || m.includes("goal is")));
  if (wantsMuscle && (user.goalType === "fat_loss" || (user.calorieTarget || 0) < 1800)) {
    const bw = parseFloat(user.currentWeight || "75");
    const { calorieTarget: newCals, proteinTarget: newProtein } = calculateTargets(bw, "muscle_gain", user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
    await db.update(users).set({ goalType: "muscle_gain", calorieTarget: newCals, proteinTarget: newProtein }).where(eq(users.phoneNumber, phone));
    user.goalType = "muscle_gain";
    user.calorieTarget = newCals;
    user.proteinTarget = newProtein;
  }

  // ---- WEIGHT MENTION: update stored weight if client states a different one ----
  const weightInMsg = m.match(/\b(\d{2,3}(?:\.\d)?)\s*kg\b/);
  if (weightInMsg) {
    const mentionedKg = parseFloat(weightInMsg[1]);
    const storedKg = parseFloat(user.currentWeight || "0");
    if (mentionedKg >= 35 && mentionedKg <= 250 && Math.abs(mentionedKg - storedKg) > 0.4) {
      const { calorieTarget: newCals, proteinTarget: newProtein } = calculateTargets(mentionedKg, user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
      await db.update(users).set({ currentWeight: mentionedKg.toString(), proteinTarget: newProtein, calorieTarget: newCals }).where(eq(users.phoneNumber, phone));
      user.currentWeight = mentionedKg.toString();
      user.proteinTarget = newProtein;
      user.calorieTarget = newCals;
    }
  }

  // ---- PROGRAMME SETUP REPLY — detect "3 intermediate lose fat" style answers ----
  const hasDayCount = /\b[3-5]\b/.test(m);
  const hasExpWord = m.includes("beginner") || m.includes("intermediate") || m.includes("advanced");
  const hasGoalWord = m.includes("lose") || m.includes("fat") || m.includes("muscle") || m.includes("both") || m.includes("recomp");

  if (hasDayCount && (hasExpWord || hasGoalWord)) {
    const dayMatch = m.match(/\b([3-5])\b/);
    const days = dayMatch ? parseInt(dayMatch[1]) : 3;

    let exp = "beginner";
    if (m.includes("intermediate")) exp = "intermediate";
    if (m.includes("advanced")) exp = "advanced";

    let goal = "fat_loss";
    if ((m.includes("muscle") || m.includes("build")) && !m.includes("lose") && !m.includes("fat")) goal = "muscle_gain";
    if (m.includes("both") || m.includes("recomp")) goal = "recomposition";

    await db.update(users).set({
      trainingDaysPerWeek: days,
      trainingExperience: exp,
      goalType: goal,
    }).where(eq(users.phoneNumber, phone));

    const updatedUser = { ...user, trainingDaysPerWeek: days, trainingExperience: exp, goalType: goal };
    const programme = getKamlifeProgramme(updatedUser);
    const goalLabel = goal === "fat_loss" ? "Fat loss" : goal === "muscle_gain" ? "Muscle gain" : "Body recomposition";

    return `Sharp. ${days} days/week. ${exp.charAt(0).toUpperCase() + exp.slice(1)}. ${goalLabel}. Programme built.\n\n${programme}`;
  }

  // ---- PROGRAMME REQUEST WITHOUT PROFILE — check for elderly/injury first ----
  const isWorkoutRelated =
    m === "1" || m === "2" || m === "gym" || m === "workout" ||
    m.includes("program") || m.includes("programme") ||
    m.includes("training plan") || m.includes("workout plan") || m.includes("exercise plan") ||
    m.includes("full body") || m.includes("3 day") || m.includes("4 day") || m.includes("5 day") ||
    m.includes("exercise") || m.includes("train") ||
    (m.includes("gym") && (m.includes("need") || m.includes("want") || m.includes("give") || m.includes("plan")));

  // ---- ELDERLY / SERIOUS INJURY — skip questions, give immediate safety programme ----
  const elderlyAge = m.match(/\bi'?m\s+(6[0-9]|7[0-9]|8[0-9]|9[0-9])\b/i) ||
    m.match(/\b(6[0-9]|7[0-9]|8[0-9]|9[0-9])\s*(year|yr|yo)\b/i) ||
    m.match(/\bage\s+(6[0-9]|7[0-9]|8[0-9]|9[0-9])\b/i);
  const isElderly = !!(elderlyAge || m.includes("elderly") || m.includes("old age") || m.includes("pensioner") || m.includes("senior citizen"));
  const hasSeriousInjury = m.includes("hip replacement") || m.includes("knee replacement") ||
    m.includes("hip surgery") || m.includes("hip problem") || m.includes("bad hip") ||
    m.includes("serious injury") || m.includes("cannot walk") || m.includes("can't walk");

  if ((isElderly || hasSeriousInjury) && isWorkoutRelated) {
    const ageStr = elderlyAge ? elderlyAge[1] : "";
    const prefix = hasSeriousInjury && !isElderly
      ? `With a serious injury, safety is everything.`
      : `At ${ageStr || "your age"} with${hasSeriousInjury ? " a hip problem" : " your history"}, safety is everything.`;
    return `${prefix} This programme builds real strength without risk. Any pain or discomfort — stop immediately and consult your doctor.\n\n*Safety-First Strength Programme — Seated and Machine Only*\nRest 90 seconds between sets. 3 sets of 15 reps. Light weight.\n\n1️⃣ *Seated Leg Press — light weight*\nhttps://www.youtube.com/results?search_query=seated+leg+press+light+weight+elderly\nFeet flat on platform. Push slowly. Never lock the knees.\n\n2️⃣ *Seated Leg Curl Machine*\nhttps://www.youtube.com/results?search_query=seated+leg+curl+machine+tutorial\nSlow and controlled. Only move through pain-free range.\n\n3️⃣ *Chest Press Machine — seated*\nhttps://www.youtube.com/results?search_query=chest+press+machine+tutorial+seniors\nBack flat against pad. Press gently. No locking at the top.\n\n4️⃣ *Seated Cable Row*\nhttps://www.youtube.com/results?search_query=seated+cable+row+elderly+tutorial\nSit tall. Pull elbows back slowly. Keep shoulders down.\n\n5️⃣ *Seated Shoulder Press Machine*\nhttps://www.youtube.com/results?search_query=seated+shoulder+press+machine+seniors\nPress overhead slowly. Stop if any shoulder pain.\n\n6️⃣ *Seated Calf Raise*\nhttps://www.youtube.com/results?search_query=seated+calf+raise+machine+tutorial\nHeel up slowly, lower slowly. Excellent for circulation.\n\n7️⃣ *Balance Work — standing at fixed support*\nHold a wall or fixed bar. Rise slowly onto toes and lower. 3 × 10. Builds ankle stability.\n\nTrain 2 to 3 times per week with at least one rest day between sessions. Reply DONE after each session and I track your progress.`;
  }

  // Fix 3 — If all programme data exists from onboarding, deliver immediately — no questions
  if (isWorkoutRelated && user.trainingDaysPerWeek && user.trainingExperience && user.goalType) {
    const programme = buildFullProgramme(user);
    const modeLabel = user.trainingMode === "gym" ? "Gym" : "Home";
    const reply = `${modeLabel} programme — ${user.trainingDaysPerWeek} days per week, ${user.trainingExperience} level, ${(user.goalType || "").replace(/_/g, " ")} focus.\n\n${programme}`;
    await logChat(user.id, message, reply, "PROGRAMME_DELIVERY");
    return reply;
  }

  if (isWorkoutRelated && (!user.trainingExperience || !user.trainingDaysPerWeek)) {
    await db.update(users).set({ awaitingProgrammeAnswers: true }).where(eq(users.phoneNumber, phone));
    const questions = `Sharp. Before I build your programme I need three things:\n\n1️⃣ How many days per week can you train? Reply 2, 3, 4, 5, or 6.\n\n2️⃣ Experience level?\nBeginner — never trained consistently\nIntermediate — trained on and off for a year or more\nAdvanced — training consistently for 2 plus years\n\n3️⃣ Main goal?\nLose fat\nBuild muscle\nBoth\n\nReply with your three answers and I build your programme immediately.`;
    await logChat(user.id, message, questions, "PROGRAMME_QUESTIONS");
    return questions;
  }

  // ---- STEP LOG DETECTION (direct — no GPT cost) ----
  const stepNumMatch = m.match(/\b([\d,]+)\s*(?:steps?|staps?)\b/i)
    || m.match(/(?:walked|done|did|logged)\s+([\d,]+)\s*(?:steps?|staps?)/i);
  const hasKmWalk = m.match(/(?:walked|loop|walk)\s+([\d.]+)\s*km/i);
  if (stepNumMatch || hasKmWalk) {
    let steps = 0;
    if (stepNumMatch) {
      steps = parseInt(stepNumMatch[1].replace(/,/g, ""));
    } else if (hasKmWalk) {
      const km = parseFloat(hasKmWalk[1]);
      steps = Math.round(km * 1300);
    }
    if (!isNaN(steps) && steps > 100 && steps < 100000) {
      const target = user.stepsTarget || 7000;
      await db.insert(stepLogs).values({ userId: user.id, steps });
      await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.phoneNumber, phone));
      const stepReply = getStepResponse(steps, target);
      const perfectDay = await checkPerfectDay(user.id);
      const fullReply = stepReply + (perfectDay || "");
      await logChat(user.id, message, fullReply, "STEP_LOG");
      return fullReply;
    }
  }

  // ---- FIX 3: HANDLER 1 — Progress check ----
  if (m.includes("how am i doing") || m.includes("my progress") || m.includes("am i on track") || m.includes("how have i done") || m.includes("check my progress")) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
      const [recentSteps, recentWorkouts, recentWeights] = await Promise.all([
        db.select().from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo))).orderBy(desc(stepLogs.loggedAt)),
        db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
        db.select().from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, sevenDaysAgo))).orderBy(asc(weightLogs.loggedAt)),
      ]);
      const liveT = calculateTargets(parseFloat(user.currentWeight || "75"), user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
      const plannedSessions = user.trainingDaysPerWeek || 3;
      const completedSessions = recentWorkouts.length;
      const avgSteps = recentSteps.length > 0 ? Math.round(recentSteps.reduce((s, r) => s + r.steps, 0) / recentSteps.length) : 0;
      const stepsTarget = user.stepsTarget || 7000;
      const weightChange = recentWeights.length >= 2
        ? (parseFloat(String(recentWeights[recentWeights.length - 1].weight)) - parseFloat(String(recentWeights[0].weight))).toFixed(1)
        : null;
      const sessionSentence = `Training: ${completedSessions} of ${plannedSessions} planned sessions done this week.`;
      const stepSentence = avgSteps > 0 ? `Steps: averaging ${avgSteps.toLocaleString()} per day against a ${stepsTarget.toLocaleString()} target.` : `Steps: no step logs this week — start logging daily.`;
      const weightSentence = weightChange !== null ? (parseFloat(weightChange) < 0 ? `Weight: down ${Math.abs(parseFloat(weightChange))}kg this week — moving in the right direction.` : parseFloat(weightChange) > 0 ? `Weight: up ${weightChange}kg — could be water, sodium, or muscle. Stay on programme.` : `Weight: holding steady this week.`) : `Weight: no weigh-ins logged — step on the scale and send me the number.`;
      const onTrack = completedSessions >= Math.ceil(plannedSessions * 0.75);
      const verdictSentence = onTrack ? `Overall you are on track — keep the consistency going into next week.` : `${user.name || "Champ"}, ${plannedSessions - completedSessions} sessions missed this week. Get the next one done today.`;
      const progressReply = `*Your 7-Day Progress Check*\n\n${sessionSentence}\n${stepSentence}\n${weightSentence}\n${verdictSentence}`;
      await logChat(user.id, message, progressReply, "PROGRESS_CHECK");
      return progressReply;
    } catch (e) {
      console.error("[PROGRESS CHECK]", e);
    }
  }

  // ---- FIX 3: HANDLER 2 — Supplement questions ----
  if (m.includes("creatine") || m.includes("protein powder") || m.includes("pre workout") || m.includes("pre-workout") || m.includes("supplement") || m.includes("what should i take") || m.includes("fat burner") || m.includes("whey")) {
    const suppContext = `Client asked about supplements. Their goal is ${user.goalType || "fat_loss"}. Their protein target is ${calculateTargets(parseFloat(user.currentWeight || "75"), user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3).proteinTarget}g/day. Give honest SA supplement advice. RULES: 1. Creatine — recommend for everyone, 5g daily, R150–R200 per month at Dischem, no cycling needed. 2. Protein powder — ONLY if they consistently cannot hit protein target from food. Whey isolate is cheapest per gram. USN or Biogen are SA brands that are honest. 3. Pre-workout — tell them black coffee 30 minutes before training is free and works as well as any pre-workout. 4. Fat burners — never. All stimulants and fat burners are marketing. 5. Everything else — food first, always. One supplement at a time. Never a stack. Be specific about SA prices and brands.`;
    const suppReply = await askCoachK(message, user, suppContext);
    await logChat(user.id, message, suppReply, "SUPPLEMENT");
    return suppReply;
  }

  // ---- FIX 3: HANDLER 3 — Motivation and struggle ----
  if (m.includes("i want to quit") || m.includes("want to give up") || m.includes("this is too hard") || m.includes("i can't do this") || m.includes("i cant do this") || m.includes("not seeing results") || m.includes("nothing is working") || m.includes("no results") || m.includes("waste of time") || m.includes("doesn't work") || m.includes("not working for me")) {
    try {
      const [recentW, recentS] = await Promise.all([
        db.select().from(workoutLogs).where(eq(workoutLogs.userId, user.id)).orderBy(desc(workoutLogs.loggedAt)).limit(10),
        db.select().from(stepLogs).where(eq(stepLogs.userId, user.id)).orderBy(desc(stepLogs.loggedAt)).limit(7),
      ]);
      const totalWorkouts = user.totalWorkoutsCompleted || recentW.length;
      const avgStepsStruggle = recentS.length > 0 ? Math.round(recentS.reduce((s, r) => s + r.steps, 0) / recentS.length) : 0;
      let dataPoint = "";
      if (totalWorkouts > 0) dataPoint = `You have completed ${totalWorkouts} training session${totalWorkouts > 1 ? "s" : ""}.`;
      else if (avgStepsStruggle > 4000) dataPoint = `You are averaging ${avgStepsStruggle.toLocaleString()} steps per day this week.`;
      const struggleContext = `Client is struggling and said: "${message}". RULES — empathy first in one sentence, no generic motivation speech. Then state this real data point: "${dataPoint || "You showed up and sent this message — that means you have not quit."}". Then give ONE single specific action for today only. Never a list. Never "you've got this" or "believe in yourself". Be real and direct like a coach, not a cheerleader. SA voice.`;
      const struggleReply = await askCoachK(message, user, struggleContext);
      await logChat(user.id, message, struggleReply, "MOTIVATION");
      return struggleReply;
    } catch (e) {
      console.error("[MOTIVATION]", e);
    }
  }

  // ---- FIX 3: HANDLER 4 — Injury during training ----
  if (m.includes("i hurt") || m.includes("something hurts") || m.includes("i pulled") || m.includes("i strained") || m.includes("i injured") || m.includes("got injured") || (m.includes("pain") && (m.includes("training") || m.includes("gym") || m.includes("workout") || m.includes("lifting") || m.includes("running"))) || m.includes("pulled a muscle") || m.includes("strained my")) {
    const injuredArea = m.includes("knee") ? "knee" : m.includes("shoulder") ? "shoulder" : m.includes("back") ? "back" : m.includes("ankle") ? "ankle" : m.includes("wrist") ? "wrist" : m.includes("hip") ? "hip" : m.includes("neck") ? "neck" : m.includes("elbow") ? "elbow" : "the affected area";
    const safeAlternative: Record<string, string> = {
      knee: "upper body — chest press, rows, shoulder press, and arm work are all safe",
      shoulder: "lower body and core — squats, leg press, lunges, planks",
      back: "upper body machines seated — chest press, lat pulldown, cable rows with a straight back",
      ankle: "seated upper body — anything you can do sitting down",
      wrist: "legs and core — squats, leg press, lunges, walking",
      hip: "upper body — everything from the waist up",
      neck: "lower body and light machines — avoid anything overhead",
      elbow: "lower body and shoulder press — avoid any pulling or curling movements",
    };
    const safe = safeAlternative[injuredArea] || "anything that does not load that area";
    const injuryReply = `Stop loading ${injuredArea} immediately. Rest it today. Ice for 15 minutes if swollen.\n\nIf the pain is severe, sharp, or does not settle within 48 hours — see a doctor or physio. Do not train through sharp pain.\n\nYou CAN still train ${safe}. One body part stops, the rest keeps going.\n\nRest ${injuredArea} for 72 hours minimum then reassess. Update me when you are back.`;
    await logChat(user.id, message, injuryReply, "INJURY");
    return injuryReply;
  }

  // ---- FIX 3: HANDLER 5 — Period and cycle tracking ----
  if (m.includes("my period") || m.includes("time of the month") || m.includes(" pms") || m.includes("that time") || m.includes("menstrual") || m.includes("on my period") || m.includes("period started") || m.includes("period week")) {
    const cycleContext = `Client mentioned their menstrual cycle or period. Ask which phase they are in using EXACTLY these options: "Just started (Day 1–5)", "Middle of cycle (Day 6–14)", "PMS week (Day 15–21)", or "Period week (Day 22–28)". Then based on their reply: Phase 1 (period) — lighter training is fine, walking counts, iron-rich foods essential (red meat, spinach, pilchards), no guilt for lower energy. Phase 2 (follicular) — best training week, peak strength, push harder, carbs support performance. Phase 3 (PMS) — reduce intensity slightly, higher protein reduces cravings, magnesium from dark leafy greens helps mood. Phase 4 (period) — same as Phase 1. Normalise all of it. Weight fluctuates 1–3kg from water retention before period — not fat. Do not panic. Coach the next meal or session, not the feelings. SA voice. Max 3 sentences unless giving phase-specific advice.`;
    const cycleReply = await askCoachK(message, user, cycleContext);
    await logChat(user.id, message, cycleReply, "CYCLE");
    return cycleReply;
  }

  // ---- QUICK STAT LOOKUPS — never touch GPT ----
  if (["calories", "calorie", "what are my calories", "what are my calories for the day", "how many calories", "my calories", "calorie target", "my calorie target"].includes(m)) {
    return `Your daily target is ${user.calorieTarget} calories and ${user.proteinTarget}g protein. Based on your weight, goal, and activity level.`;
  }
  if (["steps", "my steps", "step target", "daily steps", "steps daily", "how many steps", "my steps target", "steps target"].includes(m)) {
    return `Your daily steps target is ${user.stepsTarget} steps.`;
  }
  if (["protein", "my protein", "protein target", "daily protein", "protein daily", "how much protein", "my protein target"].includes(m)) {
    return `Your daily protein target is ${user.proteinTarget}g. Spread across 3 to 4 meals.`;
  }

  // ---- EVERYTHING ELSE → GPT decides ----
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString("en-ZA", { weekday: "long" });
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const clientName = user.name || "champ";
  const trainingMode = user.trainingMode || "home";
  const saContext = getSAContextFlags(user);

  // Fix 9 — Conversation context memory: last 10 exchanges, alternating Client/Coach K format
  let recentConvBlock = "";
  let recentChatText = "";
  try {
    const recentChats = await db.select().from(chatHistory)
      .where(eq(chatHistory.userId, user.id))
      .orderBy(desc(chatHistory.createdAt))
      .limit(10);
    if (recentChats.length > 0) {
      const ordered = recentChats.reverse();
      const thread = ordered.map(c => {
        const clientLine = c.messageIn ? `Client: "${(c.messageIn).slice(0, 150)}"` : "";
        const coachLine = c.messageOut ? `Coach K: "${(c.messageOut).slice(0, 150)}"` : "";
        return [clientLine, coachLine].filter(Boolean).join("\n");
      }).join("\n");
      recentChatText = thread;
      recentConvBlock = `\n\nRECENT CONVERSATION (last 10 exchanges — build on this, do not repeat):\n${thread}`;
    }
  } catch { }

  // Fix 5 — Ramadan check against recent chat history (in addition to profile notes)
  const RAMADAN_KW = ["ramadan", "ramadhan", "fasting", "iftar", "suhoor", "sehri", "muslim", "islam", "halaal", "halal"];
  if (recentChatText && RAMADAN_KW.some(kw => recentChatText.toLowerCase().includes(kw))) {
    const existingFlags = getSAContextFlags(user);
    if (!existingFlags.includes("RAMADAN")) {
      // User mentioned Ramadan in recent chat — inject flag into instruction
      recentConvBlock += `\n\nRAMADAN / FASTING ACTIVE: Client has mentioned Ramadan or fasting in recent messages. Train only after Iftar. Suhoor is the most critical meal — high protein, slow carbs. Adjust all meal timing advice to the eating window only.`;
    }
  }

  const instruction = `Today is ${dayOfWeek} ${timeOfDay}.${saContext ? "\n\n" + saContext : ""}${recentConvBlock}

RESPOND TO THIS CLIENT'S EXACT MESSAGE AS COACH K.

SCENARIO GUIDE — read the message and decide which applies:

WORKOUT / PROGRAMME REQUEST ("give me a program", "3 day", "full body", "training plan", "what do I do today", "1", "2", "workout", etc.):
  Use the EXACT programme below. Do not invent exercises. Do not use bodyweight unless the client is on home training. Add one short SA motivating sentence before the programme. If they asked for "today's workout" or sent "1", output only the first day/session. If they want the full programme, output all sessions.

  THEIR PROGRAMME (${trainingMode === "gym" ? "GYM" : "HOME"}, ${(user.trainingExperience || "beginner").toUpperCase()}):
${getKamlifeProgramme(user)}

STEPS LOGGED (number + "steps" / "walked" / "km"):
  Respond based on their step target of ${user.stepsTarget || 7000}. If below — push them. If at or above — celebrate and give next action.

FOOD / MEAL LOGGED (any food item or meal described):
  Coach specifically on THAT exact food. Use the SA food database. Estimate SA portion calories and protein. If junk — acknowledge without shaming, give one specific swap. If good — celebrate and connect to their ${user.goalType || "fat loss"} goal. Never end with a protein warning. Never give generic advice.

BROKE / BUDGET / MONTH-END / NO MONEY:
  Full affordable plan: Oats R15 (500g, lasts 1 week) — one cup oats + peanut butter = 400 kcal 20g protein. Eggs R25 (12 eggs) — 2 eggs = 160 kcal 12g protein. Pilchards R12 (1 tin) — full tin = 200 kcal 24g protein. Sugar beans R20 (dry 500g) — cooked cup = 220 kcal 15g protein. Peanut butter R25 (lasts 2 weeks). Brown bread R14. Total under R110. Explain how to use each one practically.

WEIGHT LOGGED (number + "kg"):
  Acknowledge. If weight went up — explain water retention, sodium, hormones. Do NOT panic them. Stay on programme. If weight went down — celebrate specifically. If same — consistency wins over weeks.

NUTRITION AND CALORIE INTELLIGENCE:
  You are a qualified fitness and nutrition coach. When a client tells you their weight and goal calculate the correct calorie and protein targets using standard sports nutrition formulas. Show the calculation. State the result. When a client has an injury or medical condition reason about what is safe and build accordingly. When a client's stated information conflicts with their stored profile trust what they are telling you right now and recalculate everything. Do not wait to be told the formula. You know the formula. Use it.

WATER LOGGED ("drank", "litre", "ml", "bottle", "glass"):
  One sentence acknowledgment. Reference how much they logged. No generic tips.

SLEEP LOGGED (number + "hours" / "slept"):
  Under 6 hours — coach firmly on sleep and fat loss link. Give one practical fix for tonight. 7-9 hours — solid, connect to results. Over 9 — check if they are ill or stressed.

PERIOD / MENSTRUAL:
  Normalise. Lighter sessions are fine. No guilt. Hydration and iron-rich foods.

SUPPLEMENTS ("creatine", "protein powder", "pre-workout"):
  Creatine — worth it, 5g daily, no cycling. Protein powder — food not magic, use if struggling to hit ${user.proteinTarget || 120}g from whole foods. Everything else optional. Food first always.

RAMADAN / FASTING:
  Train after Iftar. Suhoor = most important meal of the day. Protein priority at Iftar. Light cardio only if fasting during day.

TRAVELLING / HOTEL:
  4 exercises, hotel room, bodyweight only, sets x reps. No equipment assumed.

ALCOHOL:
  Coach forward. Acknowledge it happened. One practical next step. Never shame.

DIABETES / BLOOD SUGAR:
  Low GI carbs. Consistent meal timing. Train 1-2 hours after eating. Never skip meals.

CULTURAL EVENT (church, funeral, lobola, umemulo):
  Acknowledge its importance. Enjoy it fully. Protein first on the plate. No guilt. Back on programme next meal.

JOINED THE GYM:
  Welcome it with one sentence. Update training to gym. Give full gym programme.

TIRED / LOW ENERGY:
  DO NOT mention water. Ask about sleep first, then food timing, then stress.

INJURY MENTIONED:
  Give specific alternative exercises that route around the injury.

GENERAL QUESTION:
  Answer with SA coaching knowledge. Specific. Practical.

WHATSAPP FORMAT RULES — apply to every single response:
These messages are read on a phone screen. Never write an essay. Format depends on the response type:

SIMPLE COACHING RESPONSE: 2 to 3 sentences maximum. One specific action at the end. No bullet points. No asterisks. Plain text only.

PROGRAMME DELIVERY: Use bold day headers. Each exercise on its own line: exercise name, sets and reps, YouTube link, one form cue, one common mistake. Separate each day with a line break. Bold is allowed here.

MEAL PLAN DELIVERY: Each meal on its own block: meal name, ingredients, estimated calories and protein, preparation time. Always state the cost in rands. Bold meal names are allowed here.

CALCULATION RESPONSE: Show the formula. Show the numbers. State the result clearly. Add one sentence explaining what this specific result means for this client's goal. No padding.

CRISIS RESPONSE: Short. Warm. Direct. Give the support resources first — Samaritans SA 0800 567 567. Say nothing else until they respond.

MILESTONE CELEBRATION: Energetic, specific, personal. Reference something real and measurable from their journey — a number, a first, a behaviour change. Never use generic praise like "You're amazing" or "I'm so proud of you."

BANNED PHRASES — never say these under any circumstances:
- "I hope this helps"
- "Let me know if you need anything"
- "Feel free to ask"
- "You've got this" as a standalone sentence
- "Stay hydrated" as a default response
These are app phrases. Coach K does not use them.

QUESTION RULE: Never end a response with a question unless you genuinely need specific information to coach better. If a question is needed — ask exactly one. Single and specific. Never two questions in one response.

FORMATTING RULE: Never use asterisks for bold in conversational responses. Asterisks and bold are only allowed in programme delivery and meal plan delivery.

CRITICAL RULES — these are non-negotiable:
- Client's name is ${clientName}. Never call them "a client", "Hi client", or "champ" if you have a real name.
- NEVER say "drink 2 litres of water" as a response to anything except a water question.
- Pilchards ARE an excellent protein source — never say otherwise.
- Never append a protein warning at the end of a food coaching response.
- Never mention AI, bot, system, or technology.
- Never use a motivational quote as a standalone response.
- Maximum 3 sentences and 60 words for conversational responses. Exception: programme and meal plan delivery may be longer.
- Always end with exactly one specific action the client must take right now.
- SA voice throughout: real, warm, firm, direct.`;

  const gptReply = await askCoachK(message, user, instruction);

  // ---- FOOD PATTERN CHECK — append warning if junk/protein pattern detected ----
  const FOOD_KEYWORDS = ["ate", "had", "eating", "breakfast", "lunch", "dinner", "supper", "meal", "food", "pap", "rice", "bread", "chicken", "beef", "fish", "pilchards", "eggs", "oats", "kfc", "burger", "pizza", "vetkoek", "kota", "chips", "cool drink", "coke", "biscuit", "chocolate", "sweets", "yogurt", "beans", "lentils", "mince", "polony", "viennas", "russian", "magwinya", "fat cake", "samp", "morogo", "spinach", "peanut butter", "tuna", "sardines"];
  const isFoodLog = FOOD_KEYWORDS.some(k => m.includes(k));
  if (isFoodLog) {
    const pattern = await checkFoodPatterns(user.id);
    const perfectDay = await checkPerfectDay(user.id);
    const fullReply = gptReply + (pattern ? "\n\n" + pattern : "") + (perfectDay || "");
    await logChat(user.id, message, fullReply, "FOOD_LOG");
    return fullReply;
  }

  return gptReply;

  } catch (err) {
    console.error("[handleMessage FATAL]", phone, message, err);
    return "Eish, something went wrong on my side. Give me a second and try again.";
  }
}

// ============================================================
// LOG CHAT HELPER
// ============================================================

async function logChat(userId: string, messageIn: string, messageOut: string, intent: string): Promise<void> {
  try {
    await db.insert(chatHistory).values({ userId, messageIn, messageOut, intent });
  } catch (err) {
    console.error("Chat log error:", err);
  }
}

// ============================================================
// RATE LIMITER — 15 messages per phone per 60 seconds
// ============================================================

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

function checkRateLimit(phone: string): boolean {
  const now = Date.now();
  const window = 60 * 1000;
  const entry = rateLimitMap.get(phone);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(phone, { count: 1, resetAt: now + window });
    return true;
  }
  if (entry.count >= 15) return false;
  entry.count++;
  return true;
}

// ============================================================
// REGISTER EXPRESS ROUTES
// ============================================================

export async function registerRoutes(server: Server, app: Express): Promise<void> {

  // ── REST API for admin dashboard ──────────────────────────

  app.get("/api/users", async (_req, res) => {
    try {
      const all = await db.select().from(users).orderBy(desc(users.createdAt));
      res.json(all);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  app.get("/api/users/:id", async (req, res) => {
    try {
      const user = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1);
      if (!user.length) return res.status(404).json({ message: "User not found" });

      const weights = await db.select().from(weightLogs).where(eq(weightLogs.userId, req.params.id)).orderBy(desc(weightLogs.loggedAt)).limit(30);
      const steps = await db.select().from(stepLogs).where(eq(stepLogs.userId, req.params.id)).orderBy(desc(stepLogs.loggedAt)).limit(30);
      const workouts = await db.select().from(workoutLogs).where(eq(workoutLogs.userId, req.params.id)).orderBy(desc(workoutLogs.loggedAt)).limit(30);
      const chats = await db.select().from(chatHistory).where(eq(chatHistory.userId, req.params.id)).orderBy(desc(chatHistory.createdAt)).limit(50);

      res.json({ user: user[0], weightLogs: weights, stepLogs: steps, workoutLogs: workouts, chatHistory: chats });
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  app.get("/api/admin/flagged", async (_req, res) => {
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const inactive = await db.select().from(users).where(
        and(
          eq(users.onboardingState, "COMPLETE"),
        )
      );
      const flagged = inactive.filter(u => !u.lastActiveAt || new Date(u.lastActiveAt) < threeDaysAgo);
      res.json(flagged);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch flagged users" });
    }
  });

  app.get("/api/admin/beta-testers", async (_req, res) => {
    try {
      const all = await db.select().from(users).where(eq(users.subscriptionStatus, "trial")).orderBy(desc(users.createdAt));
      res.json(all);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch beta testers" });
    }
  });

  app.post("/api/admin/run-test", async (req, res) => {
    const { testId, liveMode } = req.body;
    const logs: string[] = [];
    try {
      logs.push(`Running test ${testId}...`);
      const testPhone = "+27000000000";
      const testMessages: Record<string, string> = {
        A: "Hi, I want to join",
        B: "I ate pap and chicken for lunch",
        C: "I did 8500 steps today",
        D: "I weigh 75kg",
        E: "I am travelling and need a workout",
        F: "weekly report",
      };
      const msg = testMessages[testId] || "Hello";
      logs.push(`Sending: "${msg}"`);
      const reply = await handleMessage(testPhone, msg);
      logs.push(`Reply: ${reply}`);
      res.json({ success: true, logs, whatsappSent: reply });
    } catch (err: any) {
      logs.push(`Error: ${err.message}`);
      res.json({ success: false, logs });
    }
  });

  // ── WhatsApp webhook ──────────────────────────────────────

  function escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  // Fix 1 — splitMessage: split long replies at newline boundaries, max 1500 chars per chunk
  function splitMessage(text: string, maxLen = 1500): string[] {
    if (text.length <= maxLen) return [text];
    const lines = text.split("\n");
    const chunks: string[] = [];
    let current = "";
    for (const line of lines) {
      const candidate = current ? current + "\n" + line : line;
      if (candidate.length > maxLen) {
        if (current) chunks.push(current.trim());
        // If single line itself is over maxLen, split at last space before limit
        if (line.length > maxLen) {
          let remaining = line;
          while (remaining.length > maxLen) {
            const cutAt = remaining.lastIndexOf(" ", maxLen);
            const breakAt = cutAt > 0 ? cutAt : maxLen;
            chunks.push(remaining.slice(0, breakAt).trim());
            remaining = remaining.slice(breakAt).trim();
          }
          current = remaining;
        } else {
          current = line;
        }
      } else {
        current = candidate;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.filter(Boolean);
  }

  app.post("/twilio/whatsapp", async (req, res) => {
    try {
      // ---- Twilio signature verification (skip in development) ----
      if (process.env.NODE_ENV !== "development") {
        const authToken = process.env.TWILIO_AUTH_TOKEN || "";
        const signature = (req.headers["x-twilio-signature"] as string) || "";
        const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
        const valid = twilio.validateRequest(authToken, signature, fullUrl, req.body);
        if (!valid) {
          console.warn(`Twilio signature validation failed from ${req.ip}`);
          return res.status(403).end();
        }
      }

      // ---- Rate limiter ----
      const rawPhoneEarly = (req.body.From || "") as string;
      const phoneKey = rawPhoneEarly.replace(/^(whatsapp:)\s+/, "$1+");
      if (!checkRateLimit(phoneKey)) {
        return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Too many messages. Wait 60 seconds.</Message></Response>`);
      }

      // Twilio sometimes sends '+' as a literal '+' in form data; URL decoders
      // convert that to a space. Normalise 'whatsapp: 27...' → 'whatsapp:+27...'
      const rawPhone = rawPhoneEarly;
      const phone = rawPhone.replace(/^(whatsapp:)\s+/, "$1+");
      const message = (req.body.Body || "").trim();
      const mediaUrl = req.body.MediaUrl0 || undefined;
      const mediaContentType = req.body.MediaContentType0 || undefined;

      if (!phone || (!message && !mediaUrl)) {
        return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      }

      const reply = await handleMessage(phone, message, mediaUrl, mediaContentType);

      const user = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
      if (user.length > 0) {
        await logChat(user[0].id, message, reply, "GPT");
      }

      // Fix 1 — split long replies into multiple TwiML messages (WhatsApp cap ~1600 chars)
      const chunks = splitMessage(reply);
      const messageXml = chunks.map(c => `<Message>${escapeXml(c)}</Message>`).join("");
      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${messageXml}</Response>`);
    } catch (err) {
      console.error("Webhook error:", err);
      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Something went wrong. Try again in a moment.</Message></Response>`);
    }
  });

  // ── Admin test harness webhook ────────────────────────────

  app.post("/api/admin/test-webhook", async (req, res) => {
    try {
      const { phone, message } = req.body;
      if (!phone || !message) return res.status(400).json({ message: "phone and message required" });
      const reply = await handleMessage(phone, message);
      res.json({ reply });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Health check ──────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "KamLife Coach", timestamp: new Date().toISOString() });
  });

  // ── Addition 7: Coach Dashboard API — protected by DASHBOARD_API_KEY ─────

  function requireDashboardKey(req: any, res: any, next: any) {
    const key = process.env.DASHBOARD_API_KEY;
    const provided = req.headers["x-dashboard-key"] || req.query.key;
    if (key && provided !== key) return res.status(403).json({ error: "Forbidden" });
    next();
  }

  app.get("/api/dashboard/clients", requireDashboardKey, async (_req, res) => {
    try {
      const all = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE")).orderBy(desc(users.lastActiveAt));
      const now = Date.now();
      const weekAgo = new Date(now - 7 * 86400000);

      const result = await Promise.all(all.map(async (u) => {
        const thisWeekLogs = await db.select().from(chatHistory)
          .where(and(eq(chatHistory.userId, u.id), gte(chatHistory.createdAt, weekAgo)))
          .limit(50);
        const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt).getTime() : 0;
        const sinceLastMsg = now - lastActive;
        const status = sinceLastMsg < 24 * 3600000 ? "green" : sinceLastMsg < 48 * 3600000 ? "yellow" : "red";
        const programmeDays = u.programmeStartDate
          ? Math.floor((now - new Date(u.programmeStartDate).getTime()) / 86400000) : 0;
        return {
          id: u.id,
          name: u.name,
          phone: u.phoneNumber,
          onboardingState: u.onboardingState,
          lastMessageAt: u.lastActiveAt,
          programmeDays,
          thisWeekLogCount: thisWeekLogs.length,
          status,
        };
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch clients" });
    }
  });

  app.get("/api/dashboard/client/:phone", requireDashboardKey, async (req, res) => {
    try {
      const phoneParam = decodeURIComponent(req.params.phone);
      const [client] = await db.select().from(users).where(eq(users.phoneNumber, phoneParam)).limit(1);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000);
      const [weights, steps, workouts, chats] = await Promise.all([
        db.select().from(weightLogs).where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, fourteenDaysAgo))).orderBy(asc(weightLogs.loggedAt)),
        db.select().from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, fourteenDaysAgo))).orderBy(asc(stepLogs.loggedAt)),
        db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, fourteenDaysAgo))).orderBy(desc(workoutLogs.loggedAt)),
        db.select().from(chatHistory).where(eq(chatHistory.userId, client.id)).orderBy(desc(chatHistory.createdAt)).limit(100),
      ]);
      const liveTargets = calculateTargets(parseFloat(client.currentWeight || "75"), client.goalType || "fat_loss", client.lifeSituation || "office", client.trainingDaysPerWeek || 3);
      const programmeDays = client.programmeStartDate ? Math.floor((Date.now() - new Date(client.programmeStartDate).getTime()) / 86400000) : 0;

      res.json({ client, weightLogs: weights, stepLogs: steps, workoutLogs: workouts, chatHistory: chats, liveTargets, programmeDays });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch client" });
    }
  });

  app.get("/api/dashboard/metrics", requireDashboardKey, async (_req, res) => {
    try {
      const allComplete = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
      const now = Date.now();
      const weekAgo = new Date(now - 7 * 86400000);
      const twoWeeksAgo = new Date(now - 14 * 86400000);

      const activeClients = allComplete.length;
      const newThisWeek = allComplete.filter(u => u.createdAt && new Date(u.createdAt) >= weekAgo).length;
      const churnedThisWeek = allComplete.filter(u => u.lastActiveAt && new Date(u.lastActiveAt) < twoWeeksAgo).length;

      const allChats = await db.select().from(chatHistory).where(gte(chatHistory.createdAt, weekAgo));
      const avgMessagesPerDay = activeClients > 0 ? Math.round(allChats.length / 7 / activeClients * 10) / 10 : 0;

      res.json({
        activeClients,
        newThisWeek,
        churnedThisWeek,
        avgMessagesPerClientPerDay: avgMessagesPerDay,
        totalRevenuePlaceholder: activeClients * 99,
        currency: "ZAR",
        note: "Revenue figure is a placeholder — integrate PayFast webhooks to get real payment data",
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  });

  app.post("/api/dashboard/broadcast", requireDashboardKey, async (req, res) => {
    try {
      const { message: broadcastMsg, filter = "all" } = req.body;
      if (!broadcastMsg) return res.status(400).json({ error: "message is required" });

      const twilioClient2 = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}` : "";
      if (!fromNum) return res.status(500).json({ error: "TWILIO_WHATSAPP_NUMBER not configured" });

      const allComplete = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
      const now = Date.now();
      const twoWeeksAgo = new Date(now - 14 * 86400000);
      const twoDaysAgo = new Date(now - 48 * 3600000);

      let targets = allComplete;
      if (filter === "active") targets = allComplete.filter(u => u.lastActiveAt && new Date(u.lastActiveAt) >= twoDaysAgo);
      if (filter === "atrisk") targets = allComplete.filter(u => !u.lastActiveAt || new Date(u.lastActiveAt) < twoWeeksAgo);

      let sent = 0;
      let failed = 0;
      for (const u of targets) {
        try {
          await twilioClient2.messages.create({ from: fromNum, to: u.phoneNumber, body: broadcastMsg });
          sent++;
        } catch { failed++; }
      }
      res.json({ sent, failed, total: targets.length });
    } catch (err) {
      res.status(500).json({ error: "Broadcast failed" });
    }
  });
}
