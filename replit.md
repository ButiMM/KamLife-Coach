# KamLife Coach

## Overview

KamLife Coach is a WhatsApp-based personal fitness coaching platform targeting South African clients. The system operates as a conversational AI coach that interacts with users via WhatsApp to track steps, workouts, weight, and weekly check-ins. An admin dashboard provides a read-only visualization of user progress and business metrics.

The core flow: Users message the coach on WhatsApp → OpenAI parses intent (log steps, log weight, etc.) → data is stored in PostgreSQL → admin views progress on a web dashboard.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Monorepo Structure
The project uses a single-repo structure with three main directories:
- `client/` — React SPA (frontend)
- `server/` — Express API (backend)
- `shared/` — Shared types, schemas, and API route contracts used by both client and server

### Frontend
- **Framework**: React with TypeScript, bundled by Vite
- **Routing**: Wouter (lightweight client-side router)
- **State/Data Fetching**: TanStack React Query for server state management
- **UI Components**: shadcn/ui (new-york style) built on Radix UI primitives with Tailwind CSS
- **Styling**: Tailwind CSS with CSS variables for theming (teal/emerald theme), custom fonts (DM Sans, Outfit)
- **Charts**: Recharts for data visualization (weight trends, step progress)
- **Animations**: Framer Motion for page transitions and interactions
- **Key Pages**:
  - `/` — Landing page (marketing)
  - `/dashboard` — Admin overview with stats, flagged users
  - `/users` — User list with search/filter
  - `/users/:id` — Individual user detail with charts
  - `/admin/test` — Admin test harness for simulating webhook flows

### Backend
- **Framework**: Express 5 on Node.js with TypeScript (run via tsx)
- **API Pattern**: REST API with a shared route contract (`shared/routes.ts`) that defines paths, methods, and Zod response schemas for type safety across client and server
- **AI Integration**: OpenAI API (via Replit AI Integrations proxy) for intent parsing and generating coaching replies. Uses `gpt-5.1` model for both intent classification and conversational responses
- **WhatsApp Webhook**: Receives incoming WhatsApp messages (Twilio-style `From`/`Body` format), parses user intent via AI, processes the action (log steps, weight, workout, etc.), and returns a response
- **Build**: Vite builds the client; esbuild bundles the server. Production serves static files from `dist/public`

### Database
- **Database**: PostgreSQL (required, referenced via `DATABASE_URL` environment variable)
- **ORM**: Drizzle ORM with `drizzle-zod` for schema-to-validation integration
- **Schema** (`shared/schema.ts`):
  - `users` — Core user table with phone number, fitness goals, subscription status, onboarding state, calorie/protein/step targets
  - `weight_logs` — Weight tracking entries per user
  - `workout_logs` — Workout completion tracking per user
  - `step_logs` — Daily step count logs per user
  - `weekly_checkins` — Weekly check-in responses
  - `chat_history` — Log of all WhatsApp conversations with intent classification
  - `conversations` / `messages` — Replit AI integration chat storage (separate from coaching chat)
- **Migrations**: Managed via `drizzle-kit push` (schema push approach, not migration files)
- **Connection**: Uses `pg` Pool with Drizzle wrapper

### Storage Layer
- `server/storage.ts` defines an `IStorage` interface with a `DatabaseStorage` implementation
- All database operations go through this storage abstraction
- Supports user CRUD, log creation/retrieval, weekly check-ins, chat logging, and flagged user queries

### Key Design Decisions
1. **Shared API Contract**: The `shared/routes.ts` file acts as a typed contract between frontend and backend, with Zod schemas for request/response validation. The `buildUrl` helper handles parameterized routes.
2. **Intent-Based WhatsApp Processing**: Messages are classified into intents (onboarding_answer, log_steps, log_workout, log_weight, weekly_checkin_response, hungry, general_question) before being processed, allowing structured data extraction from natural language.
3. **No Authentication (MVP)**: The admin dashboard currently has no auth — noted as a future concern in requirements. The landing page "Coach Login" link goes directly to the dashboard.
4. **UUID Primary Keys**: All main tables use UUID primary keys with `gen_random_uuid()`.

## External Dependencies

### Required Services
- **PostgreSQL Database**: Required. Connection via `DATABASE_URL` environment variable. Uses `connect-pg-simple` for session storage.
- **OpenAI API** (via Replit AI Integrations): Used for intent parsing and reply generation. Configured via `AI_INTEGRATIONS_OPENAI_API_KEY` and `AI_INTEGRATIONS_OPENAI_BASE_URL` environment variables.

### Expected Webhook Integrations
- **WhatsApp (Twilio)**: Incoming webhook at `/api/webhooks/whatsapp` expects `From` (phone number) and `Body` (message text) fields. Returns TwiML-style responses.
- **PayFast**: Payment webhook endpoint defined in route contract for subscription management (South African payment gateway).

### Replit Integrations
The project includes several Replit AI integration modules in `server/replit_integrations/` and `client/replit_integrations/`:
- **Chat**: Conversation storage and streaming chat routes
- **Audio**: Voice recording, playback, speech-to-text, and text-to-speech capabilities
- **Image**: Image generation via `gpt-image-1`
- **Batch**: Batch processing utilities with rate limiting and retries

### Key NPM Packages
- `drizzle-orm` / `drizzle-kit` — Database ORM and migration tooling
- `express` v5 — HTTP server
- `openai` — OpenAI API client
- `zod` / `drizzle-zod` — Schema validation
- `recharts` — Dashboard charts
- `framer-motion` — Animations
- `date-fns` — Date formatting
- `wouter` — Client-side routing
- `@tanstack/react-query` — Data fetching
- shadcn/ui ecosystem (Radix UI, class-variance-authority, tailwind-merge, clsx)