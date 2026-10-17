"use client";

/**
 * Full-screen clip editor (StreamPal-style dark workspace).
 *
 * Layout: top bar (name + Render & save) · video preview with safe zones and
 * a live karaoke caption overlay · right panel with Frame / Text / Music /
 * Brand tabs · toolbar + trim timeline at the bottom.
 *
 * "Render & save" POSTs the same /api/clips/:id/edit payload the pipeline
 * already accepts, extended with caption position/size, output aspect,
 * video zoom/pan, and draggable text overlays.

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
  Search,
  SkipBack,
  SkipForward,
  Type as TypeIcon,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  Music as MusicIcon,
} from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import type { Clip, Project } from "@/lib/types";
import { CAPTION_FONTS } from "@/lib/types";
import { cuesToSrtText, parseSrt, type SrtCue } from "@/lib/srt-client";
import { clamp, cuesFromTranscript, MIN_CLIP_SECONDS } from "@/lib/timeline";
import { CAPTION_ANIMS, wordAnimStyle, type CaptionAnimId } from "@/lib/caption-anim";
import { cn, uuid } from "@/lib/utils";
import { ClipTimeline } from "@/components/dashboard/clip-timeline";

type Tab = "frame" | "text" | "brand" | "music";
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

const MUSIC_MOODS = [
  "upbeat", "chill", "dramatic", "corporate", "energetic", "happy", "epic", "background",
];

interface MusicTrackLite {
  id: string;
  name: string;
  artist: string;
  duration: number;
  audio: string;
  image: string | null;
}

const FRAME_STEP = 1 / 30;

/**
 * A standalone text overlay placed on the canvas (independent of captions).
 * x/y are the block's CENTER as % of the canvas; size is % of canvas height —
 * the same math the local render uses for ASS \pos / \fs, so the preview
 * matches the exported MP4.
 */
interface TextOverlay {
  id: string;
  text: string;
  font: string;
  x: number;
  y: number;
  size: number;
  /** Wrap width as % of canvas width (default 90) — same math as the render. */
  width?: number;
  color: string;
  bold: boolean;
  bg: boolean;
}

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

/**
 * "Words per screen" — flatten every cue into timed words (cues without word
 * timings get times spread proportionally to word length) and re-chunk into
 * groups of N words. Display-only: the edited cue text is untouched and the
 * renderer regroups the same way from caption_words.
 */
