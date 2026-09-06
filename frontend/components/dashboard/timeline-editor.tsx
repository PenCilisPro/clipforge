"use client";

/**
 * CapCut-style timeline editor for a clip: filmstrip + trim handles over the
 * source video, a scrubbable playhead, and draggable caption / B-roll blocks.
 * All times on the timeline are source-video seconds; cues and B-roll segments
 * are clip-relative and offset by the trim window at the edges.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Scissors,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatDuration } from "@/lib/utils";
import {
  MIN_CLIP_SECONDS,
  clamp,
  fitZoom,
  formatTimecode,
  rulerTickStep,
  snap,
} from "@/lib/timeline";
import type { SrtCue } from "@/lib/srt-client";

export interface BrollSegment {
  start: number;
  end: number;
  src: string;
}

interface TimelineEditorProps {
  /** Signed source-video URL; null = split upload, editing works without playback. */
  videoUrl: string | null;
  /** Project duration fallback until the video's metadata loads. */
  sourceDuration: number | null;
  /** Clip window in source seconds. */
  start: number;
  end: number;
  onTrim: (start: number, end: number) => void;
  /** Fired once when a trim drag is released (commit-time side effects). */
  onTrimCommit?: () => void;
  cues: SrtCue[];
  onCuesChange: (cues: SrtCue[]) => void;
  /** null = AI plans B-roll at render; [] = off. */
  broll: BrollSegment[] | null;
  /** commit=false updates local state during a drag; true persists to the API. */
  onBrollChange: (segments: BrollSegment[], commit: boolean) => void;
  musicTitle: string | null;
}

type Drag =
  | { kind: "scrub" }
  | { kind: "trim"; which: "start" | "end"; originX: number; origStart: number; origEnd: number }
  | { kind: "cue"; id: string; mode: "move" | "resize-l" | "resize-r"; originX: number; orig: SrtCue }
  | {
      kind: "broll";
      index: number;
      mode: "move" | "resize-l" | "resize-r";
      originX: number;
      orig: BrollSegment;
    };

const CELL_W = 96;
const FILMSTRIP_H = 72;

