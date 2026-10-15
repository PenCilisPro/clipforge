"use client";

/**
 * Full-screen clip editor (StreamPal-style dark workspace).
 *
 * Layout: top bar (name + Render & save) · video preview with safe zones and
 * a live caption overlay · right panel with Frame / Text / Brand tabs ·
 * toolbar + trim timeline at the bottom.
 *
 * "Render & save" POSTs the same /api/clips/:id/edit payload the pipeline
 * already accepts, extended with caption position/size and output aspect.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  Frame as FrameIcon,
  Info,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  SkipBack,
  SkipForward,
  Type as TypeIcon,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import type { Clip, Project } from "@/lib/types";
import { CAPTION_FONTS } from "@/lib/types";
import { cuesToSrtText, parseSrt, type SrtCue } from "@/lib/srt-client";
import { clamp, cuesFromTranscript, MIN_CLIP_SECONDS } from "@/lib/timeline";
import { cn, uuid } from "@/lib/utils";
import { ClipTimeline } from "@/components/dashboard/clip-timeline";

type Tab = "frame" | "text" | "brand";
type CaptionPosition = "top" | "middle" | "bottom";
type OutputAspect = "9:16" | "16:9" | "1:1";

/** Canvas dimensions per output aspect (mirrors worker/src/lib/canvas.js). */
const ASPECT_DIMS: Record<OutputAspect, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "16:9": { w: 1920, h: 1080 },
  "1:1": { w: 1080, h: 1080 },
};

const PLATFORMS: { key: OutputAspect; label: string; ratio: string }[] = [
  { key: "9:16", label: "TikTok", ratio: "9:16" },
  { key: "9:16", label: "YouTube Shorts", ratio: "9:16" },
  { key: "16:9", label: "X / Twitter", ratio: "16:9" },
  { key: "1:1", label: "Square", ratio: "1:1" },
];

const TEXT_COLORS = [
  "#ffffff", // template default
  "#111111",
  "#ff5d1c",
  "#facc15",
  "#67e8f9",
  "#ec4899",
  "#22c55e",
  "#a78bfa",
];

const FRAME_STEP = 1 / 30;

