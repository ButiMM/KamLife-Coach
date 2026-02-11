import { useUser, useUserLogs } from "@/hooks/use-users";
import { DashboardLayout } from "@/components/layout";
import { StatusBadge } from "@/components/status-badge";
import { useRoute } from "wouter";
import { Card } from "@/components/ui/card";
import { format } from "date-fns";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Dumbbell, Footprints, Scale, Calendar, User as UserIcon } from "lucide-react";

export default function UserDetail() {
  const [, params] = useRoute("/users/:id");
  const userId = params?.id ? parseInt(params.id) : 0;
  
  const { data: user, isLoading: userLoading } = useUser(userId);
  const { data: logs, isLoading: logsLoading } = useUserLogs(userId);

  if (userLoading || logsLoading) {
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

  if (!user) return <DashboardLayout>User not found</DashboardLayout>;

  // Prepare chart data - filter logs with weight
  const weightData = logs
    ?.filter(log => log.weight)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map(log => ({
      date: format(new Date(log.date), 'MMM d'),
      weight: parseFloat(log.weight as string),
    })) || [];

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
                            Joined {user.joinedAt ? format(new Date(user.joinedAt), 'MMM d, yyyy') : '-'}
                        </span>
                        <span>•</span>
                        <span>{user.phoneNumber}</span>
                    </div>
                </div>
            </div>
            <StatusBadge status={user.subscriptionStatus} className="text-base px-4 py-1.5" />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card className="p-6 border-border/50 flex flex-col items-center justify-center text-center space-y-2">
                <div className="p-3 bg-blue-100 text-blue-600 rounded-xl mb-2">
                    <Scale className="w-6 h-6" />
                </div>
                <p className="text-muted-foreground text-sm font-medium">Current Weight</p>
                <h3 className="text-3xl font-bold font-display">{user.currentWeight || "-"} <span className="text-base font-normal text-muted-foreground">kg</span></h3>
                <p className="text-xs text-muted-foreground">Goal: {user.weightGoal} kg</p>
            </Card>

            <Card className="p-6 border-border/50 flex flex-col items-center justify-center text-center space-y-2">
                <div className="p-3 bg-emerald-100 text-emerald-600 rounded-xl mb-2">
                    <Footprints className="w-6 h-6" />
                </div>
                <p className="text-muted-foreground text-sm font-medium">Avg Steps</p>
                <h3 className="text-3xl font-bold font-display">
                    {logs?.length ? Math.round(logs.reduce((acc, log) => acc + (log.steps || 0), 0) / logs.length) : 0}
                </h3>
                <p className="text-xs text-muted-foreground">Per day logged</p>
            </Card>

            <Card className="p-6 border-border/50 flex flex-col items-center justify-center text-center space-y-2">
                <div className="p-3 bg-violet-100 text-violet-600 rounded-xl mb-2">
                    <Dumbbell className="w-6 h-6" />
                </div>
                <p className="text-muted-foreground text-sm font-medium">Workouts</p>
                <h3 className="text-3xl font-bold font-display">
                    {logs?.filter(l => l.workoutCompleted).length || 0}
                </h3>
                <p className="text-xs text-muted-foreground">Total sessions</p>
            </Card>
        </div>

        {/* Chart */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2">
                <Card className="p-6 border-border/50 h-[400px]">
                    <h3 className="text-lg font-bold font-display mb-6">Weight Progress</h3>
                    {weightData.length > 1 ? (
                        <ResponsiveContainer width="100%" height="85%">
                            <AreaChart data={weightData}>
                                <defs>
                                    <linearGradient id="colorWeight" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#0d9488" stopOpacity={0.2}/>
                                        <stop offset="95%" stopColor="#0d9488" stopOpacity={0}/>
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                                <XAxis 
                                    dataKey="date" 
                                    axisLine={false} 
                                    tickLine={false} 
                                    tick={{fontSize: 12, fill: '#6b7280'}} 
                                    dy={10}
                                />
                                <YAxis 
                                    domain={['dataMin - 2', 'dataMax + 2']} 
                                    axisLine={false} 
                                    tickLine={false} 
                                    tick={{fontSize: 12, fill: '#6b7280'}} 
                                />
                                <Tooltip 
                                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                                />
                                <Area 
                                    type="monotone" 
                                    dataKey="weight" 
                                    stroke="#0d9488" 
                                    strokeWidth={3}
                                    fillOpacity={1} 
                                    fill="url(#colorWeight)" 
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="h-full flex items-center justify-center text-muted-foreground">
                            Not enough data to graph
                        </div>
                    )}
                </Card>
            </div>

            {/* Recent Logs List */}
            <Card className="p-6 border-border/50 h-[400px] flex flex-col">
                <h3 className="text-lg font-bold font-display mb-4">Recent Logs</h3>
                <div className="flex-1 overflow-y-auto pr-2 space-y-4 custom-scrollbar">
                    {logs?.sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime()).map(log => (
                        <div key={log.id} className="p-3 rounded-xl bg-secondary/50 border border-border/50 text-sm">
                            <div className="flex justify-between items-center mb-2">
                                <span className="font-semibold">{format(new Date(log.date), 'EEE, MMM d')}</span>
                                {log.workoutCompleted && (
                                    <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Workout Done</span>
                                )}
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                                <div>Step: {log.steps || '-'}</div>
                                <div>Weight: {log.weight ? `${log.weight}kg` : '-'}</div>
                            </div>
                        </div>
                    ))}
                    {(!logs || logs.length === 0) && (
                        <p className="text-center text-muted-foreground py-8">No logs yet.</p>
                    )}
                </div>
            </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
