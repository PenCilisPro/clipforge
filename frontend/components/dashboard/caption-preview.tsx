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

function WordSpan({
  word,
  active,
  accent,
  stroke,
  shadow,
}: {
  word: string;
  active: boolean;
  accent: string;
  stroke?: boolean;
  shadow?: boolean;
}) {
  // The real render fakes stroke/shadow with offset text copies in underlay
  // tracks; the browser preview approximates them with native CSS.
  const effectStyle: React.CSSProperties = {};
  if (stroke) {
    effectStyle.WebkitTextStrokeWidth = "2px";
    effectStyle.WebkitTextStrokeColor = "#000";
    effectStyle.paintOrder = "stroke fill";
  }
  if (shadow) {
    effectStyle.textShadow = "3px 3px 0 rgba(0,0,0,0.55)";
  }
  return (
    <span
      className={cn(active && accent)}
      style={{ ...effectStyle, borderRadius: stroke || shadow ? 2 : undefined }}
    >
      {word}{" "}
    </span>
  );
}

function CaptionBody({
  style,
  fontKey,
  activeIndex,
  stroke,
  shadow,
}: {
  style: ClipType["caption_style"];
  fontKey: NonNullable<Clip["caption_font"]>;
  activeIndex: number;
  stroke?: boolean;
  shadow?: boolean;
}) {
  const cssVar = CAPTION_FONTS.find((f) => f.key === fontKey)?.cssVar ?? "";
  const accent = ACCENTS[style] ?? ACCENTS.classic;
  const words = () =>
    PREVIEW_WORDS.map((word) => (
      <WordSpan
        key={word}
        word={word}
        active={PREVIEW_WORDS.indexOf(word) === activeIndex}
        accent={accent}
        stroke={stroke}
        shadow={shadow}
      />
    ));

  if (style === "karaoke") {
    return (
      <div
        className="rounded-md bg-[rgba(255,93,28,0.92)] px-2 py-1"
        style={{ fontFamily: cssVar }}
      >
        <span className="text-[11px] font-extrabold text-white">{words()}</span>
      </div>
    );
  }
  if (style === "bold-pop") {
    return (
      <div
        className="rounded bg-black/80 px-2 py-1 tracking-wide"
        style={{ fontFamily: cssVar }}
      >
        <span className="text-[11px] font-black uppercase text-white">{words()}</span>
      </div>
    );
  }
  if (style === "neon") {
    return (
      <div
        className="rounded-md bg-[rgba(3,28,41,0.85)] px-2 py-1 tracking-widest"
        style={{ fontFamily: cssVar }}
      >
        <span className="text-[11px] font-extrabold text-cyan-300">{words()}</span>
      </div>
    );
  }
  if (style === "meme") {
    return (
      <div className="px-1" style={{ fontFamily: cssVar }}>
        <span className="inline-block rounded bg-black px-2 py-1 text-[11px] font-black uppercase text-white">
          {words()}
        </span>
      </div>
    );
  }
  // classic — plain white text
  return (
    <div className="px-1" style={{ fontFamily: cssVar }}>
      <span className="text-[11px] font-extrabold text-white">{words()}</span>
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
  stroke,
  shadow,
}: {
  style: ClipType["caption_style"];
  fontKey: NonNullable<Clip["caption_font"]>;
  stroke?: boolean;
  shadow?: boolean;
}) {
  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-zinc-900 text-center">
      <CaptionBody style={style} fontKey={fontKey} activeIndex={2} stroke={stroke} shadow={shadow} />
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
  stroke,
  shadow,
}: {
  style: ClipType["caption_style"];
  fontKey: NonNullable<Clip["caption_font"]>;
  stroke?: boolean;
  shadow?: boolean;
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
      <CaptionBody
        style={style}
        fontKey={fontKey}
        activeIndex={active}
        stroke={stroke}
        shadow={shadow}
      />
    </div>
  );
}
