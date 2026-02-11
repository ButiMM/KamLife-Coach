import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Status = "active" | "inactive" | "trial" | string;

export function StatusBadge({ status, className }: { status: Status; className?: string }) {
  const styles = {
    active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
    inactive: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400 border-rose-200 dark:border-rose-800",
    trial: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800",
  };

  const normalizedStatus = status.toLowerCase() as keyof typeof styles;
  const selectedStyle = styles[normalizedStatus] || "bg-slate-100 text-slate-700";

  return (
    <Badge 
      variant="outline" 
      className={cn("px-2.5 py-0.5 rounded-full capitalize font-medium border", selectedStyle, className)}
    >
      {status}
    </Badge>
  );
}
