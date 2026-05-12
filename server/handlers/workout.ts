/**
 * Workout-related commands: gym log, done, my lifts, exercise weight log,
 * goal change, weight update/mention, programme setup, photo correction,
 * elderly/injury programme, programme delivery.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users, workoutLogs, exerciseLogs } from "../../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import twilio from "twilio";
import {
  buildDayWorkout, buildDay2Workout, buildDay3Workout,
  buildFullProgramme, getKamlifeProgramme, WORKOUT_DONE_RESPONSES,
} from "../programme";
import { checkPerfectDay, getProgressiveOverloadContext } from "./checks";
import { storeMemory } from "../memory";
import { generateVoiceNote } from "../tts";
import { generateMilestoneVoiceScript } from "../gpt";
import { logChat } from "./chat-log";
import { sastDayStart } from "../utils";
import { handleWeightLog } from "./weight";
import { calculateTargets } from "../targets";
import { getPrimaryWorkoutGifUrl } from "../exercise-media";
