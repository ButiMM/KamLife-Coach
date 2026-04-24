import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { authHeaders } from "@/lib/queryClient";
import { format } from "date-fns";
import { Activity, RefreshCw, Camera, Mic, MessageSquare } from "lucide-react";

interface ObsRow {
  id: string;
  userId: string;
  intent: string | null;
  messageIn: string | null;
  messageOut: string | null;
  createdAt: string | null;
  phone: string;
  name: string | null;
  kcal: number | null;
  protein: number | null;
  source: string | null;
}

const INTENT_COLORS: Record<string, string> = {
  FOOD_LOG: "bg-emerald-100 text-emerald-800",
  WORKOUT_LOG: "bg-violet-100 text-violet-800",
  STEPS: "bg-blue-100 text-blue-800",
  WEIGHT: "bg-amber-100 text-amber-800",
  QUESTION: "bg-sky-100 text-sky-800",
  RANT: "bg-red-100 text-red-800",
  GREETING: "bg-gray-100 text-gray-700",
  MENU_REQUEST: "bg-orange-100 text-orange-800",
  OTHER: "bg-gray-100 text-gray-600",
};

export default function Observability() {
  const [limit, setLimit] = useState(100);
  const [intentFilter, setIntentFilter] = useState<string>("all");

  const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["/api/dashboard/observability", limit],
    queryFn: async () => {
      const res = await fetch(`/api/dashboard/observability?limit=${limit}`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json() as Promise<{ rows: ObsRow[]; fetchedAt: string }>;
    },
    refetchInterval: 30_000,
  });

  const rows = (data?.rows ?? []).filter(r =>
    intentFilter === "all" || r.intent === intentFilter
  );

  const intentCounts = (data?.rows ?? []).reduce<Record<string, number>>((acc, r) => {
    const k = r.intent || "OTHER";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const foodRows = rows.filter(r => r.intent === "FOOD_LOG");
  const avgKcal = foodRows.length > 0
    ? Math.round(foodRows.reduce((s, r) => s + (r.kcal ?? 0), 0) / foodRows.filter(r => r.kcal).length || 1)
    : 0;
  const noKcalCount = foodRows.filter(r => !r.kcal || r.kcal === 0).length;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display tracking-tight flex items-center gap-2">
              <Activity className="w-7 h-7 text-primary" />
              Message Feed
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Live bot exchanges — intent, kcal/protein, raw messages.
              {dataUpdatedAt ? ` Last refreshed ${format(new Date(dataUpdatedAt), "HH:mm:ss")}` : ""}
            </p>
          </div>
          <div className="flex gap-2">
            <select
              value={limit}
              onChange={e => setLimit(parseInt(e.target.value))}
              className="text-sm border border-border rounded-lg px-3 py-1.5 bg-card"
            >
              <option value={50}>Last 50</option>
              <option value={100}>Last 100</option>
              <option value={250}>Last 250</option>
              <option value={500}>Last 500</option>
            </select>
            <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5">
              <RefreshCw className="w-4 h-4" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Summary cards */}
        {data && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="p-4 border-border/50">
              <p className="text-xs text-muted-foreground font-medium mb-1">Total messages</p>
              <p className="text-2xl font-bold font-display">{data.rows.length}</p>
            </Card>
            <Card className="p-4 border-border/50">
              <p className="text-xs text-muted-foreground font-medium mb-1">Food logs</p>
              <p className="text-2xl font-bold font-display text-emerald-600">{intentCounts["FOOD_LOG"] || 0}</p>
              {noKcalCount > 0 && <p className="text-xs text-destructive mt-0.5">{noKcalCount} missing kcal</p>}
            </Card>
            <Card className="p-4 border-border/50">
              <p className="text-xs text-muted-foreground font-medium mb-1">Avg kcal per meal</p>
              <p className="text-2xl font-bold font-display">{avgKcal || "-"}</p>
            </Card>
            <Card className="p-4 border-border/50">
              <p className="text-xs text-muted-foreground font-medium mb-1">Workout logs</p>
              <p className="text-2xl font-bold font-display text-violet-600">{intentCounts["WORKOUT_LOG"] || 0}</p>
            </Card>
          </div>
        )}

        {/* Intent filter pills */}
        <div className="flex flex-wrap gap-2">
          {["all", "FOOD_LOG", "WORKOUT_LOG", "STEPS", "WEIGHT", "QUESTION", "RANT", "OTHER"].map(intent => (
            <button
              key={intent}
              onClick={() => setIntentFilter(intent)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                intentFilter === intent
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border bg-card hover:bg-muted"
              }`}
            >
              {intent === "all" ? "All" : intent}
              {intent !== "all" && intentCounts[intent] ? ` (${intentCounts[intent]})` : ""}
            </button>
          ))}
        </div>

        {/* Message feed */}
        <Card className="p-0 border-border/50 overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading feed...</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No messages found</div>
          ) : (
            <div className="divide-y divide-border/50 max-h-[700px] overflow-y-auto">
              {rows.map((row) => {
                const intentColor = INTENT_COLORS[row.intent || "OTHER"] || INTENT_COLORS.OTHER;
                const isPhoto = row.messageIn === "[Photo]" || row.source === "photo";
                const isVoice = row.source === "voice";
                return (
                  <div key={row.id} className="px-4 py-3 hover:bg-secondary/30 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        {/* Source icon */}
                        <div className="shrink-0 mt-0.5 text-muted-foreground">
                          {isPhoto ? <Camera className="w-4 h-4" /> : isVoice ? <Mic className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          {/* User + intent + time */}
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="text-xs font-semibold">{row.name || row.phone}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${intentColor}`}>{row.intent || "?"}</span>
                            {row.source && row.intent === "FOOD_LOG" && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{row.source}</span>
                            )}
                            <span className="text-xs text-muted-foreground ml-auto shrink-0">
                              {row.createdAt ? format(new Date(row.createdAt), "MMM d HH:mm") : "-"}
                            </span>
                          </div>
                          {/* Message in */}
                          <p className="text-sm text-foreground truncate font-medium">
                            {row.messageIn ? row.messageIn.slice(0, 120) : "(media)"}
                          </p>
                          {/* Bot reply preview */}
                          {row.messageOut && (
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">
                              ↳ {row.messageOut.slice(0, 100).replace(/\*/g, "")}
                            </p>
                          )}
                        </div>
                      </div>
                      {/* Kcal/protein badges for food logs */}
                      {row.intent === "FOOD_LOG" && (
                        <div className="shrink-0 flex gap-2 items-center">
                          {row.kcal != null && row.kcal > 0 ? (
                            <span className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                              {row.kcal} kcal
                            </span>
                          ) : (
                            <span className="text-xs text-destructive bg-destructive/10 px-2 py-0.5 rounded-full">no kcal</span>
                          )}
                          {row.protein != null && row.protein > 0 && (
                            <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                              {row.protein}g
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </DashboardLayout>
  );
}
