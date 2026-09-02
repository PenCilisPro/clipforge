"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { FadeIn } from "@/components/landing/fade-in";
import { Button } from "@/components/ui/button";

export function FinalCta() {
  return (
    <section className="py-20 md:py-28">
      <div className="container">
        <FadeIn>
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-primary-600 via-primary-500 to-primary-400 px-6 py-16 text-center md:py-20">
            {/* subtle dot pattern */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-20"
              style={{
                backgroundImage:
                  "radial-gradient(rgba(255,255,255,0.9) 1px, transparent 1px)",
                backgroundSize: "22px 22px",
              }}
            />
            <h2 className="relative mx-auto max-w-2xl text-3xl font-extrabold tracking-tight text-white md:text-5xl">
              Start Creating Viral Clips Today
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-primary-50">
              Your next million-view clip is already hiding in your last
              video. Let ClipForge find it.
            </p>
            <div className="relative mt-8">
              <Button
                size="xl"
                asChild
                className="bg-white text-primary-600 shadow-xl hover:bg-white/90"
              >
                <Link href="/signup">
                  Get Started Free
                  <ArrowRight />
                </Link>
              </Button>
              <p className="mt-3 text-xs text-primary-100">
                No credit card required · 60 free minutes every month
              </p>
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
