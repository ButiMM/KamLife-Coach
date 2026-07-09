/**
 * Route registration index — wires all domain modules into the Express app.
 *
 * This replaces the monolithic routes.ts for route registration.
 * The main routes.ts still contains the message handler, helpers, and
 * coach HTML page — those will be extracted in future iterations.
 */
export { requireAdminKey } from "./auth";
export { registerAuthRoutes } from "./auth";
export { registerHealthRoutes } from "./health";
export { registerAdminRoutes } from "./admin";
export { registerWhatsAppRoutes } from "./whatsapp";
export { registerDashboardRoutes } from "./dashboard";
export { registerFinanceRoutes } from "./finance";
export { registerPaymentRoutes } from "./payments";
export { registerCoachRoutes } from "./coach";
export { registerVoiceBroadcastRoutes } from "./voice-broadcast";
export { registerHealthSyncRoutes } from "./health-sync";
export { registerWorkoutViewerRoutes } from "./workout-viewer";
