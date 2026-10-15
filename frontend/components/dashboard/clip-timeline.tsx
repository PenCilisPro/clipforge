"use client";

/**
 * Infinite-canvas timeline: the clip sits anchored at 0:00 and both edges
 * can stretch into the surrounding source material (bounded by a runway
 * that keeps the canvas finite but feels endless while panning).
 */
import { useCallback, useEffect, useRef } from "react";

import { clamp, formatTimecode, rulerTickStep } from "@/lib/timeline";

interface ClipTimelineProps {
  /** Clip length in seconds (the block occupies 0 → clipDuration). */
  duration: number;
  /** How much runway is visible beyond the clip (source seconds). */
  runway?: number;
  /** Playhead position (clip-relative seconds). */
  playhead: number;
  /** Live trim updates while dragging (clip-relative times). */
  onTrim: (start: number, end: number) => void;
  /** Fired once when a trim drag is released. */
  onTrimCommit?: () => void;
  /** Scrub the playhead (clip-relative seconds). */
  onScrub: (time: number) => void;
  /** Zoom in px per second. */
  pxPerSec: number;
  /** Minimum clip length (matches the pipeline's 3 s floor). */
  minSeconds?: number;
  /** Max total clip length the source allows (start → source end). */
  maxDuration?: number;
}

type Drag =
  | { kind: "scrub" }
  | { kind: "trim"; which: "start" | "end"; originX: number; origStart: number; origEnd: number };

const RULER_H = 28;
const TRACK_H = 44;

export function ClipTimeline({
  duration,
  runway = 120,
  playhead,
  onTrim,
  onTrimCommit,
  onScrub,
  pxPerSec,
  minSeconds = 3,
  maxDuration = Infinity,
}: ClipTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const durationRef = useRef(duration);
  durationRef.current = Math.max(duration, minSeconds);

  // The canvas spans the clip plus runway on both sides (left runway exists
  // because the clip can stretch backwards into the source too — bounded by
  // what the source allows, which the parent enforces on commit).
  const runwayRef = useRef(runway);
  runwayRef.current = runway;

  const total = durationRef.current + runwayRef.current;
  const width = Math.max(total * pxPerSec, 200);

  // Wheel = horizontal pan (native listener, passive:false so
  // preventDefault works — React binds wheel as passive).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey || e.ctrlKey) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

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

  // Global pointer handlers (imperative — refs don't trigger effects).
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
        // Left edge: stretch left into 0..(origEnd - min) — dragging left
        // extends the clip backwards, right shrinks it.
        onTrim(clamp(drag.origStart + delta, 0, drag.origEnd - minSeconds), drag.origEnd);
      } else {
        // Right edge: stretch right into the runway — bounded by maxDuration.
        onTrim(
          drag.origStart,
          clamp(drag.origEnd + delta, drag.origStart + minSeconds, Math.min(durationRef.current + runwayRef.current, maxDuration))
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
    startDrag({ kind: "trim", which, originX: e.clientX, origStart: 0, origEnd: duration }, e);
  };

  const scrubFromEvent = (e: React.PointerEvent) => {
    startDrag({ kind: "scrub" }, e);
  };

  const clipEndPct = Math.min((durationRef.current / total) * 100, 100);
  const tick = rulerTickStep(pxPerSec);
  const ticks: number[] = [];
  for (let t = 0; t <= total + 0.001; t += tick) ticks.push(Number(t.toFixed(2)));

  return (
    <div
      ref={scrollRef}
      className="overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="relative select-none" style={{ width }}>
        {/* Ruler — 0:00 is the clip's first frame */}
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
          {/* Runway (source material beyond the clip) */}
          <div
            className="absolute inset-y-3 left-0 rounded-l-md bg-[#0f0f12] ring-1 ring-inset ring-white/5"
            style={{ width: "100%" }}
          />
          {/* "End of source" marker once runway exceeds maxDuration */}
          {maxDuration !== Infinity && (
            <div
              className="absolute inset-y-3 w-px bg-red-500/40"
              style={{ left: `${(Math.min(maxDuration, total) / total) * 100}%` }}
              title="End of source material"
            />
          )}

          {/* The clip block — anchored at 0:00, stretches to the right */}
          <div
            className="absolute inset-y-3 left-0 rounded-md bg-gradient-to-b from-[#7c3aed] to-[#6d28d9] shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-white/10"
            style={{ width: `${clipEndPct}%` }}
            onPointerDown={scrubFromEvent}
          >
            {/* Trim handles — both edges stretch the clip */}
            <div
              className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-start"
              onPointerDown={beginTrimDrag("start")}
            >
              <span className="h-full w-1.5 rounded-l-md bg-white/90" />
            </div>
            <div
              className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-end"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={beginTrimDrag("end")}
            >
              <span className="h-full w-1.5 rounded-r-md bg-white/90" />
            </div>
          </div>

          {/* Playhead */}
          <div
            className="pointer-events-none absolute top-0 z-10"
            style={{ left: `${(playhead / Math.max(total, 0.001)) * 100}%` }}
          >
            <div className="h-[3px] w-[3px] rounded-full bg-white" />
            <div className="absolute top-1.5 h-[68px] w-[2px] -translate-x-1/2 bg-white" />
          </div>
        </div>
      </div>
    </div>
  );
}