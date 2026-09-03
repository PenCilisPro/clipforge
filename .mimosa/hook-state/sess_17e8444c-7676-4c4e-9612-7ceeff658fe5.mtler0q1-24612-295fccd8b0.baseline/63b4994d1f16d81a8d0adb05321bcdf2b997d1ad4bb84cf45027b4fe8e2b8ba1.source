"use client";

import {
  Sparkles,
  Captions,
  Crop,
  CalendarClock,
  Palette,
  Cloud,
} from "lucide-react";

import { FadeIn } from "@/components/landing/fade-in";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const FEATURES = [
  {
    icon: Sparkles,
    title: "AI Viral Moment Detection",
    description:
      "A Kimi-powered model reads your full transcript and surfaces the moments most likely to blow up, ranked by virality score.",
  },
  {
    icon: Captions,
    title: "Auto Word-by-Word Captions",
    description:
      "Animated captions highlight every word as it's spoken — with your brand color #FF5D1C as the default highlight.",
  },
  {
    icon: Crop,
    title: "Smart 9:16 Reframing",
    description:
      "Every clip is cropped to vertical and scaled to 1080×1920, keeping faces and key visuals in frame automatically.",
  },
  {
    icon: CalendarClock,
    title: "Multi-Platform Scheduling",
    description:
      "Plan a week of content in one sitting. Delayed jobs publish each clip to TikTok, Reels and Shorts right on schedule.",
  },
  {
    icon: Palette,
    title: "Custom Caption Styles & Branding",
    description:
      "Pick fonts, colors, positions and animation presets — or drop your logo watermark on every clip you render.",
  },
  {
    icon: Cloud,
    title: "Fast Cloud Rendering",
    description:
      "Everything renders in the cloud via the Shotstack API. No downloads, no plugins, no GPU fan noise.",
    className: "sm:col-span-2 lg:col-span-1",
  },
];

export function FeaturesGrid() {
  return (
    <section id="features" className="bg-muted/40 py-20 md:py-28">
      <div className="container">
        <FadeIn className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Everything you need to go viral
          </h2>
          <p className="mt-3 text-muted-foreground">
            One pipeline from raw footage to scheduled posts — built for
            podcasters, streamers and marketing teams.
          </p>
        </FadeIn>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <FadeIn key={feature.title} delay={(i % 3) * 0.08} className={cn(feature.className)}>
              <Card className="group h-full transition-shadow hover:shadow-md">
                <CardContent className="pt-6">
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-500/10 transition-colors group-hover:bg-primary-500 group-hover:[&>svg]:text-primary-foreground">
                    <feature.icon className="h-5 w-5 text-primary-500" />
                  </div>
                  <h3 className="mt-4 font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {feature.description}
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
