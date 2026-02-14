import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";
import { Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function BetaTesters() {
  const { data: testers, isLoading } = useQuery<any[]>({
    queryKey: [api.users.betaTesters.path],
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Beta Testers</h1>
          <p className="text-muted-foreground">Users with active payment bypass allowlist.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Active Allowlist
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Phone Number</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Bypass Expiry</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {testers?.map((tester) => {
                const isExpired = new Date(tester.betaBypassUntil) < new Date();
                return (
                  <TableRow key={tester.id}>
                    <TableCell className="font-mono">{tester.phoneNumber}</TableCell>
                    <TableCell>{tester.name || "Unknown"}</TableCell>
                    <TableCell>
                      {format(new Date(tester.betaBypassUntil), "PPP")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={isExpired ? "destructive" : "default"}>
                        {isExpired ? "Expired" : "Active"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
              {(!testers || testers.length === 0) && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                    No active beta testers found. Add numbers to BETA_TESTERS environment variable.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
