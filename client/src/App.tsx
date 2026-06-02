import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import Dashboard from "@/pages/dashboard";
import Analytics from "@/pages/analytics";
import UsersList from "@/pages/users";
import UserDetail from "@/pages/user-detail";
import BetaTesters from "@/pages/admin/beta-testers";
import AdminTest from "@/pages/admin/test";
import Observability from "@/pages/observability";
import Escalations from "@/pages/escalations";
import ABTests from "@/pages/ab-tests";
import PaymentSuccess from "@/pages/payment-success";
import PaymentCancel from "@/pages/payment-cancel";
import Login from "@/pages/login";
import VoiceBroadcast from "@/pages/voice-broadcast";
import PrivacyPolicy from "@/pages/privacy";

function AuthGuard({ component: Component }: { component: React.ComponentType }) {
  const { data: isAuth, isLoading } = useQuery<boolean>({
    queryKey: ["/api/auth/check"],
    queryFn: () =>
      fetch("/api/auth/check", { credentials: "include" }).then((r) => r.ok),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (isLoading) return null;
  if (!isAuth) return <Redirect to="/login" />;
  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={Login} />
      <Route path="/payment-success" component={PaymentSuccess} />
      <Route path="/payment-cancel" component={PaymentCancel} />
      <Route path="/privacy" component={PrivacyPolicy} />
      <Route path="/dashboard">{() => <AuthGuard component={Dashboard} />}</Route>
      <Route path="/analytics">{() => <AuthGuard component={Analytics} />}</Route>
      <Route path="/users">{() => <AuthGuard component={UsersList} />}</Route>
      <Route path="/users/:id">{() => <AuthGuard component={UserDetail} />}</Route>
      <Route path="/observability">{() => <AuthGuard component={Observability} />}</Route>
      <Route path="/escalations">{() => <AuthGuard component={Escalations} />}</Route>
      <Route path="/ab-tests">{() => <AuthGuard component={ABTests} />}</Route>
      <Route path="/admin/test">{() => <AuthGuard component={AdminTest} />}</Route>
      <Route path="/admin/beta">{() => <AuthGuard component={BetaTesters} />}</Route>
      <Route path="/voice-broadcast">{() => <AuthGuard component={VoiceBroadcast} />}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
