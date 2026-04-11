import { DashboardLayout } from "@/components/layout";
import { useRevenue, useFunnel } from "@/hooks/use-users";
import { Card } from "@/components/ui/card";
import {
  DollarSign,
  TrendingUp,
  Users,
  ArrowRight,
  Activity,
  Target,
  BarChart3,
  Clock,
} from "lucide-react";

export default function Analytics() {
  const { data: revenue, isLoading: revLoading } = useRevenue();
  const { data: funnel, isLoading: funnelLoading } = useFunnel();

  const loading = revLoading || funnelLoading;

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display tracking-tight">Analytics</h2>
            <p className="text-muted-foreground mt-1">Revenue, funnel, retention, and unit economics</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            {revenue?.computedAt && (
              <span className="text-xs text-muted-foreground bg-white dark:bg-card px-3 py-1.5 rounded-full border border-border">
                <Clock className="w-3 h-3 inline mr-1" />
                Data as of {new Date(revenue.computedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        {loading ? (
          <AnalyticsLoading />
        ) : (
          <>
            {/* Revenue Row */}
            <section className="space-y-4">
              <h3 className="text-lg font-bold font-display flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-green-600" /> Revenue
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <MetricCard
                  label="MRR"
                  value={revenue?.current.mrrDisplay ?? "—"}
                  sub={`${revenue?.current.payingUsers ?? 0} paying × R${revenue?.pricePerUser ?? 149}`}
                  color="text-green-600 bg-green-100 dark:bg-green-900/20"
                />
                <MetricCard
                  label="ARR"
                  value={revenue?.current.arrDisplay ?? "—"}
                  sub="Annualized"
                  color="text-emerald-600 bg-emerald-100 dark:bg-emerald-900/20"
                />
                <MetricCard
                  label="Gross Profit"
                  value={revenue ? `R${revenue.unitEconomics.grossProfit.toLocaleString()}` : "—"}
                  sub={revenue ? `${revenue.unitEconomics.grossMargin} margin` : ""}
                  color="text-blue-600 bg-blue-100 dark:bg-blue-900/20"
                />
                <MetricCard
                  label="Projected MRR"
                  value={revenue?.forecast.projectedMRRDisplay ?? "—"}
                  sub={revenue ? `+${revenue.forecast.projectedNewPaying} trial conversions` : ""}
                  color="text-indigo-600 bg-indigo-100 dark:bg-indigo-900/20"
                />
              </div>
            </section>

            {/* Unit Economics Row */}
            <section className="space-y-4">
              <h3 className="text-lg font-bold font-display flex items-center gap-2">
                <Target className="w-5 h-5 text-purple-600" /> Unit Economics
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <MetricCard
                  label="ARPU"
                  value={revenue ? `R${revenue.unitEconomics.arpu}` : "—"}
                  sub="Per paying user / month"
                  color="text-purple-600 bg-purple-100 dark:bg-purple-900/20"
                />
                <MetricCard
                  label="Est. LTV"
                  value={revenue ? `R${revenue.unitEconomics.estimatedLTV.toLocaleString()}` : "—"}
                  sub={revenue ? `~${revenue.unitEconomics.estimatedMonthlyChurn}% monthly churn` : ""}
                  color="text-violet-600 bg-violet-100 dark:bg-violet-900/20"
                />
                <MetricCard
                  label="Cost / User"
                  value={revenue ? `R${revenue.unitEconomics.estimatedCostPerUser}` : "—"}
                  sub="WhatsApp + AI / month"
                  color="text-orange-600 bg-orange-100 dark:bg-orange-900/20"
                />
                <MetricCard
                  label="Trial → Paid"
                  value={revenue?.rates.trialConversion ?? "—"}
                  sub={`${revenue?.current.trialUsers ?? 0} on trial`}
                  color="text-amber-600 bg-amber-100 dark:bg-amber-900/20"
                />
              </div>
            </section>

            {/* Funnel */}
            <section className="space-y-4">
              <h3 className="text-lg font-bold font-display flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-blue-600" /> Conversion Funnel
              </h3>
              <Card className="p-6 border-border/50">
                <FunnelBar funnel={funnel?.funnel} rates={funnel?.conversionRates} subs={funnel?.subscriptions} />
              </Card>
            </section>

            {/* Retention */}
            <section className="space-y-4">
              <h3 className="text-lg font-bold font-display flex items-center gap-2">
                <Activity className="w-5 h-5 text-rose-600" /> Retention
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <RetentionCard
                  label="D1 Retention"
                  rate={funnel?.retention.d1.rate}
                  retained={funnel?.retention.d1.retained}
                  eligible={funnel?.retention.d1.eligible}
                />
                <RetentionCard
                  label="D7 Retention"
                  rate={funnel?.retention.d7.rate}
                  retained={funnel?.retention.d7.retained}
                  eligible={funnel?.retention.d7.eligible}
                />
                <RetentionCard
                  label="D30 Retention"
                  rate={funnel?.retention.d30.rate}
                  retained={funnel?.retention.d30.retained}
                  eligible={funnel?.retention.d30.eligible}
                />
              </div>
            </section>

            {/* Engagement */}
            <section className="space-y-4">
              <h3 className="text-lg font-bold font-display flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-teal-600" /> Engagement
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <MetricCard
                  label="Avg Workouts / Week"
                  value={funnel?.engagement.avgWorkoutsPerWeek?.toFixed(1) ?? "—"}
                  sub="Active clients"
                  color="text-teal-600 bg-teal-100 dark:bg-teal-900/20"
                />
                <MetricCard
                  label="Avg Messages / Day"
                  value={funnel?.engagement.avgMessagesPerDay?.toFixed(1) ?? "—"}
                  sub="Per active client"
                  color="text-cyan-600 bg-cyan-100 dark:bg-cyan-900/20"
                />
                <MetricCard
                  label="Subscribers"
                  value={`${(funnel?.subscriptions.paying ?? 0) + (funnel?.subscriptions.trial ?? 0)}`}
                  sub={`${funnel?.subscriptions.paying ?? 0} paid · ${funnel?.subscriptions.trial ?? 0} trial`}
                  color="text-blue-600 bg-blue-100 dark:bg-blue-900/20"
                />
                <MetricCard
                  label="Churned"
                  value={funnel?.subscriptions.churned ?? "—"}
                  sub={`${funnel?.subscriptions.inactive ?? 0} inactive total`}
                  color="text-rose-600 bg-rose-100 dark:bg-rose-900/20"
                />
              </div>
            </section>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ── Sub-components ──

function MetricCard({ label, value, sub, color }: { label: string; value: string | number; sub: string; color: string }) {
  return (
    <Card className="p-5 border-border/50 shadow-sm hover:shadow-md transition-all duration-300">
      <p className="text-sm font-medium text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-bold font-display">{value}</p>
      <p className="text-xs text-muted-foreground mt-2">{sub}</p>
    </Card>
  );
}

function FunnelBar({
  funnel,
  rates,
  subs,
}: {
  funnel?: { totalSignups: number; onboardingComplete: number; firstFoodLogged: number; firstWorkoutDone: number; activeWeek1: number };
  rates?: { signupToOnboard: number; onboardToFirstWorkout: number; firstWorkoutToWeek1: number; trialToPaid: number };
  subs?: { trial: number; paying: number; inactive: number; churned: number };
}) {
  if (!funnel || !rates) return <p className="text-muted-foreground text-sm">No funnel data yet</p>;

  const steps = [
    { label: "Signups", value: funnel.totalSignups, rate: null },
    { label: "Onboarded", value: funnel.onboardingComplete, rate: rates.signupToOnboard },
    { label: "First Food Log", value: funnel.firstFoodLogged, rate: null },
    { label: "First Workout", value: funnel.firstWorkoutDone, rate: rates.onboardToFirstWorkout },
    { label: "Week 1 Active", value: funnel.activeWeek1, rate: rates.firstWorkoutToWeek1 },
    { label: "Paid", value: subs?.paying ?? 0, rate: rates.trialToPaid },
  ];

  const maxVal = Math.max(...steps.map(s => s.value), 1);

  return (
    <div className="space-y-3">
      {steps.map((step, i) => (
        <div key={step.label} className="flex items-center gap-4">
          <div className="w-28 sm:w-36 text-sm font-medium text-right shrink-0">{step.label}</div>
          <div className="flex-1 flex items-center gap-3">
            <div className="flex-1 bg-secondary rounded-full h-7 relative overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary/80 to-primary transition-all duration-700"
                style={{ width: `${Math.max((step.value / maxVal) * 100, 2)}%` }}
              />
              <span className="absolute inset-0 flex items-center px-3 text-xs font-bold">
                {step.value}
              </span>
            </div>
            {step.rate !== null && (
              <span className="text-xs font-medium text-muted-foreground w-12 text-right shrink-0">
                {step.rate}%
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function RetentionCard({ label, rate, retained, eligible }: { label: string; rate?: number; retained?: number; eligible?: number }) {
  const displayRate = rate ?? 0;
  const color = displayRate >= 70 ? "text-green-600" : displayRate >= 40 ? "text-amber-600" : "text-rose-600";
  const bgColor = displayRate >= 70 ? "bg-green-500" : displayRate >= 40 ? "bg-amber-500" : "bg-rose-500";

  return (
    <Card className="p-5 border-border/50 shadow-sm">
      <p className="text-sm font-medium text-muted-foreground mb-2">{label}</p>
      <div className="flex items-end gap-2">
        <span className={`text-3xl font-bold font-display ${color}`}>{displayRate}%</span>
        <span className="text-xs text-muted-foreground mb-1">
          {retained ?? 0} / {eligible ?? 0}
        </span>
      </div>
      <div className="mt-3 w-full bg-secondary rounded-full h-2">
        <div className={`h-full rounded-full ${bgColor} transition-all duration-700`} style={{ width: `${displayRate}%` }} />
      </div>
    </Card>
  );
}

function AnalyticsLoading() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map(i => <div key={i} className="h-28 bg-muted rounded-2xl" />)}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map(i => <div key={i} className="h-28 bg-muted rounded-2xl" />)}
      </div>
      <div className="h-64 bg-muted rounded-2xl" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[1, 2, 3].map(i => <div key={i} className="h-28 bg-muted rounded-2xl" />)}
      </div>
    </div>
  );
}
