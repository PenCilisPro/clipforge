"use client";

import { useEffect, useState } from "react";
import { CAPTION_FONTS, type CaptionFontKey, type CaptionStyle, type Clip } from "@/lib/types";
import { cn } from "@/lib/utils";

const PREVIEW_WORDS = ["THIS", "IS", "HOW", "IT", "WORKS"];

// Accent applied to the currently-spoken word — mirrors the worker's
// per-template accent spans so previews match the final render.
const ACCENTS: Record<CaptionStyle, string> = {
  classic: "text-primary-400",
  karaoke: "rounded bg-white px-1 text-primary-500",
  "bold-pop": "text-primary-400",
  neon: "text-white",
  meme: "text-primary-400",
  "green-screen": "rounded bg-black px-1 text-white",
  highlighter: "rounded bg-zinc-900 px-1 text-yellow-300",
  ocean: "rounded bg-white px-1 text-blue-700",
  bubblegum: "rounded bg-white px-1 text-pink-600",
  royal: "rounded bg-yellow-300 px-1 text-violet-700",
  "minimal-mono": "text-primary-400",
};

// Each template's own default text color — mirrors the worker's STYLES.
// '#ffffff' (or empty) keeps these defaults.
const DEFAULT_TEXT_COLOR: Record<CaptionStyle, string> = {
  classic: "#ffffff",
  karaoke: "#ffffff",
  "bold-pop": "#ffffff",
  neon: "#67e8f9",
  meme: "#ffffff",
  "green-screen": "#ffffff",
  highlighter: "#111827",
  ocean: "#e0f2fe",
  bubblegum: "#ffffff",
  royal: "#ffffff",
  "minimal-mono": "#e5e7eb",
};

export function resolveCaptionColor(style: CaptionStyle, textColor?: string | null) {
  return textColor && textColor.toLowerCase() !== "#ffffff"
    ? textColor
    : DEFAULT_TEXT_COLOR[style];
}

function WordSpan({
  word,
  active,
  accent,
  color,
  stroke,
  shadow,
  strokeColor = "#000000",
  strokeSize = 4,
  shadowColor = "#000000",
  shadowSize = 6,
}: {
  word: string;
  active: boolean;
  accent: string;
  color: string;
  stroke?: boolean;
  shadow?: boolean;
  strokeColor?: string;
  strokeSize?: number;
  shadowColor?: string;
  shadowSize?: number;
}) {
  // The real render fakes stroke/shadow with offset text copies in underlay
  // tracks; the browser preview approximates them with native CSS.
  const effectStyle: React.CSSProperties = {};
  if (stroke) {
    // Preview text is ~11px, so the 1-10 size maps to a sub-pixel-to-2px width.
    effectStyle.WebkitTextStrokeWidth = `${Math.min(2, strokeSize * 0.4)}px`;
    effectStyle.WebkitTextStrokeColor = strokeColor;
    effectStyle.paintOrder = "stroke fill";
  }
  if (shadow) {
    const px = Math.max(1, Math.round(shadowSize * 0.5));
    effectStyle.textShadow = `${px}px ${px}px 0 ${shadowColor}8c`;
  }
  return (
    <span
      className={cn(active && accent)}
      style={{ color: active ? undefined : color, ...effectStyle, borderRadius: stroke || shadow ? 2 : undefined }}
    >
      {word}{" "}
    </span>
  );
}