export function TimelineEditor({
  videoUrl,
  sourceDuration,
  start,
  end,
  onTrim,
  onTrimCommit,
  cues,
  onCuesChange,
  broll,
  onBrollChange,
  musicTitle,
}: TimelineEditorProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captureVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const timecodeRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const rafRef = useRef<number | null>(null);
  const fittedRef = useRef(false);
  const thumbsCacheRef = useRef<Map<number, string>>(new Map());
  const thumbQueueRef = useRef<number[]>([]);
  const thumbBusyRef = useRef(false);
  const thumbFailedRef = useRef(false);
  const pxPerSecRef = useRef(20);
  const durationRef = useRef(0);
  const isPlayingRef = useRef(false);
  const loopRef = useRef(true);
  const startRef = useRef(start);
  const endRef = useRef(end);
  const brollRef = useRef<BrollSegment[]>([]);

  const [pxPerSec, setPxPerSec] = useState(20);
  const [containerWidth, setContainerWidth] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [loop, setLoop] = useState(true);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [thumbsFailed, setThumbsFailed] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [startText, setStartText] = useState("0");
  const [endText, setEndText] = useState("0");

  const duration = videoDuration || sourceDuration || end + 60;
  const windowLen = Math.max(MIN_CLIP_SECONDS, end - start);
  pxPerSecRef.current = pxPerSec;
  durationRef.current = duration;
  isPlayingRef.current = isPlaying;
  loopRef.current = loop;
  startRef.current = start;
  endRef.current = end;
  brollRef.current = broll ?? [];

  // Keep the text fields in sync with externally-driven changes (drags, load).
  useEffect(() => setStartText(String(Number(start.toFixed(1)))), [start]);
  useEffect(() => setEndText(String(Number(end.toFixed(1)))), [end]);

  const canPlay = Boolean(videoUrl) && !videoError;
  const contentWidth = Math.max(duration * pxPerSec, containerWidth);
  const cellCount = Math.ceil(contentWidth / CELL_W);

  // ---------- container width + initial zoom fit ----------

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (fittedRef.current || containerWidth <= 0) return;
    fittedRef.current = true;
    const fit = fitZoom(windowLen, containerWidth);
    setPxPerSec(fit);
    scrollRef.current?.scrollTo({ left: Math.max(0, start * fit - 48) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerWidth]);

  function zoomBy(factor: number) {
    setPxPerSec((prev) => {
      const next = clamp(Number((prev * factor).toFixed(2)), 2, 200);
      const el = scrollRef.current;
      if (el) el.scrollLeft = Math.max(0, start * next - 48);
      return next;
    });
  }

  function zoomFit() {
    if (containerWidth <= 0) return;
    const next = fitZoom(windowLen, containerWidth);
    setPxPerSec(next);
    scrollRef.current?.scrollTo({ left: Math.max(0, start * next - 48) });
  }

  // ---------- filmstrip thumbnails ----------

  /** Seek the hidden capture video and grab a JPEG frame. */
  const captureAt = useCallback((t: number): Promise<string | null> => {
    return new Promise((resolve) => {
      const v = captureVideoRef.current;
      if (!v || thumbFailedRef.current) return resolve(null);

      const grab = () => {
        const canvas = canvasRef.current ?? (canvasRef.current = document.createElement("canvas"));
        canvas.width = 128;
        canvas.height = Math.max(72, Math.round(128 * (v.videoHeight / Math.max(v.videoWidth, 1))));
        try {
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(null);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.6));
        } catch {
          // Tainted canvas (no CORS headers) — give up on the filmstrip for good.
          thumbFailedRef.current = true;
          resolve(null);
        }
      };

      const onSeeked = () => {
        v.removeEventListener("seeked", onSeeked);
        grab();
      };

      if (!v.videoWidth) {
        // Metadata hasn't arrived yet — wait briefly, then treat as unavailable.
        const onReady = () => {
          cleanup();
          if (v.videoWidth) {
            v.addEventListener("seeked", onSeeked);
            v.currentTime = t;
          } else {
            resolve(null);
          }
        };
        const onError = () => {
          cleanup();
          thumbFailedRef.current = true;
          resolve(null);
        };
        const timer = setTimeout(onError, 8000);
        const cleanup = () => {
          clearTimeout(timer);
          v.removeEventListener("loadeddata", onReady);
          v.removeEventListener("error", onError);
        };
        v.addEventListener("loadeddata", onReady);
        v.addEventListener("error", onError);
        return;
      }

      v.addEventListener("seeked", onSeeked);
      const maxT = Number.isFinite(v.duration) && v.duration > 0 ? v.duration - 0.05 : t;
      v.currentTime = clamp(t, 0, Math.max(0, maxT));
    });
  }, []);

  /** Queue thumbnails for the filmstrip cells near the scroll viewport. */
  const ensureThumbs = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !videoUrl || thumbFailedRef.current) return;
    if (cellCount > 400) return; // zoomed too far out — gradient fallback
    const pps = pxPerSecRef.current;
    const dur = durationRef.current;
    const iFrom = Math.max(0, Math.floor((el.scrollLeft - CELL_W) / CELL_W));
    const iTo = Math.ceil((el.scrollLeft + el.clientWidth + CELL_W) / CELL_W);
    const wanted: number[] = [];
    for (let i = iFrom; i <= iTo; i++) {
      const center = clamp((i * CELL_W + CELL_W / 2) / pps, 0, dur);
      const bucket = Math.round(center * 2) / 2;
      if (bucket >= dur || thumbsCacheRef.current.has(bucket)) continue;
      if (!wanted.includes(bucket)) wanted.push(bucket);
    }
    if (wanted.length === 0) return;
    thumbQueueRef.current = wanted.concat(thumbQueueRef.current).slice(0, 120);

    if (thumbBusyRef.current) return;
    thumbBusyRef.current = true;
    void (async () => {
      while (thumbQueueRef.current.length > 0 && !thumbFailedRef.current) {
        const bucket = thumbQueueRef.current.shift();
        if (bucket == null || thumbsCacheRef.current.has(bucket)) continue;
        const url = await captureAt(bucket);
        if (!url) {
          setThumbsFailed(true);
          break;
        }
        if (thumbsCacheRef.current.size > 500) {
          thumbsCacheRef.current.clear();
          setThumbs({});
        }
        thumbsCacheRef.current.set(bucket, url);
        setThumbs((prev) => ({ ...prev, [bucket]: url }));
      }
      thumbBusyRef.current = false;
    })();
  }, [videoUrl, cellCount, captureAt]);

  // Reset the filmstrip when the source changes.
  useEffect(() => {
    thumbsCacheRef.current.clear();
    thumbQueueRef.current = [];
    thumbFailedRef.current = false;
    setThumbs({});
    setThumbsFailed(false);
  }, [videoUrl]);

  // Debounced (re)capture on zoom/resize/trim.
  useEffect(() => {
    if (!videoUrl) return;
    const id = setTimeout(ensureThumbs, 250);
    return () => clearTimeout(id);
  }, [videoUrl, pxPerSec, containerWidth, start, end, ensureThumbs]);

  function onTimelineScroll() {
    ensureThumbs();
  }

  // ---------- playback sync (rAF; playhead/timecode via refs, no re-renders) ----------

  useEffect(() => {
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const video = videoRef.current;
      const ph = playheadRef.current;
      if (!ph) return;
      const t = video ? video.currentTime : 0;
      ph.style.left = `${t * pxPerSecRef.current}px`;
      if (timecodeRef.current) timecodeRef.current.textContent = formatTimecode(t);
      if (video && isPlayingRef.current && t >= endRef.current) {
        if (loopRef.current && startRef.current < endRef.current) {
          video.currentTime = startRef.current;
        } else {
          video.pause();
        }
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  function seek(t: number) {
    const video = videoRef.current;
    if (!video || !canPlay) return;
    video.currentTime = clamp(snap(t), 0, duration);
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video || !canPlay) return;
    if (video.paused) {
      if (video.currentTime < start || video.currentTime >= end) video.currentTime = start;
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  // ---------- drag handling ----------

  function beginDrag(e: React.PointerEvent, drag: Drag) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = drag;
    if (drag.kind === "scrub") seek(scrubTime(e));
  }

  function scrubTime(e: React.PointerEvent) {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return (e.clientX - rect.left) / pxPerSec;
  }

  function onDragMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "scrub") {
      seek(scrubTime(e));
      return;
    }
    const dt = (e.clientX - drag.originX) / pxPerSec;

    if (drag.kind === "trim") {
      if (drag.which === "start") {
        const s = clamp(snap(drag.origStart + dt), 0, drag.origEnd - MIN_CLIP_SECONDS);
        onTrim(s, drag.origEnd);
      } else {
        const en = clamp(
          snap(drag.origEnd + dt),
          drag.origStart + MIN_CLIP_SECONDS,
          duration
        );
        onTrim(drag.origStart, en);
      }
      return;
    }
    if (drag.kind === "cue") {
      const len = Math.max(0.3, drag.orig.end - drag.orig.start);
      if (drag.mode === "move") {
        const s = clamp(snap(drag.orig.start + dt), 0, Math.max(0, windowLen - len));
        onCuesChange(cues.map((c) => (c.id === drag.id ? { ...c, start: s, end: s + len } : c)));
      } else if (drag.mode === "resize-l") {
        const s = clamp(snap(drag.orig.start + dt), 0, drag.orig.end - 0.3);
        onCuesChange(cues.map((c) => (c.id === drag.id ? { ...c, start: s } : c)));
      } else {
        const en = clamp(snap(drag.orig.end + dt), drag.orig.start + 0.3, windowLen);
        onCuesChange(cues.map((c) => (c.id === drag.id ? { ...c, end: en } : c)));
      }
      return;
    }
    if (drag.kind === "broll") {
      const len = Math.max(0.5, drag.orig.end - drag.orig.start);
      let next: BrollSegment;
      if (drag.mode === "move") {
        const s = clamp(snap(drag.orig.start + dt), 0, Math.max(0, windowLen - len));
        next = { ...drag.orig, start: s, end: s + len };
      } else if (drag.mode === "resize-l") {
        const s = clamp(snap(drag.orig.start + dt), 0, drag.orig.end - 0.5);
        next = { ...drag.orig, start: s };
      } else {
        const en = clamp(snap(drag.orig.end + dt), drag.orig.start + 0.5, windowLen);
        next = { ...drag.orig, end: en };
      }
      applyBroll(drag.index, next, false);
    }
  }

  function onDragUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.kind === "broll") {
      const seg = brollRef.current[drag.index];
      if (seg) applyBroll(drag.index, seg, true);
    }
    if (drag?.kind === "trim") {
      ensureThumbs();
      onTrimCommit?.();
    }
  }

  function applyBroll(index: number, seg: BrollSegment, commit: boolean) {
    const next = brollRef.current.map((s, i) => (i === index ? seg : s));
    onBrollChange(next, commit);
  }

  function removeBroll(index: number) {
    onBrollChange(
      brollRef.current.filter((_, i) => i !== index),
      true
    );
  }

  /** Scrub handlers shared by the ruler, filmstrip and lane backgrounds. */
  const scrubHandlers = {
    onPointerDown: (e: React.PointerEvent) => beginDrag(e, { kind: "scrub" }),
    onPointerMove: onDragMove,
    onPointerUp: onDragUp,
    onPointerCancel: onDragUp,
  };

  function cueById(id: string): SrtCue {
    return cues.find((c) => c.id === id) ?? { id, start: 0, end: 1, text: "" };
  }

  function brollByIndex(index: number): BrollSegment {
    return brollRef.current[index] ?? { start: 0, end: 1, src: "" };
  }

  const renderBlocks = (
    kind: "cue" | "broll",
    items: { key: string; relStart: number; relEnd: number; label: string }[]
  ) =>
    items.map((item) => {
      const left = (start + item.relStart) * pxPerSec;
      const width = Math.max(10, (item.relEnd - item.relStart) * pxPerSec);
      const isCue = kind === "cue";
      const dragFor = (mode: "move" | "resize-l" | "resize-r", originX: number): Drag =>
        isCue
          ? { kind: "cue", id: item.key, mode, originX, orig: cueById(item.key) }
          : { kind: "broll", index: Number(item.key), mode, originX, orig: brollByIndex(Number(item.key)) };
      return (
        <div
          key={`${kind}-${item.key}`}
          className={cn(
            "group absolute bottom-1 top-4 cursor-grab select-none overflow-hidden rounded-md border text-[10px] leading-tight",
            isCue
              ? "border-primary-500/70 bg-primary-500/20 hover:bg-primary-500/30"
              : "border-sky-400/70 bg-sky-400/20 hover:bg-sky-400/30"
          )}
          style={{ left, width }}
          onPointerDown={(e) => beginDrag(e, dragFor("move", e.clientX))}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
          onPointerCancel={onDragUp}
        >
          <span
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize"
            onPointerDown={(e) => beginDrag(e, dragFor("resize-l", e.clientX))}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
            onPointerCancel={onDragUp}
          />
          <span
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize"
            onPointerDown={(e) => beginDrag(e, dragFor("resize-r", e.clientX))}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
            onPointerCancel={onDragUp}
          />
          <span className="pointer-events-none block px-2 py-0.5 text-foreground/90">
            {item.label}
          </span>
          {!isCue && (
            <button
              type="button"
              aria-label="Remove B-roll scene"
              className="absolute right-0.5 top-0.5 hidden rounded bg-black/60 p-0.5 text-white group-hover:block"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => removeBroll(Number(item.key))}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </div>
      );
    });

  const trimHandle = (which: "start" | "end") => {
    const t = which === "start" ? start : end;
    return (
      <div
        role="slider"
        aria-label={which === "start" ? "Trim start" : "Trim end"}
        aria-valuenow={Math.round(t)}
        className="absolute inset-y-0 z-20 -ml-2 w-4 cursor-col-resize"
        style={{ left: t * pxPerSec }}
        onPointerDown={(e) =>
          beginDrag(e, { kind: "trim", which, originX: e.clientX, origStart: start, origEnd: end })
        }
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        onPointerCancel={onDragUp}
      >
        <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-primary-500 shadow" />
        <div className="absolute left-1/2 top-1/2 h-6 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-primary-500 shadow" />
        <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-primary-500 px-1 text-[9px] font-semibold text-white shadow">
          {formatTimecode(t)}
        </span>
      </div>
    );
  };

  function commitStartText() {
    const s = clamp(Number(startText) || 0, 0, Math.max(0, end - MIN_CLIP_SECONDS));
    onTrim(s, end);
  }

  function commitEndText() {
    const en = clamp(Number(endText) || 0, start + MIN_CLIP_SECONDS, duration);
    onTrim(start, en);
  }

  const ticks: number[] = [];
  const step = rulerTickStep(pxPerSec);
  for (let t = 0; t <= duration + step / 2 && ticks.length < 500; t += step) ticks.push(t);

  return (
    <div className="space-y-3">
      {/* Top row: preview player + controls */}
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="w-full shrink-0 sm:w-40">
          <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg border bg-zinc-900">
            {videoUrl && !videoError ? (
              <video
                ref={videoRef}
                src={videoUrl}
                playsInline
                preload="auto"
                muted={isMuted}
                className="h-full w-full cursor-pointer object-contain"
                onClick={togglePlay}
                onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration || 0)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onError={() => setVideoError(true)}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-[11px] text-muted-foreground">
                <Scissors className="h-5 w-5" />
                {videoError
                  ? "Source video unavailable — trim by dragging the handles."
                  : "Split uploads can't stream here. Trim with the handles or type times below."}
              </div>
            )}
            {!isPlaying && canPlay && (
              <button
                type="button"
                aria-label="Play"
                onClick={togglePlay}
                className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors hover:bg-black/40"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-500 text-white shadow-lg">
                  <Play className="ml-0.5 h-5 w-5" />
                </span>
              </button>
            )}
          </div>
          <div className="mt-2 flex items-center justify-center gap-1">
            <Button
              size="icon"
              variant="outline"
              className="h-7 w-7"
              aria-label={isPlaying ? "Pause" : "Play"}
              onClick={togglePlay}
              disabled={!canPlay}
            >
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="h-7 w-7"
              aria-label={isMuted ? "Unmute preview" : "Mute preview"}
              onClick={() => setIsMuted((m) => !m)}
              disabled={!canPlay}
            >
              {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </Button>
            <span ref={timecodeRef} className="ml-1 text-xs tabular-nums text-muted-foreground">
              0:00.0
            </span>
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">Start (s)</label>
              <Input
                type="number"
                min={0}
                step={0.1}
                value={startText}
                onChange={(e) => setStartText(e.target.value)}
                onBlur={commitStartText}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">End (s)</label>
              <Input
                type="number"
                min={MIN_CLIP_SECONDS}
                step={0.1}
                value={endText}
                onChange={(e) => setEndText(e.target.value)}
                onBlur={commitEndText}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">Length</label>
              <div className="flex h-8 items-center">
                <Badge variant="secondary">{formatDuration(windowLen)}</Badge>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!canPlay}
              onClick={() => {
                const s = clamp(snap(videoRef.current?.currentTime ?? 0), 0, end - MIN_CLIP_SECONDS);
                onTrim(s, end);
              }}
            >
              <Scissors className="h-3.5 w-3.5" /> Set in
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!canPlay}
              onClick={() => {
                const en = clamp(
                  snap(videoRef.current?.currentTime ?? 0),
                  start + MIN_CLIP_SECONDS,
                  duration
                );
                onTrim(start, en);
              }}
            >
              <Scissors className="h-3.5 w-3.5" /> Set out
            </Button>
            <Button
              size="sm"
              variant={loop ? "secondary" : "ghost"}
              className={cn("h-7 text-xs", loop && "text-primary-600 dark:text-primary-400")}
              onClick={() => setLoop((l) => !l)}
              aria-pressed={loop}
              disabled={!canPlay}
            >
              <Repeat className="h-3.5 w-3.5" /> Loop window
            </Button>
            <div className="ml-auto flex items-center gap-1">
              <Button size="icon" variant="outline" className="h-7 w-7" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.6)}>
                <ZoomOut className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="outline" className="h-7 w-7" aria-label="Fit window to view" onClick={zoomFit}>
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="outline" className="h-7 w-7" aria-label="Zoom in" onClick={() => zoomBy(1.6)}>
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Drag the orange handles to re-trim, click the strip to scrub, and drag caption /
            B-roll blocks to retime them. Changes apply when you save &amp; re-render.
          </p>
        </div>
      </div>

      {/* Timeline: ruler + filmstrip + lanes */}
      <div
        ref={scrollRef}
        className="overflow-x-auto overflow-y-hidden rounded-lg border bg-muted/40 [scrollbar-width:thin]"
        onScroll={onTimelineScroll}
      >
        <div
          ref={contentRef}
          className="relative select-none"
          style={{ width: contentWidth, minWidth: "100%" }}
        >
          {/* Ruler */}
          <div className="relative h-6 border-b bg-background/60" {...scrubHandlers}>
            {ticks.map((t) => (
              <div key={t} className="absolute top-0 h-full" style={{ left: t * pxPerSec }}>
                <span className="absolute left-1 top-0.5 text-[9px] tabular-nums text-muted-foreground">
                  {step < 1 ? formatTimecode(t) : formatDuration(t)}
                </span>
                <span className="absolute bottom-0 left-0 h-1.5 w-px bg-border" />
              </div>
            ))}
          </div>

          {/* Filmstrip with trim window */}
          <div className="relative" style={{ height: FILMSTRIP_H }} {...scrubHandlers}>
            {cellCount > 400 || thumbsFailed ? (
              <div className="absolute inset-0 bg-gradient-to-b from-zinc-700/50 to-zinc-800/50" />
            ) : (
              Array.from({ length: cellCount }, (_, i) => {
                const bucket = Math.round(((i * CELL_W + CELL_W / 2) / pxPerSec) * 2) / 2;
                const src = thumbs[bucket];
                return (
                  <div
                    key={i}
                    className={cn(
                      "absolute inset-y-0 overflow-hidden border-r border-background/40",
                      src ? "bg-zinc-800" : "bg-gradient-to-b from-zinc-700/40 to-zinc-800/40"
                    )}
                    style={{ left: i * CELL_W, width: CELL_W }}
                  >
                    {src && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
                    )}
                  </div>
                );
              })
            )}
            {/* Dimmed regions outside the trim window */}
            <div
              className="pointer-events-none absolute inset-y-0 left-0 bg-black/60"
              style={{ width: Math.max(0, start * pxPerSec) }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 bg-black/60"
              style={{ width: Math.max(0, contentWidth - end * pxPerSec) }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 border-x-2 border-primary-500"
              style={{ left: start * pxPerSec, width: Math.max(2, windowLen * pxPerSec) }}
            />
            {trimHandle("start")}
            {trimHandle("end")}
          </div>

          {/* Captions lane */}
          <div className="relative h-10 border-t bg-background/40" {...scrubHandlers}>
            <span className="absolute left-1 top-0.5 z-10 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              Captions
            </span>
            {renderBlocks(
              "cue",
              cues.map((c) => ({
                key: c.id,
                relStart: c.start,
                relEnd: Math.max(c.end, c.start + 0.3),
                label: c.text,
              }))
            )}
            {cues.length === 0 && (
              <span className="absolute left-20 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                No captions — add lines below or auto-fill from the transcript.
              </span>
            )}
          </div>

          {/* B-roll lane */}
          <div className="relative h-10 border-t bg-background/40" {...scrubHandlers}>
            <span className="absolute left-1 top-0.5 z-10 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              B-roll
            </span>
            {broll != null &&
              renderBlocks(
                "broll",
                broll.map((s, i) => ({
                  key: String(i),
                  relStart: s.start,
                  relEnd: s.end,
                  label: `Scene ${i + 1}`,
                }))
              )}
            {broll == null && (
              <span className="absolute left-20 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                Auto — AI plans B-roll at render. Add scenes below to take control.
              </span>
            )}
            {broll != null && broll.length === 0 && (
              <span className="absolute left-20 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                B-roll is off for this clip.
              </span>
            )}
          </div>

          {/* Music lane (read-only — music is project-wide) */}
          <div className="relative h-7 border-t bg-background/40" {...scrubHandlers}>
            <div
              className="absolute bottom-0.5 top-1 rounded bg-violet-400/25"
              style={{ left: start * pxPerSec, width: Math.max(2, windowLen * pxPerSec) }}
            />
            <span className="absolute left-1 top-0.5 z-10 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              Music
            </span>
            <span
              className="pointer-events-none absolute top-1/2 z-10 max-w-[180px] -translate-y-1/2 truncate pl-2 text-[10px] text-foreground/80"
              style={{ left: start * pxPerSec }}
            >
              {musicTitle ?? "No music"}
            </span>
          </div>

          {/* Playhead */}
          <div
            ref={playheadRef}
            className={cn(
              "pointer-events-none absolute bottom-0 top-0 z-30 w-[2px] bg-primary-500",
              !canPlay && "opacity-0"
            )}
            style={{ left: 0 }}
          >
            <div
              className="pointer-events-auto absolute left-1/2 top-0 h-3 w-3 -translate-x-1/2 cursor-ew-resize rounded-b-sm bg-primary-500 shadow"
              onPointerDown={(e) => beginDrag(e, { kind: "scrub" })}
              onPointerMove={onDragMove}
              onPointerUp={onDragUp}
              onPointerCancel={onDragUp}
            />
          </div>
        </div>
      </div>

      {/* Hidden CORS-scoped capture video — never played, only seeked for frames. */}
      {videoUrl && !thumbsFailed && cellCount <= 400 && (
        <video
          ref={captureVideoRef}
          src={videoUrl}
          crossOrigin="anonymous"
          muted
          preload="auto"
          className="hidden"
          aria-hidden
          onLoadedData={ensureThumbs}
          onError={() => setThumbsFailed(true)}
        />
      )}

      {thumbQueueRef.current.length > 0 && !thumbsFailed && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Building filmstrip…
        </div>
      )}
    </div>
  );
}
