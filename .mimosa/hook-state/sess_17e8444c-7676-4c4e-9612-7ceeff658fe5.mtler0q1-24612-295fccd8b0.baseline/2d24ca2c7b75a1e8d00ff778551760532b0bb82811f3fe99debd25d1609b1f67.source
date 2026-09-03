"use client";

import { Link2, BrainCircuit, Clapperboard, CalendarClock } from "lucide-react";

import { FadeIn } from "@/components/landing/fade-in";
import { Card, CardContent } from "@/components/ui/card";

const STEPS = [
  {
    icon: Link2,
    step: "01",
    title: "Paste a link or upload your video",
    description:
      "Drop in a YouTube, Zoom or podcast URL, or upload an MP4/MOV directly. We fetch the full-length video for you.",
  },
  {
    icon: BrainCircuit,
    step: "02",
    title: "Our AI finds the best moments",
    description:
      "Word-level transcription feeds a Kimi-powered analysis engine that scores every moment for hook strength, emotion and shareability.",
  },
  {
    icon: Clapperboard,
    step: "03",
    title: "Get vertical clips with auto-captions",
    description:
      "Shotstack renders each clip in 9:16 with animated word-by-word captions, reframed to keep the speaker centered.",
  },
  {
    icon: CalendarClock,
    step: "04",
    title: "Schedule & auto-post",
    description:
      "Queue clips to TikTok, Instagram Reels, YouTube Shorts and Facebook Reels — ClipForge publishes them at the perfect time.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-20 md:py-28">
      <div className="container">
        <FadeIn className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            From long video to viral clip in 4 steps
          </h2>
          <p className="mt-3 text-muted-foreground">
            No timeline editing, no software to install. Paste a link and let
            the pipeline do the rest.
          </p>
        </FadeIn>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <FadeIn key={step.step} delay={i * 0.08}>
              <Card className="relative h-full overflow-hidden">
                <span
                  aria-hidden
                  className="pointer-events-none absolute -right-2 -top-4 select-none text-7xl font-extrabold text-primary-500/10"
                >
                  {step.step}
                </span>
                <CardContent className="pt-6">
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-500/10">
                    <step.icon className="h-5 w-5 text-primary-500" />
                  </div>
                  <h3 className="mt-4 font-semibold leading-snug">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {step.description}
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
