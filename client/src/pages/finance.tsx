import { DashboardLayout } from "@/components/layout";
import { useFinance, useFinanceHistory, type FinanceAlert } from "@/hooks/use-users";
import { Card } from "@/components/ui/card";
import {
  TrendingUp, TrendingDown, Wallet, ArrowDownCircle, Target,
  CheckCircle2, AlertTriangle, XCircle, Clock, Info, BarChart2,
} from "lucide-react";

export default function Finance() {
  const { data: f, isLoading } = useFinance();
  const { data: history } = useFinanceHistory();

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display tracking-tight">Business Health</h2>
            <p className="text-muted-foreground mt-1">Are we making money — and what needs attention right now?</p>
          </div>
          {f?.computedAt && (
            <span className="text-xs text-muted-foreground bg-white dark:bg-card px-3 py-1.5 rounded-full border border-border">
              <Clock className="w-3 h-3 inline mr-1" />
              Updated {new Date(f.computedAt).toLocaleTimeString("en-ZA", { timeZone: "Africa/Johannesburg" })}
            </span>
          )}
        </div>

        {isLoading || !f ? (
          <FinanceLoading />
        ) : (
          <>
            {/* ── THE HEADLINE: are we making money? ── */}
            <Card className={`p-8 border-2 ${f.headline.profitable
              ? "border-green-500/40 bg-green-50 dark:bg-green-900/10"
              : "border-rose-500/40 bg-rose-50 dark:bg-rose-900/10"}`}>
              <div className="flex items-center gap-4">
                <div className={`p-4 rounded-2xl ${f.headline.profitable
                  ? "bg-green-100 dark:bg-green-900/30 text-green-600"
                  : "bg-rose-100 dark:bg-rose-900/30 text-rose-600"}`}>
                  {f.headline.profitable ? <TrendingUp className="w-8 h-8" /> : <TrendingDown className="w-8 h-8" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    {f.headline.profitable ? "This month you're making" : "This month you're losing"}
                  </p>
                  <p className={`text-4xl sm:text-5xl font-bold font-display ${f.headline.profitable ? "text-green-600" : "text-rose-600"}`}>
                    {f.headline.netProfitDisplay}
                    <span className="text-lg text-muted-foreground font-normal"> /month</span>
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    R{f.headline.revenue.toLocaleString()} in − R{f.headline.totalCost.toLocaleString()} out
                    {" · "}{f.headline.margin}% margin
                  </p>
                </div>
              </div>
            </Card>

            {/* ── WHAT TO WATCH (the warnings) ── */}
            <section className="space-y-4">
              <h3 className="text-lg font-bold font-display flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500" /> What to watch
              </h3>
              <div className="space-y-3">
                {f.alerts.map((a, i) => <AlertRow key={i} alert={a} />)}
              </div>
            </section>

            {/* ── BREAK-EVEN ── */}
            <Card className="p-6 border-border/50">
              <div className="flex items-start gap-4">
                <div className="p-3 rounded-xl bg-blue-100 dark:bg-blue-900/30 text-blue-600">
                  <Target className="w-6 h-6" />
                </div>
                <div className="flex-1">
                  <h3 className="font-bold font-display text-lg">Break-even</h3>
                  {f.breakEven.payingNeeded == null ? (
                    <p className="text-sm text-rose-600 mt-1">
                      Each client currently costs more than R{f.assumptions.price}. Fix cost-per-user before adding more clients.
                    </p>
                  ) : f.breakEven.toGo && f.breakEven.toGo > 0 ? (
                    <p className="text-sm text-muted-foreground mt-1">
                      You need <span className="font-bold text-foreground">{f.breakEven.payingNeeded}</span> paying clients to cover all costs.
                      You have <span className="font-bold text-foreground">{f.breakEven.payingNow}</span> —{" "}
                      <span className="font-bold text-rose-600">{f.breakEven.toGo} to go.</span>
                    </p>
                  ) : (
                    <p className="text-sm text-green-600 mt-1">
                      ✅ Past break-even ({f.breakEven.payingNow} paying, needed {f.breakEven.payingNeeded}).
                      Every new client adds ~R{f.breakEven.contributionPerUser} profit.
                    </p>
                  )}
                </div>
              </div>
            </Card>

            {/* ── MONEY IN / MONEY OUT ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Money in */}
              <Card className="p-6 border-border/50">
                <h3 className="font-bold font-display flex items-center gap-2 mb-4">
                  <Wallet className="w-5 h-5 text-green-600" /> Money in
                </h3>
                <div className="space-y-3">
                  <Row label="Monthly revenue (MRR)" value={f.moneyIn.mrrDisplay} strong />
                  <Row label="Paying clients" value={`${f.moneyIn.payingUsers}`} />
                  <Row label="On trial" value={`${f.moneyIn.trialUsers}`} />
                  <Row label="Trial → paid rate" value={`${f.moneyIn.trialConversion}%`} />
                  <div className="pt-2 border-t border-border/50">
                    <Row
                      label="Projected if trials convert"
                      value={f.moneyIn.projectedMRRDisplay}
                      hint={`+${f.moneyIn.projectedNewPaying} clients`}
                    />
                  </div>
                </div>
              </Card>

              {/* Money out */}
              <Card className="p-6 border-border/50">
                <h3 className="font-bold font-display flex items-center gap-2 mb-4">
                  <ArrowDownCircle className="w-5 h-5 text-orange-600" /> Money out
                </h3>
                <div className="space-y-3">
                  {f.moneyOut.breakdown.map((b) => (
                    <Row
                      key={b.label}
                      label={b.label}
                      value={`R${b.amount.toLocaleString()}`}
                      hint={b.note}
                      badge={b.measured ? "measured" : "estimate"}
                    />
                  ))}
                  <div className="pt-2 border-t border-border/50">
                    <Row label="Total costs" value={`R${f.moneyOut.total.toLocaleString()}`} strong />
                  </div>
                </div>
                {f.moneyOut.aiByFeature.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-border/50">
                    <p className="text-xs font-medium text-muted-foreground mb-2">AI spend by feature (this month)</p>
                    <div className="space-y-1.5">
                      {f.moneyOut.aiByFeature.map((a) => (
                        <div key={a.feature} className="flex justify-between text-xs">
                          <span className="text-muted-foreground capitalize">{a.feature.replace(/_/g, " ")}</span>
                          <span className="font-medium">R{a.zar.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            </div>

            {/* ── AI SPEND HISTORY (P&L trend) ── */}
            {history && history.months.length > 0 && (
              <Card className="p-6 border-border/50">
                <h3 className="font-bold font-display flex items-center gap-2 mb-4">
                  <BarChart2 className="w-5 h-5 text-blue-500" /> AI spend — last 6 months
                </h3>
                <p className="text-xs text-muted-foreground mb-4">
                  Real measured costs from every GPT/vision/voice call. Use this to spot trends before they hurt margin.
                  {f.trend.aiChange != null && (
                    <span className={` ml-2 font-medium ${f.trend.aiChange > 20 ? "text-rose-500" : f.trend.aiChange < 0 ? "text-green-600" : "text-muted-foreground"}`}>
                      {f.trend.aiChange > 0 ? `▲${f.trend.aiChange}%` : `▼${Math.abs(f.trend.aiChange)}%`} vs last month.
                    </span>
                  )}
                </p>
                <div className="space-y-2">
                  {(() => {
                    const max = Math.max(...history.months.map(m => m.aiZar), 1);
                    return history.months.map((m, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-12 shrink-0">{m.label}</span>
                        <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                          <div
                            className="h-2 rounded-full bg-blue-500 transition-all duration-500"
                            style={{ width: `${(m.aiZar / max) * 100}%` }}
                          />
                        </div>
                        <span className="text-xs font-medium w-16 text-right shrink-0">
                          {m.aiZar > 0 ? `R${m.aiZar.toLocaleString()}` : <span className="text-muted-foreground">R0</span>}
                        </span>
                      </div>
                    ));
                  })()}
                </div>
                <p className="text-[10px] text-muted-foreground mt-3">
                  Note: revenue and user-count history require monthly snapshots (not yet implemented). AI spend is the only cost with full historical data.
                </p>
              </Card>
            )}

            {/* ── ASSUMPTIONS (honesty footer) ── */}
            <Card className="p-5 border-border/50 bg-muted/30">
              <div className="flex items-start gap-3">
                <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="text-xs text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground">How these numbers are worked out</p>
                  <p>
                    <span className="font-medium">AI cost is real</span> — measured from every GPT/vision/voice call this month.
                    The rest are estimates you can change in Railway:
                  </p>
                  <p>
                    Exchange rate ${"→"}R: <b>{f.assumptions.usdZar}</b> ·
                    Hosting: <b>R{f.assumptions.hostingZar}/mo</b> ·
                    WhatsApp: <b>R{f.assumptions.whatsappPerUser}/active user</b> ·
                    PayFast: <b>{f.assumptions.payfastPct}% + R{f.assumptions.payfastFixed}</b> ·
                    Price: <b>R{f.assumptions.price}</b>
                  </p>
                </div>
              </div>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ── Sub-components ──

function AlertRow({ alert }: { alert: FinanceAlert }) {
  const cfg = {
    good: { icon: CheckCircle2, ring: "border-green-500/30 bg-green-50 dark:bg-green-900/10", text: "text-green-600" },
    warn: { icon: AlertTriangle, ring: "border-amber-500/30 bg-amber-50 dark:bg-amber-900/10", text: "text-amber-600" },
    bad: { icon: XCircle, ring: "border-rose-500/30 bg-rose-50 dark:bg-rose-900/10", text: "text-rose-600" },
  }[alert.level];
  const Icon = cfg.icon;
  return (
    <Card className={`p-4 border ${cfg.ring}`}>
      <div className="flex items-start gap-3">
        <Icon className={`w-5 h-5 mt-0.5 shrink-0 ${cfg.text}`} />
        <div className="flex-1">
          <p className={`font-semibold ${cfg.text}`}>{alert.title}</p>
          <p className="text-sm text-muted-foreground mt-0.5">{alert.detail}</p>
          <p className="text-sm mt-1.5">
            <span className="font-medium text-foreground">Do this: </span>
            <span className="text-muted-foreground">{alert.action}</span>
          </p>
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value, hint, strong, badge }: {
  label: string; value: string; hint?: string; strong?: boolean; badge?: string;
}) {
  return (
    <div className="flex justify-between items-start gap-3">
      <div className="min-w-0">
        <p className={`${strong ? "font-bold" : "font-medium"} text-sm`}>{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="text-right shrink-0">
        <p className={`${strong ? "text-lg font-bold font-display" : "font-medium"}`}>{value}</p>
        {badge && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${badge === "measured"
            ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            : "bg-muted text-muted-foreground"}`}>
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}

function FinanceLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-32 bg-muted rounded-2xl" />
      <div className="space-y-3">
        {[1, 2, 3].map(i => <div key={i} className="h-20 bg-muted rounded-2xl" />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-64 bg-muted rounded-2xl" />
        <div className="h-64 bg-muted rounded-2xl" />
      </div>
    </div>
  );
}
