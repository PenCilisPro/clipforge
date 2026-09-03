"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, PlayCircle, Sparkles, Star } from "lucide-react";

import { Button } from "@/components/ui/button";

const CLIP_PREVIEWS = [
  {
    title: "The $10M mistake\nnobody talks about",
    score: 92,
    words: ["THE", "$10M", "MISTAKE", "NOBODY", "TALKS"],
    highlight: 1,
  },
  {
    title: "Why your first\n100 videos flopped",
    score: 87,
    words: ["WHY", "YOUR", "FIRST", "100", "VIDEOS"],
    highlight: 2,
  },
  {
    title: "This changed how\nI hire forever",
    score: 81,
    words: ["THIS", "CHANGED", "HOW", "I", "HIRE"],
    highlight: 0,
  },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden pb-20 pt-16 md:pt-24">
      {/* soft radial glow behind hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[560px] w-[900px] -translate-x-1/2 rounded-full bg-primary-500/10 blur-3xl dark:bg-primary-500/15"
      />

      <div className="container flex flex-col items-center text-center">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary-200 bg-primary-50 px-3 py-1 text-xs font-medium text-primary-700 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300">
            <Sparkles className="h-3.5 w-3.5" />
            Kimi-powered viral moment detection
          </span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.08 }}
          className="mt-6 max-w-3xl text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl md:text-6xl"
        >
          Turn Long Videos Into{" "}
          <span className="text-gradient-primary">Viral Clips</span> —
          Automatically
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.16 }}
          className="mt-5 max-w-2xl text-lg text-muted-foreground"
        >
          ClipForge watches your podcast, webinar or YouTube video, picks the
          most shareable moments with AI, and renders vertical 9:16 clips with
          animated word-by-word captions — ready for TikTok, Reels and Shorts.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.24 }}
          className="mt-8 flex flex-col items-center gap-3 sm:flex-row"
        >
          <Button
            size="xl"
            asChild
            className="animate-pulse-glow text-base font-semibold"
          >
            <Link href="/signup">
              Try ClipForge Free
              <ArrowRight className="ml-1" />
            </Link>
          </Button>
          <Button size="xl" variant="ghost" asChild>
            <a href="#demo">
              <PlayCircle />
              Watch Demo
            </a>
          </Button>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"
        >
          <span className="flex">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star key={i} className="h-4 w-4 fill-primary-500 text-primary-500" />
            ))}
          </span>
          Trusted by 10,000+ creators
        </motion.div>

        {/* Hero visual: long video -> vertical clips */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.35 }}
          className="mt-14 w-full"
        >
          <div className="mx-auto flex max-w-5xl flex-col items-center justify-center gap-6 lg:flex-row lg:gap-8">
            {/* source video mock */}
            <div className="w-full max-w-md rounded-2xl border bg-card p-3 shadow-xl">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Source — 1:02:47
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  16:9
                </span>
              </div>
              <div className="relative aspect-video overflow-hidden rounded-lg bg-gradient-to-br from-zinc-800 to-zinc-900">
                <div className="absolute inset-0 flex items-center justify-center gap-1 opacity-70">
                  {Array.from({ length: 28 }).map((_, i) => (
                    <div
                      key={i}
                      className="w-1 rounded-full bg-zinc-500"
                      style={{
                        height: `${18 + Math.abs(Math.sin(i * 1.7)) * 34}px`,
                      }}
                    />
                  ))}
                </div>
                <div className="absolute bottom-3 left-3 right-3 h-1 overflow-hidden rounded-full bg-zinc-700">
                  <div className="h-full w-1/3 rounded-full bg-primary-500" />
                </div>
              </div>
              <p className="px-1 pt-2 text-left text-xs text-muted-foreground">
                Podcast episode — full length
              </p>
            </div>

            {/* arrow */}
            <div className="flex items-center gap-2 lg:flex-col">
              <div className="h-px w-16 bg-gradient-to-r from-transparent via-primary-400 to-primary-500 lg:h-16 lg:w-px lg:bg-gradient-to-b" />
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary shadow-lg shadow-primary/40">
                <Sparkles className="h-5 w-5 text-primary-foreground" />
              </span>
              <div className="h-px w-16 bg-gradient-to-r from-primary-500 to-transparent lg:h-16 lg:w-px lg:bg-gradient-to-b" />
            </div>

            {/* vertical clips mock */}
            <div className="grid w-full max-w-md grid-cols-3 gap-3">
              {CLIP_PREVIEWS.map((clip, idx) => (
                <div
                  key={idx}
                  className="animate-float rounded-xl border bg-card p-1.5 shadow-lg"
                  style={{ animationDelay: `${idx * 0.6}s` }}
                >
                  <div className="relative aspect-[9/16] overflow-hidden rounded-lg bg-gradient-to-b from-zinc-700 via-zinc-800 to-zinc-900">
                    <span className="score-gradient absolute right-1 top-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {clip.score}
                    </span>
                    <div className="absolute inset-x-1.5 bottom-3 flex flex-wrap justify-center gap-0.5">
                      {clip.words.map((w, wi) => (
                        <span
                          key={wi}
                          className={
                            wi === clip.highlight
                              ? "animate-caption rounded bg-primary-500 px-1 py-0.5 text-[9px] font-extrabold text-white"
                              : "rounded px-1 py-0.5 text-[9px] font-extrabold text-white drop-shadow"
                          }
                          style={{ animationDelay: `${wi * 0.12}s` }}
                        >
                          {w}
                        </span>
                      ))}
                    </div>
                  </div>
                  <p className="px-1 pb-1 pt-1.5 text-left text-[10px] font-medium leading-tight text-muted-foreground">
                    {clip.title.replace("\n", " ")}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
