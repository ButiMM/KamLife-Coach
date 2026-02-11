import { z } from 'zod';
import { insertUserSchema, insertDailyLogSchema, users, dailyLogs, weeklyCheckins } from './schema';

// ============================================
// SHARED ERROR SCHEMAS
// ============================================
export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

// ============================================
// API CONTRACT
// ============================================
export const api = {
  users: {
    list: {
      method: 'GET' as const,
      path: '/api/users' as const,
      responses: {
        200: z.array(z.custom<typeof users.$inferSelect>()),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/users/:id' as const,
      responses: {
        200: z.custom<typeof users.$inferSelect>(),
        404: errorSchemas.notFound,
      },
    },
    getLogs: {
        method: 'GET' as const,
        path: '/api/users/:id/logs' as const,
        responses: {
            200: z.array(z.custom<typeof dailyLogs.$inferSelect>()),
            404: errorSchemas.notFound,
        }
    },
    flagged: {
        method: 'GET' as const,
        path: '/api/admin/flagged' as const,
        responses: {
            200: z.array(z.custom<any>()), // Should be FlaggedUser but using custom for simplicity with extended types
        }
    }
  },
  webhooks: {
    whatsapp: {
        method: 'POST' as const,
        path: '/api/webhooks/whatsapp' as const,
        input: z.any(), // Twilio payload
        responses: {
            200: z.string(), // TwiML
        }
    },
    payfast: {
        method: 'POST' as const,
        path: '/api/webhooks/payfast' as const,
        input: z.any(), // PayFast payload
        responses: {
            200: z.void(),
        }
    }
  }
};

// ============================================
// REQUIRED: buildUrl helper
// ============================================
export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
