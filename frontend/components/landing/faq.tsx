"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { FadeIn } from "@/components/landing/fade-in";
import { API_URL } from "@/lib/api";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const DEFAULT_FAQS = [
  {
    q: "What video formats and sources can I upload?",
    a: "Paste a YouTube link (or most social/webinar links) and ClipForge fetches the video for you, or upload files directly — MP4, MOV, WEBM and MKV up to 4K are supported on every plan.",
  },
  {
    q: "How does the AI decide which clips to create?",
    a: "Your video is transcribed with word-level timestamps, then a GLM-powered model reads the full transcript and scores every candidate moment for hook strength, emotion, self-containment and shareability. Each suggested clip gets a virality score so you can review the reasoning.",
  },
  {
    q: "Can I customize the caption style and branding?",
    a: "Yes. Choose from preset styles (Classic, Karaoke, Bold Pop) with configurable font, color, position and animation — the word highlight defaults to ClipForge orange (#FF5D1C). Pro and Business plans can add a logo watermark to every clip.",
  },
  {
    q: "Which platforms can I schedule posts to?",
    a: "TikTok, Instagram Reels, YouTube Shorts and Facebook Reels. Pick a platform, set a date and time, and ClipForge publishes the clip automatically — captions and hashtags included.",
  },
  {
    q: "Do I need to connect my social media accounts?",
    a: "Only if you want auto-scheduling and publishing. Downloading clips and using the editor doesn't require any account connections, and you can revoke access at any time.",
  },
  {
    q: "Is there a free plan?",
    a: "Yes — the Free plan includes 60 upload minutes per month, up to 3 clips per video and all core features with a small ClipForge watermark. No credit card required.",
  },
  {
    q: "How long does it take to process a video?",
    a: "Processing is fully asynchronous. A 30-minute video typically finishes in 5–15 minutes: download and transcription run first, then AI analysis, then cloud rendering of each clip. You can close the tab — the dashboard shows live progress and notifies you when clips are ready.",
  },
  {
    q: "Can I cancel or change my plan anytime?",
    a: "Absolutely. Upgrade, downgrade or cancel from your billing page at any time. Changes take effect at the next billing cycle and unused credits roll over for 30 days after cancellation.",
  },
];

const BRANDING_FAQ_URL = API_URL + "/api/branding";

export function Faq() {
  const [faqs, setFaqs] = useState(DEFAULT_FAQS);

  // Admin-managed FAQs (edited on the admin page) override the defaults.
  useEffect(() => {
    fetch(BRANDING_FAQ_URL)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.faq) && data.faq.length > 0) setFaqs(data.faq);
      })
      .catch(() => {});
  }, []);

  return (
    <section id="faq" className="bg-muted/40 py-20 md:py-28">
      <div className="container max-w-3xl">
        <FadeIn className="text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Frequently Asked Questions
          </h2>
          <p className="mt-3 text-muted-foreground">
            Everything you need to know about the product and billing.
          </p>
        </FadeIn>

        <FadeIn delay={0.1} className="mt-10">
          <Accordion type="single" collapsible className="rounded-xl border bg-card px-6">
            {faqs.map((faq, i) => (
              <AccordionItem key={i} value={`item-${i}`}>
                <AccordionTrigger className="text-left text-[15px] font-medium">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </FadeIn>

        <FadeIn delay={0.15} className="mt-8 text-center text-sm text-muted-foreground">
          Still have questions?{" "}
          <Link
            href="mailto:support@clipforge.app"
            className="font-medium text-primary-500 hover:underline"
          >
            Contact us
          </Link>{" "}
          — we reply within one business day.
        </FadeIn>
      </div>
    </section>
  );
}
