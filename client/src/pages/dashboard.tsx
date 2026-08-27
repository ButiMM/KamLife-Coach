import { useState } from "react";
import { useUsers, useFlaggedUsers, useMetrics, useNextActions } from "@/hooks/use-users";
import { DashboardLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/status-badge";
import { Users, UserX, Activity, TrendingUp, AlertCircle, ArrowRight, DollarSign, UserPlus } from "lucide-react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authHeaders, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PRICING } from "@shared/pricing";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function Dashboard() {
  const { data: users, isLoading: usersLoading } = useUsers();
  const { data: flaggedUsers, isLoading: flaggedLoading } = useFlaggedUsers();
  const { data: metrics } = useMetrics();
  const { data: nextActionsData } = useNextActions();
  const [flagFilter, setFlagFilter] = useState<"all" | "inactive_7_days" | "plateau_2_weeks">("all");
  const [flagSort, setFlagSort] = useState<"lastActive" | "name">("lastActive");
  const [broadcastMsg, setBroadcastMsg] = useState("");
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastPending, setBroadcastPending] = useState(false);
  const { toast } = useToast();

  const broadcastMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await apiRequest("POST", "/api/dashboard/broadcast", { message, filter: "active" });
      return res.json();
    },
    onSuccess: (data) => {
      setBroadcastMsg("");
      setBroadcastOpen(false);
      setBroadcastPending(false);
      toast({ title: "Broadcast sent", description: `Delivered to ${data.sent ?? "?"} clients` });
    },
    onError: () => {
      setBroadcastPending(false);
      toast({ title: "Broadcast failed", description: "Check Twilio config", variant: "destructive" });
    },
  });

  // Live health check — polls every 60s
  const { data: health } = useQuery({
    queryKey: ["/api/health"],
    queryFn: async () => {
      const res = await fetch("/api/health", { headers: authHeaders() });
      if (!res.ok) return null;
      return res.json() as Promise<{ status: string; checks: Record<string, { status: string }> }>;
    },
    refetchInterval: 60_000,
    retry: false,
  });

  const totalUsers = users?.length || 0;
  const activeUsers = users?.filter(u => u.subscriptionStatus === 'active').length || 0;
  const trialUsers = metrics?.trialClients ?? users?.filter(u => u.subscriptionStatus === 'trial').length ?? 0;
  const mrr = metrics?.estimatedMRR ?? (activeUsers * (metrics?.pricePerUser ?? PRICING.monthlyPriceZAR));

  const displayedFlagged = (flaggedUsers || [])
    .filter(u => flagFilter === "all" || u.flagReason === flagFilter)
    .sort((a, b) => {
      if (flagSort === "name") return (a.name || "").localeCompare(b.name || "");
      const aDate = a.lastLogDate ? new Date(a.lastLogDate).getTime() : 0;
      const bDate = b.lastLogDate ? new Date(b.lastLogDate).getTime() : 0;
      return aDate - bDate; // oldest activity first
    });

  if (usersLoading) return <DashboardLoading />;

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display tracking-tight">Dashboard</h2>
            <p className="text-muted-foreground mt-1">Overview of your coaching business</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="flex gap-2 text-sm text-muted-foreground bg-white dark:bg-card px-4 py-2 rounded-full border border-border shadow-sm">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse my-auto"></span>
              System Online
            </div>
            {metrics?.computedAt && (
              <span className="text-xs text-muted-foreground">
                Data as of {new Date(metrics.computedAt).toLocaleTimeString("en-ZA", { timeZone: "Africa/Johannesburg" })}
              </span>
            )}
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6">
          <StatCard
            title="Total Users"
            value={totalUsers}
            icon={Users}
            trend={metrics ? `+${metrics.newThisWeek} this week` : "All time"}
            color="text-blue-600 bg-blue-100 dark:bg-blue-900/20"
          />
          <StatCard
            title="Active Subs"
            value={activeUsers}
            icon={Activity}
            trend="Paying clients"
            color="text-emerald-600 bg-emerald-100 dark:bg-emerald-900/20"
          />
          <StatCard
            title="Est. MRR"
            value={`R${mrr.toLocaleString()}`}
            icon={DollarSign}
            trend={`${metrics?.payingClients ?? activeUsers} paying × R199`}
            color="text-green-600 bg-green-100 dark:bg-green-900/20"
          />
          <StatCard
            title="New This Week"
            value={metrics?.newThisWeek ?? "—"}
            icon={UserPlus}
            trend="Just joined"
            color="text-indigo-600 bg-indigo-100 dark:bg-indigo-900/20"
          />
          <StatCard
            title="On Trial"
            value={trialUsers}
            icon={TrendingUp}
            trend="Need converting"
            color="text-amber-600 bg-amber-100 dark:bg-amber-900/20"
          />
          <StatCard
            title="Flagged"
            value={flaggedUsers?.length || 0}
            icon={AlertCircle}
            trend="Needs attention"
            color="text-rose-600 bg-rose-100 dark:bg-rose-900/20"
          />
        </div>

        {/* Coach Health — adjudicated failures, counted from the turns we already record */}
        <CoachHealth />

        {/* Scaling Radar — milestone playbook with approach alerts */}
        <ScalingRadar />

        {/* Pinned Next Actions */}
        {nextActionsData && nextActionsData.actions.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold font-display">📌 Next Actions <span className="text-base font-normal text-muted-foreground ml-2">({nextActionsData.total} total)</span></h3>
            </div>
            <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
              <div className="divide-y divide-border">
                {nextActionsData.actions.slice(0, 8).map((item, i) => {
                  const priorityColor = item.priority === "urgent" ? "text-red-600 bg-red-50 border-red-200" : item.priority === "high" ? "text-orange-600 bg-orange-50 border-orange-200" : item.priority === "medium" ? "text-amber-600 bg-amber-50 border-amber-200" : "text-blue-600 bg-blue-50 border-blue-200";
                  return (
                    <div key={i} className="flex items-center gap-4 p-4 hover:bg-muted/20 transition-colors">
                      <span className={`text-xs font-bold px-2 py-1 rounded-full border shrink-0 ${priorityColor}`}>{item.priority.toUpperCase()}</span>
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-sm">{item.name}</span>
                        <span className="text-sm text-muted-foreground ml-2">{item.action}</span>
                      </div>
                      <span className="text-xs text-muted-foreground bg-secondary px-2 py-1 rounded shrink-0">{item.category}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Flagged Users List - Takes up 2 cols */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-xl font-bold font-display">Attention Required</h3>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Filter buttons */}
                {(["all", "inactive_7_days", "plateau_2_weeks"] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setFlagFilter(f)}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${flagFilter === f ? "bg-primary text-white border-primary" : "border-border bg-card hover:bg-muted"}`}
                  >
                    {f === "all" ? "All" : f === "inactive_7_days" ? "Inactive 7d" : "Plateau"}
                  </button>
                ))}
                <select
                  value={flagSort}
                  onChange={e => setFlagSort(e.target.value as "lastActive" | "name")}
                  className="text-xs px-2 py-1.5 rounded-lg border border-border bg-card"
                >
                  <option value="lastActive">Sort: Least Active</option>
                  <option value="name">Sort: Name</option>
                </select>
              </div>
            </div>

            <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
              {flaggedLoading ? (
                <div className="p-8 text-center text-muted-foreground">Loading flagged users...</div>
              ) : displayedFlagged.length > 0 ? (
                <div className="divide-y divide-border">
                  {displayedFlagged.map((user) => (
                    <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        key={user.id} 
                        className="p-4 sm:p-6 hover:bg-muted/30 transition-colors flex items-center justify-between group"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center font-bold">
                          {user.name?.[0] || "?"}
                        </div>
                        <div>
                          <h4 className="font-semibold text-foreground">{user.name || "Unknown User"}</h4>
                          <p className="text-sm text-rose-600 font-medium mt-0.5">
                            {user.flagReason === 'inactive_7_days' ? 'Inactive > 7 Days' : 'Weight Plateau (2 Weeks)'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-sm text-muted-foreground hidden sm:block">
                            Last active: {user.lastLogDate ? new Date(user.lastLogDate).toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg" }) : 'Never'}
                        </span>
                        <Link href={`/users/${user.id}`}>
                            <Button size="sm" variant="secondary" className="group-hover:bg-primary group-hover:text-white transition-colors">
                                Review
                            </Button>
                        </Link>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="p-12 text-center">
                    <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
                        <CheckCircle className="w-8 h-8" />
                    </div>
                    <h3 className="text-lg font-semibold">All Clear!</h3>
                    <p className="text-muted-foreground">No users flagged for attention right now.</p>
                </div>
              )}
            </div>
          </div>

          {/* Quick Actions / Recent Activity - Takes up 1 col */}
          <div className="space-y-6">
            <h3 className="text-xl font-bold font-display">Quick Actions</h3>
            <div className="grid gap-4">
                {/* Broadcast compose */}
                <div className="bg-card rounded-2xl border border-border p-4 shadow-sm space-y-3">
                  <h4 className="font-semibold text-sm flex items-center gap-2">
                    <MessageCircle className="w-4 h-4 text-primary" /> Broadcast Message
                  </h4>
                  <Textarea
                    placeholder="Type a message to send to all active clients..."
                    value={broadcastMsg}
                    onChange={e => setBroadcastMsg(e.target.value)}
                    className="resize-none min-h-[80px] text-sm"
                  />
                  <Button
                    className="w-full"
                    disabled={!broadcastMsg.trim() || broadcastMutation.isPending}
                    onClick={() => setBroadcastPending(true)}
                  >
                    {broadcastMutation.isPending ? "Sending..." : `Send to ${metrics?.payingClients ?? activeUsers} active clients`}
                  </Button>
                </div>
                
                <div className="bg-card rounded-2xl border border-border p-6 shadow-sm">
                    <h4 className="font-semibold mb-4 text-sm text-muted-foreground uppercase tracking-wider">System Status</h4>
                    <div className="space-y-4">
                        <StatusRow label="WhatsApp API" status={health?.checks?.whatsapp?.status === "online" ? "online" : health ? "offline" : "idle"} />
                        <StatusRow label="OpenAI GPT-4" status={health?.checks?.openai?.status === "online" ? "online" : health ? "offline" : "idle"} />
                        <StatusRow label="PayFast Payments" status={health?.checks?.payfast?.status === "online" ? "online" : health ? "offline" : "idle"} />
                        <StatusRow label="Database" status={health?.checks?.database?.status === "online" ? "online" : health ? "offline" : "idle"} />
                    </div>
                    {health && <p className="text-xs text-muted-foreground mt-3">Last checked: {new Date().toLocaleTimeString("en-ZA", { timeZone: "Africa/Johannesburg" })}</p>}
                </div>
            </div>
          </div>
        </div>
      </div>

      {/* Broadcast confirmation dialog */}
      <AlertDialog open={broadcastPending} onOpenChange={open => { if (!open) setBroadcastPending(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send broadcast to all active clients?</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap break-words">
              "{broadcastMsg}"
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => broadcastMutation.mutate(broadcastMsg)}>
              Send via WhatsApp
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}

import { CheckCircle, MessageCircle } from "lucide-react";

function StatCard({ title, value, icon: Icon, trend, color }: any) {
  return (
    <Card className="p-6 border-border/50 shadow-sm hover:shadow-md transition-all duration-300">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <h3 className="text-3xl font-bold font-display mt-1">{value}</h3>
        </div>
        <div className={`p-3 rounded-xl ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
      <p className="text-xs font-medium text-muted-foreground bg-secondary/50 py-1 px-2 rounded inline-block">
        {trend}
      </p>
    </Card>
  );
}

function StatusRow({ label, status }: { label: string, status: 'online' | 'offline' | 'idle' }) {
    const color = status === 'online' ? 'bg-emerald-500' : status === 'idle' ? 'bg-amber-500' : 'bg-rose-500';
    return (
        <div className="flex items-center justify-between">
            <span className="font-medium text-sm">{label}</span>
            <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${color}`}></span>
                <span className="text-xs text-muted-foreground capitalize">{status}</span>
            </div>
        </div>
    )
}

function DashboardLoading() {
    return (
        <DashboardLayout>
            <div className="space-y-8 animate-pulse">
                <div className="h-8 bg-muted rounded w-1/4"></div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    {[1,2,3,4].map(i => <div key={i} className="h-32 bg-muted rounded-2xl"></div>)}
                </div>
                <div className="h-96 bg-muted rounded-2xl"></div>
            </div>
        </DashboardLayout>
    )
}

// ── Coach Health ────────────────────────────────────────────────────────────────
// THE FOUNDER STOPS BEING THE SENSOR (2026-08-27).
//
// Every defect this product has fixed arrived the same way: Kam saw it on his own phone,
// screenshotted it, and explained it. That makes one person's attention the limit of what the
// product can discover about itself. turn_ledger has recorded the mechanism of every turn since
// 2026-08-10 and the triage page could already read it — but only a HUMAN verdict put a turn in
// the queue, so nothing was ever found that nobody looked at.
//
// This section counts the failures we have ALREADY adjudicated, against real turns. No model
// judges anything: each rule is the same property its cut's contract test asserts, pointed at
// production instead of a fixture. A non-zero count is therefore not a new discovery — it is a
// merged fix that is not holding, which is the more valuable signal.
//
// ASKED is shown next to FAILED on purpose. A rule at 0/0 has not been exercised in this window,
// which is a different statement from "this failure is not happening", and the difference is
// exactly where a dashboard starts lying. Data: /api/admin/coach-health.
interface CoachHealthPayload {
  windowDays: number;
  turns: number;
  flagged: number;
  unresolved: number;
  historical: number;
  attribution: string;
  clusters: Array<{
    id: string; label: string; layer: string; fixRef: string; expected: string;
    fixedAt: string; trigger: "request" | "mutation";
    occurrences: number; historical: number; clients: number; candidates: number;
    examples: Array<{ turnId: string; at: string; version: string | null; input: string; reply: string; status: string | null }>;
    historicalExamples: Array<{ turnId: string; at: string; version: string | null; input: string; reply: string; status: string | null }>;
  }>;
  cannotSurface: Array<{ id: string; fixRef: string; why: string }>;
}

const LAYER_CHIP: Record<string, string> = {
  Claim: "bg-amber-100 text-amber-700 border-amber-200",
  Decision: "bg-blue-100 text-blue-700 border-blue-200",
  Response: "bg-violet-100 text-violet-700 border-violet-200",
  Coaching: "bg-emerald-100 text-emerald-700 border-emerald-200",
};

function CoachHealth() {
  const [open, setOpen] = useState<string | null>(null);
  const [days, setDays] = useState(1);
  const { data } = useQuery({
    queryKey: ["/api/admin/coach-health", days],
    queryFn: async () => {
      const res = await fetch(`/api/admin/coach-health?days=${days}`, { headers: authHeaders() });
      if (!res.ok) return null;
      return res.json() as Promise<CoachHealthPayload>;
    },
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  if (!data) return null;

  return (
    <Card className="p-6 border-border/50">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
        <div>
          <h3 className="text-xl font-bold font-display">🩺 Coach Health</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {data.turns.toLocaleString()} turns · {data.flagged} regression
            {data.flagged === 1 ? "" : "s"} since fix · {data.historical} historical
          </p>
        </div>
        <div className="flex gap-1">
          {[1, 7, 30].map(d => (
            <Button
              key={d}
              variant={days === d ? "default" : "outline"}
              size="sm"
              onClick={() => setDays(d)}
            >
              {d === 1 ? "Today" : `${d}d`}
            </Button>
          ))}
        </div>
      </div>

      {data.flagged === 0 && (
        <div className="text-sm text-muted-foreground mb-4 p-3 rounded-md bg-muted/40">
          No adjudicated failure has recurred since its fix merged. A rule whose denominator is
          <strong> 0</strong> below was not exercised at all in this window — that is untested,
          not proven healthy.
        </div>
      )}

      <div className="space-y-2">
        {data.clusters.map(c => (
          <div key={c.id} className="border rounded-lg overflow-hidden">
            <button
              className="w-full flex items-center justify-between gap-3 p-3 text-left hover:bg-muted/40"
              onClick={() => setOpen(open === c.id ? null : c.id)}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className={`text-xs px-2 py-0.5 rounded border ${LAYER_CHIP[c.layer] || ""}`}>
                  {c.layer}
                </span>
                <span className="font-medium truncate">{c.label}</span>
                <span className="text-xs text-muted-foreground shrink-0">{c.fixRef}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`text-sm font-bold ${c.occurrences > 0 ? "text-rose-600" : "text-muted-foreground"}`}>
                  {c.occurrences}
                </span>
                <span className="text-xs text-muted-foreground">
                  {c.trigger === "request"
                    ? `of ${c.candidates} matching request${c.candidates === 1 ? "" : "s"}`
                    : `${c.candidates} turn${c.candidates === 1 ? "" : "s"} scanned`}
                  {c.clients > 0 ? ` · ${c.clients} client${c.clients === 1 ? "" : "s"}` : ""}
                  {c.historical > 0 ? ` · ${c.historical} before the fix` : ""}
                </span>
              </div>
            </button>

            {open === c.id && (
              <div className="border-t p-3 bg-muted/20 text-sm space-y-3">
                <p className="text-muted-foreground">Expected: {c.expected}</p>
                <p className="text-muted-foreground text-xs">
                  Fixed {new Date(c.fixedAt).toLocaleString("en-ZA")} ({c.fixRef}). Turns before that
                  are the failure we corrected, not a regression — they are counted separately.
                </p>
                {c.examples.length === 0 ? (
                  <p className="text-muted-foreground italic">
                    {c.candidates === 0
                      ? "Not exercised in this window — nothing matched this rule at all."
                      : "Exercised, and answered correctly every time since the fix."}
                  </p>
                ) : c.examples.map(ex => (
                  <div key={ex.turnId} className="border rounded p-2 bg-background">
                    <div className="text-xs text-muted-foreground mb-1">
                      {new Date(ex.at).toLocaleString("en-ZA")} · build {ex.version || "?"}
                      {ex.status ? ` · ${ex.status}` : ""}
                    </div>
                    <div className="font-mono text-xs">“{ex.input}”</div>
                    <div className="font-mono text-xs text-rose-700 mt-1">→ {ex.reply}</div>
                    <a
                      className="text-xs text-blue-600 hover:underline mt-1 inline-block"
                      href={`/admin/turns?turn=${ex.turnId}`}
                    >
                      Open the turn →
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {data.cannotSurface.length > 0 && (
        <div className="mt-4 pt-3 border-t text-xs text-muted-foreground">
          <strong>Not measurable here:</strong>{" "}
          {data.cannotSurface.map(c => `${c.fixRef} — ${c.why}`).join(" · ")}
        </div>
      )}
    </Card>
  );
}

// ── Scaling Radar ───────────────────────────────────────────────────────────────
// Every client-count milestone that affects margins, infrastructure, compliance
// or team gets a playbook — and an ALERT state from 80% of the threshold, so the
// founder acts BEFORE the mark hits, never after. Data: /api/admin/scaling.
interface ScalingPayload {
  activeClients: number;
  messages24h: number;
  gptMonthZar: number;
  gptPerClientZar: number;
  config: { dbPoolMax: number; sendRatePerSec: number; proactivePaused: boolean };
  milestones: Array<{
    clients: number; title: string; mrrZar: number; why: string;
    status: "passed" | "approaching" | "upcoming"; progressPct: number;
    actions: Array<{ owner: "you" | "claude" | "together"; action: string }>;
  }>;
}

const OWNER_CHIP: Record<string, string> = {
  you: "bg-orange-100 text-orange-700 border-orange-200",
  claude: "bg-blue-100 text-blue-700 border-blue-200",
  together: "bg-violet-100 text-violet-700 border-violet-200",
};

function ScalingRadar() {
  const [expanded, setExpanded] = useState<number | null>(null);
  const { data } = useQuery({
    queryKey: ["/api/admin/scaling"],
    queryFn: async () => {
      const res = await fetch("/api/admin/scaling", { headers: authHeaders() });
      if (!res.ok) return null;
      return res.json() as Promise<ScalingPayload>;
    },
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  if (!data) return null;
  const next = data.milestones.find(mm => mm.status !== "passed");
  const approaching = data.milestones.filter(mm => mm.status === "approaching");

  return (
    <Card className="p-6 border-border/50">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
        <div>
          <h3 className="text-xl font-bold font-display">📡 Scaling Radar</h3>
          <p className="text-sm text-muted-foreground">What must change at every growth mark — before it hits</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="px-2.5 py-1 rounded-full bg-secondary border border-border/50">GPT this month: <b>R{data.gptMonthZar.toLocaleString()}</b>{data.activeClients > 0 && <> · R{data.gptPerClientZar}/client</>}</span>
          <span className="px-2.5 py-1 rounded-full bg-secondary border border-border/50">Msgs 24h: <b>{data.messages24h.toLocaleString()}</b></span>
          <span className="px-2.5 py-1 rounded-full bg-secondary border border-border/50">Pool {data.config.dbPoolMax} · Send {data.config.sendRatePerSec}/s</span>
          <span className={`px-2.5 py-1 rounded-full border ${data.config.proactivePaused ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>
            Proactive {data.config.proactivePaused ? "PAUSED" : "ON"}
          </span>
        </div>
      </div>

      {/* Approach alerts — the whole point of this card */}
      {approaching.map(mm => (
        <div key={`alert-${mm.clients}`} className="mb-4 p-4 rounded-xl border-2 border-amber-400 bg-amber-50">
          <p className="font-bold text-amber-800 text-sm mb-2">🚨 APPROACHING {mm.clients.toLocaleString()} CLIENTS ({mm.progressPct}%) — act now, not at the mark:</p>
          <ul className="space-y-1.5">
            {mm.actions.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-amber-900">
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${OWNER_CHIP[a.owner]}`}>{a.owner}</span>
                <span>{a.action}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {/* Progress to next mark */}
      {next && (
        <div className="mb-5">
          <div className="flex justify-between text-sm mb-1.5">
            <span className="font-semibold">{data.activeClients.toLocaleString()} active clients</span>
            <span className="text-muted-foreground">next mark: <b className="text-foreground">{next.clients.toLocaleString()}</b> ({next.title} · R{next.mrrZar.toLocaleString()} MRR)</span>
          </div>
          <div className="h-2.5 rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full transition-all ${next.status === "approaching" ? "bg-amber-500" : "bg-primary"}`} style={{ width: `${next.progressPct}%` }} />
          </div>
        </div>
      )}

      {/* Full milestone ladder */}
      <div className="space-y-1.5">
        {data.milestones.map(mm => (
          <div key={mm.clients} className={`rounded-xl border ${mm.status === "approaching" ? "border-amber-300 bg-amber-50/50" : mm.status === "passed" ? "border-emerald-200 bg-emerald-50/40" : "border-border/50 bg-secondary/30"}`}>
            <button className="w-full flex items-center justify-between px-4 py-2.5 text-left" onClick={() => setExpanded(expanded === mm.clients ? null : mm.clients)}>
              <span className="flex items-center gap-3 text-sm">
                <span className="font-bold tabular-nums w-20">{mm.clients.toLocaleString()}</span>
                <span className="font-medium">{mm.title}</span>
                <span className="text-xs text-muted-foreground hidden sm:inline">R{mm.mrrZar.toLocaleString()} MRR</span>
              </span>
              <span className="flex items-center gap-2 text-xs shrink-0">
                {mm.status === "passed" ? <span className="text-emerald-600 font-semibold">✓ passed</span>
                  : mm.status === "approaching" ? <span className="text-amber-600 font-bold">{mm.progressPct}% — approaching</span>
                  : <span className="text-muted-foreground">{mm.progressPct}%</span>}
              </span>
            </button>
            {expanded === mm.clients && (
              <div className="px-4 pb-3">
                <p className="text-xs text-muted-foreground italic mb-2">{mm.why}</p>
                <ul className="space-y-1.5">
                  {mm.actions.map((a, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${OWNER_CHIP[a.owner]}`}>{a.owner}</span>
                      <span>{a.action}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
