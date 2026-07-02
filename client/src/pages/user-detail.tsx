import { useState } from "react";
import { useUser, useClientTimeline, useUploadProgressPhoto, useProgressPhotoUrl, type ClientAction, type ProgressPhotoEntry } from "@/hooks/use-users";
import { DashboardLayout } from "@/components/layout";
import { StatusBadge } from "@/components/status-badge";
import { useRoute } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { format, formatDistanceToNow } from "date-fns";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Dumbbell, Footprints, Scale, Calendar, User as UserIcon, Send, AlertTriangle, Trophy, MessageSquare, UtensilsCrossed, Camera, Mic, ClipboardList, Check, Trash2, Plus, Activity, ShieldAlert, Utensils, ShieldCheck, ShieldOff } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { authHeaders } from "@/lib/queryClient";
import { api } from "@shared/routes";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ── Daily Log — day-by-day view of everything the client logged ────────────────
// Groups meals (14d) + timeline events (steps/workouts/weights/escalations) per
// SAST day, with daily kcal/protein totals vs targets. Days with no logs still
// render — a silent day is coaching signal, not missing UI.
const SAST_TZ = "Africa/Johannesburg";
function sastDayKey(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-ZA", { timeZone: SAST_TZ }); // yyyy/mm/dd
}
function DailyLogSection({ userData, timelineEvents }: {
  userData: NonNullable<ReturnType<typeof useUser>["data"]>;
  timelineEvents: Array<{ type: string; detail: string; date: string }>;
}) {
  const user = userData.user;
  const calTarget = user.calorieTarget || 0;
  const protTarget = user.proteinTarget || 0;

  const mealsByDay = new Map<string, typeof userData.mealLogs>();
  for (const log of userData.mealLogs || []) {
    if (!log.loggedAt) continue;
    const k = sastDayKey(log.loggedAt);
    if (!mealsByDay.has(k)) mealsByDay.set(k, []);
    mealsByDay.get(k)!.push(log);
  }
  const eventsByDay = new Map<string, typeof timelineEvents>();
  for (const ev of timelineEvents) {
    if (ev.type === "food") continue; // meals come from mealLogs with real macros
    const k = sastDayKey(ev.date);
    if (!eventsByDay.has(k)) eventsByDay.set(k, []);
    eventsByDay.get(k)!.push(ev);
  }

  const days: Array<{ key: string; date: Date }> = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    days.push({ key: sastDayKey(d), date: d });
  }

  const evIcon = (type: string) =>
    type === "weight" ? <Scale className="w-3.5 h-3.5 text-blue-600" /> :
    type === "steps" ? <Footprints className="w-3.5 h-3.5 text-emerald-600" /> :
    type === "workout" ? <Dumbbell className="w-3.5 h-3.5 text-violet-600" /> :
    type === "escalation" ? <ShieldAlert className="w-3.5 h-3.5 text-red-600" /> :
    <MessageSquare className="w-3.5 h-3.5 text-slate-500" />;

  return (
    <Card className="p-6 border-border/50">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-primary/10 text-primary rounded-xl">
          <Calendar className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-lg font-bold font-display">Daily Log</h3>
          <p className="text-sm text-muted-foreground">Day by day, last 14 days — meals, steps, workouts, weigh-ins</p>
        </div>
      </div>
      <div className="overflow-y-auto max-h-[560px] space-y-4 custom-scrollbar pr-1">
        {days.map(({ key, date }) => {
          const meals = (mealsByDay.get(key) || []).slice().sort((a, b) => new Date(a.loggedAt ?? 0).getTime() - new Date(b.loggedAt ?? 0).getTime());
          const events = eventsByDay.get(key) || [];
          const dayKcal = meals.reduce((s, m) => s + (m.kcalInt || 0), 0);
          const dayProt = meals.reduce((s, m) => s + (m.proteinInt || 0), 0);
          const isEmpty = meals.length === 0 && events.length === 0;
          const calPct = calTarget > 0 ? dayKcal / calTarget : 0;
          const calTone = dayKcal === 0 ? "text-muted-foreground" : calPct > 1.1 ? "text-rose-600" : calPct >= 0.7 ? "text-emerald-600" : "text-amber-600";
          return (
            <div key={key} className={`rounded-xl border ${isEmpty ? "border-border/30 bg-muted/20" : "border-border/50 bg-secondary/40"}`}>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/40">
                <span className="font-semibold text-sm">{format(date, "EEE d MMM")}</span>
                {isEmpty ? (
                  <span className="text-xs text-muted-foreground italic">No logs — silent day</span>
                ) : (
                  <div className="flex items-center gap-3 text-xs font-medium">
                    <span className={calTone}>{dayKcal.toLocaleString()} kcal{calTarget ? ` / ${calTarget.toLocaleString()}` : ""}</span>
                    <span className={dayProt >= protTarget && protTarget > 0 ? "text-emerald-600" : "text-muted-foreground"}>{dayProt}g{protTarget ? ` / ${protTarget}g` : ""} protein</span>
                  </div>
                )}
              </div>
              {!isEmpty && (
                <div className="px-4 py-2 space-y-1.5">
                  {meals.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-3 text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-muted-foreground w-10 shrink-0">{m.loggedAt ? format(new Date(m.loggedAt), "HH:mm") : ""}</span>
                        <span className="truncate">{m.rawMessage && m.rawMessage !== "[Photo]" ? m.rawMessage.slice(0, 70) : (m.items?.map((i: any) => i.name).join(", ") || "Food logged")}</span>
                        {m.mealLabel && <span className="text-[10px] uppercase tracking-wide bg-primary/10 text-primary px-1.5 py-0.5 rounded shrink-0">{m.mealLabel}</span>}
                      </div>
                      <span className="text-xs shrink-0 text-muted-foreground">{m.kcalInt || 0} kcal · {m.proteinInt || 0}g</span>
                    </div>
                  ))}
                  {events.map((ev, i) => (
                    <div key={`ev-${i}`} className="flex items-center gap-2 text-sm">
                      <span className="text-xs text-muted-foreground w-10 shrink-0">{format(new Date(ev.date), "HH:mm")}</span>
                      {evIcon(ev.type)}
                      <span className="text-muted-foreground truncate">{ev.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function PhotoThumbnail({ userId, photo }: { userId: string; photo: ProgressPhotoEntry }) {
  const { data: src } = useProgressPhotoUrl(userId, photo.id);
  if (!src) return <div className="w-24 h-24 rounded-lg bg-muted animate-pulse" />;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer">
      <img src={src} alt={`Progress #${photo.photoNumber}`} className="w-24 h-24 object-cover rounded-lg border border-border hover:opacity-80 transition-opacity" />
    </a>
  );
}

function ProgressPhotoSection({ userId, photos }: { userId: string; photos: ProgressPhotoEntry[] }) {
  const upload = useUploadProgressPhoto(userId);
  const [error, setError] = useState<string | null>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    upload.mutate(file, { onError: (err) => setError(err.message) });
    e.target.value = "";
  }

  return (
    <Card className="p-6 border-border/50">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-100 text-purple-600 rounded-xl">
            <span className="text-lg">📸</span>
          </div>
          <div>
            <h3 className="font-semibold">Progress Photos</h3>
            <p className="text-sm text-muted-foreground">{photos.length} photo{photos.length !== 1 ? "s" : ""}</p>
          </div>
        </div>
        <label className="cursor-pointer">
          <Button variant="outline" size="sm" asChild>
            <span>{upload.isPending ? "Uploading…" : "Upload photo"}</span>
          </Button>
          <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={upload.isPending} />
        </label>
      </div>
      {error && <p className="text-sm text-destructive mb-3">{error}</p>}
      {photos.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No progress photos yet.</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {photos.map((p) => <PhotoThumbnail key={p.id} userId={userId} photo={p} />)}
        </div>
      )}
    </Card>
  );
}

export default function UserDetail() {
  const [, params] = useRoute("/users/:id");
  const userId = params?.id ? params.id : "";
  const [coachMessage, setCoachMessage] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [newAction, setNewAction] = useState("");
  const [showTimeline, setShowTimeline] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: userData, isLoading: userLoading } = useUser(userId);
  const { data: timelineData } = useClientTimeline(userId);

  const setSubscriptionMutation = useMutation({
    mutationFn: async (status: "active" | "inactive") => {
      const res = await apiRequest("POST", "/api/admin/set-subscription", {
        phone: user?.phoneNumber?.replace(/^whatsapp:\+?/, ""),
        status,
      });
      return res.json();
    },
    onSuccess: (_, status) => {
      queryClient.invalidateQueries({ queryKey: [api.users.get.path, userId] });
      toast({ title: status === "active" ? "Account activated" : "Account deactivated", description: status === "active" ? "Client now has full access" : "Client access suspended" });
    },
    onError: (err: any) => toast({ title: "Failed to update subscription", description: err.message, variant: "destructive" }),
  });

  const sendMessageMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await apiRequest("POST", "/api/admin/send-message", { userId: user?.id, message });
      return res.json();
    },
    onSuccess: (data) => {
      setCoachMessage("");
      setPendingMessage(null);
      toast({ title: "Message sent", description: `Delivered to ${data.sentTo}` });
    },
    onError: (err: any) => {
      toast({ title: "Failed to send", description: err.message || "Check Twilio configuration", variant: "destructive" });
    },
  });

  const addActionMutation = useMutation({
    mutationFn: async (content: string) => {
      const res = await fetch(`/api/users/${userId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Failed to add action");
      return res.json();
    },
    onSuccess: () => {
      setNewAction("");
      queryClient.invalidateQueries({ queryKey: [api.users.get.path, userId] });
    },
    onError: () => toast({ title: "Failed to add action", variant: "destructive" }),
  });

  const toggleActionMutation = useMutation({
    mutationFn: async ({ actionId, completed }: { actionId: number; completed: boolean }) => {
      const res = await fetch(`/api/users/${userId}/actions/${actionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ completed }),
      });
      if (!res.ok) throw new Error("Failed to update action");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [api.users.get.path, userId] }),
    onError: () => toast({ title: "Failed to update action", variant: "destructive" }),
  });

  const deleteActionMutation = useMutation({
    mutationFn: async (actionId: number) => {
      const res = await fetch(`/api/users/${userId}/actions/${actionId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to delete action");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [api.users.get.path, userId] }),
    onError: () => toast({ title: "Failed to delete action", variant: "destructive" }),
  });

  const user = userData?.user;
  const weightData = (userData?.weightLogs || [])
    .slice()
    .filter((w) => Boolean(w.loggedAt))
    .sort((a, b) => new Date(a.loggedAt ?? 0).getTime() - new Date(b.loggedAt ?? 0).getTime())
    .map(w => ({ date: format(new Date(w.loggedAt ?? 0), "MMM d"), weight: parseFloat(String(w.weight)) }))
    .filter(w => !isNaN(w.weight));

  if (userLoading) {
    return (
      <DashboardLayout>
        <div className="animate-pulse space-y-8">
          <div className="h-20 bg-muted rounded-xl w-full"></div>
          <div className="grid grid-cols-3 gap-6">
            <div className="h-40 bg-muted rounded-xl col-span-2"></div>
            <div className="h-40 bg-muted rounded-xl"></div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (!userData || !user) return <DashboardLayout>User not found</DashboardLayout>;

  const daysOnProgramme = user.programmeStartDate
    ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86400000)
    : 0;

  const isCrisisClient = false;

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="bg-card p-6 sm:p-8 rounded-2xl border border-border shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="flex items-center gap-6">
            <div className="w-20 h-20 rounded-full bg-primary/10 text-primary flex items-center justify-center text-3xl font-bold font-display border-4 border-background shadow-lg">
              {user.name?.[0] || <UserIcon />}
            </div>
            <div>
              <h1 className="text-3xl font-bold font-display mb-1">{user.name || "Unknown User"}</h1>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Calendar className="w-4 h-4" />
                  Joined {user.createdAt ? format(new Date(user.createdAt), 'MMM d, yyyy') : '-'}
                </span>
                <span>•</span>
                <span>{user.phoneNumber}</span>
                {daysOnProgramme > 0 && (
                  <>
                    <span>•</span>
                    <span className="text-primary font-medium">Day {daysOnProgramme}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={user.subscriptionStatus} className="text-base px-4 py-1.5" />
            {user.subscriptionStatus === "active" ? (
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/50 text-destructive hover:bg-destructive/10"
                disabled={setSubscriptionMutation.isPending}
                onClick={() => setSubscriptionMutation.mutate("inactive")}
              >
                <ShieldOff className="w-4 h-4 mr-1" />
                Deactivate
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="border-emerald-500/50 text-emerald-600 hover:bg-emerald-50"
                disabled={setSubscriptionMutation.isPending}
                onClick={() => setSubscriptionMutation.mutate("active")}
              >
                <ShieldCheck className="w-4 h-4 mr-1" />
                Activate
              </Button>
            )}
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <Card className="p-6 border-border/50 flex flex-col items-center justify-center text-center space-y-2">
            <div className="p-3 bg-blue-100 text-blue-600 rounded-xl mb-2">
              <Scale className="w-6 h-6" />
            </div>
            <p className="text-muted-foreground text-sm font-medium">Current Weight</p>
            <h3 className="text-3xl font-bold font-display">{user.currentWeight || "-"} <span className="text-base font-normal text-muted-foreground">kg</span></h3>
            <p className="text-xs text-muted-foreground">Goal: {user.goalType || "-"}</p>
          </Card>

          <Card className="p-6 border-border/50 flex flex-col items-center justify-center text-center space-y-2">
            <div className="p-3 bg-emerald-100 text-emerald-600 rounded-xl mb-2">
              <Footprints className="w-6 h-6" />
            </div>
            <p className="text-muted-foreground text-sm font-medium">Step Target</p>
            <h3 className="text-3xl font-bold font-display" data-testid="text-avg-steps">
              {user.stepsTarget?.toLocaleString() || "-"}
            </h3>
            <p className="text-xs text-muted-foreground">steps/day</p>
          </Card>

          <Card className="p-6 border-border/50 flex flex-col items-center justify-center text-center space-y-2">
            <div className="p-3 bg-violet-100 text-violet-600 rounded-xl mb-2">
              <Dumbbell className="w-6 h-6" />
            </div>
            <p className="text-muted-foreground text-sm font-medium">Workouts Done</p>
            <h3 className="text-3xl font-bold font-display" data-testid="text-workouts">
              {user.totalWorkoutsCompleted || 0}
            </h3>
            <p className="text-xs text-muted-foreground">{user.trainingDaysPerWeek || "-"} days/week plan</p>
          </Card>

          <Card className="p-6 border-border/50 flex flex-col items-center justify-center text-center space-y-2">
            <div className="p-3 bg-amber-100 text-amber-600 rounded-xl mb-2">
              <Trophy className="w-6 h-6" />
            </div>
            <p className="text-muted-foreground text-sm font-medium">Programme Phase</p>
            <h3 className="text-3xl font-bold font-display">
              {user.programmePhase || 1}
            </h3>
            <p className="text-xs text-muted-foreground">Week {user.programmeWeek || 1} • Day {user.programmeDayInWeek || 1}</p>
          </Card>
        </div>

        {/* Chart + Info */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <Card className="p-6 border-border/50 h-[400px]">
              <h3 className="text-lg font-bold font-display mb-6">Weight Progress</h3>
              {weightData.length > 1 ? (
                <ResponsiveContainer width="100%" height="85%">
                  <AreaChart data={weightData}>
                    <defs>
                      <linearGradient id="colorWeight" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0d9488" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#6b7280' }} dy={10} />
                    <YAxis domain={['dataMin - 2', 'dataMax + 2']} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#6b7280' }} />
                    <Tooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Area type="monotone" dataKey="weight" stroke="#0d9488" strokeWidth={3} fillOpacity={1} fill="url(#colorWeight)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Not enough data to graph
                </div>
              )}
            </Card>
          </div>

          {/* User Info Panel */}
          <Card className="p-6 border-border/50 h-[400px] flex flex-col">
            <h3 className="text-lg font-bold font-display mb-4">Client Profile</h3>
            <div className="flex-1 overflow-y-auto pr-2 space-y-3 custom-scrollbar" data-testid="panel-user-info">
              {[
                ["Training Mode", user.trainingMode || "home"],
                ["Goal", user.goalType || "-"],
                ["Life Situation", user.lifeSituation || "-"],
                ["Calories Target", user.calorieTarget ? `${user.calorieTarget} kcal` : "-"],
                ["Protein Target", user.proteinTarget ? `${user.proteinTarget}g` : "-"],
                ["Step Target", user.stepsTarget?.toLocaleString() || "-"],
                ["BMI", user.bmi ? parseFloat(String(user.bmi)).toFixed(1) : "-"],
                ["Medical", user.medicalConditions || "none"],
                ["Referral Code", user.referralCode || "none generated"],
                ["Referred By", user.referredBy || "direct"],
              ].map(([label, value]) => (
                <div key={label} className="p-3 rounded-xl bg-secondary/50 border border-border/50 text-sm flex justify-between">
                  <span className="text-muted-foreground">{label}:</span>
                  <span className="font-medium capitalize">{value}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Daily Log — day-by-day view (the coach's actual working view) */}
        <DailyLogSection userData={userData} timelineEvents={timelineData?.events || []} />

        {/* Coach Message Panel */}
        <Card className="p-6 border-border/50">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-primary/10 text-primary rounded-xl">
              <MessageSquare className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold font-display">Send Message to Client</h3>
              <p className="text-sm text-muted-foreground">Sends directly to {user.name || "client"}'s WhatsApp as Coach K</p>
            </div>
          </div>

          {/* Quick message templates */}
          <div className="flex flex-wrap gap-2 mb-4">
            {[
              "How are you doing this week?",
              "Don't forget your workout today.",
              "Great progress — keep it up.",
              "Log your meals today.",
              "Weigh in this morning and send me the number.",
            ].map((template) => (
              <button
                key={template}
                onClick={() => setCoachMessage(template)}
                className="text-xs px-3 py-1.5 rounded-full bg-secondary border border-border/50 hover:bg-primary/10 hover:text-primary hover:border-primary/30 transition-colors"
                data-testid={`button-template-${template.slice(0, 20).replace(/\s/g, "-")}`}
              >
                {template}
              </button>
            ))}
          </div>

          <div className="flex gap-3">
            <Textarea
              placeholder="Type a personal message to this client..."
              value={coachMessage}
              onChange={(e) => setCoachMessage(e.target.value)}
              className="flex-1 min-h-[80px] resize-none"
              data-testid="input-coach-message"
            />
            <Button
              onClick={() => setPendingMessage(coachMessage)}
              disabled={!coachMessage.trim() || sendMessageMutation.isPending}
              className="self-end gap-2"
              data-testid="button-send-message"
            >
              <Send className="w-4 h-4" />
              {sendMessageMutation.isPending ? "Sending..." : "Send"}
            </Button>
          </div>

          {sendMessageMutation.isError && (
            <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="w-4 h-4" />
              <span>Twilio must be configured to send messages to clients.</span>
            </div>
          )}
        </Card>

        {/* Pinned Actions */}
        <Card className="p-6 border-border/50">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-violet-100 text-violet-600 rounded-xl">
                <ClipboardList className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold font-display">Pinned Actions</h3>
                <p className="text-sm text-muted-foreground">Coach-defined follow-ups for this client</p>
              </div>
            </div>
            <span className="text-xs text-muted-foreground bg-secondary px-2 py-1 rounded-full">
              {(userData?.actions || []).filter(a => !a.completedAt).length} open
            </span>
          </div>

          {/* Add new action */}
          <div className="flex gap-2 mb-4">
            <Input
              placeholder="Add a follow-up action..."
              value={newAction}
              onChange={(e) => setNewAction(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newAction.trim()) { addActionMutation.mutate(newAction.trim()); } }}
              className="flex-1"
            />
            <Button
              size="sm"
              onClick={() => newAction.trim() && addActionMutation.mutate(newAction.trim())}
              disabled={!newAction.trim() || addActionMutation.isPending}
              className="gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </Button>
          </div>

          {/* Action list */}
          {(userData?.actions || []).length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No actions yet. Add one above.</p>
          ) : (
            <div className="space-y-2">
              {[...(userData?.actions || [])].sort((a, b) => {
                // Open first, then by createdAt
                const aOpen = !a.completedAt ? 0 : 1;
                const bOpen = !b.completedAt ? 0 : 1;
                return aOpen - bOpen;
              }).map((action: ClientAction) => (
                <div key={action.id} className={`flex items-center gap-3 p-3 rounded-xl border text-sm ${action.completedAt ? "bg-secondary/30 border-border/30 opacity-60" : "bg-secondary/50 border-border/50"}`}>
                  <button
                    onClick={() => toggleActionMutation.mutate({ actionId: action.id, completed: !action.completedAt })}
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${action.completedAt ? "bg-emerald-500 border-emerald-500 text-white" : "border-muted-foreground/40 hover:border-primary"}`}
                  >
                    {action.completedAt && <Check className="w-3 h-3" />}
                  </button>
                  <span className={`flex-1 ${action.completedAt ? "line-through text-muted-foreground" : ""}`}>{action.content}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {action.createdAt && (
                      <span className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(action.createdAt), { addSuffix: true })}</span>
                    )}
                    <button
                      onClick={() => deleteActionMutation.mutate(action.id)}
                      className="text-muted-foreground/50 hover:text-destructive transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Activity Timeline */}
        <Card className="p-6 border-border/50">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-100 text-amber-600 rounded-xl">
                <Activity className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold font-display">Activity Timeline</h3>
                <p className="text-sm text-muted-foreground">Last 30 days — all events</p>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowTimeline(v => !v)} className="text-xs">
              {showTimeline ? "Collapse" : `Show ${timelineData?.events?.length ?? 0} events`}
            </Button>
          </div>

          {showTimeline && (
            <div className="overflow-y-auto max-h-[500px] custom-scrollbar">
              {!timelineData?.events?.length ? (
                <p className="text-sm text-muted-foreground text-center py-4">No events in the last 30 days.</p>
              ) : (
                <div className="relative pl-6 border-l-2 border-border space-y-1">
                  {(timelineData?.events || []).map((event, i) => {
                    const icon =
                      event.type === "weight" ? <Scale className="w-3.5 h-3.5" /> :
                      event.type === "steps" ? <Footprints className="w-3.5 h-3.5" /> :
                      event.type === "workout" ? <Dumbbell className="w-3.5 h-3.5" /> :
                      event.type === "food" ? <Utensils className="w-3.5 h-3.5" /> :
                      event.type === "escalation" ? <ShieldAlert className="w-3.5 h-3.5" /> :
                      <MessageSquare className="w-3.5 h-3.5" />;
                    const color =
                      event.type === "weight" ? "bg-blue-100 text-blue-600" :
                      event.type === "steps" ? "bg-emerald-100 text-emerald-600" :
                      event.type === "workout" ? "bg-violet-100 text-violet-600" :
                      event.type === "food" ? "bg-amber-100 text-amber-600" :
                      event.type === "escalation" ? "bg-red-100 text-red-600" :
                      "bg-slate-100 text-slate-600";
                    return (
                      <div key={i} className="flex items-start gap-3 py-2 group">
                        <div className={`absolute -left-2.5 w-5 h-5 rounded-full flex items-center justify-center ${color} border-2 border-background`}>
                          {icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{event.detail}</p>
                          <p className="text-xs text-muted-foreground">{format(new Date(event.date), "MMM d, HH:mm")}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Food Log History */}
        {(userData?.mealLogs?.length ?? 0) > 0 && (
          <Card className="p-6 border-border/50">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-emerald-100 text-emerald-600 rounded-xl">
                <UtensilsCrossed className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold font-display">Food Log (last 14 days)</h3>
                <p className="text-sm text-muted-foreground">{userData!.mealLogs.length} meals logged</p>
              </div>
            </div>
            <div className="overflow-y-auto max-h-96 space-y-2 custom-scrollbar">
              {userData!.mealLogs.map((log) => {
                const label = log.mealLabel ? `${log.mealLabel.charAt(0).toUpperCase()}${log.mealLabel.slice(1)}` : "Meal";
                const sourceIcon = log.source === "photo" ? <Camera className="w-3 h-3" /> : log.source === "voice" ? <Mic className="w-3 h-3" /> : null;
                const display = log.rawMessage && log.rawMessage !== "[Photo]" ? log.rawMessage.slice(0, 60) : (log.items && log.items.length > 0 ? log.items.map(i => i.name).join(", ") : log.rawMessage || "Food logged");
                return (
                  <div key={log.id} className="flex items-center justify-between p-3 rounded-xl bg-secondary/40 border border-border/40 text-sm gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {sourceIcon && <span className="text-muted-foreground shrink-0">{sourceIcon}</span>}
                      <span className="text-xs text-muted-foreground shrink-0">{log.loggedAt ? format(new Date(log.loggedAt), "MMM d, HH:mm") : "-"}</span>
                      <span className="font-medium truncate">{display}</span>
                      {log.mealLabel && <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full shrink-0">{label}</span>}
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-right">
                      {log.kcalInt > 0 && <span className="font-semibold text-amber-600">{log.kcalInt} kcal</span>}
                      {log.proteinInt > 0 && <span className="text-emerald-600">{log.proteinInt}g prot</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Progress Photos */}
        <ProgressPhotoSection userId={userId} photos={userData?.progressPhotos ?? []} />

        {/* Recent Chat Messages */}
        {(userData?.chatHistory?.length ?? 0) > 0 && (
          <Card className="p-6 border-border/50">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-blue-100 text-blue-600 rounded-xl">
                <MessageSquare className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold font-display">Recent Messages</h3>
                <p className="text-sm text-muted-foreground">Last {Math.min(userData!.chatHistory.length, 20)} exchanges</p>
              </div>
            </div>
            <div className="overflow-y-auto max-h-[500px] space-y-3 custom-scrollbar">
              {userData!.chatHistory.slice(0, 20).map((chat, i) => (
                <div key={i} className="rounded-xl border border-border/40 text-sm overflow-hidden">
                  <div className="px-3 py-2 bg-secondary/40 flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground truncate">{chat.messageIn || "(media)"}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">{chat.intent || "?"}</span>
                      <span className="text-xs text-muted-foreground">{chat.createdAt ? format(new Date(chat.createdAt), "MMM d, HH:mm") : ""}</span>
                    </div>
                  </div>
                  <div className="px-3 py-2 text-muted-foreground whitespace-pre-wrap">{chat.messageOut?.slice(0, 200) || "(no reply)"}{(chat.messageOut?.length ?? 0) > 200 ? "…" : ""}</div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Send confirmation dialog */}
      <AlertDialog open={!!pendingMessage} onOpenChange={(open) => { if (!open) setPendingMessage(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send message to {user.name || "client"}?</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap break-words">
              "{pendingMessage}"
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingMessage) sendMessageMutation.mutate(pendingMessage); }}
            >
              Send via WhatsApp
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}
