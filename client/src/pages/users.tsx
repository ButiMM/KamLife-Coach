import { useUsers } from "@/hooks/use-users";
import { DashboardLayout } from "@/components/layout";
import { StatusBadge } from "@/components/status-badge";
import { Link } from "wouter";
import { Search, Filter, MoreHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function UsersList() {
  const { data: users, isLoading } = useUsers();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const filteredUsers = users?.filter((user) => {
    const matchesSearch = user.name?.toLowerCase().includes(search.toLowerCase()) || 
                          user.phoneNumber.includes(search);
    const matchesStatus = statusFilter ? user.subscriptionStatus === statusFilter : true;
    return matchesSearch && matchesStatus;
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display">Users</h2>
            <p className="text-muted-foreground mt-1">Manage your coaching clients</p>
          </div>
          <Button>
             Export CSV
          </Button>
        </div>

        {/* Filters */}
        <div className="bg-card p-4 rounded-xl border border-border shadow-sm flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search by name or phone..." 
              className="pl-9 bg-background"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button 
                variant={statusFilter === null ? "secondary" : "ghost"} 
                onClick={() => setStatusFilter(null)}
                className="text-sm"
            >
                All
            </Button>
            <Button 
                variant={statusFilter === "active" ? "secondary" : "ghost"} 
                onClick={() => setStatusFilter("active")}
                className="text-emerald-600"
            >
                Active
            </Button>
            <Button 
                variant={statusFilter === "trial" ? "secondary" : "ghost"} 
                onClick={() => setStatusFilter("trial")}
                className="text-amber-600"
            >
                Trial
            </Button>
            <Button 
                variant={statusFilter === "inactive" ? "secondary" : "ghost"} 
                onClick={() => setStatusFilter("inactive")}
                className="text-rose-600"
            >
                Inactive
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[250px]">User</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Training</TableHead>
                <TableHead>Goal</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    Loading users...
                  </TableCell>
                </TableRow>
              ) : filteredUsers && filteredUsers.length > 0 ? (
                filteredUsers.map((user) => (
                  <TableRow key={user.id} className="hover:bg-muted/30 transition-colors">
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-semibold text-foreground">{user.name || "Unknown"}</span>
                        <span className="text-xs text-muted-foreground">{user.phoneNumber}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={user.subscriptionStatus} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col text-xs">
                        <span className="font-medium capitalize">{user.trainingMode || "Home"}</span>
                        <span className="text-muted-foreground">Day {user.programDayIndex || 1}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        <span className="font-medium">{user.currentWeight || "-"}</span>
                        <span className="text-muted-foreground"> / {user.weightGoal || "-"} kg</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {user.joinedAt ? new Date(user.joinedAt).toLocaleDateString() : "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <Link href={`/users/${user.id}`}>
                            <DropdownMenuItem className="cursor-pointer">View Profile</DropdownMenuItem>
                          </Link>
                          <DropdownMenuItem className="text-destructive">Block User</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No users found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </DashboardLayout>
  );
}
