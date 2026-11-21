"use client";

import { Mic, Radio, GraduationCap, Briefcase } from "lucide-react";

import { FadeIn } from "@/components/landing/fade-in";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Honest "Built for" section — real use cases the product handles, no
 * invented quotes or subscriber counts.
 */
const USE_CASES = [
  {
    icon: Mic,
    title: "Podcasters",
    description:
      "Drop in your latest episode — ClipForge finds the hooks, cuts the clips and burns word-by-word captions while you record the next one.",
  },
  {
    icon: Radio,
    title: "Streamers",
    description:
      "Turn long streams and gaming sessions into vertical highlight clips sized for TikTok, Reels and Shorts — no timeline scrubbing required.",
  },
  {
    icon: GraduationCap,
    title: "Educators",
    description:
      "One webinar becomes a month of shareable clips. Key moments get hook-first edits with captions, ready to schedule or download.",
  },
  {
    icon: Briefcase,
    title: "Agencies & teams",
    description:
      "Batch-process client recordings, keep caption styling on-brand, and publish to every channel from one dashboard on a schedule.",
  },
];

export function Testimonials() {
  return (
    <section className="py-20 md:py-28">
      <div className="container">
        <FadeIn className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Built for people who ship content
          </h2>
          <p className="mt-3 text-muted-foreground">
            If you record long videos and need short ones, the pipeline is
            already wired for your workflow.
          </p>
        </FadeIn>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {USE_CASES.map((useCase, i) => (
            <FadeIn key={useCase.title} delay={i * 0.08}>
              <Card className="flex h-full flex-col">
                <CardContent className="flex flex-1 flex-col pt-6">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-500/10">
                    <useCase.icon className="h-5 w-5 text-primary-500" />
                  </span>
                  <h3 className="mt-4 text-sm font-semibold">{useCase.title}</h3>
                  <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
                    {useCase.description}
                  </p>
                </CardContent>
              </Card>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
