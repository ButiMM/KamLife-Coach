import { z } from 'zod';
import { insertUserSchema, users, weightLogs, workoutLogs, stepLogs, weeklyCheckins } from './schema';

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
    flagged: {
        method: 'GET' as const,
        path: '/api/admin/flagged' as const,
        responses: {
            200: z.array(z.custom<any>()),
        }
    },
    betaTesters: {
      method: 'GET' as const,
      path: '/api/admin/beta-testers' as const,
      responses: {
        200: z.array(z.custom<typeof users.$inferSelect>()),
      }
    }
  },
  webhooks: {
    whatsapp: {
        method: 'POST' as const,
        path: '/api/webhooks/whatsapp' as const,
        input: z.any(),
        responses: {
            200: z.string(),
        }
    },
    payfast: {
        method: 'POST' as const,
        path: '/api/webhooks/payfast' as const,
        input: z.any(),
        responses: {
            200: z.void(),
        }
    }
  },
  admin: {
    runTest: {
      method: 'POST' as const,
      path: '/api/admin/run-test' as const,
      input: z.object({
        testId: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
        liveMode: z.boolean().default(false)
      }),
      responses: {
        200: z.object({
          success: z.boolean(),
          logs: z.array(z.string()),
          dbChanges: z.any(),
          whatsappSent: z.string().optional()
        })
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
