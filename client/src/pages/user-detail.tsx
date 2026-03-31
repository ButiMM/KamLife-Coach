import { useState } from "react";
import { useUser } from "@/hooks/use-users";
import { DashboardLayout } from "@/components/layout";
import { StatusBadge } from "@/components/status-badge";
import { useRoute } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Dumbbell, Footprints, Scale, Calendar, User as UserIcon, Send, AlertTriangle, Trophy, MessageSquare } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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

export default function UserDetail() {
  const [, params] = useRoute("/users/:id");
  const userId = params?.id ? params.id : "";
  const [coachMessage, setCoachMessage] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const { toast } = useToast();

  const { data: userData, isLoading: userLoading } = useUser(userId as any);

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

  const user = userData?.user;
  const weightData = (userData?.weightLogs || [])
    .slice()
    .sort((a, b) => new Date(a.loggedAt).getTime() - new Date(b.loggedAt).getTime())
    .map(w => ({ date: format(new Date(w.loggedAt), "MMM d"), weight: parseFloat(String(w.weight)) }))
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
          <StatusBadge status={user.subscriptionStatus} className="text-base px-4 py-1.5" />
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
