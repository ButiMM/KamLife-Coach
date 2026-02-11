import { useQuery } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import type { User, DailyLog, FlaggedUser } from "@shared/schema";

// Helper to log validation errors but not crash app in production
function parseWithLogging<T>(schema: any, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error(`[Zod] ${label} validation failed:`, result.error.format());
    // For now, return data cast as T to allow UI to attempt render, 
    // but in strict mode we might want to throw
    return data as T;
  }
  return result.data;
}

export function useUsers() {
  return useQuery({
    queryKey: [api.users.list.path],
    queryFn: async () => {
      const res = await fetch(api.users.list.path);
      if (!res.ok) throw new Error("Failed to fetch users");
      const data = await res.json();
      return parseWithLogging<User[]>(api.users.list.responses[200], data, "users.list");
    },
  });
}

export function useUser(id: number) {
  return useQuery({
    queryKey: [api.users.get.path, id],
    queryFn: async () => {
      const url = buildUrl(api.users.get.path, { id });
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch user");
      const data = await res.json();
      return parseWithLogging<User>(api.users.get.responses[200], data, "users.get");
    },
    enabled: !!id && !isNaN(id),
  });
}

export function useUserLogs(id: number) {
  return useQuery({
    queryKey: [api.users.getLogs.path, id],
    queryFn: async () => {
      const url = buildUrl(api.users.getLogs.path, { id });
      const res = await fetch(url);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error("Failed to fetch logs");
      const data = await res.json();
      return parseWithLogging<DailyLog[]>(api.users.getLogs.responses[200], data, "users.getLogs");
    },
    enabled: !!id && !isNaN(id),
  });
}

export function useFlaggedUsers() {
  return useQuery({
    queryKey: [api.users.flagged.path],
    queryFn: async () => {
      const res = await fetch(api.users.flagged.path);
      if (!res.ok) throw new Error("Failed to fetch flagged users");
      const data = await res.json();
      return parseWithLogging<FlaggedUser[]>(api.users.flagged.responses[200], data, "users.flagged");
    },
  });
}