function CaptionBody({
  style,
  fontKey,
  activeIndex,
  textColor,
  stroke,
  shadow,
  strokeColor,
  strokeSize,
  shadowColor,
  shadowSize,
}: {
  style: CaptionStyle;
  fontKey: NonNullable<Clip["caption_font"]>;
  activeIndex: number;
  textColor?: string;
  stroke?: boolean;
  shadow?: boolean;
  strokeColor?: string;
  strokeSize?: number;
  shadowColor?: string;
  shadowSize?: number;
}) {
  const cssVar = CAPTION_FONTS.find((f) => f.key === fontKey)?.cssVar ?? "";
  const accent = ACCENTS[style] ?? ACCENTS.classic;
  const color = resolveCaptionColor(style, textColor);
  const words = () =>
    PREVIEW_WORDS.map((word) => (
      <WordSpan
        key={word}
        word={word}
        active={PREVIEW_WORDS.indexOf(word) === activeIndex}
        accent={accent}
        color={color}
        stroke={stroke}
        shadow={shadow}
        strokeColor={strokeColor}
        strokeSize={strokeSize}
        shadowColor={shadowColor}
        shadowSize={shadowSize}
      />
    ));

  const body = (() => {
    if (style === "karaoke") {
      return (
        <div className="rounded-md bg-[rgba(255,93,28,0.92)] px-2 py-1" style={{ fontFamily: cssVar }}>
          <span className="text-[11px] font-extrabold">{words()}</span>
        </div>
      );
    }
    if (style === "bold-pop") {
      return (
        <div className="rounded bg-black/80 px-2 py-1 tracking-wide" style={{ fontFamily: cssVar }}>
          <span className="text-[11px] font-black uppercase">{words()}</span>
        </div>
      );
    }
    if (style === "neon") {
      return (
        <div className="rounded-md bg-[rgba(3,28,41,0.85)] px-2 py-1 tracking-widest" style={{ fontFamily: cssVar }}>
          <span className="text-[11px] font-extrabold">{words()}</span>
        </div>
      );
    }
    if (style === "meme") {
      return (
        <div className="px-1" style={{ fontFamily: cssVar }}>
          <span className="inline-block rounded bg-black px-2 py-1 text-[11px] font-black uppercase">
            {words()}
          </span>
        </div>
      );
    }
    if (style === "green-screen") {
      return (
        <div className="rounded bg-[rgba(22,163,74,0.95)] px-2 py-1" style={{ fontFamily: cssVar }}>
          <span className="text-[11px] font-black uppercase">{words()}</span>
        </div>
      );
    }
    if (style === "highlighter") {
      return (
        <div className="px-1" style={{ fontFamily: cssVar }}>
          <span className="inline-block rounded bg-[#facc15] px-2 py-1 text-[11px] font-extrabold">
            {words()}
          </span>
        </div>
      );
    }
    if (style === "ocean") {
      return (
        <div className="rounded-md bg-[rgba(29,78,216,0.85)] px-2 py-1 tracking-wide" style={{ fontFamily: cssVar }}>
          <span className="text-[11px] font-extrabold">{words()}</span>
        </div>
      );
    }
    if (style === "bubblegum") {
      return (
        <div className="rounded-[10px] bg-[rgba(236,72,153,0.92)] px-2 py-1" style={{ fontFamily: cssVar }}>
          <span className="text-[11px] font-black">{words()}</span>
        </div>
      );
    }
    if (style === "royal") {
      return (
        <div className="rounded-md bg-[rgba(124,58,237,0.9)] px-2 py-1" style={{ fontFamily: cssVar }}>
          <span className="text-[11px] font-black uppercase">{words()}</span>
        </div>
      );
    }
    if (style === "minimal-mono") {
      return (
        <div className="px-1 tracking-[2px]" style={{ fontFamily: cssVar }}>
          <span className="text-[10px] font-semibold uppercase">{words()}</span>
        </div>
      );
    }
    // classic — plain text, no box
    return (
      <div className="px-1" style={{ fontFamily: cssVar }}>
        <span className="text-[11px] font-extrabold">{words()}</span>
      </div>
    );
  })();

  return <div className="flex items-center justify-center">{body}</div>;
}

interface PreviewProps {
  style: CaptionStyle;
  fontKey: NonNullable<Clip["caption_font"]>;
  textColor?: string;
  stroke?: boolean;
  shadow?: boolean;
  strokeColor?: string;
  strokeSize?: number;
  shadowColor?: string;
  shadowSize?: number;
}

/**
 * Static template preview (highlight on a middle word) — used in the
 * regenerate dialog's template cards and the style pickers.
 */
export function CaptionPreview(props: PreviewProps) {
  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-zinc-900 text-center">
      <CaptionBody {...props} activeIndex={2} />
    </div>
  );
}

/**
 * Animated caption preview — cycles the accent across the words to show the
 * word-sync highlighting the final render produces. Used in the clip editor
 * and on the New Project page.
 */
export function AnimatedCaptionPreview(props: PreviewProps) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setActive((prev) => (prev + 1) % PREVIEW_WORDS.length);
    }, 450);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-zinc-900 text-center">
      <CaptionBody {...props} activeIndex={active} />
    </div>
  );
}
