import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import type { User, FlaggedUser, WeightLog } from "@shared/schema";
import { authHeaders } from "@/lib/queryClient";

export interface MealLogEntry {
  id: string;
  loggedAt: string;
  rawMessage: string | null;
  source: string;
  kcalInt: number;
  proteinInt: number;
  carbsInt: number;
  fatInt: number;
  mealLabel: string | null;
  items: Array<{ name: string; kcal: number; protein: number }> | null;
}

export interface ClientAction {
  id: number;
  userId: string;
  content: string;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

export interface TimelineEvent {
  date: string;
  type: "weight" | "steps" | "workout" | "food" | "escalation" | "chat";
  detail: string;
  meta?: Record<string, unknown>;
}

export interface ProgressPhotoEntry {
  id: string;
  photoNumber: number;
  contentType: string;
  loggedAt: string;
}

export interface UserDetailResponse {
  user: User;
  weightLogs: WeightLog[];
  stepLogs: { steps: number; loggedAt: string }[];
  workoutLogs: { completed: boolean; loggedAt: string }[];
  chatHistory: { messageIn: string; messageOut: string; intent: string; createdAt: string }[];
  mealLogs: MealLogEntry[];
  actions: ClientAction[];
  progressPhotos: ProgressPhotoEntry[];
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

export function useCohorts() {
  return useQuery({
    queryKey: ["/api/dashboard/cohorts"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/cohorts", { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch cohorts");
      return res.json() as Promise<{
        cohorts: Array<{
          month: string;
          signups: number;
          onboarded: number;
          paying: number;
          onboardRate: number;
          payRate: number;
          week1RetentionRate: number;
          week2RetentionRate: number;
          retentionRate: number;
          avgWorkouts: number;
        }>;
      }>;
    },
    refetchInterval: 300_000,
  });
}

export interface NextAction {
  phone: string;
  name: string;
  action: string;
  priority: "urgent" | "high" | "medium" | "low";
  category: string;
}

export function useNextActions() {
  return useQuery({
    queryKey: ["/api/dashboard/next-actions"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/next-actions", { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch next actions");
      return res.json() as Promise<{ actions: NextAction[]; total: number }>;
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

export function useClientTimeline(userId: string) {
  return useQuery({
    queryKey: [`/api/users/${userId}/timeline`],
    queryFn: async () => {
      const res = await fetch(`/api/users/${userId}/timeline`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch timeline");
      return res.json() as Promise<{ events: TimelineEvent[] }>;
    },
    enabled: !!userId,
    refetchInterval: 60_000,
  });
}

export function useUploadProgressPhoto(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch(`/api/users/${userId}/progress-photos`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ base64, contentType: file.type || "image/jpeg" }),
      });
      if (res.status === 413) throw new Error("Image must be under 8MB");
      if (!res.ok) throw new Error("Upload failed");
      return res.json() as Promise<{ photo: ProgressPhotoEntry }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/users/", userId] });
    },
  });
}

export function useProgressPhotoUrl(userId: string, photoId: string) {
  return useQuery({
    queryKey: [`/api/users/${userId}/progress-photos/${photoId}`],
    queryFn: async () => {
      const res = await fetch(`/api/users/${userId}/progress-photos/${photoId}`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch photo");
      const data = await res.json() as { photo: { photoBase64: string; contentType: string } };
      return `data:${data.photo.contentType};base64,${data.photo.photoBase64}`;
    },
    enabled: !!photoId,
    staleTime: Infinity,
  });
}
