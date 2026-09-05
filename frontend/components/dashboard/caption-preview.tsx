"use client";

import { CAPTION_FONTS, type Clip, type Clip as ClipType } from "@/lib/types";
import { cn } from "@/lib/utils";

const PREVIEW_PHRASE = ["THIS", "IS", "HOW", "IT", "WORKS"];

/**
 * Miniature preview of a caption template rendered with the selected font.
 * Mirrors what the worker's HTML clips produce on Shotstack (boxed templates
 * render as one rounded chip per cue; one word is accented brand-orange).
 */
export function CaptionPreview({
  style,
  fontKey,
}: {
  style: ClipType["caption_style"];
  fontKey: NonNullable<Clip["caption_font"]>;
}) {
  const cssVar = CAPTION_FONTS.find((f) => f.key === fontKey)?.cssVar ?? "";
  const phrase = PREVIEW_PHRASE.join(" ");

  let caption: React.ReactNode;
  if (style === "karaoke") {
    caption = (
      <div
        className="rounded-md bg-[rgba(255,93,28,0.92)] px-2 py-1"
        style={{ fontFamily: cssVar }}
      >
        <span className="text-[11px] font-extrabold text-white">{phrase}</span>
      </div>
    );
  } else if (style === "bold-pop") {
    caption = (
      <div
        className="rounded bg-black/80 px-2 py-1 tracking-wide"
        style={{ fontFamily: cssVar }}
      >
        <span className="text-[11px] font-black uppercase text-white">{phrase}</span>
      </div>
    );
  } else if (style === "neon") {
    caption = (
      <div
        className="rounded-md bg-[rgba(3,28,41,0.85)] px-2 py-1 tracking-widest"
        style={{ fontFamily: cssVar }}
      >
        <span className="text-[11px] font-extrabold text-cyan-300">{phrase}</span>
      </div>
    );
  } else if (style === "meme") {
    caption = (
      <div className="px-1" style={{ fontFamily: cssVar }}>
        <span className="inline-block rounded bg-black px-2 py-1 text-[11px] font-black uppercase text-white">
          {phrase}
        </span>
      </div>
    );
  } else {
    // classic — plain white text, accent word in brand orange
    caption = (
      <div className="px-1" style={{ fontFamily: cssVar, textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
        {PREVIEW_PHRASE.map((word, i) => (
          <span
            key={word}
            className={cn("text-[11px] font-extrabold text-white", i === 2 && "text-primary-400")}
          >
            {word}{" "}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-zinc-900 text-center">
      {caption}
    </div>
  );
}
