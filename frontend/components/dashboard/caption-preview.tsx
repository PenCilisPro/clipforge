"use client";

import { useEffect, useState } from "react";
import { CAPTION_FONTS, type Clip, type Clip as ClipType } from "@/lib/types";
import { cn } from "@/lib/utils";

const PREVIEW_WORDS = ["THIS", "IS", "HOW", "IT", "WORKS"];

// Accent applied to the currently-spoken word — mirrors the worker's
// per-template accent spans so previews match the final render.
const ACCENTS: Record<ClipType["caption_style"], string> = {
  classic: "text-primary-400",
  karaoke: "rounded bg-white px-1 text-primary-500",
  "bold-pop": "text-primary-400",
  neon: "text-white",
  meme: "text-primary-400",
};

function CaptionBody({
  style,
  fontKey,
  activeIndex,
}: {
  style: ClipType["caption_style"];
  fontKey: NonNullable<Clip["caption_font"]>;
  activeIndex: number;
}) {
  const cssVar = CAPTION_FONTS.find((f) => f.key === fontKey)?.cssVar ?? "";
  const phrase = PREVIEW_WORDS.join(" ");
  const accent = ACCENTS[style] ?? ACCENTS.classic;

  if (style === "karaoke") {
    return (
      <div
        className="rounded-md bg-[rgba(255,93,28,0.92)] px-2 py-1"
        style={{ fontFamily: cssVar }}
      >
        <span className="text-[11px] font-extrabold text-white">
          {PREVIEW_WORDS.map((word, i) => (
            <span key={word} className={cn(i === activeIndex && accent)}>
              {word}{" "}
            </span>
          ))}
        </span>
      </div>
    );
  }
  if (style === "bold-pop") {
    return (
      <div
        className="rounded bg-black/80 px-2 py-1 tracking-wide"
        style={{ fontFamily: cssVar }}
      >
        <span className="text-[11px] font-black uppercase text-white">
          {PREVIEW_WORDS.map((word, i) => (
            <span key={word} className={cn(i === activeIndex && accent)}>
              {word}{" "}
            </span>
          ))}
        </span>
      </div>
    );
  }
  if (style === "neon") {
    return (
      <div
        className="rounded-md bg-[rgba(3,28,41,0.85)] px-2 py-1 tracking-widest"
        style={{ fontFamily: cssVar }}
      >
        <span className="text-[11px] font-extrabold text-cyan-300">
          {PREVIEW_WORDS.map((word, i) => (
            <span key={word} className={cn(i === activeIndex && accent)}>
              {word}{" "}
            </span>
          ))}
        </span>
      </div>
    );
  }
  if (style === "meme") {
    return (
      <div className="px-1" style={{ fontFamily: cssVar }}>
        <span className="inline-block rounded bg-black px-2 py-1 text-[11px] font-black uppercase text-white">
          {PREVIEW_WORDS.map((word, i) => (
            <span key={word} className={cn(i === activeIndex && accent)}>
              {word}{" "}
            </span>
          ))}
        </span>
      </div>
    );
  }
  // classic — plain white text
  return (
    <div className="px-1" style={{ fontFamily: cssVar, textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
      {PREVIEW_WORDS.map((word, i) => (
        <span
          key={word}
          className={cn("text-[11px] font-extrabold text-white", i === activeIndex && accent)}
        >
          {word}{" "}
        </span>
      ))}
    </div>
  );
}

/**
 * Static template preview (highlight on a middle word) — used in the
 * regenerate dialog's template cards.
 */
export function CaptionPreview({
  style,
  fontKey,
}: {
  style: ClipType["caption_style"];
  fontKey: NonNullable<Clip["caption_font"]>;
}) {
  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-zinc-900 text-center">
      <CaptionBody style={style} fontKey={fontKey} activeIndex={2} />
    </div>
  );
}

/**
 * Animated caption preview — cycles the accent across the words to show the
 * word-sync highlighting the final render produces. Used in the clip editor.
 */
export function AnimatedCaptionPreview({
  style,
  fontKey,
}: {
  style: ClipType["caption_style"];
  fontKey: NonNullable<Clip["caption_font"]>;
}) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setActive((prev) => (prev + 1) % PREVIEW_WORDS.length);
    }, 450);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-zinc-900 text-center">
      <CaptionBody style={style} fontKey={fontKey} activeIndex={active} />
    </div>
  );
}
