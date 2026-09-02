import Link from "next/link";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export function Logo({
  className,
  href = "/",
  textClassName,
}: {
  className?: string;
  href?: string;
  textClassName?: string;
}) {
  return (
    <Link href={href} className={cn("flex items-center gap-2", className)}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary shadow-md shadow-primary/30">
        <Zap className="h-5 w-5 fill-primary-foreground text-primary-foreground" />
      </span>
      <span
        className={cn(
          "text-lg font-bold tracking-tight text-foreground",
          textClassName
        )}
      >
        ClipForge
      </span>
    </Link>
  );
}
