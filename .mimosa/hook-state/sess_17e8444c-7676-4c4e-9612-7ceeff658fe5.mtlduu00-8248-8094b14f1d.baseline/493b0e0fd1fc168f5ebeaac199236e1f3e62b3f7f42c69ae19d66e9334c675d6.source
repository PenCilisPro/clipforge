"use client";

import { Star } from "lucide-react";

import { FadeIn } from "@/components/landing/fade-in";
import { Card, CardContent } from "@/components/ui/card";

const TESTIMONIALS = [
  {
    quote:
      "I used to spend every Sunday cutting my podcast into shorts. ClipForge does it before I finish my coffee — and its picks honestly outperform mine.",
    name: "Maya Chen",
    role: "Podcast Host, 200K subscribers",
    initials: "MC",
  },
  {
    quote:
      "We turned one 90-minute webinar into 14 clips and scheduled the whole month in an afternoon. The word-by-word captions get stopped on every time.",
    name: "Jordan Okafor",
    role: "Head of Content, B2B SaaS",
    initials: "JO",
  },
  {
    quote:
      "The virality scoring is scarily good. The clips it ranked 90+ were exactly the ones that hit a million views on TikTok.",
    name: "Sofia Reyes",
    role: "YouTube Educator, 1.2M subscribers",
    initials: "SR",
  },
  {
    quote:
      "No editing software, no freelancers, no render queue on my laptop. Paste link, wait, download, done. It just works.",
    name: "Liam Gallagher",
    role: "Creator & Agency Owner",
    initials: "LG",
  },
];

export function Testimonials() {
  return (
    <section className="py-20 md:py-28">
      <div className="container">
        <FadeIn className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Creators ship more with ClipForge
          </h2>
          <p className="mt-3 text-muted-foreground">
            Thousands of podcasters, streamers and marketers post daily with
            clips cut by ClipForge.
          </p>
        </FadeIn>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {TESTIMONIALS.map((t, i) => (
            <FadeIn key={t.name} delay={i * 0.08}>
              <Card className="flex h-full flex-col">
                <CardContent className="flex flex-1 flex-col pt-6">
                  <div className="flex gap-0.5">
                    {Array.from({ length: 5 }).map((_, s) => (
                      <Star
                        key={s}
                        className="h-3.5 w-3.5 fill-primary-500 text-primary-500"
                      />
                    ))}
                  </div>
                  <p className="mt-3 flex-1 text-sm leading-relaxed text-muted-foreground">
                    “{t.quote}”
                  </p>
                  <div className="mt-5 flex items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full score-gradient text-xs font-bold text-white">
                      {t.initials}
                    </span>
                    <div>
                      <p className="text-sm font-semibold">{t.name}</p>
                      <p className="text-xs text-muted-foreground">{t.role}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
