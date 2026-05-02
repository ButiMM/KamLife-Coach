import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  tablesFilter: [
    "users",
    "weight_logs",
    "workout_logs",
    "step_logs",
    "weekly_checkins",
    "chat_history",
    "clothing_checkins",
    "body_measurements",
    "exercise_logs",
    "progress_photos",
    "escalations",
    "ab_experiments",
    "ab_assignments",
    "meal_logs",
    "sent_proactive",
    "client_actions",
    "conversations",
    "messages",
  ],
});
