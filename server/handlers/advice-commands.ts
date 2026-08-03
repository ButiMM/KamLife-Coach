/**
 * ADVICE & MASTERCLASS COMMANDS — extracted verbatim from early-commands.ts (2026-07-21) to
 * decompose the keyword wall (file-size + isolation: a workout regex can't reach a food message).
 * BEHAVIOUR IS IDENTICAL — same handlers, same order, same ENGINE_LIVE gates. Most of these are
 * JUDGMENT handlers that stand down when the brain is live; two are mechanical (step-target
 * update, walking-calorie) and always run. Runs after the numbers-literacy layer in the pipeline.
 */

import { db } from "../db";
import { users, stepLogs } from "../../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import { logChat } from "./chat-log";
import { looksSickMention } from "./sick-flow";
import { scanForSAFoods } from "./food-scanner";
import { nextDayDate, extractStepTargetChange, looksLikeLowMobility, looksLikeDefeatedNoResults, looksLikeDigestiveIssue, looksLikeFoodDislike, looksLikeOvertrainingPlan, sastDayStart } from "../utils";
import { stepBurnKcal } from "../targets";

export async function handleAdviceCommands(ctx: { message: string; m: string; user: any; phone: string }): Promise<string | null> {
  const { message, m, user, phone } = ctx;
  const firstName = user.name?.split(" ")[0] || "";
  const capName = user.name?.split(" ")[0] || "there";

  // ---- LOAD SHEDDING ----
  const isLoadShedding = /\b(load.?shed|loadshed|eskom|no.?electricity|no.?power|stage\s*[1-8]|power.?cut|power.?out|blackout|no.?lights|lights.?out|inverter.?dead|battery.?dead|no.?signal.*load|generator.*off)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isLoadShedding) {
    const lsReply = `${capName}, load shedding is real — it messes with routines, meals, and everything else. No blame.\n\nHere's what you can still do with zero power:\n- Home workout: 3 rounds of 15 squats, 10 push-ups, 20 jumping jacks, 30-sec plank. No equipment, no electricity needed.\n- Eating: cold food counts. Bread + peanut butter, fruit, biltong, yoghurt if still cold — log it.\n- Steps: even 20 minutes walking outside counts. Send me the count when you're back.\n\nWhen power's back, pick up where you left off. One missed session never killed progress — giving up does.`;
    await logChat(user.id, message, lsReply, "LOAD_SHEDDING");
    return lsReply;
  }
  const isSick = looksSickMention(m); // sick itself is handled at the TOP now (understanding before keywords)

  // ---- RETURN PLANNING ("I'll be back Wednesday", "let's confirm I go back Monday") ----
  const isReturnPlanning = /\b(i.?ll (be back|start|resume|return|train|come back)|let.?s confirm|confirm (i|that i)|going back|back (on|from) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)|start(ing)? (again|back|monday|tuesday|wednesday|thursday|friday|tomorrow)|resume (on|from|monday|tuesday|wednesday|thursday|friday)|back to (training|gym|it) (on|from|monday|tuesday|wednesday|thursday|friday))\b/i.test(m)
    && !isSick
    && /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|next month)\b/i.test(m);
  // MEMORY (always, whoever replies): persist the stated return day as back_on:<date> — surfaced in the snapshot so the brain REMEMBERS it (2026-07-20 Kam).
  const rpDay = isReturnPlanning ? m.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)\b/i) : null;
  const rpDate = rpDay ? nextDayDate(rpDay[0]) : null;
  if (rpDate && user.id) {
    const rpBase = (user.profileNotes || "").replace(/\s*\|?\s*back_on:\d{4}-\d{2}-\d{2}/g, "").trim();
    const rpNotes = `${rpBase ? rpBase + " | " : ""}back_on:${rpDate}`;
    db.update(users).set({ profileNotes: rpNotes }).where(eq(users.id, user.id)).then(() => { user.profileNotes = rpNotes; }).catch((e: any) => console.error("[RETURN_PLAN] persist failed:", e));
    // TEMPORAL LOOP: nudge them the evening before they said they'd be back, so we never go silent.
    import("../reminders").then(({ scheduleReturnNudge }) => scheduleReturnNudge(user.id, phone, rpDate, "away")).catch((e: any) => console.error("[RETURN_PLAN] nudge failed:", e));
  }
  if (process.env.ENGINE_LIVE !== "on" && isReturnPlanning) {
    const dayMatch = m.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)\b/i);
    const returnDay = dayMatch ? dayMatch[0].charAt(0).toUpperCase() + dayMatch[0].slice(1).toLowerCase() : "then";
    const goal = user.goalType || "fat_loss";
    const protTip = goal === "muscle_gain"
      ? `Keep your protein up until then — your muscles are still recovering.`
      : `Eat clean until then — no point starting strong on an empty tank.`;
    const returnReply = `${returnDay} confirmed, ${capName}. Rest up until then.\n\n${protTip}\n\nYour programme and targets are exactly where you left them. When you're back, message me and I'll send today's session.`;
    await logChat(user.id, message, returnReply, "RETURN_PLAN");
    return returnReply;
  }

  // ---- OVER-TRAINING SIGNAL ----
  const isFatigueMessage = /\b(so tired|exhausted|body.*sore|everything.*sore|can.?t move|legs.*dead|dead.*legs|burnt out|overtrain|worn out|body.*aching|aching all over|too sore|too tired|destroyed|wrecked|ruined|my body.*killing|killing me.*gym|can.?t walk|can.?t lift|barely.*move)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isFatigueMessage && (user.workoutStreak || 0) >= 4) {
    const overtrainReply = `${capName}, that's your body telling you to stop — and you should listen.\n\n${user.workoutStreak} days straight is real work. But without rest, you're breaking muscle down, not building it. Progress lives in recovery.\n\n*Today: rest.* No gym, no run. Walk if you want, but nothing intense.\n\n*Eat:* hit your protein target — your muscles repair during rest, not during training.\n\n*Tomorrow:* come back. You will lift more, feel better, and actually make progress. Rest is not quitting — it's part of the programme.`;
    await logChat(user.id, message, overtrainReply, "OVERTRAIN");
    return overtrainReply;
  }

  // ---- ALCOHOL QUESTION (not a log — asking about it) ----
  const isAlcoholQuestion = /\b(can i (drink|have.*alcohol|have.*beer|have.*wine)|alcohol.*ok|ok.*alcohol|is (beer|wine|alcohol|drinking) ok|what about (alcohol|drinking|beer|wine)|alcohol.*diet|diet.*alcohol|drinking.*weekends?|weekends?.*drink|how bad.*alcohol|affect.*results|alcohol.*results|skip.*alcohol|cut.*alcohol|limit.*alcohol)\b/i.test(m)
    && !(/\b(had|drank|drinking|having|tonight|last night|yesterday|at the braai|at the party)\b/i.test(m));
  if (process.env.ENGINE_LIVE !== "on" && isAlcoholQuestion) {
    const goal = user.goalType || "fat_loss";
    const alcoholQReply = goal === "muscle_gain"
      ? `${capName}, alcohol and muscle gain don't mix well — here's the honest version:\n\nYour body burns alcohol before everything else. While it's processing the drinks, testosterone drops and cortisol (the breakdown hormone) rises. That means less muscle built from that session.\n\n*Practical rule:* 1–2 drinks max on social occasions. Not every weekend. The more you drink, the more you undo.\n\n*What actually kills gains:* missing protein meals the next day because you're hungover. Eat your protein even on bad nights.`
      : `${capName}, alcohol is the one thing that silently kills fat loss without people realising it.\n\nYour body treats alcohol as a toxin and stops burning fat completely until it's processed — that can take 6–24 hours depending on how much you drank. The food you eat while drinking is more likely to be stored as fat.\n\n*Practical rule:* limit to 1–2 drinks max, not every weekend. Stick to spirits + soda water (no sugary mixers). Beer and wine add up fast.\n\n*It's not banned* — but if your results are stalling and you're drinking every weekend, that's likely why.`;
    await logChat(user.id, message, alcoholQReply, "ALCOHOL_QUESTION");
    return alcoholQReply;
  }

  // ---- FOODS TO AVOID / LIMIT ----
  // "cut.*out" was unanchored — it hijacked "scared of CUTting because I'm worried abOUT
  // losing my muscle" (2026-07-23). Anchored to the actual phrase "cut(ting) out".
  const isFoodsToAvoidQ = /\b(what.*avoid|what.*not.*eat|foods?.*cut|foods?.*limit|foods?.*avoid|avoid.*foods?|what.*skip|bad.*foods?|worst.*foods?|should.*avoid|cut(?:ting)?\s+out|what.*hurting|what.*killing|killing.*results|what.*blocking|what.*slowing|bad for.*loss|bad for.*gain|what (not|never) (to )?eat)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isFoodsToAvoidQ) {
    const goal = user.goalType || "fat_loss";
    let avoidReply = "";
    if (goal === "muscle_gain") {
      avoidReply = `${capName}, for muscle gain the biggest mistakes are:\n\n🚫 *What quietly kills your gains:*\n• Skipping meals — your muscles have nothing to build with\n• Not enough protein at each meal — aim for 30–40g per meal\n• Alcohol — drops testosterone, raises cortisol, slows recovery\n• Sugary drinks — empty calories with no protein\n• Too much junk — you can't out-supplement a bad diet\n\n✅ *Eat freely:* chicken, eggs, beef, tuna, pilchards, brown rice, sweet potato, oats, peanut butter\n\n_Nothing is permanently banned. You're just prioritising what builds muscle._`;
    } else {
      avoidReply = `${capName}, these are the things quietly killing fat loss for most South Africans:\n\n🚫 *The main culprits:*\n• *Sugary drinks* — Coke, juice, Oros, Energade. Liquid calories you don't feel full from\n• *White bread, pap, white rice* — spike blood sugar fast, you're hungry again in 2 hours\n• *Takeaways more than once a week* — KFC, Steers, Debonairs are mostly oil + refined carbs\n• *Alcohol* — stops fat burning for up to 24hrs. More than 2 drinks a weekend stalls progress\n• *Flavoured yoghurt + cereals* — marketed as "healthy", full of added sugar\n\n⚠️ *Limit, don't stress:*\nFull-cream dairy, peanut butter, dried fruit — fine in small amounts, just track it\n\n✅ *Eat as much as you want:*\nChicken, eggs, tuna, pilchards, vegetables, sweet potato, oats, brown rice\n\n_Nothing is permanently banned. You're spending your calorie budget wisely._`;
    }
    await logChat(user.id, message, avoidReply, "FOODS_TO_AVOID");
    return avoidReply;
  }

  // ---- BAD EATING DAY / BINGE RECOVERY ----
  const isBadEatingDay = /\b(ate (badly|everything|too much|junk|rubbish|badly today)|went off track|off track (today|completely)|had a (bad|terrible|awful) (day|eating)|cheat day gone (wrong|bad|too far)|couldn.?t stop eating|binge(d|ing)|ate everything in sight|blew (my|the) (diet|plan|calories)|messed up (today|my diet|my eating)|fell off|ruined (today|my diet|it)|ate like (crazy|mad|pig)|stress (ate|eating))\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isBadEatingDay) {
    const badDayReply = `${capName}, one bad day doesn't undo weeks of work. It's one meal — not one month.\n\nHere's what actually matters now:\n\n*Tonight:* drink water, get to sleep at a decent time. Don't try to "make up" for it by skipping tomorrow's meals — that makes it worse.\n\n*Tomorrow:* back to normal. First meal — protein. Eggs, chicken, tuna. Don't punish yourself with restriction, just get back on track.\n\n*The truth:* fat loss happens over weeks and months. One rough day is noise in the data. What you do the next 3 days is what actually matters.`;
    await logChat(user.id, message, badDayReply, "BAD_EATING_DAY");
    return badDayReply;
  }

  // ---- LOGGING CONFESSION — "I haven't been logging" (general, not about skipping meals) ----
  // Catches people apologising for not logging. Research: respond with curiosity not consequence.
  const isLoggingConfession = /\b(haven.?t been logging|haven.?t logged|not been logging|been bad (at|with) logging|been slack(ing)? (on|with) (logging|tracking)|forgot to (log|track)|haven.?t been tracking|I know I haven.?t|I know, I haven.?t|missed (my )?log(s|ging)?|no logs (lately|recently|this week)|haven.?t logged (anything|meals?|food)|been slipping (on|with) (logging|tracking))\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isLoggingConfession) {
    const confessionReply = `${capName}, no guilt here. Logging is information — not a test you pass or fail.\n\nTell me one thing: what are you eating right now, or what did you have at your last meal? Just that. We pick up from here.`;
    await logChat(user.id, message, confessionReply, "LOGGING_CONFESSION");
    return confessionReply;
  }

  // ---- NIBBLING / GRAZING — "I was just nibbling on things" ----
  // Client ate, but grazed rather than had proper meals. Don't shame — just get the data.
  // Research: any eating occasion logged is better than none.
  const isNibbling = (
    /\bnibb(le[ds]?|ling)\b/i.test(m)
    || (/\bgraz(e[ds]?|ing)\b/i.test(m) && !/\b(knee|elbow|skin|wound|road|floor)\b/i.test(m))
    || /\bpicking at (my )?food\b/i.test(m)
    || /\b(bits? and pieces|bits? here and there|eating here and there)\b/i.test(m)
    || /\b(no proper meal today|didn.?t have a proper meal|ate nothing proper)\b/i.test(m)
  );
  if (process.env.ENGINE_LIVE !== "on" && isNibbling) {
    const nibblingReply = `${capName}, nibbling still counts — tell me what you had and I'll log it properly.\n\nWhat were you picking at? Even rough amounts — "a few crackers, some peanut butter, bits of chicken". Anything you give me is data I can coach from.`;
    await logChat(user.id, message, nibblingReply, "NIBBLING_CONFESSION");
    return nibblingReply;
  }

  // ---- CHRONIC UNDER-EATING — "I only eat once a day", "I struggle to eat", "no appetite most days" ----
  // Distinct from the acute "forgot to eat today" below. This is the recurring SA pattern:
  // work-from-home, low movement, low appetite, one meal a day. Research: 2 eating occasions/day
  // is the threshold. Movement drives appetite. Never shame — make adding ONE thing feel easy.
  const isChronicUndereating = /\b(only eat once|eat once a day|once or twice a day|one meal a day|two meals a day|don.?t eat much|hardly eat|barely eat|struggle to eat|struggling to eat|hard to eat|can.?t eat much|small appetite|no appetite|not (really |very )?hungry (most|these|during|when)|never (really )?hungry|low appetite|lose my appetite|don.?t feel like eating)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isChronicUndereating) {
    const goal = user.goalType || "fat_loss";
    const undereatReply = goal === "muscle_gain"
      ? `${capName}, this is the thing holding your results back — and it's fixable.\n\nEating once or twice a day means your body never gets enough fuel to build. It breaks down muscle for energy instead. You can train perfectly and still go nowhere if the food isn't there.\n\n*The easy fix — don't force big meals:*\nAdd ONE protein snack between meals. No cooking:\n• Yoghurt + a banana\n• Peanut butter on 2 slices bread\n• A tin of pilchards or tuna\n• A shake with milk\n\nOne extra eating moment a day. Your appetite grows once your body learns food is coming regularly.`
      : `${capName}, I hear this a lot — and I'll be straight: eating once or twice a day is *slowing your fat loss, not speeding it up.*\n\nWhen you barely eat, your body thinks food is scarce — it slows your metabolism and holds onto fat harder. You also lose muscle, the exact thing that keeps you burning. "Skinny-fat" comes from under-eating, not over-eating.\n\nAnd if you're not moving much (working from home), your appetite stays low — that's normal. A short walk actually wakes it up.\n\n*The easy fix — don't force a big meal:*\nAdd ONE small protein thing a day. Yoghurt, a tin of pilchards, peanut butter on bread, boiled eggs. No cooking.\n\nTwo eating moments beats one. That's the only food target this week.`;
    await logChat(user.id, message, undereatReply, "CHRONIC_UNDEREATING");
    return undereatReply;
  }

  // ---- DEFER START / NOT MENTALLY READY — keep the habit forming, no pressure ----
  // Active client wants to push their start to next month. Don't let them go dark —
  // offer minimum viable engagement (walk + photo food) so the habit forms in the gap.
  const isDeferringStart = /\b(can.?t start (this month|now|yet|right now)|don.?t think i can start|not sure i can start|not (mentally )?ready (to start|yet|for this|to begin)|not mentally ready|mentally not ready|start (next month|later|properly (next|in)|in (january|february|march|april|may|june|july|august|september|october|november|december))|begin next month|postpone (my|the|this)|push (my|the) start|wait (until|till|for) next month)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isDeferringStart) {
    const deferReply = `${capName}, I appreciate you being upfront instead of going quiet — that tells me you're serious.\n\nMental readiness is real. If your head isn't in it, the body won't follow. I get it.\n\nBut here's what we're going to do — this time is not wasted:\n\n*Just two things. No program, no pressure:*\n🚶 Walk when you can — send me your steps\n📸 Photo what you eat — I won't judge, I just want to see where you're starting\n\nThat's it. No strict rules. By the time you feel ready, you'll already be in the habit and I'll already know your patterns — so we hit the ground running instead of starting from scratch.\n\nEvery walk you take now counts more than you think. 💪`;
    await logChat(user.id, message, deferReply, "DEFER_START");
    return deferReply;
  }

  // ---- RESULTS TIMELINE — "how long until I see results?" ----
  // The #1 dropout question. User's proven answer: 3 months visual. Set honest expectations.
  const isResultsTimelineQ = (
    /\b(how long (until|before|till|to see|will it|does it) (take\b|be\b)?)/i.test(m) && /\b(results?|changes?|difference|lose|build|visible|see|notice|transform)\b/i.test(m)
  ) || (
    /\bwhen will (i|you|we) (see|notice|lose|start)\b/i.test(m) && /\b(results?|changes?|difference|weight|muscle|visible)\b/i.test(m)
  ) || (
    /\bhow many (weeks?|months?) (until|to see|before)\b/i.test(m) && /\b(results?|changes?|difference|visible)\b/i.test(m)
  ) || /\b(when will i (see|notice|lose|feel)\s.{0,20}(results?|changes?|difference|weight)|how long (to|before) (see|notice) (results?|changes?|a difference)|how long (to|before) lose weight)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isResultsTimelineQ) {
    const goal = user.goalType || "fat_loss";
    let timelineReply: string;
    if (goal === "muscle_gain") {
      timelineReply = `${capName}, honest answer:\n\n*Week 1–2:* You'll feel stronger. Workouts will feel easier.\n*Week 4–6:* Scale starts moving. Clothes start fitting differently.\n*Month 3:* You'll see it — and so will other people.\n\nMuscle builds from the inside out — strength going up IS the result before you see it visually. Trust the lifts, not the mirror right now.\n\nSend me a photo today. In 3 months I'll show you the exact difference.`;
    } else if (goal === "recomposition") {
      timelineReply = `${capName}, recomp is the most powerful transformation — but the slowest to show on scale.\n\n*Week 2–4:* Energy improves. Clothes fit differently. Waist tightens.\n*Month 3:* You'll see it — definition where fat was, different shape.\n*Month 6:* Other people start asking what you're doing.\n\nDon't trust the scale for recomp — it barely moves while your body changes shape. Monthly photos are the only measure that matters.`;
    } else {
      timelineReply = `${capName}, honest answer:\n\n*Week 1–2:* Scale drops 1–2kg — mostly water and glycogen. Energy improves.\n*Week 3–4:* Real fat loss starts. Clothes start feeling different.\n*Month 3:* You'll see it clearly — and so will other people.\n\nMost people want results in 3 weeks. The physiology takes 12. But those months pass whether you're doing this or not.\n\nSend me a photo now — clothed, mirror selfie is fine. In 3 months I'll show you the exact difference.`;
    }
    await logChat(user.id, message, timelineReply, "RESULTS_TIMELINE");
    return timelineReply;
  }

  // ---- SHIFT WORKER — "I work 4 days dayshift 4 days nightshift 4 days off" ----
  // Mining, nursing, security, casino — rotating schedules. Build around the schedule.
  const isShiftWorker =
    /\b(shift.?work(er|ing)?|rotating (shift|roster|schedule)|4\s*days?\s*(on|off|day.?shift|night.?shift)|work(ing)?\s+(day.?shift|night.?shift|on shift)|night.?shift\s+work|day.?shift\s+work|shift\s+(schedule|pattern|rotation|system|rota)|i\s+work\s+(days?\s+and\s+nights?|nights?\s+and\s+days?)|irregular\s+(shift|hours?)|12[\s\-]?hour\s+shift|24[\s\-]?hour\s+shift|working\s+(dayshift|nightshift|day\s+shift|night\s+shift)|going\s+(on|into)\s+shift|before\s+(my|the)\s+shift|come\s+off\s+shift|rotating\s+roster|i\s+work\s+(night|day)\s+shift)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isShiftWorker) {
    const goal = user.goalType || "fat_loss";
    const shiftReply = `${capName}, KamLife is built to work around schedules like yours — miners, nurses, security, casino workers. You're not the first, and this is solvable.\n\n*On DAYSHIFT:* Train after your shift or first thing in the morning. Energy is normal.\n\n*On NIGHTSHIFT:* Train in the morning *before* you sleep — your body is still running after a night shift, use that window. Don't train right before going in.\n\n*On DAYS OFF:* These are your best training days. Full sessions.\n\n*Food on shift:* Pack your own. Canteen food is mostly refined carbs. Pre-pack chicken + rice, eggs + bread, biltong + fruit.\n\n*The one rule:* ${goal === "fat_loss" ? "Hit your protein target every 24 hours — timing matters less than consistency." : "Eat before and after every session. Muscle builds in the recovery window, not in the gym."}\n\nTell me your current rotation — dayshift, nightshift, or days off — and I'll tell you exactly what to do today.`;
    await logChat(user.id, message, shiftReply, "SHIFT_WORKER");
    return shiftReply;
  }

  // ---- INACTIVE GYM MEMBER — "only went 4 days in 3 months", "barely use my membership" ----
  // Sunk cost guilt. Don't reinforce it — offer the real choice honestly.
  const isInactiveGym =
    /\b(gym\s+(but|member|membership)\s+(i|but|only|haven.?t|barely|rarely|hardly)|only\s+(go|went|been)\s+(to\s+)?(the\s+)?gym\s+(once|twice|\d+\s+times?|\d+\s+days?|rarely|barely)|haven.?t\s+(been|gone)\s+(to\s+)?(the\s+)?gym\s+(in|for|since)\s+(weeks?|months?|ages?|a\s+long\s+time)|(rarely|hardly|barely|never)\s+(go|use|been\s+to)\s+(the\s+)?gym|gym\s+membership\s+(sitting|wasting|going\s+to\s+waste|i\s+don.?t\s+use)|paying\s+for\s+(a\s+)?gym\s+(but|and)\s+(don.?t|haven.?t|barely|rarely)|not\s+using\s+(the|my)\s+gym|wasted?\s+(on\s+)?gym\s+membership)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isInactiveGym) {
    const inactiveGymReply = `${capName}, the membership is sunk cost — it's paid whether you go or not. Let's not make training decisions based on guilt about it.\n\nHonest question: what's actually stopping you from going?\n\n*If it's distance or time:* home training gets the same results. You don't need a gym.\n*If it's motivation:* home training is easier to start — no commute, no threshold to cross.\n*If it's schedule:* 30 minutes at home, 3 days a week, is enough.\n\n*Three options:*\n1. Switch fully to home training — I'll rebuild your programme right now\n2. Keep the gym for 1 day a week + home training for the rest\n3. Set one gym day as non-negotiable and build from there\n\nWhich one makes sense for where you are right now?`;
    await logChat(user.id, message, inactiveGymReply, "INACTIVE_GYM");
    return inactiveGymReply;
  }

  // ---- SKIPPING MEALS / FORGOT TO EAT ----
  const isSkippingMeals = /\b(haven.?t eaten|forgot to eat|haven.?t had anything|skipped (breakfast|lunch|dinner|meals?|eating)|too busy to eat|no time to eat|nothing today|haven.?t had food|not eaten (yet|today|all day)|missed (breakfast|lunch|dinner|meals?)|didn.?t eat|didn.?t have (breakfast|lunch|dinner)|no food today)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isSkippingMeals) {
    const hourSAST = (new Date().getUTCHours() + 2) % 24;
    const skipReply = hourSAST >= 15
      ? `${capName}, it's late in the day and you haven't eaten — that's a problem. Your metabolism slows, cortisol rises, and you'll likely overeat tonight.\n\n*Eat something now:* 2 eggs + bread, peanut butter on toast, a tin of tuna — anything with protein. Don't wait for a "proper meal" that never comes.\n\nMissing meals doesn't speed up fat loss — it makes your body hold onto fat harder. Consistent eating wins every time.`
      : `${capName}, don't let busyness become a skipped meal habit — it backfires. Your body needs fuel to burn fat and build muscle.\n\n*Grab something now:* eggs, bread + peanut butter, a tin of fish, yoghurt. Takes 5 minutes.\n\n_Eating consistently is one of the most powerful things you can do for your results._`;
    await logChat(user.id, message, skipReply, "SKIPPING_MEALS");
    return skipReply;
  }

  // ---- FUNERAL / BEREAVEMENT ----
  // "passed on" / "passed" (with a relative) are as common as "passed away" in SA
  // English — a real client wrote "my grandfather passed on in the wee hours" and it
  // must reach this compassion path, never generic handling (2026-07-08 screenshot).
  const isBereaved = /\b(funeral|passed away|passed on|someone.*died|died.*someone|lost.*loved one|loved one.*lost|in mourning|family.*death|death.*family|my (mom|dad|mother|father|brother|sister|uncle|aunt|gogo|ouma|oupa|gran|grandma|grandfather|grandmother|friend).*(died|passed)|died.*(mom|dad|mother|father|brother|sister|uncle|aunt|gran)|umngcwabo|ukufa|silahlekelwe)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isBereaved) {
    const bereavReply = `${capName}, I'm sorry for your loss. Take all the time you need — the programme will wait.\n\nFunerals mean long days, different food, no routine. That's okay. Eat what's there, stay hydrated, walk if you can. Don't stress about the plan right now.\n\nWhen you're ready to come back — even if it's weeks from now — just message me and I'll reset your programme from that day. There's no guilt here. Rest, mourn, be with your family.`;
    await logChat(user.id, message, bereavReply, "BEREAVEMENT");
    return bereavReply;
  }

  // UPDATE STEP TARGET — ONE parser (utils.extractStepTargetChange) shared with the brain gate; all SA number formats caught + persisted (2026-07-12).
  const parsedStepTarget = extractStepTargetChange(m);
  if (parsedStepTarget !== null) {
    if (parsedStepTarget >= 2000 && parsedStepTarget <= 30000) {
      const oldTarget = user.stepsTarget || 8500;
      await db.update(users).set({ stepsTarget: parsedStepTarget }).where(eq(users.phoneNumber, phone));
      const direction = parsedStepTarget > oldTarget ? "raised" : parsedStepTarget < oldTarget ? "lowered" : "kept";
      const stepUpdateReply = `Step target ${direction} to *${parsedStepTarget.toLocaleString()} steps/day*. ✅ Every screenshot you log — and your morning brief — now tracks against this.`;
      await logChat(user.id, message, stepUpdateReply, "STEP_TARGET_UPDATE");
      return stepUpdateReply;
    }
    return `That step count doesn't look right (valid range: 2,000–30,000). What should your daily step goal be?`;
  }

  // ---- STEP TRACKING APP RECOMMENDATION ----
  // "Which app?" "What app to track steps?" — comes up every onboarding conversation.
  // Give a clear, device-aware answer so the client can act immediately.
  const isStepAppQ = /\b(which\s+app|what\s+app|step\s+(?:app|counter|tracker)|app\s+(?:for\s+)?steps?|steps?\s+app|track\s+(?:my\s+)?steps|how\s+(?:do\s+i\s+)?(?:count|track)\s+(?:my\s+)?steps|best\s+app\s+for\s+steps|google\s+fit|samsung\s+health|pedometer)\b/i.test(m);
  if (isStepAppQ) {
    const stepAppReply = `For counting steps, here is what I recommend based on your phone:\n\n*Android (Samsung):* Samsung Health — already on your phone. Open it, tap *Activity*, then *Steps*. It tracks automatically in the background.\n\n*Android (other):* Google Fit — free on Google Play. Takes 2 minutes to set up. If you already have it, open it and look for the steps circle on the home screen.\n\n*iPhone:* Apple Health — already installed. It counts steps automatically. Open it, tap *Browse → Activity → Steps*.\n\n*No smartphone / basic phone:* A cheap pedometer from Pick n Pay or Checkers works — clip it to your waistband, reset it in the morning.\n\nOnce it is set up, just send me your step count at the end of each day — type *"walked 8,000 steps"* or similar and I log it for you.\n\n_Target: ${(user.stepsTarget || 8500).toLocaleString()} steps/day._`;
    await logChat(user.id, message, stepAppReply, "STEP_APP_GUIDE");
    return stepAppReply;
  }

  // ---- PHONE IN CAR / INFLATED STEPS — driving or machine vibration inflates step count ----
  // Accelerometer can't distinguish walking from road/machine vibration.
  // Common: truck drivers, miners, taxi drivers, machine operators.
  const isInflatedSteps =
    /\b(phone\s+(in|on|with\s+me\s+in)\s+(the\s+)?(car|truck|bakkie|vehicle)|driving\s+(around\s+)?with\s+(my\s+)?phone|car\s+(vibration|vibrates?)|machine\s+(vibration|vibrates?|shaking)|vibration\s+(is\s+too\s+much|count(s|ing)\s+as\s+steps?|giving\s+me\s+steps?)|steps?\s+(from|because\s+of|due\s+to)\s+(vibration|driving|car|truck)|inflated\s+steps?|steps?\s+not\s+(accurate|real|right|from\s+walking)|operating\s+(big|heavy|those|mining|the)\s+machine|step\s+count\s+(is\s+)?(from\s+)?(vibration|car|driving|machine))\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isInflatedSteps) {
    const inflatedReply = `${capName}, car and machine vibration inflating step counts is a real issue — the phone accelerometer can't tell the difference between walking and road bumps.\n\n*Quick fix:* Phone in your *pocket* (not on the seat or console) filters out most vehicle vibration.\n\nOr just tell me your actual walking: "walked 2,000 steps at lunch" and I'll log only that.\n\n*For your situation:*\nYour real movement target will be smaller — and that's fine. What matters is intentional walking:\n• 10-min walk on a break: ~1,000 steps\n• Walking to/from your vehicle or canteen\n• 20-min walk at home in the evening\n\nShould I set your step target to reflect what you can actually walk — not what the car registers for you?`;
    await logChat(user.id, message, inflatedReply, "INFLATED_STEPS");
    return inflatedReply;
  }

  // LOW MOBILITY — concern-first; results come from the FOOD deficit, not steps; offer a lower step goal in one tap (2026-07-12 Kam, detector: utils.looksLikeLowMobility). JUDGMENT → brain owns it when live (brain bullet: CAN'T WALK MUCH).
  if (process.env.ENGINE_LIVE !== "on" && looksLikeLowMobility(m)) {
    const goal = user.goalType || "fat_loss";
    const goalWord = goal === "muscle_gain" ? "muscle" : goal === "recomposition" ? "results" : "fat loss";
    const lowMobReply = `${capName}, I hear you — and this changes nothing about your results. 💛\n\nYour ${goalWord} comes from your *eating* — that's the engine, and we've got it dialled. Walking is a bonus on top, never the main thing. Plenty of people get real results barely walking.\n\n*Movement that counts for you:* chair marches, seated leg lifts, gentle arm circles, or a short flat stroll — even 5 minutes matters, and anything is a win.\n\nLet's set a step goal that fits *your* body, no pressure — pick one and I'll track against that:\n\n[BUTTONS:Set steps to 3000|Set steps to 5000|Log my food]`;
    await logChat(user.id, message, lowMobReply, "LOW_MOBILITY");
    return lowMobReply;
  }

  // DEFEATED / "IT'S MY GENETICS" — Kam's masterclass (2026-07-12), now ported to the brain so the brain owns this JUDGMENT when live; template is the ENGINE_LIVE=off fallback.
  if (process.env.ENGINE_LIVE !== "on" && looksLikeDefeatedNoResults(m)) {
    const defeatReply = `${capName}, I completely understand how you feel. 💛\n\nGym, lifting, running, eating clean — that's what social media (TikTok, Instagram) sells everyone. What they *don't* tell you is you have to do the RIGHT things for *your* body and *your* goal — not some generic routine.\n\n*It's not your genetics.* You just haven't had the right help yet — and that's exactly what I'm here for.\n\nYou're here now. You can relax. 🧘 We keep it simple, I hold you accountable, and we do the right things for *you*. One step at a time.\n\n[BUTTONS:What do I do today?]`;
    await logChat(user.id, message, defeatReply, "DEFEATED_REFRAME");
    return defeatReply;
  }

  // ---- DIGESTIVE ISSUES — bloating / acid reflux / heartburn / indigestion (2026-07-12
  // onboarding screenshot). Care first, practical food guidance, and a defer-to-doctor
  // safety line. Detector (utils.looksLikeDigestiveIssue) excludes period + check-in noise.
  // NOT GATED — same reason: it carries the "check with your doctor, I work alongside
  // them, never instead of them" line, which is a scope boundary, not coaching flavour.
  if (looksLikeDigestiveIssue(m)) {
    const giReply = `Thanks for telling me${capName ? ", " + capName : ""} — that matters, and we can work with it. 💛\n\nBloating, reflux and heartburn are really common. What helps most people:\n• *Smaller meals, more often* — big meals overload the gut.\n• Eat *slower*, sit up, and don't lie down for 2–3 hours after eating.\n• Common triggers: fizzy drinks, very fatty/fried food, too much dairy, big late-night meals, eating in a rush.\n• Sip water *between* meals, not gulping during.\n\nI'll keep your meals lighter and easier on your stomach. If it's regular or you're already on tablets for it, please also check in with your doctor — I work *alongside* them, never instead of them.\n\nTell me when it hits worst and I'll help you spot the trigger.`;
    await logChat(user.id, message, giReply, "DIGESTIVE_ISSUE");
    return giReply;
  }

  // ---- FOOD DISLIKE — "I hate chicken breast" / "I force myself to eat X" (2026-07-12).
  // Offer an alternative in the same role; never make someone force down food they hate.
  if (process.env.ENGINE_LIVE !== "on" && looksLikeFoodDislike(m)) {
    const disliked = scanForSAFoods(m)[0];
    if (disliked) {
      const alts: Record<string, string> = {
        protein: "eggs, chicken thighs, tinned pilchards or tuna, lean beef mince, or beans and lentils",
        carb: "brown rice, oats, sweet potato, samp, or potatoes",
        veg: "spinach or morogo, cabbage, broccoli, carrots, or butternut",
        fruit: "banana, apple, orange, or naartjies",
        dairy: "low-fat milk, maas, or Greek yoghurt",
      };
      const altLine = alts[disliked.category] || "something you actually enjoy in the same slot";
      const dislikeReply = `${capName}, you never have to force down food you hate. 💛\n\nIf *${disliked.name.toLowerCase()}* isn't for you, swap it for ${altLine} — same job for your goal, and you'll actually stick to it. Log what you *enjoy* and I'll make the numbers work.\n\nWhat do you like eating? I'll build around that.`;
      await logChat(user.id, message, dislikeReply, "FOOD_DISLIKE");
      return dislikeReply;
    }
    // Dislike phrasing but no recognisable food — let it flow to the normal handlers.
  }

  // ---- OVER-TRAINING PLAN — client states 5+ sessions/week or "every day" (2026-07-12,
  // Kam: "5 is unnecessary"). Right-size it: rest is where results happen.
  if (process.env.ENGINE_LIVE !== "on" && looksLikeOvertrainingPlan(m)) {
    const overReply = `${capName}, quick one — more than *4 sessions a week is unnecessary* for most people, and it usually backfires. 🛑\n\nYour muscles grow on the REST days, not in the gym. 3–4 focused sessions beat 5–6 rushed ones every single time — better results *and* your body recovers.\n\nLet's keep you at *3–4 quality sessions* and make each one count. Rest is part of the programme, not a break from it.\n\n[BUTTONS:Today's workout|My progress]`;
    await logChat(user.id, message, overReply, "OVERTRAINING_PLAN");
    return overReply;
  }

  // ---- WALKING CALORIE BURN — "how many calories did I burn walking/steps?" ----
  // Previously the bot ignored this cross-reference question and just showed food totals.
  // Key coaching point: their calorie target already accounts for activity — don't eat back steps.
  const isWalkingCalQ =
    /\b(how\s+(many\s+)?calories?\s+(did\s+i\s+|have\s+i\s+)?burn(ed|t)?\s+(from\s+)?(walking|steps?|my\s+walk(ing)?|my\s+steps?|the\s+walk(ing)?))\b/i.test(m)
    || /\b(how\s+much\s+(did\s+i\s+|have\s+i\s+)?burn(ed|t)?\s+(from\s+)?(walking|steps?))\b/i.test(m)
    || /\b(walk(ing)?\s+calories?|step\s+calories?|calories?\s+(from|burned\s+from)\s+(walking|steps?))\b/i.test(m)
    || /\b(how\s+(does|do)\s+(the\s+)?(walking|steps?)\s+(affect|impact|count|factor\s+into|fit\s+into)\s+(my\s+)?(total\s+calories?|calorie\s+total|calories?\s+(for\s+)?today|daily\s+(intake|calories?|budget)|calorie\s+(target|budget)))\b/i.test(m)
    || /\b(burned|burnt)\s+(walking|from\s+(walking|steps?))\b/i.test(m);

  if (isWalkingCalQ) {
    const todayStart = sastDayStart();
    let todaySteps = 0;
    try {
      const stepRow = await db.select({ steps: stepLogs.steps })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStart)))
        .orderBy(desc(stepLogs.loggedAt))
        .limit(1);
      todaySteps = stepRow[0]?.steps || 0;
    } catch { /* non-fatal */ }

    const bodyWeightKg = user.currentWeight ? parseFloat(String(user.currentWeight)) : 75;
    const estimatedKcal = stepBurnKcal(todaySteps, bodyWeightKg);
    const stepsTarget = user.stepsTarget || 8500;
    const calTarget = user.calorieTarget || 1800;
    const nm = firstName ? `${firstName}, ` : "";

    let walkCalReply: string;
    if (todaySteps === 0) {
      const perK = stepBurnKcal(1000, bodyWeightKg);
      const targetBurn = stepBurnKcal(stepsTarget, bodyWeightKg);
      walkCalReply = `${nm}no steps logged yet today — send me your step count ("walked 6,000 steps") and I'll work it out exactly.\n\nFor you specifically, every 1,000 steps ≈ *~${perK} kcal*.\nHitting your ${stepsTarget.toLocaleString()} steps target burns roughly *~${targetBurn} kcal*.\n\n*One thing to know:* your *${calTarget} kcal daily target already includes your activity level.* Walk your steps, hit your calorie target — you're on track. You don't need to eat extra because you walked.`;
    } else {
      walkCalReply = `${nm}*Today's step burn:*\n${todaySteps.toLocaleString()} steps ≈ *~${estimatedKcal} kcal*\n\n*Important — how this fits your plan:*\nYour *${calTarget} kcal target already accounts for your activity level.* You don't "eat back" those walking calories on top of your target — the target was set to include them.\n\n*The rule:*\n✅ Hit your calorie target → you're eating the right amount\n✅ Hit your step target (${stepsTarget.toLocaleString()}) → your metabolism stays active, fat loss is faster\n❌ Adding step calories on top of your food target = eating at maintenance, not a deficit\n\nWalking accelerates fat loss. It doesn't mean you can eat more.`;
    }

    await logChat(user.id, message, walkCalReply, "WALKING_CALORIE_BURN");
    return walkCalReply;
  }

  // ---- BELLY FAT / MKHABA — "I want to lose my belly", "mkhaba", "stomach fat" ----
  // The #1 specific fat loss target. SA word "mkhaba" = belly/stomach fat (Zulu/Sotho).
  // Acknowledge specifically — people feel heard when you know their word.
  const isBellyFatQ =
    /\b(mkhaba|belly\s*(fat|flab)?|belly\s+is|my\s+belly|lose\s+(my\s+)?belly|flat\s+(stomach|tummy|belly)|stomach\s+fat|tummy\s+(fat|flab)|love\s+handles?|spare\s+tyre|spare\s+tire|fat\s+(belly|stomach|tummy)|pot\s+belly|get\s+rid\s+of\s+(my\s+)?(belly|stomach|mkhaba)|stomach\s+is\s+(big|huge|fat)|big\s+(belly|stomach|tummy))\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isBellyFatQ) {
    const goal = user.goalType || "fat_loss";
    const bellyReply = `${capName}, the mkhaba — the most common target, and the most frustrating one. Here's the honest version:\n\n*You cannot spot-reduce belly fat.* No amount of sit-ups or crunches removes fat from a specific area — that's not how the body burns fat. Fat leaves from everywhere when you're in a calorie deficit, and the belly is usually the *last* area to go because that's where your body stores it last.\n\n*What actually shrinks it:*\n✅ Calorie deficit — eating less than you burn\n✅ High protein — preserves muscle while fat is lost\n✅ Steps — walking is the single most effective belly fat activity\n✅ Sleep — poor sleep raises cortisol, which stores fat specifically in the belly\n\n*What doesn't:*\n❌ Sit-ups (build abs under the fat, don't remove the fat)\n❌ Green tea, detoxes, waist trainers\n\n${goal === "fat_loss" || goal === "recomposition" ? "The good news: you're already on the right programme for this. Hit your calorie target, walk your steps, and the mkhaba goes — it just takes the full 3 months to become visible." : "For your muscle gain goal, eating a small surplus means the mkhaba won't grow — and once you build muscle, your metabolism burns more fat at rest. Recomp mode handles this well."}\n\nKeep logging. The belly is the last place it shows up and the last place it leaves — but it does leave.`;
    await logChat(user.id, message, bellyReply, "BELLY_FAT");
    return bellyReply;
  }

  // ---- GAINS-FEAR / "I don't want to get lean" — the intermediate myth-victim ----
  // (2026-07-23, Kam: intermediates at high body fat refuse the deficit because "last time
  // I lost all my gains" — social media lied to them; they leave when the truth has no soft
  // landing. Meet the fear with respect, hold the cut-first line, leave the door open.)
  const isGainsFear =
    (/\b(los(?:e|ing|t)\s+(?:my\s+|all\s+(?:my\s+)?)?(?:gains|muscle|size))\b/i.test(m)
      && /\b(deficit|cut(?:ting)?|lean(?:ing)?(?:\s+out)?|diet(?:ing)?|drop(?:ping)?\s+(?:weight|fat)|scared|afraid|worried|don'?t want)\b/i.test(m))
    || /\b(?:don'?t|do not|won'?t|not)\s+want(?:\s+to)?\s+(?:get|be|go)\s+(?:lean|small(?:er)?|skinny)\b/i.test(m)
    || /\b(?:scared|afraid|worried)\s+(?:of\s+|about\s+)?(?:the\s+)?(?:deficit|cutting|getting\s+lean|losing\s+(?:my\s+)?(?:muscle|gains))\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isGainsFear) {
    const gainsReply = `${capName}, I hear you — and this fear is the most common one serious trainers carry. Social media planted it. Here's the truth:\n\n*In a proper deficit you do not lose your muscle.* High protein + heavy lifting protects it — what you lose is the fat covering it. What you "lost" last time was water and glycogen: muscles look flatter within days of dieting and fill straight back up when you eat normally. That, or it was a crash diet with no lifting — which is not what we do.\n\n*The order matters:*\n1️⃣ Lean phase — 8–12 weeks. Deficit, protein high, lifting stays HEAVY.\n2️⃣ Then rebuild — glutes, hamstrings, back, shoulders — on a frame where you can actually see them grow.\n\nYou cannot build a visible physique under fat the body keeps feeding. The stomach you mentioned is fat, not gains — and it only goes one way: the deficit.\n\nEverything you're afraid of losing comes back bigger, on a leaner body. That's the whole plan. In or out, I'll coach you either way — but I won't pretend there's a version where the stomach goes and the deficit doesn't happen.`;
    await logChat(user.id, message, gainsReply, "GAINS_FEAR");
    return gainsReply;
  }

  // ---- HEALTH QUICK-FIX EXPECTATION — "will losing weight fix my BP/sugar fast?" ----
  // (2026-07-23, Kam: clients with health problems expect a two-week cure, quit when the
  // miracle doesn't come. Honest timeline up front keeps them — or filters them on day one.)
  const isHealthQuickFix =
    /\b(blood\s*pressure|bp|diabetes|diabetic|sugar\s+(?:is|levels?|problem)|cholesterol|knees?\s+(?:pain|hurt|problem))\b/i.test(m)
    && /\b(fix|cure|heal|sort(?:\s+out)?|go\s+away|reverse|help)\b/i.test(m)
    && /\b(weight|fat|slim|lose|losing|kg)\b/i.test(m);
  // NOT GATED (2026-08-03). This carries a MEDICAL-SCOPE GUARANTEE — the honest timeline and
  // "medication decisions stay with your doctor". It sat behind ENGINE_LIVE !== "on", which has
  // been "on" in production for weeks, so it never ran: a client asking whether losing weight
  // fixes their blood pressure got whatever the model improvised, with no guaranteed doctor
  // referral. A safety guarantee must never depend on a feature flag being off.
  if (isHealthQuickFix) {
    const healthReply = `${capName}, straight answer: *yes, losing weight genuinely improves this* — blood pressure, sugar control, joint load all respond to fat loss. Doctors see it every day.\n\nBut I owe you the honest timeline: the real improvements show up after roughly *5–10% of your body weight* comes off and stays off — that's a *12-week-plus steady project*, not a two-week fix. Anyone promising faster is selling something.\n\nWhat you'll notice early (weeks 1–3): better energy, better sleep, clothes easing. The clinic numbers follow the consistency.\n\nTwo rules while we work:\n• Keep seeing your doctor — medication decisions stay with them, always.\n• Our lane: food logged, steps walked, strength trained — every day, boring, effective.\n\nIf you're in for the real timeline, I'm in with you the whole way.`;
    await logChat(user.id, message, healthReply, "HEALTH_QUICK_FIX");
    return healthReply;
  }

  // ---- CRIME / SAFETY WALKING OBJECTION ----
  // "Can't walk outside — crime", "not safe to walk in my area", "too dangerous outside"
  // This is a real SA barrier. Acknowledge it, give indoor alternatives immediately.
  const isCrimeWalkingObjection = /\b(can.?t\s+walk\s+(?:outside|outside here|outside in my area|in my area|near me|around here|on the street)|not\s+safe\s+to\s+walk|unsafe\s+to\s+walk|scared\s+to\s+walk|afraid\s+to\s+walk|dangerous\s+(?:to walk|outside|around here|in my area|near me)|crime\s+(?:in my area|is bad|is high|outside|near me|around here)|too\s+much\s+crime|high\s+crime|crime\s+rate|it.?s\s+not\s+safe\s+(?:outside|to walk|here)|can.?t\s+go\s+outside|don.?t\s+feel\s+safe\s+(?:walking|outside)|neighbourhood\s+(?:is\s+)?(?:dangerous|unsafe|not safe))\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isCrimeWalkingObjection) {
    const goal = user.goalType || "fat_loss";
    const target = user.stepsTarget || 8500;
    const crimeReply = `${capName}, that is a real issue — no argument. Walking in an unsafe area is not worth the risk.\n\nHere is what works instead:\n\n*Indoors:*\n• Walk on the spot while watching TV or on the phone — 30 min = ~2,500 steps\n• March up and down your passage — it counts\n• Stair climbs if you have stairs — 10 min = ~1,200 steps\n• Jump rope — 20 min = ${goal === "fat_loss" ? "~200 kcal burned" : "great conditioning"}\n\n*Safer outdoor options:*\n• Mall walking early morning before it fills up — free, well-lit, secure\n• Church grounds or school yard if access is possible\n• Taxi to a safer area for a morning walk if viable\n\nThe number is what matters — *${target.toLocaleString()} steps* — not where you walk. Indoor steps count exactly the same.\n\nSend me your step count at the end of the day, wherever you got them.`;
    await logChat(user.id, message, crimeReply, "CRIME_WALKING");
    return crimeReply;
  }

  // ---- MONTH-END / FINANCIAL STRESS ----
  const isMonthEnd = /\b(month.?end|end of month|no.?money|broke|short on cash|can.?t afford|salary.?not|waiting for.?(salary|pay|payday)|payday.*friday|payday.*next|no.?budget|empty|flat.?broke|nothing (left|to eat)|no.?food|can.?t buy|no.?groceries|no.?airtime|airtime.?finished)\b/i.test(m);
  if (process.env.ENGINE_LIVE !== "on" && isMonthEnd) {
    const meReply = `${capName}, month-end is tough for everyone in SA. No shame in it.\n\nHere's how to keep it going on zero budget:\n- *Protein:* eggs (cheapest protein there is), pilchards, beans, lentils\n- *Carbs:* pap, brown bread, oats, rice, sweet potato\n- *Vegetables:* cabbage, spinach, frozen veg — all cheap and good\n\nType *cheap meals* and I'll send you a full day of eating under R30. Fitness doesn't stop when the money runs out — your body still needs fuel to change.`;
    await logChat(user.id, message, meReply, "MONTH_END");
    return meReply;
  }

  return null;
}
