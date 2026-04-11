import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
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
import Login from "@/pages/login";
import { isAuthenticated } from "@/lib/auth";

function AuthGuard({ component: Component }: { component: React.ComponentType }) {
  if (!isAuthenticated()) return <Redirect to="/login" />;
  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={Login} />
      <Route path="/dashboard">{() => <AuthGuard component={Dashboard} />}</Route>
      <Route path="/analytics">{() => <AuthGuard component={Analytics} />}</Route>
      <Route path="/users">{() => <AuthGuard component={UsersList} />}</Route>
      <Route path="/users/:id">{() => <AuthGuard component={UserDetail} />}</Route>
      <Route path="/admin/test">{() => <AuthGuard component={AdminTest} />}</Route>
      <Route path="/admin/beta">{() => <AuthGuard component={BetaTesters} />}</Route>
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