function formatClock(seconds: number) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** Short m:ss for badges and the meta line. */
function formatShort(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export function ClipEditor({ projectId, clipId }: { projectId: string; clipId: string }) {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [clip, setClip] = useState<Clip | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [sourceVideoUrl, setSourceVideoUrl] = useState<string | null>(null);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [saving, setSaving] = useState(false);

  // Editor state
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [cues, setCues] = useState<SrtCue[]>([]);
  const [resetSrt, setResetSrt] = useState(false);
  const [font, setFont] = useState("anton");
  const [textColor, setTextColor] = useState("#ffffff");
  const [position, setPosition] = useState<CaptionPosition>("bottom");
  const [size, setSize] = useState(0); // 0 = template default
  const [aspect, setAspect] = useState<OutputAspect>("9:16");
  const [videoFit, setVideoFit] = useState<"cover" | "contain">("cover");
  const [blur, setBlur] = useState(true);
  const [stroke, setStroke] = useState(false);
  const [strokeColor, setStrokeColor] = useState("#000000");
  const [strokeSize, setStrokeSize] = useState(4);
  const [shadow, setShadow] = useState(false);
  const [shadowColor, setShadowColor] = useState("#000000");
  const [shadowSize, setShadowSize] = useState(6);

  // UI state
  const [tab, setTab] = useState<Tab>("text");
  const [safeZones, setSafeZones] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [clipTime, setClipTime] = useState(0); // clip-relative preview time
  const [playheadSource, setPlayheadSource] = useState(0); // timeline (source seconds)
  const [zoom, setZoom] = useState(24); // px per second
  const [fullscreen, setFullscreen] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const nameDirtyRef = useRef(false);

  // Derived geometry (needed by the effects below).
  const clipDuration = Math.max(MIN_CLIP_SECONDS, endTime - startTime);
  const dims = ASPECT_DIMS[aspect];
  const timelineDuration = sourceDuration || Math.max(endTime, clipDuration);
  // Preview plays the SOURCE video so trim edits are visible live; split
  // uploads have no source URL — the timeline still handles trimming.
  const previewSrc = sourceVideoUrl;

  // ---------- Load ----------
  useEffect(() => {
    (async () => {
      try {
        const { project: loaded } = await apiFetch<{
          project: { clips: Clip[] } & Project;
        }>(`/api/projects/${projectId}`);
        const found = (loaded.clips as Clip[]).find((c) => c.id === clipId);
        if (!found) throw new Error("Clip not found");
        setClip(found);
        setProject(loaded);
        setName(found.title ?? "");
        setStartTime(Number(found.start_time));
        setEndTime(Number(found.end_time));
        setPlayheadSource(Number(found.start_time));
        setFont(found.caption_font ?? "anton");
        setTextColor(found.caption_color ?? "#ffffff");
        setPosition((found.caption_position as CaptionPosition) ?? "bottom");
        setSize(Number(found.caption_size) || 0);
        setAspect((found.output_aspect as OutputAspect) ?? "9:16");
        setVideoFit(found.video_fit === "contain" ? "contain" : "cover");
        setBlur(found.video_background_blur !== false);
        setStroke(found.caption_stroke === true);
        setStrokeColor(found.caption_stroke_color ?? "#000000");
        setStrokeSize(Number(found.caption_stroke_size) || 4);
        setShadow(found.caption_shadow === true);
        setShadowColor(found.caption_shadow_color ?? "#000000");
        setShadowSize(Number(found.caption_shadow_size) || 6);

        if (found.srt_override) setCues(parseSrt(found.srt_override));

        // Source video powers both the preview and the timeline (split
        // uploads: null — the timeline still works via the clip duration).
        try {
          const src = await apiFetch<{
            video_url: string | null;
            split: boolean;
            duration: number | null;
          }>(`/api/clips/${clipId}/source-playback`);
          setSourceVideoUrl(src.video_url);
          setSourceDuration(src.duration ?? 0);
        } catch {
          // Non-fatal — trimming still works from the clip's own window.
        }

        // Manual overrides show up directly; otherwise fetch the stored SRT.
        if (!found.srt_override) {
          try {
            const playback = await apiFetch<{ srt_url: string | null }>(
              `/api/clips/${clipId}/playback`
            );
            if (playback.srt_url) {
              const res = await fetch(playback.srt_url);
              if (res.ok) setCues(parseSrt(await res.text()));
            }
          } catch {
            // Captions stay empty — the Text tab offers auto-fill.
          }
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load clip");
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId, clipId]);

  // ---------- AUTO-CAPTIONS ----------
  // When no override and no stored SRT loaded, auto-fill from the transcript
  // so the overlay always has captions (mirrors the auto-fill button).
  useEffect(() => {
    if (loading) return;
    if (cues.length > 0) return;
    if (!project?.transcript_json?.words?.length) return;
    if (!endTime || endTime <= startTime) return;
    const words = project.transcript_json.words;
    const next = cuesFromTranscript(words, startTime, endTime);
    if (next.length > 0) {
      setCues(next);
      setResetSrt(false);
    }
    // Runs once after load (and again only if cues are cleared intentionally).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, cues.length, startTime, endTime]);

  // Preview: play the SOURCE video so trim edits are visible live.
  // Lock playback to the trim window and keep the timeline playhead in sync.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tick = () => {
      if (video.currentTime < startTime - 0.05 || video.currentTime >= endTime) {
        video.currentTime = startTime;
      }
      setClipTime(clamp(video.currentTime - startTime, 0, clipDuration));
      setPlayheadSource(clamp(video.currentTime, startTime, endTime));
    };
        video.addEventListener("timeupdate", tick);
    return () => video.removeEventListener("timeupdate", tick);
  }, [startTime, endTime, clipDuration]);

  // ---------- SEEK TO CLIP START ON LOAD ----------
  // The preview video starts at the clip's first frame (CapCut-style), not
  // at the original video's 0:00.
  useEffect(() => {
    const video = videoRef.current;
    if (loading || !video || !sourceVideoUrl) return;
    if (!endTime || endTime <= startTime) return;
    const seek = () => {
      if (video.readyState >= 1) {
        video.currentTime = startTime;
      } else {
        video.addEventListener("loadedmetadata", () => {
          video.currentTime = startTime;
        }, { once: true });
      }
    };
    seek();
    // Re-seek once when the source URL arrives / clip data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, sourceVideoUrl, startTime]);

  // Track preview box width for the caption overlay's px-accurate scaling.
  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setPreviewWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  // Fullscreen state sync.
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Sync volume/mute to the element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [volume, muted]);

  // ---------- Handlers ----------
    // Fresh-window refs: the tick always reads current values, and the
  // ref-callback binding survives video element replacement.
  const windowRef = useRef({ start: 0, end: 0, dur: 0 });
  windowRef.current = { start: startTime, end: endTime, dur: clipDuration };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    const { start, end, dur } = windowRef.current;
    if (video.currentTime < start - 0.05 || video.currentTime >= end) {
      video.currentTime = start;
    }
    setClipTime(clamp(video.currentTime - start, 0, dur));
    setPlayheadSource(clamp(video.currentTime, start, end));
  };

  const videoRefCallback = (el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el) {
      // (re)bind on every element swap — old listeners die with the old node
      el.addEventListener("timeupdate", handleTimeUpdate);
    }
  };
  const scrub = useCallback(
    (t: number) => {
      const clamped = clamp(t, startTime, endTime);
      setPlayheadSource(clamped);
      setClipTime(clamp(clamped - startTime, 0, clipDuration));
      const video = videoRef.current;
      if (video) video.currentTime = clamped;
    },
    [startTime, endTime, clipDuration]
  );

  const trim = useCallback((start: number, end: number) => {
    setStartTime(start);
    setEndTime(end);
    setPlayheadSource((prev) => clamp(prev, start, end));
  }, []);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function stepFrame(dir: 1 | -1) {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = clamp(video.currentTime + dir * FRAME_STEP, startTime, endTime);
  }

  function restart() {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = startTime;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  // ---------- Caption ops ----------
  function updateActiveCue(text: string) {
    if (!activeCue) return;
    setCues((prev) => prev.map((c) => (c.id === activeCue.id ? { ...c, text } : c)));
    setResetSrt(false);
  }

  function addCaptionHere() {
    const start = clamp(clipTime, 0, Math.max(0, clipDuration - 1));
    const end = Math.min(start + 2, clipDuration);
    setCues((prev) =>
      [...prev, { id: uuid(), start, end, text: "" }].sort((a, b) => a.start - b.start)
    );
    setResetSrt(false);
  }

  function autoFillCaptions() {
    const words = project?.transcript_json?.words ?? [];
    const next = cuesFromTranscript(words, startTime, endTime);
    if (next.length === 0) {
      toast.error("No transcript words inside this window");
      return;
    }
    setCues(next);
    setResetSrt(false);
    toast.success(
      `Filled ${next.length} caption line${next.length === 1 ? "" : "s"} from the transcript`
    );
  }

  // ---------- Split / Duplicate ----------
  async function handleSplit() {
    if (!clip || saving) return;
    const at = clamp(playheadSource, startTime + MIN_CLIP_SECONDS, endTime - MIN_CLIP_SECONDS);
    if (at - startTime < MIN_CLIP_SECONDS || endTime - at < MIN_CLIP_SECONDS) {
      toast.error("Both parts must be at least 3 seconds long");
      return;
    }

    const boundary = Number((at - startTime).toFixed(1));
    const part1: SrtCue[] = [];
    const part2: SrtCue[] = [];
    for (const c of cues) {
      if (c.end <= boundary) part1.push(c);
      else if (c.start >= boundary) {
        part2.push({
          ...c,
          id: uuid(),
          start: Number((c.start - boundary).toFixed(1)),
          end: Number((c.end - boundary).toFixed(1)),
        });
      } else {
        if (boundary - c.start >= 0.3) part1.push({ ...c, end: boundary });
        if (c.end - boundary >= 0.3) {
          part2.push({ ...c, id: uuid(), start: 0, end: Number((c.end - boundary).toFixed(1)) });
        }
      }
    }

    setSaving(true);
    try {
      await apiFetch(`/api/clips/${clip.id}/split`, {
        method: "POST",
        body: { at, srt_part1: cuesToSrtText(part1), srt_part2: cuesToSrtText(part2) },
      });
      toast.success("Clip split — both parts are re-rendering");
      router.push(`/dashboard/projects/${projectId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to split clip");
      setSaving(false);
    }
  }

  async function handleDuplicate() {
    if (!clip || saving) return;
    setSaving(true);
    try {
      await apiFetch(`/api/clips/${clip.id}/duplicate`, { method: "POST" });
      toast.success("Clip duplicated — rendering the copy");
      router.push(`/dashboard/projects/${projectId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to duplicate clip");
      setSaving(false);
    }
  }

  // ---------- Save ----------
  async function save() {
    if (!clip || saving) return;
    if (endTime - startTime < MIN_CLIP_SECONDS) {
      toast.error("Clip must be at least 3 seconds long");
      return;
    }
    // Caption times are clip-relative — lines outside the trim window are
    // dropped (the pipeline regenerates captions when the override is empty).
    const winLen = endTime - startTime;
    const inWindow = cues.filter((c) => c.end > 0.05 && c.start < winLen - 0.05);
    const dropped = cues.length - inWindow.length;
    if (!resetSrt) {
      for (const cue of inWindow) {
        if (!cue.text.trim()) {
          toast.error("Caption lines can't be empty — delete the line instead");
          return;
        }
      }
    }

    setSaving(true);
    try {
      await apiFetch(`/api/clips/${clip.id}/edit`, {
        method: "POST",
        body: {
          ...(nameDirtyRef.current ? { title: name.trim().slice(0, 200) } : {}),
          caption_font: font,
          caption_color: textColor,
          caption_position: position,
          caption_size: size,
          output_aspect: aspect,
          video_fit: videoFit,
          video_background_blur: blur,
          caption_stroke: stroke,
          caption_stroke_color: strokeColor,
          caption_stroke_size: strokeSize,
          caption_shadow: shadow,
          caption_shadow_color: shadowColor,
          caption_shadow_size: shadowSize,
          start_time: startTime,
          end_time: endTime,
          ...(resetSrt
            ? { srt_content: "" } // clear override → pipeline regenerates
            : inWindow.length > 0
              ? { srt_content: cuesToSrtText(inWindow) }
              : cues.length > 0
                ? { srt_content: "" } // every line drifted out of the window
                : { srt_content: cuesToSrtText(cues) }),
        },
      });
      toast.success("Saved — re-render started", {
        description:
          dropped > 0
            ? `${dropped} caption line${dropped === 1 ? "" : "s"} outside the trim window will be regenerated.`
            : "The clip will show its new look once rendering finishes.",
      });
      router.push(`/dashboard/projects/${projectId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save clip");
      setSaving(false);
    }
  }

  // S splits at the playhead (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSplit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadSource, startTime, endTime, cues, clip, saving]);

  const activeCue = useMemo(() => {
    const t = clipTime;
    return cues.find((c) => t >= c.start - 0.05 && t <= c.end + 0.05) ?? null;
  }, [cues, clipTime]);

  const fontDef = CAPTION_FONTS.find((f) => f.key === font) ?? CAPTION_FONTS[0];

  /** Caption font size scaled from the 1080px canvas to the preview box. */
  const previewFontSize = useMemo(() => {
    const canvasSize = size > 0 ? size : 60; // template default ≈ 60px
    const scale = previewWidth > 0 ? previewWidth / dims.w : 0.25;
    return canvasSize * scale;
  }, [size, previewWidth, dims.w]);

  // ---------- Render ----------
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#101013] text-zinc-400">
        <div className="flex items-center gap-3 text-sm">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          Loading editor…
        </div>
      </div>
    );
  }

  if (!clip) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[#101013]">
        <p className="text-sm text-zinc-400">Clip not found</p>
        <Link
          href={`/dashboard/projects/${projectId}`}
          className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-zinc-200"
        >
          Back to project
        </Link>
      </div>
    );
  }

  const sourceName = clip.title
    ? `${clip.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "clip"}.mp4`
    : "clip.mp4";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#101013] text-zinc-100">
      {/* ---------- Top bar ---------- */}
      <header className="flex items-center justify-between gap-4 px-5 pb-3 pt-4">
        <div className="flex min-w-0 items-start gap-2">
          <Link
            href={`/dashboard/projects/${projectId}`}
            aria-label="Back to project"
            className="mt-1 rounded-md p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0">
            <input
              value={name}
              onChange={(e) => {
                nameDirtyRef.current = true;
                setName(e.target.value);
              }}
              placeholder="Name this clip (used as the file name)"
              className="w-72 max-w-full border-b border-transparent bg-transparent text-[15px] font-medium text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-white/20"
            />
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
              <span className="max-w-56 truncate">{sourceName}</span>
              <span>·</span>
              <span>
                {dims.w} × {dims.h}
              </span>
              <span>·</span>
              <span>{formatShort(clipDuration)}</span>
              <span>·</span>
              <Link
                href={`/dashboard/projects/${projectId}`}
                className="text-primary-400 hover:text-primary-300"
              >
                Replace
              </Link>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Render & save"}
          </button>
          <button
            onClick={toggleFullscreen}
            aria-label="Toggle fullscreen"
            className="rounded-lg border border-white/10 bg-white/5 p-2 text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </button>
        </div>
      </header>


      {/* ---------- Main: preview + right panel ---------- */}
      <div className="flex min-h-0 flex-1">
        {/* Preview */}
        <section className="flex min-w-0 flex-1 flex-col px-5">
          <div className="flex items-center justify-between pb-2 text-xs text-zinc-400">
            <span className="tabular-nums">
              {aspect} · {dims.w} × {dims.h}
            </span>
            <label className="flex cursor-pointer items-center gap-2">
              <span>Safe zones</span>
              <Info className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
              <button
                role="switch"
                aria-checked={safeZones}
                onClick={() => setSafeZones((v) => !v)}
                className={cn(
                  "relative h-5 w-9 rounded-full transition-colors",
                  safeZones ? "bg-primary-500" : "bg-zinc-700"
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                    safeZones ? "left-[18px]" : "left-0.5"
                  )}
                />
              </button>
            </label>
          </div>

          <div
            ref={previewBoxRef}
            className="relative flex min-h-0 flex-1 items-center justify-center"
          >
            <div
              className="relative overflow-hidden rounded-lg bg-black shadow-2xl"
              style={{
                aspectRatio: `${dims.w} / ${dims.h}`,
                maxWidth: "100%",
                height: "100%",
              }}
            >
                            {previewSrc ? (
                <>
                  {/* Blurred backdrop for "Blur fill" — mimics the render's
                      boxblur+scale backdrop so the preview matches the output */}
                  {videoFit === "contain" && blur && (
                    <video
                      src={previewSrc}
                      playsInline
                      muted
                      aria-hidden
                      className="absolute inset-0 h-full w-full scale-125 object-cover blur-2xl brightness-[0.93]"
                      onLoadedMetadata={(e) => {
                        e.currentTarget.currentTime = startTime;
                      }}
                      onTimeUpdate={(e) => {
                        e.currentTarget.currentTime = videoRef.current?.currentTime ?? 0;
                      }}
                    />
                  )}
                  <video
                    ref={videoRefCallback}
                    src={previewSrc}
                    playsInline
                    className={cn(
                      "relative h-full w-full",
                      videoFit === "contain" ? "object-contain" : "object-cover"
                    )}
                    onLoadedMetadata={(e) => {
                      e.currentTarget.currentTime = startTime;
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onClick={togglePlay}
                  />
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-zinc-500">
                  <Scissors className="h-5 w-5" />
                  Preview isn't available for split uploads — trimming still works below
                </div>
              )}

              {/* Live caption overlay */}
              {activeCue?.text.trim() && (
                <div
                  className="pointer-events-none absolute inset-x-0 flex justify-center px-[5%] text-center"
                  style={{
                    fontFamily: fontDef.cssVar,
                    ...(position === "top"
                      ? { top: "8%" }
                      : position === "middle"
                        ? { top: "50%", transform: "translateY(-50%)" }
                        : { bottom: "8%" }),
                  }}
                >
                  <span
                    style={{
                      fontSize: `${previewFontSize}px`,
                      color: textColor.toLowerCase() === "#ffffff" ? "#ffffff" : textColor,
                      lineHeight: 1.15,
                      fontWeight: 800,
                      ...(stroke
                        ? {
                            WebkitTextStroke: `${((strokeSize * previewFontSize) / 64) / 4}px ${strokeColor}`,
                          }
                        : {}),
                      ...(shadow
                        ? {
                            textShadow: `0 ${((shadowSize * previewFontSize) / 64) / 3}px 8px ${shadowColor}`,
                          }
                        : {}),
                    }}
                  >
                    {activeCue.text}
                  </span>
                </div>
              )}

              {/* Safe zones overlay */}
              {safeZones && (
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute inset-x-0 top-0 h-[12%] bg-primary-500/15 ring-1 ring-inset ring-primary-500/40" />
                  <div className="absolute inset-x-0 bottom-0 h-[18%] bg-primary-500/15 ring-1 ring-inset ring-primary-500/40" />
                  <div className="absolute inset-y-0 left-0 w-[6%] bg-primary-500/10 ring-1 ring-inset ring-primary-500/30" />
                  <div className="absolute inset-y-0 right-0 w-[6%] bg-primary-500/10 ring-1 ring-inset ring-primary-500/30" />
                </div>
              )}
            </div>
          </div>


          {/* Transport */}
          <div className="flex items-center justify-center gap-3 py-3">
            <button
              onClick={() => stepFrame(-1)}
              aria-label="Previous frame"
              className="rounded-full p-2 text-zinc-300 hover:bg-white/10"
            >
              <SkipBack className="h-4 w-4" />
            </button>
            <button
              onClick={restart}
              aria-label="Restart"
              className="rounded-full p-2 text-zinc-300 hover:bg-white/10"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black shadow-lg hover:bg-zinc-200"
            >
              {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
            </button>
            <button
              onClick={() => stepFrame(1)}
              aria-label="Next frame"
              className="rounded-full p-2 text-zinc-300 hover:bg-white/10"
            >
              <SkipForward className="h-4 w-4" />
            </button>
            <span className="ml-2 text-xs tabular-nums text-zinc-400">
              {formatClock(clipTime)} / {formatClock(clipDuration)}
            </span>
            <div className="ml-3 flex items-center gap-2">
              <button
                onClick={() => setMuted((v) => !v)}
                aria-label={muted ? "Unmute" : "Mute"}
                className="text-zinc-300 hover:text-white"
              >
                {muted || volume === 0 ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value));
                  setMuted(Number(e.target.value) === 0);
                }}
                className="h-1 w-24 accent-primary-500"
                aria-label="Volume"
              />
            </div>
          </div>
        </section>


        {/* ---------- Right panel ---------- */}
        <aside className="flex w-[320px] shrink-0 flex-col border-l border-white/10 bg-[#161619]">
          <div className="flex items-center gap-1 border-b border-white/10 px-4 py-3">
            {(
              [
                { key: "frame", label: "Frame", icon: FrameIcon },
                { key: "text", label: "Text", icon: TypeIcon },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === key
                    ? "bg-primary-500/15 text-primary-300 ring-1 ring-primary-500/40"
                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
            <button
              onClick={() => setTab("brand")}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                tab === "brand"
                  ? "bg-primary-500/15 text-primary-300 ring-1 ring-primary-500/40"
                  : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
              )}
            >
              <span className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-current text-[9px] font-bold">
                B
              </span>
              Brand
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {tab === "frame" && (
              <div className="space-y-5">
                <div>
                  <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Platform
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {PLATFORMS.map((p, i) => {
                      const selected = aspect === p.key;
                      const first = i === 0 || PLATFORMS[i - 1].key !== p.key;
                      return first ? (
                        <button
                          key={p.label}
                          onClick={() => setAspect(p.key)}
                          className={cn(
                            "rounded-xl border p-3 text-left transition-colors",
                            selected
                              ? "border-primary-500 bg-primary-500/10"
                              : "border-white/10 bg-white/[0.03] hover:border-white/20"
                          )}
                        >
                          <span className="block text-sm font-medium">{p.label}</span>
                          <span className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
                            <span
                              className={cn(
                                "inline-block border border-current",
                                p.key === "9:16"
                                  ? "h-3 w-1.5"
                                  : p.key === "16:9"
                                    ? "h-1.5 w-3"
                                    : "h-2.5 w-2.5"
                              )}
                            />
                            {p.ratio}
                          </span>
                        </button>
                      ) : (
                        <span key={p.label} className="hidden" aria-hidden />
                      );
                    })}
                  </div>
                </div>

                <div>
                  <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Fit ({aspect})
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {(
                      [
                        { key: "blur", label: "Blur fill", fit: "contain", blur: true },
                        { key: "crop", label: "Crop fill", fit: "cover", blur: false },
                        { key: "bars", label: "Black bars", fit: "contain", blur: false },
                      ] as const
                    ).map(({ key, label, fit, blur: b }) => {
                      const selected = videoFit === fit && blur === b;
                      return (
                        <button
                          key={key}
                          onClick={() => {
                            setVideoFit(fit);
                            setBlur(b);
                          }}
                          className="group text-center"
                        >
                          <span
                            className={cn(
                              "mb-1.5 block h-14 w-full overflow-hidden rounded-lg border p-1",
                              selected
                                ? "border-primary-500"
                                : "border-white/10 group-hover:border-white/25"
                            )}
                          >
                            <span
                              className={cn(
                                "block h-full w-full rounded-sm",
                                fit === "cover"
                                  ? "bg-zinc-600"
                                  : b
                                    ? "bg-zinc-700 ring-2 ring-zinc-500 ring-inset"
                                    : "bg-black ring-2 ring-zinc-600 ring-inset"
                              )}
                            />
                          </span>
                          <span className="block text-[10px] leading-tight text-zinc-400">
                            {label}
                          </span>
                        </button>
                      );
                    })}
                    <button
                      disabled
                      title="Coming soon"
                      className="group cursor-not-allowed text-center opacity-50"
                    >
                      <span className="mb-1.5 block h-14 w-full overflow-hidden rounded-lg border border-white/10 p-1">
                        <span className="flex h-full w-full items-center justify-center rounded-sm bg-zinc-800 text-[8px] text-zinc-500">
                          ⧉⧉
                        </span>
                      </span>
                      <span className="block text-[10px] leading-tight text-zinc-400">
                        Split screen
                      </span>
                    </button>
                  </div>
                </div>

                <div>
                  <div className="flex overflow-hidden rounded-lg border border-white/10">
                    {(["Fill bars", "Whole frame"] as const).map((label, i) => {
                      const selected = i === 0 ? videoFit === "contain" : videoFit === "cover";
                      return (
                        <button
                          key={label}
                          onClick={() => setVideoFit(i === 0 ? "contain" : "cover")}
                          className={cn(
                            "flex-1 py-2 text-xs font-medium transition-colors",
                            selected ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5"
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {tab === "text" && (
              <div className="space-y-5">
                <div>
                  <div className="flex items-baseline justify-between pb-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Caption text
                    </p>
                    <span className="text-[10px] tabular-nums text-zinc-600">
                      {(activeCue?.text ?? "").length}/120
                    </span>
                  </div>
                  <input
                    value={activeCue?.text ?? ""}
                    onChange={(e) => updateActiveCue(e.target.value.slice(0, 120))}
                    disabled={!activeCue}
                    maxLength={120}
                    placeholder={activeCue ? "On-video text" : "No caption at this moment"}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-primary-500/60 disabled:opacity-60"
                  />
                  {activeCue ? (
                    <p className="pt-1.5 text-[10px] text-zinc-600">
                      Editing the caption at the playhead · {formatClock(activeCue.start)} –{" "}
                      {formatClock(activeCue.end)}
                    </p>
                  ) : (
                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={addCaptionHere}
                        className="rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/15"
                      >
                        Add caption here
                      </button>
                      <button
                        onClick={autoFillCaptions}
                        className="rounded-md bg-primary-500/20 px-2.5 py-1 text-[11px] font-medium text-primary-300 hover:bg-primary-500/30"
                      >
                        Auto-fill from transcript
                      </button>
                    </div>
                  )}
                </div>

                <div>
                  <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Font
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {CAPTION_FONTS.map((f) => (
                      <button
                        key={f.key}
                        onClick={() => setFont(f.key)}
                        style={{ fontFamily: f.cssVar }}
                        className={cn(
                          "truncate rounded-lg border px-3 py-2 text-sm transition-colors",
                          font === f.key
                            ? "border-primary-500 bg-primary-500/10 text-primary-200"
                            : "border-white/10 bg-white/[0.03] text-zinc-300 hover:border-white/20"
                        )}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Position
                  </p>
                  <div className="flex overflow-hidden rounded-lg border border-white/10">
                    {(
                      [
                        ["top", "Top"],
                        ["middle", "Middle"],
                        ["bottom", "Bottom"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        onClick={() => setPosition(key)}
                        className={cn(
                          "flex-1 py-2 text-xs font-medium transition-colors",
                          position === key
                            ? "bg-white/10 text-white"
                            : "text-zinc-400 hover:bg-white/5"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="flex items-baseline justify-between pb-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Size
                    </p>
                    <span className="text-[10px] tabular-nums text-zinc-500">
                      {size > 0 ? `${size}px` : "Auto"}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={30}
                    max={120}
                    step={1}
                    value={size > 0 ? size : 60}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setSize(v === 60 ? 0 : v);
                    }}
                    onDoubleClick={() => setSize(0)}
                    className="h-1 w-full accent-primary-500"
                    aria-label="Caption size"
                  />
                </div>

                <div>
                  <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Text colour
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {TEXT_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => setTextColor(c)}
                        aria-label={c === "#ffffff" ? "Template default" : c}
                        className={cn(
                          "h-7 w-7 rounded-full border transition-transform",
                          textColor.toLowerCase() === c.toLowerCase()
                            ? "scale-110 border-primary-500 ring-2 ring-primary-500/40"
                            : "border-white/20 hover:scale-105"
                        )}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <p className="pt-1.5 text-[10px] text-zinc-600">
                    White keeps the caption template's own default colour
                  </p>
                </div>
              </div>
            )}

            {tab === "brand" && (
              <div className="space-y-6">
                <div>
                  <div className="flex items-center justify-between pb-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Stroke
                    </p>
                    <button
                      role="switch"
                      aria-checked={stroke}
                      onClick={() => setStroke((v) => !v)}
                      className={cn(
                        "relative h-5 w-9 rounded-full transition-colors",
                        stroke ? "bg-primary-500" : "bg-zinc-700"
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                          stroke ? "left-[18px]" : "left-0.5"
                        )}
                      />
                    </button>
                  </div>
                  <div className={cn("space-y-3", !stroke && "pointer-events-none opacity-40")}>
                    <div className="flex flex-wrap gap-2">
                      {["#000000", "#ffffff", "#ff5d1c", "#111111"].map((c) => (
                        <button
                          key={c}
                          onClick={() => setStrokeColor(c)}
                          aria-label={`Stroke ${c}`}
                          className={cn(
                            "h-6 w-6 rounded-full border",
                            strokeColor.toLowerCase() === c.toLowerCase()
                              ? "border-primary-500 ring-2 ring-primary-500/40"
                              : "border-white/20"
                          )}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="w-10 text-[10px] text-zinc-500">{strokeSize}px</span>
                      <input
                        type="range"
                        min={1}
                        max={10}
                        value={strokeSize}
                        onChange={(e) => setStrokeSize(Number(e.target.value))}
                        className="h-1 flex-1 accent-primary-500"
                        aria-label="Stroke size"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between pb-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Drop shadow
                    </p>
                    <button
                      role="switch"
                      aria-checked={shadow}
                      onClick={() => setStroke((v) => !v)}
                      className={cn(
                        "relative h-5 w-9 rounded-full transition-colors",
                        shadow ? "bg-primary-500" : "bg-zinc-700"
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                          shadow ? "left-[18px]" : "left-0.5"
                        )}
                      />
                    </button>
                  </div>
                  <div className={cn("space-y-3", !shadow && "pointer-events-none opacity-40")}>
                    <div className="flex flex-wrap gap-2">
                      {["#000000", "#ffffff", "#1e1b4b", "#111111"].map((c) => (
                        <button
                          key={c}
                          onClick={() => setShadowColor(c)}
                          aria-label={`Shadow ${c}`}
                          className={cn(
                            "h-6 w-6 rounded-full border",
                            shadowColor.toLowerCase() === c.toLowerCase()
                              ? "border-primary-500 ring-2 ring-primary-500/40"
                              : "border-white/20"
                          )}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="w-10 text-[10px] text-zinc-500">{shadowSize}px</span>
                      <input
                        type="range"
                        min={1}
                        max={10}
                        value={shadowSize}
                        onChange={(e) => setShadowSize(Number(e.target.value))}
                        className="h-1 flex-1 accent-primary-500"
                        aria-label="Shadow size"
                      />
                    </div>
                  </div>
                </div>

                <p className="text-[10px] leading-relaxed text-zinc-600">
                  Brand effects render with your caption template and apply to every
                  word-synced caption in this clip.
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* ---------- Toolbar ---------- */}
      <div className="flex items-center gap-2 border-t border-white/10 px-5 py-2">
        <button
          onClick={() => void handleSplit()}
          disabled={saving}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-50"
        >
          <Scissors className="h-4 w-4" />
          Split at {formatClock(clamp(playheadSource - startTime, 0, clipDuration))}
          <span className="rounded border border-white/20 px-1 text-[10px] text-zinc-400">S</span>
        </button>
        <button
          onClick={() => void handleDuplicate()}
          disabled={saving}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-50"
        >
          <span className="text-[13px]">⧉</span>
          Duplicate
        </button>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => setZoom((z) => clamp(z / 1.5, 4, 160))}
            aria-label="Zoom out"
            className="text-zinc-400 hover:text-white"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <input
            type="range"
            min={4}
            max={160}
            step={1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="h-1 w-40 accent-primary-500"
            aria-label="Timeline zoom"
          />
          <button
            onClick={() => setZoom((z) => clamp(z * 1.5, 4, 160))}
            aria-label="Zoom in"
            className="text-zinc-400 hover:text-white"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <span className="text-xs tabular-nums text-zinc-500">
            CLIP · {formatShort(clipDuration)}
          </span>
        </div>
      </div>

      {/* ---------- Timeline ---------- */}
      <div className="border-t border-white/10 bg-[#0d0d0f] px-2 pb-2">
  <ClipTimeline
    duration={clipDuration}
    runway={120}
    playhead={clipTime}
    onTrim={(s, e) => trim(s + startTime, e + startTime)}
    onTrimCommit={undefined}
    onScrub={(t) => scrub(t + startTime)}
    pxPerSec={zoom}
    maxDuration={sourceDuration - startTime || undefined}
  />
</div>
      <div className="flex items-center justify-between px-5 py-1.5 text-[10px] text-zinc-600">
        <span>Source · drag edges to set each piece, gaps are dropped</span>
        <span>Editing runs on your device · larger clips take longer · the result is saved to your uploaded clips</span>
      </div>
    </div>
  );
}