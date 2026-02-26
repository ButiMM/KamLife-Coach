import { useQuery } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import type { User, FlaggedUser } from "@shared/schema";

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
