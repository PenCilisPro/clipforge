/**
 * Math + formatting helpers for the CapCut-style timeline editor.
 * Times on the timeline are SOURCE-video seconds; caption cues and B-roll
 * segments are stored clip-relative (0 = clip start) and converted at the edges.
 */
import type { SrtCue } from "@/lib/srt-client";
import type { TranscriptWord } from "@/lib/types";

/** The pipeline re-trims with a 3 s floor — the editor enforces the same. */
export const MIN_CLIP_SECONDS = 3;

/** Snap resolution for drags, in seconds. */
export const SNAP_SECONDS = 0.1;

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Round to the drag snap grid. */
export function snap(seconds: number) {
  return Number((Math.round(seconds / SNAP_SECONDS) * SNAP_SECONDS).toFixed(1));
}

/** `1:23.4` — sub-second precision matters when trimming. */
export function formatTimecode(seconds: number) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Nice ruler interval so major ticks land ~80 px apart at this zoom. */
export function rulerTickStep(pxPerSecond: number) {
  const raw = 80 / Math.max(pxPerSecond, 0.01);
  return TICK_STEPS.find((step) => step >= raw) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

/** px/s that fits `windowSeconds` (plus breathing room) into `widthPx`. */
export function fitZoom(windowSeconds: number, widthPx: number) {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0 || widthPx <= 0) return 20;
  return clamp(widthPx / (windowSeconds * 1.35), 2, 200);
}

/**
 * Build caption cues for the clip window straight from the word-level
 * transcript (source coordinates). Words are grouped into readable cues:
 * break on >42 chars, >1 s pause, or >3.5 s duration. Returns clip-relative
 * cues ready for the SRT editor.
 */
export function cuesFromTranscript(
  words: TranscriptWord[],
  clipStart: number,
  clipEnd: number
): SrtCue[] {
  const cues: SrtCue[] = [];
  let current: { start: number; end: number; text: string } | null = null;

  const push = () => {
    if (current && current.text.trim()) cues.push({ id: crypto.randomUUID(), ...current });
    current = null;
  };

  for (const word of words) {
    const wStart = Number(word.start);
    const wEnd = Number(word.end);
    if (!Number.isFinite(wStart) || !Number.isFinite(wEnd) || wEnd <= clipStart || wStart >= clipEnd)
      continue;
    const start = Math.max(0, wStart - clipStart);
    const end = Math.max(start + 0.1, Math.min(wEnd, clipEnd) - clipStart);
    const text = String(word.word ?? "").trim();
    if (!text) continue;

    const gap = current ? start - current.end : 0;
    const chars = current ? current.text.length + 1 + text.length : text.length;
    if (current && (chars > 42 || gap > 1 || end - current.start > 3.5)) push();
    if (!current) current = { start, end, text };
    else {
      current.end = end;
      current.text = `${current.text} ${text}`;
    }
  }
  push();

  // Serialize clamps ends to start+0.3 anyway; make the data honest upfront.
  return cues.map((c) => ({ ...c, end: Math.max(c.end, c.start + 0.3) }));
}
