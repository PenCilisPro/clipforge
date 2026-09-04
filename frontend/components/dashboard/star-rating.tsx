"use client";

import { useState } from "react";
import { Star } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 1–5 star rating. `value` + `onChange` make it an input; omit both for a
 * read-only display (shows `value` stars filled, dimmed if absent).
 */
export function StarRating({
  value,
  onChange,
  size = "md",
  className,
}: {
  value?: number | null;
  onChange?: (rating: number) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const interactive = Boolean(onChange);
  const shown = hover ?? value ?? 0;
  const px = size === "sm" ? "h-3.5 w-3.5" : "h-6 w-6";

  return (
    <div
      className={cn("flex items-center gap-0.5", className)}
      onMouseLeave={() => interactive && setHover(null)}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= shown;
        const star = (
          <Star
            className={cn(
              px,
              "transition-colors",
              filled ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40"
            )}
          />
        );
        if (!interactive) return <span key={n}>{star}</span>;
        return (
          <button
            key={n}
            type="button"
            aria-label={`Rate ${n} star${n === 1 ? "" : "s"}`}
            className="rounded transition-transform hover:scale-125 active:scale-110"
            onMouseEnter={() => setHover(n)}
            onFocus={() => setHover(n)}
            onBlur={() => setHover(null)}
            onClick={() => onChange?.(n)}
          >
            {star}
          </button>
        );
      })}
    </div>
  );
}
