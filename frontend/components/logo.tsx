"use client";

import Link from "next/link";
import { Zap } from "lucide-react";

import { useBranding } from "@/lib/branding";
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
  const { logoUrl } = useBranding();

  return (
    <Link href={href} className={cn("flex items-center gap-2", className)}>
      {logoUrl ? (
        // Custom branding uploaded from the admin page (https enforced there).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt="ClipForge"
          className="h-8 w-8 rounded-lg object-contain"
        />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary shadow-md shadow-primary/30">
          <Zap className="h-5 w-5 fill-primary-foreground text-primary-foreground" />
        </span>
      )}
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
