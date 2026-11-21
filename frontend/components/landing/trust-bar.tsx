"use client";

import { FadeIn } from "@/components/landing/fade-in";

/**
 * Honest "works with" strip — the source types the downloader actually
 * supports. No invented customer logos.
 */
const SOURCES = ["YouTube", "Twitch", "Zoom", "Vimeo", "Podcast hosts"];

export function TrustBar() {
  return (
    <section className="border-y bg-muted/40 py-8">
      <div className="container">
        <FadeIn>
          <p className="text-center text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Works with
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-12 gap-y-4">
            {SOURCES.map((source) => (
              <span
                key={source}
                className="select-none text-xl font-bold tracking-tight text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                {source}
              </span>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
