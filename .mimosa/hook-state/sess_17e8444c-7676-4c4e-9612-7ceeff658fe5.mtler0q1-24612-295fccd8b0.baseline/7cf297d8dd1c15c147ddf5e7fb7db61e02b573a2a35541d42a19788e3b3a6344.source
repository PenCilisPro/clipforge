"use client";

import { FadeIn } from "@/components/landing/fade-in";

const LOGOS = ["Podium", "Wavecast", "CreatorLab", "Streamly", "ReelReach"];

export function TrustBar() {
  return (
    <section className="border-y bg-muted/40 py-8">
      <div className="container">
        <FadeIn>
          <p className="text-center text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Powering clips for teams and creators at
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-12 gap-y-4">
            {LOGOS.map((logo) => (
              <span
                key={logo}
                className="select-none text-xl font-bold tracking-tight text-muted-foreground/50 transition-colors hover:text-muted-foreground"
              >
                {logo}
              </span>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
