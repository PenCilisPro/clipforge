import type { CSSProperties } from "react";

export type CaptionAnimId =
  | "none" | "pop" | "bounce" | "shake"
  | "fade" | "typewriter" | "slideUp";

export const CAPTION_ANIMS: { id: CaptionAnimId; label: string }[] = [
  { id: "none", label: "None" },
  { id: "pop", label: "Pop" },
  { id: "bounce", label: "Bounce" },
  { id: "shake", label: "Shake" },
  { id: "fade", label: "Fade" },
  { id: "typewriter", label: "Typewriter" },
  { id: "slideUp", label: "Slide Up" },
];

/** Per-word style for the karaoke overlay */
export function wordAnimStyle(
  anim: CaptionAnimId,
  isActive: boolean,
  hasActive: boolean
): CSSProperties {
  switch (anim) {
    case "pop":
      return {
        display: "inline-block",
        transform: isActive ? "translateY(-3px) scale(1.15)" : "translateY(0) scale(1)",
        transition: "color 80ms linear, transform 120ms cubic-bezier(0.34, 1.56, 0.64, 1)",
      };
    case "bounce":
      return {
        display: "inline-block",
        transform: isActive ? "translateY(-8px) scale(1.25)" : "translateY(0) scale(1)",
        transition: "color 80ms linear, transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1)",
      };
    case "shake":
      return {
        display: "inline-block",
        animation: isActive ? "cfShake 300ms linear" : undefined,
        transition: "color 80ms linear",
      };
    case "fade":
  return {
    display: "inline-block",
    transition: "color 80ms linear",
  };
    case "typewriter":
      return {
        display: "inline-block",
        visibility: !hasActive || isActive ? "visible" : "hidden",
      };
    default:
      return { transition: "color 80ms linear" };
  }
}