function regroupCuesForDisplay(cues: SrtCue[], n: number): SrtCue[] {
  if (!Number.isFinite(n) || n < 1) return cues;
  const words: { word: string; start: number; end: number }[] = [];
  for (const c of cues) {
    const raw = c.text.trim().split(/\s+/).filter(Boolean);
    if (raw.length === 0) continue;
    const timed =
      Array.isArray(c.words) && c.words.length > 0
        ? c.words.map((w) => ({ word: w.word, start: w.start, end: w.end }))
        : [];
    if (timed.length > 0) {
      words.push(...timed);
    } else {
      const start = Math.max(0, c.start);
      const dur = Math.max(0.3, c.end - start);
      const total = raw.reduce((s, w) => s + w.length, 0) || 1;
      let t = start;
      for (const w of raw) {
        const d = (w.length / total) * dur;
        words.push({ word: w, start: t, end: t + d });
        t += d;
      }
    }
  }
  const out: SrtCue[] = [];
  for (let i = 0; i < words.length; i += n) {
    const chunk = words.slice(i, i + n);
    if (chunk.length === 0) continue;
    out.push({
      id: `grp-${i}`,
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      text: chunk.map((w) => w.word).join(" "),
      words: chunk,
    });
  }
  return out.length > 0 ? out : cues;
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
  const [captionAnim, setCaptionAnim] = useState<CaptionAnimId>("pop");
  const [capX, setCapX] = useState<number | null>(null); // % across, null = preset mode
  const [capY, setCapY] = useState<number | null>(null); // % down, null = preset mode
  const [dragging, setDragging] = useState(false);
  const [scaling, setScaling] = useState(false);
  const [capHover, setCapHover] = useState(false);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const canvasBoxRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<{ x: number; y: number; gx: boolean; gy: boolean; sh: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);
  const scaleRef = useRef<{ size0: number; d0: number } | null>(null);
  const pendingSizeRef = useRef<number | null>(null);
  const rafSizeRef = useRef<number | null>(null);
  const [guides, setGuides] = useState({ shift: false, x: false, y: false });
  const snapRef = useRef({ x: false, y: false });
  const [position, setPosition] = useState<CaptionPosition>("bottom");
  const [size, setSize] = useState(0); // 0 = template default
  // "Words per screen": regroup caption words into blocks of N words
  // (0 = off — show each caption line as edited). Preview and the local
  // render regroup identically from the saved caption_words field.
  const [wordsPerCue, setWordsPerCue] = useState(0);
  // Caption wrap width as % of canvas width (CapCut-style wider text box).
  const [capWidth, setCapWidth] = useState(90);
  const [aspect, setAspect] = useState<OutputAspect>("9:16");
  const [videoFit, setVideoFit] = useState<"cover" | "contain">("cover");
  const [blur, setBlur] = useState(true);
  const [stroke, setStroke] = useState(false);
  const [strokeColor, setStrokeColor] = useState("#000000");
  const [strokeSize, setStrokeSize] = useState(4);
  const [shadow, setShadow] = useState(false);
  const [shadowColor, setShadowColor] = useState("#000000");
  const [shadowSize, setShadowSize] = useState(6);

  // Video transform (CapCut-style zoom & pan). videoScale is 50-300 (%);
  // videoX/videoY are pan offsets in % of the canvas. Panning is clamped so
  // the frame never reveals black past the edges unless zoomed below 100%.
  const [videoScale, setVideoScale] = useState(100);
  const [videoX, setVideoX] = useState(0);
  const [videoY, setVideoY] = useState(0);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null);
  const rafPanRef = useRef<number | null>(null);
  const panMovedRef = useRef(false);

  // Custom text overlays: draggable blocks rendered above the captions.
  const [overlays, setOverlays] = useState<TextOverlay[]>([]);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [ovDragging, setOvDragging] = useState(false);
  const ovDragRef = useRef<{ id: string; px: number; py: number; x: number; y: number } | null>(null);
  const pendingOvRef = useRef<{ id: string; x: number; y: number; gx: boolean; gy: boolean; sh: boolean } | null>(null);
  const rafOvRef = useRef<number | null>(null);
  // Live canvas box size — overlay font sizes are % of canvas height.
  const [canvasPx, setCanvasPx] = useState({ w: 0, h: 0 });

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

  // Music tab state
  const [musicTabMood, setMusicTabMood] = useState("background");
  const [musicTracks, setMusicTracks] = useState<MusicTrackLite[] | null>(null);
  const [musicLoading, setMusicLoading] = useState(false);
  const [musicPlaying, setMusicPlaying] = useState<string | null>(null);
  const [musicQuery, setMusicQuery] = useState("");
  const [aiMusicBusy, setAiMusicBusy] = useState(false);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

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
        setCaptionAnim((found.caption_anim as CaptionAnimId) ?? "pop");
        setPosition((found.caption_position as CaptionPosition) ?? "bottom");
        setCapX((found as any).caption_x != null ? Number((found as any).caption_x) : null);
        setCapY((found as any).caption_y != null ? Number((found as any).caption_y) : null);
        setSize(Number(found.caption_size) || 0);
        setWordsPerCue(
          Math.min(12, Math.max(0, Math.round(Number((found as any).caption_words) || 0)))
        );
        setCapWidth(clamp(Number((found as any).caption_width) || 90, 20, 100));
        setAspect((found.output_aspect as OutputAspect) ?? "9:16");
        setVideoFit(found.video_fit === "contain" ? "contain" : "cover");
        setBlur(found.video_background_blur !== false);
        setStroke(found.caption_stroke === true);
        setStrokeColor(found.caption_stroke_color ?? "#000000");
        setStrokeSize(Number(found.caption_stroke_size) || 4);
        setShadow(found.caption_shadow === true);
        setShadowColor(found.caption_shadow_color ?? "#000000");
        setShadowSize(Number(found.caption_shadow_size) || 6);
        setVideoScale(clamp(Number((found as any).video_scale) || 100, 50, 300));
        setVideoX(clamp(Number((found as any).video_x) || 0, -50, 50));
        setVideoY(clamp(Number((found as any).video_y) || 0, -50, 50));
        const loadedOverlays = (found as any).text_overlays;
        setOverlays(
          Array.isArray(loadedOverlays)
            ? loadedOverlays.slice(0, 10).map((o: any, i: number): TextOverlay => ({
                id: typeof o?.id === "string" && o.id ? o.id : `ov-${i}-${Date.now()}`,
                text: String(o?.text ?? "").slice(0, 200),
                font: typeof o?.font === "string" && o.font ? o.font : "poppins",
                x: clamp(Number(o?.x) || 50, 2, 98),
                y: clamp(Number(o?.y) || 50, 2, 98),
                size: clamp(Number(o?.size) || 5, 1, 20),
                width: clamp(Number(o?.width) || 90, 20, 100),
                color: typeof o?.color === "string" && o.color ? o.color : "#ffffff",
                bold: o?.bold !== false,
                bg: o?.bg === true,
              }))
            : []
        );

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
                // Manual overrides show up directly; otherwise prefer word-timed
        // transcript auto-fill over the flat stored SRT.
        if (!found.srt_override && !loaded.transcript_json?.words?.length) {
          try {
            const playback = await apiFetch<{ srt_url: string | null }>(
              `/api/clips/${clipId}/playback`
            );
            if (playback.srt_url) {
              const res = await fetch(playback.srt_url);
              if (res.ok) setCues(parseSrt(await res.text()));
            }
          } catch {
            // Captions stay empty — the auto-fill effect covers it.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, cues.length, startTime, endTime]);

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

  // Track the canvas box itself — text overlay font sizes are % of its height.
  useEffect(() => {
    const el = canvasBoxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasPx({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
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

  // ---------- Caption drag & scale (CapCut-style) ----------
  // Drag: pointer capture + rAF-throttled state (one render per frame
  // instead of one per mousemove — that was the lag).
  function onCaptionPointerDown(e: React.PointerEvent<HTMLSpanElement>) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const y0 = capY ?? (position === "top" ? 12 : position === "middle" ? 50 : 90);
    dragRef.current = { px: e.clientX, py: e.clientY, x: capX ?? 50, y: y0 };
    setCapX(capX ?? 50);
    setCapY(y0);
    setDragging(true);
    snapRef.current = { x: false, y: false };
  }

  function onCaptionPointerMove(e: React.PointerEvent<HTMLSpanElement>) {
    const d = dragRef.current;
    const box = canvasBoxRef.current?.getBoundingClientRect();
    if (!d || !box) return;
    const nx = clamp(d.x + ((e.clientX - d.px) / box.width) * 100, 4, 96);
    const ny = clamp(d.y + ((e.clientY - d.py) / box.height) * 100, 4, 96);
    // Shift = CapCut-style center guides: magnetic snap to the middle axes
    // with a wider release threshold so the lock never flickers at the edge.
    const SNAP = 1.2;
    const RELEASE = 2.6;
    let ux = nx;
    let uy = ny;
    let gx = false;
    let gy = false;
    if (e.shiftKey) {
      const thrX = snapRef.current.x ? RELEASE : SNAP;
      const thrY = snapRef.current.y ? RELEASE : SNAP;
      if (Math.abs(nx - 50) <= thrX) { ux = 50; gx = true; }
      if (Math.abs(ny - 50) <= thrY) { uy = 50; gy = true; }
    }
    snapRef.current = { x: gx, y: gy };
    pendingRef.current = { x: ux, y: uy, gx, gy, sh: e.shiftKey };
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const p = pendingRef.current;
        if (!p) return;
        setCapX(p.x);
        setCapY(p.y);
        setGuides({ shift: p.sh, x: p.gx, y: p.gy });
      });
    }
  }

  function onCaptionPointerUp() {
    dragRef.current = null;
    setDragging(false);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const p = pendingRef.current;
    pendingRef.current = null;
    if (p) {
      setCapX(p.x);
      setCapY(p.y);
    }
    setGuides({ shift: false, x: false, y: false });
    snapRef.current = { x: false, y: false };
  }

  // Scale: drag the white handle — distance from the caption's anchor point
  // maps to caption size (20–160), so it saves & renders with zero new wiring.
  function captionAnchor() {
    const box = canvasBoxRef.current?.getBoundingClientRect();
    if (!box) return null;
    const ax = capX ?? 50;
    const ay = capY ?? (position === "top" ? 12 : position === "middle" ? 50 : 88);
    return {
      cx: box.left + box.width * (ax / 100),
      cy: box.top + box.height * (ay / 100),
    };
  }

  function onScalePointerDown(e: React.PointerEvent<HTMLSpanElement>) {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const a = captionAnchor();
    if (!a) return;
    scaleRef.current = {
      size0: size > 0 ? size : 60,
      d0: Math.max(24, Math.hypot(e.clientX - a.cx, e.clientY - a.cy)),
    };
    setScaling(true);
  }

  function onScalePointerMove(e: React.PointerEvent<HTMLSpanElement>) {
    const s = scaleRef.current;
    const a = captionAnchor();
    if (!s || !a) return;
    const d = Math.hypot(e.clientX - a.cx, e.clientY - a.cy);
    pendingSizeRef.current = clamp(Math.round(s.size0 * (d / s.d0)), 20, 160);
    if (rafSizeRef.current == null) {
      rafSizeRef.current = requestAnimationFrame(() => {
        rafSizeRef.current = null;
        if (pendingSizeRef.current == null) return;
        setSize(pendingSizeRef.current);
      });
    }
  }

  function onScalePointerUp() {
    scaleRef.current = null;
    setScaling(false);
    if (rafSizeRef.current != null) {
      cancelAnimationFrame(rafSizeRef.current);
      rafSizeRef.current = null;
    }
    if (pendingSizeRef.current != null) {
      setSize(pendingSizeRef.current);
      pendingSizeRef.current = null;
    }
  }

  // ---------- Video zoom & pan (CapCut-style) ----------
  // Pan: drag the video itself — pointer capture + rAF throttle, same trick
  // that fixed the caption drag lag. Max pan grows with zoom: a 2x-zoomed
  // frame can slide ±50%, while 100% is locked (nothing outside to reveal).
  function videoMaxPan() {
    return videoScale >= 100 ? Math.max(0, (videoScale - 100) / 2) : 50;
  }

  function onVideoPointerDown(e: React.PointerEvent<HTMLVideoElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { px: e.clientX, py: e.clientY, x: videoX, y: videoY };
    panMovedRef.current = false;
    setPanning(true);
  }

  function onVideoPointerMove(e: React.PointerEvent<HTMLVideoElement>) {
    const p = panRef.current;
    const box = canvasBoxRef.current?.getBoundingClientRect();
    if (!p || !box) return;
    if (!panMovedRef.current && Math.hypot(e.clientX - p.px, e.clientY - p.py) > 4) {
      panMovedRef.current = true;
    }
    const mp = videoMaxPan();
    pendingPanRef.current = {
      x: clamp(p.x + ((e.clientX - p.px) / box.width) * 100, -mp, mp),
      y: clamp(p.y + ((e.clientY - p.py) / box.height) * 100, -mp, mp),
    };
    if (rafPanRef.current == null) {
      rafPanRef.current = requestAnimationFrame(() => {
        rafPanRef.current = null;
        const q = pendingPanRef.current;
        if (!q) return;
        setVideoX(q.x);
        setVideoY(q.y);
      });
    }
  }

  function onVideoPointerUp() {
    panRef.current = null;
    setPanning(false);
    if (rafPanRef.current != null) {
      cancelAnimationFrame(rafPanRef.current);
      rafPanRef.current = null;
    }
    const q = pendingPanRef.current;
    pendingPanRef.current = null;
    if (q) {
      setVideoX(q.x);
      setVideoY(q.y);
    }
  }

  // Click-to-pause still works — a drag swallows the click that follows it.
  function onVideoClick() {
    if (panMovedRef.current) {
      panMovedRef.current = false;
      return;
    }
    togglePlay();
  }

  // Re-clamp the pan whenever the zoom level changes.
  useEffect(() => {
    const mp = videoMaxPan();
    setVideoX((x) => clamp(x, -mp, mp));
    setVideoY((y) => clamp(y, -mp, mp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoScale]);

  // ---------- Text overlay drag (Shift snaps to center, like captions) ----------
  function onOverlayPointerDown(e: React.PointerEvent<HTMLSpanElement>, id: string) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const ov = overlays.find((o) => o.id === id);
    if (!ov) return;
    ovDragRef.current = { id, px: e.clientX, py: e.clientY, x: ov.x, y: ov.y };
    setSelectedOverlayId(id);
    setOvDragging(true);
    snapRef.current = { x: false, y: false };
  }

  function onOverlayPointerMove(e: React.PointerEvent<HTMLSpanElement>) {
    const d = ovDragRef.current;
    const box = canvasBoxRef.current?.getBoundingClientRect();
    if (!d || !box) return;
    const nx = clamp(d.x + ((e.clientX - d.px) / box.width) * 100, 2, 98);
    const ny = clamp(d.y + ((e.clientY - d.py) / box.height) * 100, 2, 98);
    const SNAP = 1.2;
    const RELEASE = 2.6;
    let ux = nx;
    let uy = ny;
    let gx = false;
    let gy = false;
    if (e.shiftKey) {
      const thrX = snapRef.current.x ? RELEASE : SNAP;
      const thrY = snapRef.current.y ? RELEASE : SNAP;
      if (Math.abs(nx - 50) <= thrX) { ux = 50; gx = true; }
      if (Math.abs(ny - 50) <= thrY) { uy = 50; gy = true; }
    }
    snapRef.current = { x: gx, y: gy };
    pendingOvRef.current = { id: d.id, x: ux, y: uy, gx, gy, sh: e.shiftKey };
    if (rafOvRef.current == null) {
      rafOvRef.current = requestAnimationFrame(() => {
        rafOvRef.current = null;
        const p = pendingOvRef.current;
        if (!p) return;
        setOverlays((prev) => prev.map((o) => (o.id === p.id ? { ...o, x: p.x, y: p.y } : o)));
        setGuides({ shift: p.sh, x: p.gx, y: p.gy });
      });
    }
  }

  function onOverlayPointerUp() {
    ovDragRef.current = null;
    setOvDragging(false);
    if (rafOvRef.current != null) {
      cancelAnimationFrame(rafOvRef.current);
      rafOvRef.current = null;
    }
    const p = pendingOvRef.current;
    pendingOvRef.current = null;
    if (p) {
      setOverlays((prev) => prev.map((o) => (o.id === p.id ? { ...o, x: p.x, y: p.y } : o)));
    }
    setGuides({ shift: false, x: false, y: false });
    snapRef.current = { x: false, y: false };
  }

  // ---------- Text overlay ops ----------
  function addTextOverlay() {
    const ov: TextOverlay = {
      id: uuid(),
      text: "New text",
      font: "poppins",
      x: 50,
      y: 50,
      size: 5,
      color: "#ffffff",
      bold: true,
      bg: false,
    };
    setOverlays((prev) => [...prev, ov].slice(-10));
    setSelectedOverlayId(ov.id);
  }

  function patchOverlay(id: string, patch: Partial<TextOverlay>) {
    setOverlays((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }

  function removeTextOverlay(id: string) {
    setOverlays((prev) => prev.filter((o) => o.id !== id));
    setSelectedOverlayId((sel) => (sel === id ? null : sel));
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

  // ---------- Music ops ----------
  async function loadMusicCatalog(m: string) {
    setMusicLoading(true);
    try {
      const data = await apiFetch<{ configured: boolean; tracks: MusicTrackLite[] }>(
        `/api/music?mood=${encodeURIComponent(m)}`
      );
      setMusicTracks(data.tracks);
    } catch {
      setMusicTracks([]);
    } finally {
      setMusicLoading(false);
    }
  }

  function previewMusicTrack(track: MusicTrackLite) {
    if (audioPreviewRef.current) {
      audioPreviewRef.current.pause();
      audioPreviewRef.current = null;
    }
    if (musicPlaying === track.id) {
      setMusicPlaying(null);
      return;
    }
    const audio = new Audio(track.audio);
    audioPreviewRef.current = audio;
    audio.play().catch(() => toast.error("Preview failed"));
    setMusicPlaying(track.id);
    audio.onended = () => setMusicPlaying(null);
  }

  async function applyMusicTrack(track: MusicTrackLite) {
    if (!clip) return;
    try {
      await apiFetch(`/api/projects/${clip.project_id}/music`, {
        method: "POST",
        body: {
          music_url: track.audio,
          music_title: track.name,
          music_artist: track.artist,
          music_mood: musicTabMood,
        },
      });
      setProject((p) =>
        p ? { ...p, music_title: track.name, music_artist: track.artist, music_mood: musicTabMood } : p
      );
      toast.success(`"${track.name}" set — re-render this clip to hear it`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set music");
    }
  }

  async function aiPickMusic() {
    if (!clip || aiMusicBusy) return;
    setAiMusicBusy(true);
    try {
      const res = await apiFetch<{
        track: { name: string; artist: string; audio: string; mood: string };
      }>(`/api/clips/${clipId}/music/ai`, { method: "POST" });
      setProject((p) =>
        p ? { ...p, music_title: res.track.name, music_artist: res.track.artist, music_mood: res.track.mood } : p
      );
      toast.success(`AI picked "${res.track.name}" — re-render to hear it`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "AI music pick failed");
    } finally {
      setAiMusicBusy(false);
    }
  }

  // Stop preview audio when leaving the editor.
  useEffect(() => () => audioPreviewRef.current?.pause(), []);

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
          caption_anim: captionAnim,
          caption_position: position,
          ...(capX != null && capY != null
            ? { caption_x: Number(capX.toFixed(2)), caption_y: Number(capY.toFixed(2)) }
            : {}),
          caption_size: size,
          caption_words: wordsPerCue,
          caption_width: capWidth,
          video_scale: videoScale,
          video_x: Number(videoX.toFixed(2)),
          video_y: Number(videoY.toFixed(2)),
          text_overlays: overlays.map((o) => ({
            ...o,
            x: Number(o.x.toFixed(2)),
            y: Number(o.y.toFixed(2)),
            size: Number(o.size.toFixed(2)),
            width: Number((o.width ?? 90).toFixed(2)),
          })),
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
  // Words-per-screen display cues (see regroupCuesForDisplay) — only the
  // live caption overlay uses these; the caption editor keeps the original
  // lines so text edits stay per-line.
  const displayCues = useMemo(
    () => (wordsPerCue > 0 ? regroupCuesForDisplay(cues, wordsPerCue) : cues),
    [cues, wordsPerCue]
  );
  const displayCue = useMemo(() => {
    if (wordsPerCue <= 0) return activeCue;
    return (
      displayCues.find((c) => clipTime >= c.start - 0.05 && clipTime <= c.end + 0.05) ?? null
    );
  }, [displayCues, activeCue, clipTime, wordsPerCue]);

  // Music search filter (client-side over the loaded catalog page).
  const musicFiltered = useMemo(() => {
    const q = musicQuery.trim().toLowerCase();
    if (!q) return musicTracks ?? [];
    return (musicTracks ?? []).filter(
      (t) => t.name.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)
    );
  }, [musicTracks, musicQuery]);

  const fontDef = CAPTION_FONTS.find((f) => f.key === font) ?? CAPTION_FONTS[0];

  const selectedOverlay = overlays.find((o) => o.id === selectedOverlayId) ?? null;

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
              ref={canvasBoxRef}
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
                      "relative h-full w-full touch-none",
                      videoFit === "contain" ? "object-contain" : "object-cover",
                      panning ? "cursor-grabbing" : "cursor-grab"
                    )}
                    style={{
                      transform: `translate(${videoX.toFixed(2)}%, ${videoY.toFixed(2)}%) scale(${
                        videoScale / 100
                      })`,
                    }}
                    onLoadedMetadata={(e) => {
                      e.currentTarget.currentTime = startTime;
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onPointerDown={onVideoPointerDown}
                    onPointerMove={onVideoPointerMove}
                    onPointerUp={onVideoPointerUp}
                    onClick={onVideoClick}
                  />
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-zinc-500">
                  <Scissors className="h-5 w-5" />
                  Preview isn't available for split uploads — trimming still works below
                </div>
              )}

              {/* Center guide lines — hold Shift while dragging to snap */}
              {(dragging || ovDragging) && guides.shift && (
                <>
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-100",
                      guides.x
                        ? "bg-primary-400 shadow-[0_0_8px_rgba(255,93,28,0.9)]"
                        : "bg-white/25"
                    )}
                  />
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 transition-colors duration-100",
                      guides.y
                        ? "bg-primary-400 shadow-[0_0_8px_rgba(255,93,28,0.9)]"
                        : "bg-white/25"
                    )}
                  />
                </>
              )}
              {/* Live caption overlay — karaoke with word animations, fully
                  draggable + scalable CapCut-style (box appears on hover) */}
              {displayCue?.text.trim() && (
                <div
                  key={displayCue.id}
                  className="pointer-events-none absolute inset-x-0 flex justify-center text-center"
                  style={{
                    fontFamily: fontDef.cssVar,
                    ...(captionAnim === "slideUp"
                      ? { animation: "cfSlideUp 200ms ease-out" }
                      : {}),
                    ...(capY == null
                      ? position === "top"
                        ? { top: "8%" }
                        : position === "middle"
                          ? { top: "50%", transform: "translateY(-50%)" }
                          : { bottom: "8%" }
                      : {
                          left: `${capX}%`,
                          right: "auto",
                          top: `${capY}%`,
                          bottom: "auto",
                          transform: "translate(-50%, -50%)",
                        }),
                  }}
                >
                  <span
                    onPointerDown={onCaptionPointerDown}
                    onPointerMove={onCaptionPointerMove}
                    onPointerUp={onCaptionPointerUp}
                    onMouseEnter={() => setCapHover(true)}
                    onMouseLeave={() => setCapHover(false)}
                    className={cn(
                      "pointer-events-auto relative inline-block touch-none select-none",
                      dragging || scaling ? "cursor-grabbing" : "cursor-grab"
                    )}
                    style={{
                      fontSize: `${previewFontSize}px`,
                      maxWidth:
                        canvasPx.w > 0
                          ? `${((capWidth / 100) * canvasPx.w).toFixed(1)}px`
                          : `${capWidth}%`,
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
                    {(() => {
                      const cueWords =
                        Array.isArray(displayCue.words) && displayCue.words.length > 0
                          ? displayCue.words
                          : null;
                      if (!cueWords) return displayCue.text;
                      const activeIdx = cueWords.findIndex(
                        (w) => clipTime >= w.start - 0.05 && clipTime <= w.end + 0.05
                      );
                      return cueWords.map((w, i) => (
                        <span
                          key={i}
                          style={{
                            color:
                              i === activeIdx
                                ? "#ff5d1c"
                                : textColor.toLowerCase() === "#ffffff"
                                  ? "#d9d9d9"
                                  : textColor,
                            ...wordAnimStyle(captionAnim, i === activeIdx, activeIdx !== -1),
                          }}
                        >
                          {w.word}
                          {i < cueWords.length - 1 ? " " : ""}
                        </span>
                      ));
                    })()}
                    {(capHover || dragging || scaling) && (
                      <>
                        <span className="pointer-events-none absolute left-0 top-0 h-3.5 w-3.5 border-l-[3px] border-t-[3px] border-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
                        <span className="pointer-events-none absolute right-0 top-0 h-3.5 w-3.5 border-r-[3px] border-t-[3px] border-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
                        <span className="pointer-events-none absolute bottom-0 left-0 h-3.5 w-3.5 border-b-[3px] border-l-[3px] border-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
                        <span className="pointer-events-none absolute bottom-0 right-0 h-3.5 w-3.5 border-b-[3px] border-r-[3px] border-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
                        <span
                          onPointerDown={onScalePointerDown}
                          onPointerMove={onScalePointerMove}
                          onPointerUp={onScalePointerUp}
                          className="pointer-events-auto absolute -bottom-2.5 -right-2.5 h-4 w-4 rounded-full border-2 border-black/70 bg-white shadow-md touch-none"
                          style={{ cursor: "nwse-resize" }}
                        />
                      </>
                    )}
                  </span>
                </div>
              )}

              {/* Custom text overlays — draggable, Shift snaps to center */}
              {overlays.map((ov) => (
                <div
                  key={ov.id}
                  className="pointer-events-none absolute"
                  style={{
                    left: `${ov.x}%`,
                    top: `${ov.y}%`,
                    transform: "translate(-50%, -50%)",
                  }}
                >
                  <span
                    onPointerDown={(e) => onOverlayPointerDown(e, ov.id)}
                    onPointerMove={onOverlayPointerMove}
                    onPointerUp={onOverlayPointerUp}
                    onClick={() => {
                      setSelectedOverlayId(ov.id);
                      setTab("text");
                    }}
                    className={cn(
                      "pointer-events-auto inline-block whitespace-pre-wrap rounded-md px-1.5 py-0.5 touch-none select-none",
                      ovDragging && selectedOverlayId === ov.id
                        ? "cursor-grabbing"
                        : "cursor-grab",
                      selectedOverlayId === ov.id
                        ? "ring-2 ring-primary-400/90"
                        : "ring-1 ring-transparent hover:ring-white/40"
                    )}
                    style={{
                      fontFamily: (
                        CAPTION_FONTS.find((f) => f.key === ov.font) ?? CAPTION_FONTS[0]
                      ).cssVar,
                      fontSize: `${(ov.size / 100) * canvasPx.h}px`,
                      maxWidth:
                        canvasPx.w > 0
                          ? `${(((ov.width ?? 90) / 100) * canvasPx.w).toFixed(1)}px`
                          : `${ov.width ?? 90}%`,
                      lineHeight: 1.2,
                      fontWeight: ov.bold ? 800 : 500,
                      color: ov.color,
                      ...(ov.bg
                        ? {
                            background: "rgba(0,0,0,0.72)",
                            borderRadius: "0.35em",
                          }
                        : { textShadow: "0 2px 4px rgba(0,0,0,0.8)" }),
                    }}
                  >
                    {ov.text || "Text"}
                  </span>
                </div>
              ))}

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
        <aside className="flex w-[380px] shrink-0 flex-col border-l border-white/10 bg-[#161619]">
          <div className="flex items-center gap-1 border-b border-white/10 px-4 py-3">
            {(
              [
                { key: "frame", label: "Frame", icon: FrameIcon },
                { key: "text", label: "Text", icon: TypeIcon },
                { key: "music", label: "Music", icon: MusicIcon },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => {
                  setTab(key);
                  if (key === "music" && musicTracks === null) void loadMusicCatalog(musicTabMood);
                }}
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

                <div>
                  <div className="flex items-baseline justify-between pb-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Zoom & pan
                    </p>
                    <span className="text-[10px] tabular-nums text-zinc-500">{videoScale}%</span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={300}
                    step={5}
                    value={videoScale}
                    onChange={(e) => setVideoScale(Number(e.target.value))}
                    className="h-1 w-full accent-primary-500"
                    aria-label="Video zoom"
                  />
                  <div className="flex items-center justify-between pt-1.5">
                    <p className="text-[10px] text-zinc-600">
                      {videoScale === 100
                        ? "Zoom in, then drag the video on the canvas to move it"
                        : "Drag the video on the canvas to move it"}
                    </p>
                    <button
                      onClick={() => {
                        setVideoScale(100);
                        setVideoX(0);
                        setVideoY(0);
                      }}
                      disabled={videoScale === 100 && videoX === 0 && videoY === 0}
                      className="ml-2 shrink-0 rounded-md bg-white/10 px-2 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-white/15 disabled:opacity-40"
                    >
                      Reset
                    </button>
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
                    min={20}
                    max={160}
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
                  <div className="flex items-baseline justify-between pb-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Words per screen
                    </p>
                    <span className="text-[10px] tabular-nums text-zinc-500">
                      {wordsPerCue > 0 ? `${wordsPerCue} word${wordsPerCue === 1 ? "" : "s"}` : "Off"}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    step={1}
                    value={wordsPerCue > 0 ? wordsPerCue : 1}
                    onChange={(e) => setWordsPerCue(Number(e.target.value))}
                    onDoubleClick={() => setWordsPerCue(0)}
                    className="h-1 w-full accent-primary-500"
                    aria-label="Words per screen"
                  />
                  <p className="pt-1 text-[10px] leading-snug text-zinc-600">
                    Show N words at a time · double-click the slider to turn off
                  </p>
                </div>

                <div>
                  <div className="flex items-baseline justify-between pb-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Caption width
                    </p>
                    <span className="text-[10px] tabular-nums text-zinc-500">{capWidth}%</span>
                  </div>
                  <input
                    type="range"
                    min={30}
                    max={100}
                    step={5}
                    value={capWidth}
                    onChange={(e) => setCapWidth(Number(e.target.value))}
                    className="h-1 w-full accent-primary-500"
                    aria-label="Caption width"
                  />
                  <p className="pt-1 text-[10px] leading-snug text-zinc-600">
                    How wide the caption box gets before text wraps
                  </p>
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
                <div>
                  <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Animation
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {CAPTION_ANIMS.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => setCaptionAnim(a.id)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors",
                          captionAnim === a.id
                            ? "border-primary-500 bg-primary-500/10 text-primary-200"
                            : "border-white/10 bg-white/[0.03] text-zinc-300 hover:border-white/20"
                        )}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <p className="pt-1.5 text-[10px] text-zinc-600">
                    How caption words behave while they are spoken
                  </p>
                </div>

                <div className="border-t border-white/10 pt-4">
                  <div className="flex items-center justify-between pb-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Text overlays
                    </p>
                    <button
                      onClick={addTextOverlay}
                      disabled={overlays.length >= 10}
                      className="rounded-md bg-primary-500/20 px-2.5 py-1 text-[11px] font-medium text-primary-200 hover:bg-primary-500/30 disabled:opacity-40"
                    >
                      + Add text
                    </button>
                  </div>
                  {overlays.length === 0 ? (
                    <p className="text-[10px] leading-relaxed text-zinc-600">
                      Add standalone text — titles, labels, callouts. Drag it anywhere on the
                      video, pick the font, size and colour, and it renders exactly where you
                      placed it.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-1.5">
                        {overlays.map((ov, i) => (
                          <button
                            key={ov.id}
                            onClick={() => setSelectedOverlayId(ov.id)}
                            className={cn(
                              "max-w-[140px] truncate rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors",
                              selectedOverlayId === ov.id
                                ? "border-primary-500 bg-primary-500/10 text-primary-200"
                                : "border-white/10 bg-white/[0.03] text-zinc-300 hover:border-white/20"
                            )}
                          >
                            {i + 1}. {ov.text || "Text"}
                          </button>
                        ))}
                      </div>
                      {selectedOverlay && (
                        <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
                          <textarea
                            value={selectedOverlay.text}
                            onChange={(e) =>
                              patchOverlay(selectedOverlay.id, { text: e.target.value.slice(0, 200) })
                            }
                            rows={2}
                            maxLength={200}
                            placeholder="Overlay text — Enter for a new line"
                            className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-primary-500/60"
                          />
                          <div className="grid grid-cols-3 gap-1.5">
                            {CAPTION_FONTS.slice(0, 9).map((f) => (
                              <button
                                key={f.key}
                                onClick={() => patchOverlay(selectedOverlay.id, { font: f.key })}
                                style={{ fontFamily: f.cssVar }}
                                className={cn(
                                  "truncate rounded-md border px-2 py-1 text-[10px] transition-colors",
                                  selectedOverlay.font === f.key
                                    ? "border-primary-500 bg-primary-500/10 text-primary-200"
                                    : "border-white/10 text-zinc-300 hover:border-white/25"
                                )}
                              >
                                {f.label}
                              </button>
                            ))}
                          </div>
                          <div>
                            <div className="flex items-baseline justify-between pb-1">
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                                Size
                              </p>
                              <span className="text-[10px] tabular-nums text-zinc-500">
                                {selectedOverlay.size.toFixed(1)}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min={2}
                              max={20}
                              step={0.5}
                              value={selectedOverlay.size}
                              onChange={(e) =>
                                patchOverlay(selectedOverlay.id, { size: Number(e.target.value) })
                              }
                              className="h-1 w-full accent-primary-500"
                              aria-label="Overlay size"
                            />
                          </div>

                          <div>
                            <div className="flex items-baseline justify-between pb-1">
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                                Width
                              </p>
                              <span className="text-[10px] tabular-nums text-zinc-500">
                                {selectedOverlay.width ?? 90}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min={20}
                              max={100}
                              step={5}
                              value={selectedOverlay.width ?? 90}
                              onChange={(e) =>
                                patchOverlay(selectedOverlay.id, { width: Number(e.target.value) })
                              }
                              className="h-1 w-full accent-primary-500"
                              aria-label="Overlay width"
                            />
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {TEXT_COLORS.map((c) => (
                              <button
                                key={c}
                                onClick={() => patchOverlay(selectedOverlay.id, { color: c })}
                                aria-label={`Overlay colour ${c}`}
                                className={cn(
                                  "h-6 w-6 rounded-full border transition-transform",
                                  selectedOverlay.color.toLowerCase() === c.toLowerCase()
                                    ? "scale-110 border-primary-500 ring-2 ring-primary-500/40"
                                    : "border-white/20 hover:scale-105"
                                )}
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              onClick={() => patchOverlay(selectedOverlay.id, { bold: !selectedOverlay.bold })}
                              className={cn(
                                "rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors",
                                selectedOverlay.bold
                                  ? "border-primary-500 bg-primary-500/15 text-primary-200"
                                  : "border-white/10 text-zinc-400 hover:border-white/25"
                              )}
                            >
                              Bold
                            </button>
                            <button
                              onClick={() => patchOverlay(selectedOverlay.id, { bg: !selectedOverlay.bg })}
                              className={cn(
                                "rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors",
                                selectedOverlay.bg
                                  ? "border-primary-500 bg-primary-500/15 text-primary-200"
                                  : "border-white/10 text-zinc-400 hover:border-white/25"
                              )}
                            >
                              Box
                            </button>
                            <button
                              onClick={() => patchOverlay(selectedOverlay.id, { x: 50 })}
                              className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] font-medium text-zinc-400 hover:border-white/25"
                            >
                              Center H
                            </button>
                            <button
                              onClick={() => patchOverlay(selectedOverlay.id, { y: 50 })}
                              className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] font-medium text-zinc-400 hover:border-white/25"
                            >
                              Center V
                            </button>
                            <button
                              onClick={() => removeTextOverlay(selectedOverlay.id)}
                              className="ml-auto rounded-full border border-red-500/40 px-2.5 py-1 text-[10px] font-medium text-red-300 hover:bg-red-500/15"
                            >
                              Delete
                            </button>
                          </div>
                          <p className="text-[10px] text-zinc-600">
                            Drag the text on the video to move it · hold Shift while dragging to
                            snap to the center lines
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === "music" && (
              <div className="space-y-4">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Current track
                  </p>
                  <p className="pt-1 text-sm text-zinc-200">
                    {project?.music_title
                      ? `${project.music_title}${project.music_artist ? ` — ${project.music_artist}` : ""}`
                      : "No music set"}
                  </p>
                </div>

                <button
                  onClick={() => void aiPickMusic()}
                  disabled={aiMusicBusy}
                  className="w-full rounded-lg bg-primary-500/20 px-3 py-2 text-xs font-semibold text-primary-200 hover:bg-primary-500/30 disabled:opacity-50"
                >
                  {aiMusicBusy ? "Picking…" : "AI pick from transcript (10 credits)"}
                </button>

                <div>
                  <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Mood
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {MUSIC_MOODS.map((m) => (
                      <button
                        key={m}
                        onClick={() => {
                          setMusicTabMood(m);
                          void loadMusicCatalog(m);
                        }}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[10px] font-medium capitalize transition-colors",
                          musicTabMood === m
                            ? "border-primary-500 bg-primary-500/15 text-primary-200"
                            : "border-white/10 text-zinc-400 hover:border-white/25"
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                  <input
                    value={musicQuery}
                    onChange={(e) => setMusicQuery(e.target.value)}
                    placeholder="Search tracks or artists…"
                    className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-2 pl-8 pr-3 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-primary-500/60"
                  />
                </div>

                <div className="space-y-2">
                  {musicLoading && <p className="text-xs text-zinc-500">Loading catalog…</p>}
                  {musicFiltered.map((track) => (
                    <div
                      key={track.id}
                      className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2 transition-colors hover:border-white/20"
                    >
                      <button
                        onClick={() => previewMusicTrack(track)}
                        aria-label="Preview"
                        className="shrink-0 rounded-full bg-white/10 p-1.5 text-zinc-200 hover:bg-white/20"
                      >
                        {musicPlaying === track.id ? (
                          <Pause className="h-3.5 w-3.5" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-zinc-200">{track.name}</p>
                        <p className="truncate text-[10px] text-zinc-500">{track.artist}</p>
                      </div>
                      <button
                        onClick={() => void applyMusicTrack(track)}
                        className="shrink-0 rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold text-black hover:bg-zinc-200"
                      >
                        Use
                      </button>
                    </div>
                  ))}
                  {!musicLoading && musicFiltered.length === 0 && musicTracks !== null && (
                    <p className="text-xs text-zinc-500">
                      No tracks match{musicQuery ? ` "${musicQuery}"` : " this mood"} — try
                      another mood.
                    </p>
                  )}
                </div>

                <p className="text-[10px] leading-relaxed text-zinc-600">
                  Applies to the project's background music. Re-render this clip to hear the
                  new track.
                </p>
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
                      onClick={() => setShadow((v) => !v)}
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
          onScrub={(t) => scrub(t + startTime)}
          pxPerSec={zoom}
          maxDuration={sourceDuration - startTime || undefined}
        />
      </div>
      <div className="flex items-center justify-between px-5 py-1.5 text-[10px] text-zinc-600">
        <span>Source · drag edges to stretch the clip, runway is source material</span>
        <span>Editing runs on your device · larger clips take longer · the result is saved to your uploaded clips</span>
      </div>
    </div>
  );
}