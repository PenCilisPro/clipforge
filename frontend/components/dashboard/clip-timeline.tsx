"use client";

/**
 * StreamPal-style timeline for the full-screen clip editor: a time ruler, a
 * single source track with draggable trim handles at both edges, and a
 * playhead you can scrub. All times are SOURCE-video seconds (the trim
 * window selects the piece of the original that renders).
 */
import { useCallback, useRef } from "react";

import { clamp, formatTimecode, rulerTickStep } from "@/lib/timeline";

interface ClipTimelineProps {
  /** Total source-video duration in seconds. */
  duration: number;
  /** Clip window (source seconds). */
  start: number;
  end: number;
  /** Live trim updates while dragging. */
  onTrim: (start: number, end: number) => void;
  /** Fired once when a trim drag is released. */
  onTrimCommit?: () => void;
  /** Playhead position (source seconds). */
  playhead: number;
  /** Scrub the playhead (fires continuously while dragging). */
  onScrub: (time: number) => void;
  /** Zoom in px per second. */
  pxPerSec: number;
  /** Minimum clip length in seconds (matches the pipeline's 3 s floor). */
  minSeconds?: number;
}

type Drag =
  | { kind: "scrub" }
  | { kind: "trim"; which: "start" | "end"; originX: number; origStart: number; origEnd: number };

const RULER_H = 28;
const TRACK_H = 44;

export function ClipTimeline({
  duration,
  start,
  end,
  onTrim,
  onTrimCommit,
  playhead,
  onScrub,
  pxPerSec,
  minSeconds = 3,
}: ClipTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const durationRef = useRef(duration);
  durationRef.current = duration > 0 ? duration : Math.max(end, 1);

  const width = Math.max(durationRef.current * pxPerSec, 200);

  const timeAt = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left + el.scrollLeft;
      return clamp(x / pxPerSec, 0, durationRef.current);
    },
    [pxPerSec]
  );

  // Global pointer handlers are attached imperatively on pointer-down (refs
  // don't trigger effects, so an effect-based approach would never bind).
  const startDrag = (drag: Drag, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = drag;

    const move = (ev: PointerEvent) => {
      if (drag.kind === "scrub") {
        onScrub(timeAt(ev.clientX));
        return;
      }
      const delta = (ev.clientX - drag.originX) / pxPerSec;
      if (drag.which === "start") {
        onTrim(clamp(drag.origStart + delta, 0, drag.origEnd - minSeconds), drag.origEnd);
      } else {
        onTrim(
          drag.origStart,
          clamp(drag.origEnd + delta, drag.origStart + minSeconds, durationRef.current)
        );
      }
    };
    const up = () => {
      dragRef.current = null;
      if (drag.kind === "trim") onTrimCommit?.();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const beginTrimDrag = (which: "start" | "end") => (e: React.PointerEvent) => {
    startDrag({ kind: "trim", which, originX: e.clientX, origStart: start, origEnd: end }, e);
  };

  const scrubFromEvent = (e: React.PointerEvent) => {
    startDrag({ kind: "scrub" }, e);
  };

  const startPct = durationRef.current > 0 ? (start / durationRef.current) * 100 : 0;
  const endPct = durationRef.current > 0 ? (end / durationRef.current) * 100 : 100;
  const tick = rulerTickStep(pxPerSec);
  const ticks: number[] = [];
  for (let t = 0; t <= durationRef.current + 0.001; t += tick) ticks.push(Number(t.toFixed(2)));

  return (
    <div
            ref={scrollRef}
      onWheel={(e) => {
        // Vertical wheel input pans the timeline horizontally — natural for
        // a track wider than the viewport. Shift+wheel already does this
        // natively; this makes plain wheel do it too (unless the user is
        // zooming via ctrl+wheel).
        if (e.shiftKey || e.ctrlKey) return;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          scrollRef.current?.scrollBy({ left: e.deltaY });
          e.preventDefault();
        }
      }}
      className="overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="relative select-none" style={{ width }}>
        {/* Ruler */}
        <div
          className="relative cursor-pointer border-b border-white/10"
          style={{ height: RULER_H }}
          onPointerDown={scrubFromEvent}
        >
          {ticks.map((t) => (
            <div key={t} className="absolute top-0 h-full" style={{ left: t * pxPerSec }}>
              <span className="absolute left-1 top-1 text-[10px] tabular-nums text-zinc-500">
                {formatTimecode(t).replace(/\.0$/, "")}
              </span>
              <span className="absolute bottom-0 left-0 h-1.5 w-px bg-white/15" />
            </div>
          ))}
        </div>

        {/* Track */}
        <div className="relative py-3" style={{ height: TRACK_H + 24 }}>
          {/* Dimmed out-of-window regions */}
          <div
            className="absolute inset-y-3 left-0 rounded-l-md bg-black/50"
            style={{ width: `${startPct}%` }}
            onPointerDown={scrubFromEvent}
          />
          <div
            className="absolute inset-y-3 right-0 rounded-r-md bg-black/50"
            style={{ width: `${100 - endPct}%` }}
            onPointerDown={scrubFromEvent}
          />

          {/* Selected clip window */}
          <div
            className="absolute inset-y-3 rounded-md bg-gradient-to-b from-[#7c3aed] to-[#6d28d9] shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-white/10"
            style={{ left: `${startPct}%`, width: `${Math.max(endPct - startPct, 0.5)}%` }}
            onPointerDown={scrubFromEvent}
          >
            {/* Trim handles */}
            <div
              className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-start"
              onPointerDown={beginTrimDrag("start")}
            >
              <span className="h-full w-1.5 rounded-l-md bg-white/90" />
            </div>
            <div
              className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-end"
              onPointerDown={beginTrimDrag("end")}
            >
              <span className="h-full w-1.5 rounded-r-md bg-white/90" />
            </div>
          </div>

          {/* Playhead */}
          <div
            className="pointer-events-none absolute top-0 z-10"
            style={{ left: `${(playhead / Math.max(durationRef.current, 0.001)) * 100}%` }}
          >
            <div className="h-[3px] w-[3px] rounded-full bg-white" />
            <div className="absolute top-1.5 h-[68px] w-[2px] -translate-x-1/2 bg-white" />
          </div>
        </div>
      </div>
    </div>
  );
}
