"use client";

import { Check } from "lucide-react";

import { FadeIn } from "@/components/landing/fade-in";
import { Badge } from "@/components/ui/badge";

export function DemoPreview() {
  return (
    <section id="demo" className="py-20 md:py-28">
      <div className="container">
        <FadeIn className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Before &amp; after, side by side
          </h2>
          <p className="mt-3 text-muted-foreground">
            The same minute of footage — raw landscape on the left, a
            caption-ready vertical clip on the right.
          </p>
        </FadeIn>

        <FadeIn delay={0.1} className="mt-12">
          <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
            {/* BEFORE */}
            <div className="rounded-2xl border bg-card p-4 shadow">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold">Before</span>
                <Badge variant="secondary">Raw 16:9 source</Badge>
              </div>
              <div className="relative aspect-video overflow-hidden rounded-lg bg-gradient-to-br from-zinc-700 to-zinc-900">
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-xs font-medium text-zinc-400">
                  No captions · landscape · 60 min long
                </div>
                <div className="absolute bottom-2 left-2 right-2 h-1 overflow-hidden rounded-full bg-zinc-600">
                  <div className="h-full w-1/4 rounded-full bg-zinc-400" />
                </div>
              </div>
              <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                <li className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                  Buried gems in an hour of footage
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                  Wrong aspect ratio for TikTok / Reels
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                  80% of viewers scroll with sound off
                </li>
              </ul>
            </div>

            {/* AFTER */}
            <div className="relative rounded-2xl border border-primary-500/40 bg-card p-4 shadow-lg shadow-primary-500/10">
              <span
                aria-hidden
                className="absolute -top-3 left-4 rounded-full score-gradient px-3 py-0.5 text-xs font-bold text-white"
              >
                After — ClipForge
              </span>
              <div className="mb-3 mt-1 flex items-center justify-between">
                <span className="text-sm font-semibold">After</span>
                <Badge className="score-gradient border-transparent text-white">
                  92 virality score
                </Badge>
              </div>
              <div className="relative mx-auto aspect-[9/16] max-w-[240px] overflow-hidden rounded-xl bg-gradient-to-b from-zinc-700 via-zinc-800 to-zinc-900">
                <span className="score-gradient absolute right-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-white">
                  0:34
                </span>
                <div className="absolute inset-x-2 bottom-4 flex flex-wrap justify-center gap-1">
                  {["THIS", "ONE", "MISTAKE", "COST", "ME", "$10K"].map(
                    (w, i) => (
                      <span
                        key={w}
                        className={
                          i === 2
                            ? "animate-caption rounded bg-primary-500 px-1.5 py-0.5 text-[10px] font-extrabold text-white"
                            : "rounded px-1.5 py-0.5 text-[10px] font-extrabold text-white drop-shadow"
                        }
                        style={{ animationDelay: `${i * 0.14}s` }}
                      >
                        {w}
                      </span>
                    )
                  )}
                </div>
              </div>
              <ul className="mt-3 space-y-1.5 text-sm">
                {[
                  "Hook-first edit with animated captions",
                  "9:16 vertical, 1080×1920, speaker centered",
                  "Scheduled to TikTok, Reels & Shorts",
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2 text-muted-foreground">
                    <Check className="h-4 w-4 shrink-0 text-primary-500" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
