import { useQuery } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import type { User, FlaggedUser, WeightLog } from "@shared/schema";
import { authHeaders } from "@/lib/queryClient";

export interface UserDetailResponse {
  user: User;
  weightLogs: WeightLog[];
  stepLogs: { steps: number; loggedAt: string }[];
  workoutLogs: { completed: boolean; loggedAt: string }[];
  chatHistory: { messageIn: string; messageOut: string; intent: string; createdAt: string }[];
}

function parseWithLogging<T>(schema: any, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error(`[Zod] ${label} validation failed:`, result.error.format());
    return data as T;
  }
  return result.data;
}

export function useUsers() {
  return useQuery({
    queryKey: [api.users.list.path],
    queryFn: async () => {
      const res = await fetch(`${api.users.list.path}?limit=100`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch users");
      const data = await res.json();
      // API now returns { users, pagination } — extract the array
      const arr = Array.isArray(data) ? data : (data.users ?? data);
      return arr as User[];
    },
  });
}

export function useUser(id: string) {
  return useQuery({
    queryKey: [api.users.get.path, id],
    queryFn: async () => {
      const url = buildUrl(api.users.get.path, { id });
      const res = await fetch(url, { headers: authHeaders() });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch user");
      return res.json() as Promise<UserDetailResponse>;
    },
    enabled: !!id && id.length > 0,
    refetchInterval: 30_000, // auto-refresh every 30s so coach sees live data
  });
}

export function useFlaggedUsers() {
  return useQuery({
    queryKey: [api.users.flagged.path],
    queryFn: async () => {
      const res = await fetch(api.users.flagged.path, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch flagged users");
      const data = await res.json();
      return parseWithLogging<FlaggedUser[]>(api.users.flagged.responses[200], data, "users.flagged");
    },
  });
}

export function useRevenue() {
  return useQuery({
    queryKey: ["/api/dashboard/revenue"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/revenue", { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch revenue");
      return res.json() as Promise<{
        computedAt: string;
        currency: string;
        pricePerUser: number;
        current: {
          mrr: number;
          mrrDisplay: string;
          arr: number;
          arrDisplay: string;
          payingUsers: number;
          trialUsers: number;
          cancelledUsers: number;
          totalUsers: number;
        };
        unitEconomics: {
          arpu: number;
          estimatedLTV: number;
          estimatedMonthlyChurn: number;
          estimatedCostPerUser: number;
          grossProfit: number;
          grossMargin: string;
        };
        rates: {
          trialConversion: string;
          trialConversionRaw: number;
        };
        forecast: {
          projectedNewPaying: number;
          projectedMRR: number;
          projectedMRRDisplay: string;
        };
      }>;
    },
    refetchInterval: 60_000,
  });
}

export function useFunnel() {
  return useQuery({
    queryKey: ["/api/dashboard/funnel"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/funnel", { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch funnel");
      return res.json() as Promise<{
        computedAt: string;
        funnel: {
          totalSignups: number;
          onboardingComplete: number;
          firstFoodLogged: number;
          firstWorkoutDone: number;
          activeWeek1: number;
          signupsWithWeek1Data: number;
        };
        subscriptions: {
          trial: number;
          paying: number;
          inactive: number;
          churned: number;
        };
        conversionRates: {
          signupToOnboard: number;
          onboardToFirstWorkout: number;
          firstWorkoutToWeek1: number;
          trialToPaid: number;
        };
        retention: {
          d1: { eligible: number; retained: number; rate: number };
          d7: { eligible: number; retained: number; rate: number };
          d30: { eligible: number; retained: number; rate: number };
        };
        engagement: {
          avgWorkoutsPerWeek: number;
          avgMessagesPerDay: number;
        };
      }>;
    },
    refetchInterval: 120_000,
  });
}

export function useMetrics() {
  return useQuery({
    queryKey: ["/api/dashboard/metrics"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/metrics", { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch metrics");
      return res.json() as Promise<{
        computedAt: string;
        activeClients: number;
        payingClients: number;
        trialClients: number;
        newThisWeek: number;
        churnedThisWeek: number;
        avgMessagesPerClientPerDay: number;
        estimatedMRR: number;
        currency: string;
        pricePerUser: number;
      }>;
    },
    refetchInterval: 60_000,
  });
}
