"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Tone = "default" | "info" | "success" | "destructive" | "warning" | "muted";

const TONE_CLASSES: Record<Tone, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  info: "border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400",
  success:
    "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  destructive:
    "border-transparent bg-red-500/15 text-red-600 dark:text-red-400",
  warning:
    "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  muted: "border-transparent bg-muted text-muted-foreground",
};

export function StatusPill({
  label,
  tone = "muted",
  pulse,
}: {
  label: string;
  tone?: Tone;
  pulse?: boolean;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5", TONE_CLASSES[tone])}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          pulse && "animate-pulse",
          tone === "default" || tone === "info"
            ? "bg-current"
            : "bg-current"
        )}
      />
      {label}
    </Badge>
  );
}
