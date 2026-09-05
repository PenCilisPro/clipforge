"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Film,
  Loader2,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { CAPTION_FONTS, CAPTION_STYLES, type Clip, type Project } from "@/lib/types";
import { cuesToSrtText, parseSrt, type SrtCue } from "@/lib/srt-client";
import { AnimatedCaptionPreview, CaptionPreview } from "@/components/dashboard/caption-preview";
import { Reveal } from "@/components/dashboard/reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const AI_CREDIT_COST = 10;

/** Music (MP3) and B-roll (MP4) uploads may not exceed this size. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const BROLL_CATEGORIES: { label: string; q: string }[] = [
  { label: "Nature", q: "nature landscape" },
  { label: "City", q: "city street aerial" },
  { label: "People", q: "people walking" },
  { label: "Business", q: "business office work" },
  { label: "Tech", q: "technology computer" },
  { label: "Food", q: "food cooking" },
  { label: "Sports", q: "sports action" },
  { label: "Abstract", q: "abstract background" },
];

const MUSIC_MOODS = [
  "upbeat",
  "chill",
  "dramatic",
  "corporate",
  "energetic",
  "happy",
  "epic",
  "background",
];

interface StockResult {
  url: string;
  poster: string | null;
  provider: string;
  duration: number;
}

interface MusicTrack {
  id: string;
  name: string;
  artist: string;
  duration: number;
  audio: string;
  image: string | null;
}

function formatTime(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export default function ClipEditPage() {
  const router = useRouter();
  const params = useParams<{ id: string; clipId: string }>();
  const supabase = useCallback(() => createClient(), []);

  const [loading, setLoading] = useState(true);
  const [clip, setClip] = useState<Clip | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isFinalRender, setIsFinalRender] = useState(true);
  const [credits, setCredits] = useState<number | null>(null);
  const [brollBusy, setBrollBusy] = useState(false);
  const [musicBusy, setMusicBusy] = useState(false);

  const [cues, setCues] = useState<SrtCue[]>([]);
  const [captionStyle, setCaptionStyle] = useState<Clip["caption_style"]>("karaoke");
  const [captionFont, setCaptionFont] = useState<NonNullable<Clip["caption_font"]>>("anton");
  const [captionStroke, setCaptionStroke] = useState(false);
  const [captionShadow, setCaptionShadow] = useState(false);
  const [strokeColor, setStrokeColor] = useState("#000000");
  const [strokeSize, setStrokeSize] = useState(4);
  const [shadowColor, setShadowColor] = useState("#000000");
  const [shadowSize, setShadowSize] = useState(6);
  const [resetSrt, setResetSrt] = useState(false);
  const [startTime, setStartTime] = useState("0");
  const [endTime, setEndTime] = useState("0");
  const [saving, setSaving] = useState(false);

  const [brollQuery, setBrollQuery] = useState("");
  const [brollResults, setBrollResults] = useState<StockResult[] | null>(null);
  const [brollSearching, setBrollSearching] = useState(false);

  const [musicMood, setMusicMood] = useState("background");
  const [musicQuery, setMusicQuery] = useState("");
  const [musicTracks, setMusicTracks] = useState<MusicTrack[] | null>(null);
  const [musicLoading, setMusicLoading] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [musicUploading, setMusicUploading] = useState(false);
  const [brollUploading, setBrollUploading] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicFileRef = useRef<HTMLInputElement | null>(null);
  const brollFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { project: loaded } = await apiFetch<{
          project: { clips: Clip[] } & Project;
        }>(`/api/projects/${params.id}`);
        const found = (loaded.clips as Clip[]).find((c) => c.id === params.clipId);
        if (!found) throw new Error("Clip not found");
        setClip(found);
        setProject(loaded);
        setCaptionStyle(found.caption_style ?? "karaoke");
        setCaptionFont(found.caption_font ?? "anton");
        setCaptionStroke(found.caption_stroke ?? false);
        setCaptionShadow(found.caption_shadow ?? false);
        setStrokeColor(found.caption_stroke_color ?? "#000000");
        setStrokeSize(found.caption_stroke_size ?? 4);
        setShadowColor(found.caption_shadow_color ?? "#000000");
        setShadowSize(found.caption_shadow_size ?? 6);
        setStartTime(String(Number(found.start_time)));
        setEndTime(String(Number(found.end_time)));

        // Manual overrides show up directly; otherwise fetch the stored SRT.
        if (found.srt_override) {
          setCues(parseSrt(found.srt_override));
        }

        const playback = await apiFetch<{
          video_url: string;
          srt_url: string | null;
          is_final_render: boolean;
        }>(`/api/clips/${params.clipId}/playback`);
        setVideoUrl(playback.video_url);
        setIsFinalRender(playback.is_final_render);

        if (!found.srt_override && playback.srt_url) {
          const res = await fetch(playback.srt_url);
          if (res.ok) setCues(parseSrt(await res.text()));
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load clip");
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id, params.clipId]);

  async function loadCredits() {
    try {
      const me = await apiFetch<{ profile: { credits_remaining: number } }>("/api/me");
      setCredits(me.profile.credits_remaining);
    } catch {
      // non-critical — the endpoints re-check server-side
    }
  }

  useEffect(() => {
    loadCredits();
  }, []);

  async function fetchMusic(mood: string, q: string) {
    setMusicLoading(true);
    try {
      const res = await apiFetch<{ tracks: MusicTrack[] }>(
        `/api/music?mood=${encodeURIComponent(mood)}${q ? `&q=${encodeURIComponent(q)}` : ""}`
      );
      setMusicTracks(res.tracks);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Music search failed");
    } finally {
      setMusicLoading(false);
    }
  }

  function updateCue(id: string, patch: Partial<SrtCue>) {
    setCues((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    setResetSrt(false);
  }

  function addCue() {
    const last = cues[cues.length - 1];
    const start = last ? last.end + 0.2 : 0;
    setCues((prev) => [
      ...prev,
      { id: crypto.randomUUID(), start, end: start + 1.5, text: "New caption" },
    ]);
    setResetSrt(false);
  }

  // ---------- B-roll ----------

  async function saveBrollSegments(segments: NonNullable<Clip["broll_json"]>) {
    if (!clip) return;
    try {
      const res = await apiFetch<{ broll: NonNullable<Clip["broll_json"]> }>(
        `/api/clips/${clip.id}/broll/segments`,
        { method: "POST", body: { segments } }
      );
      setClip({ ...clip, broll_json: res.broll });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save B-roll");
    }
  }

  async function searchBroll(q: string) {
    if (!clip || !q.trim()) return;
    setBrollSearching(true);
    try {
      const res = await apiFetch<{ results: StockResult[] }>(
        `/api/clips/${clip.id}/broll/search?q=${encodeURIComponent(q.trim())}`
      );
      setBrollResults(res.results);
      if (res.results.length === 0) toast.info("No stock clips found for that search");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "B-roll search failed");
    } finally {
      setBrollSearching(false);
    }
  }

  async function addBrollSegment(result: StockResult) {
    if (!clip) return;
    const duration = Math.max(3, Number(endTime) - Number(startTime));
    const segments = Array.isArray(clip.broll_json) ? clip.broll_json : [];
    if (segments.length >= 8) {
      toast.error("A clip can hold at most 8 B-roll scenes — remove one first");
      return;
    }
    const lastEnd = segments.length > 0 ? segments[segments.length - 1].end : 0;
    const start = Math.min(Math.max(lastEnd + 1, 0), Math.max(0, duration - 3));
    const end = Math.min(start + 3, duration);
    await saveBrollSegments([...segments, { start, end, src: result.url }]);
    toast.success("B-roll scene added — adjust its timing below");
  }

  async function useUploadedBroll(file: File) {
    if (!clip || !validateUpload(file, "video")) return;
    const segments = Array.isArray(clip.broll_json) ? clip.broll_json : [];
    if (segments.length >= 8) {
      toast.error("A clip can hold at most 8 B-roll scenes — remove one first");
      return;
    }
    setBrollUploading(true);
    try {
      const userId = await getUserId();
      const path = `${userId}/broll/${Date.now()}-${file.name.replace(/\s+/g, "-")}`;
      const { error } = await supabase()
        .storage.from("user-uploads")
        .upload(path, file, { cacheControl: "3600", upsert: false, contentType: "video/mp4" });
      if (error) throw error;

      const duration = Math.max(3, Number(endTime) - Number(startTime));
      const lastEnd = segments.length > 0 ? segments[segments.length - 1].end : 0;
      const start = Math.min(Math.max(lastEnd + 1, 0), Math.max(0, duration - 3));
      const end = Math.min(start + 3, duration);
      await saveBrollSegments([...segments, { start, end, src: `storage:user-uploads/${path}` }]);
      toast.success("Uploaded B-roll added — adjust its timing below");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "B-roll upload failed");
    } finally {
      setBrollUploading(false);
      if (brollFileRef.current) brollFileRef.current.value = "";
    }
  }

  async function removeBrollSegment(index: number) {
    if (!clip || !Array.isArray(clip.broll_json)) return;
    await saveBrollSegments(clip.broll_json.filter((_, i) => i !== index));
  }

  async function updateBrollSegment(index: number, field: "start" | "end", value: number) {
    if (!clip || !Array.isArray(clip.broll_json)) return;
    const next = clip.broll_json.map((s, i) => (i === index ? { ...s, [field]: value } : s));
    setClip({ ...clip, broll_json: next });
    await saveBrollSegments(next);
  }

  async function generateBroll() {
    if (!clip || brollBusy) return;
    setBrollBusy(true);
    try {
      const res = await apiFetch<{ broll: Clip["broll_json"]; credits_remaining: number }>(
        `/api/clips/${clip.id}/broll/ai`,
        { method: "POST" }
      );
      setClip({ ...clip, broll_json: res.broll });
      setCredits(res.credits_remaining);
      const count = res.broll?.length ?? 0;
      toast.success(
        count > 0 ? `B-roll ready — ${count} scene${count === 1 ? "" : "s"} added` : "No B-roll moments found for this clip",
        { description: `10 credits used · applies when you re-render · ${res.credits_remaining} left` }
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "B-roll generation failed");
    } finally {
      setBrollBusy(false);
    }
  }

  async function setBrollMode(mode: "auto" | "none") {
    if (!clip || brollBusy) return;
    setBrollBusy(true);
    try {
      const res = await apiFetch<{ broll_json: Clip["broll_json"] }>(`/api/clips/${clip.id}/broll`, {
        method: "POST",
        body: { mode },
      });
      setClip({ ...clip, broll_json: res.broll_json });
      toast.success(mode === "auto" ? "B-roll set to automatic" : "B-roll turned off for this clip");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update B-roll");
    } finally {
      setBrollBusy(false);
    }
  }

  // ---------- Music ----------

  function stopPreview() {
    previewAudioRef.current?.pause();
    setPreviewingId(null);
  }

  function togglePreview(track: MusicTrack) {
    if (previewingId === track.id) {
      stopPreview();
      return;
    }
    let audio = previewAudioRef.current;
    if (!audio) {
      audio = new Audio();
      previewAudioRef.current = audio;
      audio.addEventListener("ended", () => setPreviewingId(null));
    }
    audio.src = track.audio;
    audio.play().catch(() => toast.error("Couldn't play the preview"));
    setPreviewingId(track.id);
  }

  async function getUserId(): Promise<string> {
    const { data } = await supabase().auth.getSession();
    if (!data.session) throw new Error("Not signed in");
    return data.session.user.id;
  }

  function validateUpload(file: File, kind: "audio" | "video") {
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error("File is too large — uploads can't exceed 20 MB");
      return false;
    }
    const ok =
      kind === "audio"
        ? file.type === "audio/mpeg" || /\.mp3$/i.test(file.name)
        : file.type === "video/mp4" || /\.mp4$/i.test(file.name);
    if (!ok) {
      toast.error(kind === "audio" ? "Only MP3 files are supported" : "Only MP4 files are supported");
      return false;
    }
    return true;
  }

  async function useUploadedMusic(file: File) {
    if (!project || !validateUpload(file, "audio")) return;
    setMusicUploading(true);
    try {
      const userId = await getUserId();
      const path = `${userId}/music/${Date.now()}-${file.name.replace(/\s+/g, "-")}`;
      const { error } = await supabase()
        .storage.from("user-uploads")
        .upload(path, file, { cacheControl: "3600", upsert: false, contentType: "audio/mpeg" });
      if (error) throw error;

      const title = file.name.replace(/\.[^.]+$/, "").slice(0, 200);
      await apiFetch(`/api/projects/${project.id}/music`, {
        method: "POST",
        body: {
          music_storage_path: path,
          music_title: title,
          music_mood: musicMood,
        },
      });
      setProject({
        ...project,
        music_url: null,
        music_storage_path: path,
        music_title: title,
        music_artist: "Your upload",
        music_mood: musicMood,
      });
      toast.success(`Music: ${title}`, {
        description: "Your uploaded track applies on the next re-render",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Music upload failed");
    } finally {
      setMusicUploading(false);
      if (musicFileRef.current) musicFileRef.current.value = "";
    }
  }

  async function useTrack(track: MusicTrack, mood: string) {
    if (!project) return;
    stopPreview();
    try {
      await apiFetch(`/api/projects/${project.id}/music`, {
        method: "POST",
        body: {
          music_url: track.audio,
          music_title: track.name,
          music_artist: track.artist,
          music_mood: mood,
        },
      });
      setProject({
        ...project,
        music_url: track.audio,
        music_storage_path: null,
        music_title: track.name,
        music_artist: track.artist,
        music_mood: mood,
      });
      toast.success(`Music: ${track.name}`, {
        description: "Applies to the project on the next re-render",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set music");
    }
  }

  async function generateMusic() {
    if (!clip || musicBusy) return;
    setMusicBusy(true);
    try {
      const res = await apiFetch<{
        track: { name: string; artist: string; mood: string };
        credits_remaining: number;
      }>(`/api/clips/${clip.id}/music/ai`, { method: "POST" });
      setProject((prev) =>
        prev
          ? {
              ...prev,
              music_url: null,
              music_title: res.track.name,
              music_artist: res.track.artist,
              music_mood: res.track.mood,
            }
          : prev
      );
      setCredits(res.credits_remaining);
      toast.success(`Music: ${res.track.name}`, {
        description: `${res.track.artist} · ${res.track.mood} · 10 credits used · applies on re-render`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Music generation failed");
    } finally {
      setMusicBusy(false);
    }
  }

  // ---------- Save ----------

  async function save() {
    if (!clip || saving) return;
    const start = Number(startTime);
    const end = Number(endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3) {
      toast.error("Clip must be at least 3 seconds long");
      return;
    }
    if (!resetSrt) {
      for (const cue of cues) {
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
          caption_style: captionStyle,
          caption_font: captionFont,
          caption_stroke: captionStroke,
          caption_shadow: captionShadow,
          caption_stroke_color: strokeColor,
          caption_stroke_size: strokeSize,
          caption_shadow_color: shadowColor,
          caption_shadow_size: shadowSize,
          start_time: start,
          end_time: end,
          ...(resetSrt
            ? { srt_content: "" } // clear override → pipeline regenerates
            : cues.length > 0
              ? { srt_content: cuesToSrtText(cues) }
              : {}),
        },
      });
      toast.success("Saved — re-render started", {
        description: "The clip will show its new look once rendering finishes.",
      });
      router.push(`/dashboard/projects/${params.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save clip");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <Skeleton className="aspect-[9/16] max-h-72 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (!clip) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="font-medium">Clip not found</p>
        <Button asChild variant="outline" className="mt-4">
          <Link href={`/dashboard/projects/${params.id}`}>Back to project</Link>
        </Button>
      </div>
    );
  }

  const clipDuration = Math.max(3, Number(endTime) - Number(startTime));
  const brollSegments = Array.isArray(clip.broll_json) ? clip.broll_json : [];

  return (
    <Reveal className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-1">
            <Link href={`/dashboard/projects/${params.id}`}>
              <ArrowLeft /> Back to project
            </Link>
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">
            Edit — {clip.title ?? "Untitled clip"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Edit captions, pick a style, add B-roll & music, trim the window,
            then re-render.
          </p>
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          {saving ? "Re-rendering…" : "Save & re-render"}
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* Preview + captions/timing | captions editor + B-roll + Music */}
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="aspect-[9/16] max-h-96 w-full bg-zinc-900">
              {videoUrl ? (
                <video
                  key={videoUrl}
                  src={videoUrl}
                  controls
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  No video yet
                </div>
              )}
            </div>
            <CardContent className="p-3">
              <Badge variant={isFinalRender ? "default" : "secondary"}>
                {isFinalRender ? "Final render" : "Raw trim preview"}
              </Badge>
            </CardContent>
          </Card>

          {/* Timing + captions */}
          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Start (seconds)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.1}
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">End (seconds)</Label>
                  <Input
                    type="number"
                    min={3}
                    step={0.1}
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Live caption preview</Label>
                <AnimatedCaptionPreview
                  style={captionStyle}
                  fontKey={captionFont}
                  stroke={captionStroke}
                  shadow={captionShadow}
                  strokeColor={strokeColor}
                  strokeSize={strokeSize}
                  shadowColor={shadowColor}
                  shadowSize={shadowSize}
                />
                <p className="text-xs text-muted-foreground">
                  The accented word follows the voice — exactly what the render
                  produces.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Caption template</Label>
                <div className="grid grid-cols-2 gap-2">
                  {CAPTION_STYLES.map((style) => (
                    <button
                      key={style.key}
                      type="button"
                      onClick={() => setCaptionStyle(style.key)}
                      className={cn(
                        "rounded-lg border p-1.5 text-left transition-all hover:border-primary-500/60",
                        captionStyle === style.key &&
                          "border-primary-500 ring-2 ring-primary-500/30"
                      )}
                    >
                      <CaptionPreview
                        style={style.key}
                        fontKey={captionFont}
                        stroke={captionStroke}
                        shadow={captionShadow}
                        strokeColor={strokeColor}
                        strokeSize={strokeSize}
                        shadowColor={shadowColor}
                        shadowSize={shadowSize}
                      />
                      <p className="mt-1.5 text-xs font-semibold">{style.label}</p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {CAPTION_STYLES.find((s) => s.key === captionStyle)?.description}
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={captionStroke}
                    onChange={(e) => setCaptionStroke(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  <span className="font-medium">Stroke</span>
                  <input
                    type="color"
                    value={strokeColor}
                    onChange={(e) => setStrokeColor(e.target.value)}
                    disabled={!captionStroke}
                    aria-label="Stroke color"
                    className="h-6 w-8 cursor-pointer rounded border bg-transparent p-0.5 disabled:opacity-40"
                  />
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={strokeSize}
                    onChange={(e) => setStrokeSize(Number(e.target.value))}
                    disabled={!captionStroke}
                    aria-label="Stroke size"
                    className="h-1 flex-1 accent-[var(--primary)] disabled:opacity-40"
                  />
                  <span className="w-4 text-right tabular-nums">{strokeSize}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={captionShadow}
                    onChange={(e) => setCaptionShadow(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  <span className="font-medium">Shadow</span>
                  <input
                    type="color"
                    value={shadowColor}
                    onChange={(e) => setShadowColor(e.target.value)}
                    disabled={!captionShadow}
                    aria-label="Shadow color"
                    className="h-6 w-8 cursor-pointer rounded border bg-transparent p-0.5 disabled:opacity-40"
                  />
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={shadowSize}
                    onChange={(e) => setShadowSize(Number(e.target.value))}
                    disabled={!captionShadow}
                    aria-label="Shadow size"
                    className="h-1 flex-1 accent-[var(--primary)] disabled:opacity-40"
                  />
                  <span className="w-4 text-right tabular-nums">{shadowSize}</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Caption font</Label>
                <div className="grid grid-cols-2 gap-2">
                  {CAPTION_FONTS.map((font) => (
                    <button
                      key={font.key}
                      type="button"
                      onClick={() => setCaptionFont(font.key)}
                      style={{ fontFamily: font.cssVar }}
                      className={cn(
                        "truncate rounded-lg border px-2 py-2 text-sm transition-all hover:border-primary-500/60",
                        captionFont === font.key &&
                          "border-primary-500 ring-2 ring-primary-500/30"
                      )}
                    >
                      {font.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={resetSrt}
                  onChange={(e) => setResetSrt(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                />
                Reset captions to AI-generated (discards edits below)
              </label>
            </CardContent>
          </Card>
        </div>

        {/* Caption editor + B-roll + Music */}
        <div className="space-y-4">
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">Captions</p>
                <p className="text-xs text-muted-foreground">
                  Each line appears on screen during its time range. Times are
                  relative to the clip start.
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={addCue}>
                <Plus /> Add line
              </Button>
            </div>

            {resetSrt ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Captions will be regenerated from the transcript when you save.
              </p>
            ) : (
              <div className="max-h-[480px] space-y-2 overflow-y-auto pr-1">
                {cues.map((cue) => (
                  <div key={cue.id} className="flex items-start gap-2">
                    <div className="w-32 shrink-0 space-y-1">
                      <Input
                        className="h-7 px-2 text-[11px]"
                        type="number"
                        step={0.1}
                        min={0}
                        value={cue.start}
                        onChange={(e) =>
                          updateCue(cue.id, { start: Number(e.target.value) })
                        }
                      />
                      <Input
                        className="h-7 px-2 text-[11px]"
                        type="number"
                        step={0.1}
                        min={0}
                        value={cue.end}
                        onChange={(e) => updateCue(cue.id, { end: Number(e.target.value) })}
                      />
                    </div>
                    <Textarea
                      className="min-h-[52px] flex-1 text-sm"
                      value={cue.text}
                      onChange={(e) => updateCue(cue.id, { text: e.target.value })}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Delete caption line"
                      onClick={() => setCues((prev) => prev.filter((c) => c.id !== cue.id))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {cues.length === 0 && (
                  <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No captions yet — add a line or reset to AI-generated.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

          {/* B-roll */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <Film className="h-4 w-4 text-primary-500" /> B-roll
                </p>
                {credits != null && (
                  <span className="text-xs text-muted-foreground">{credits} credits</span>
                )}
              </div>

              {/* Where the scenes sit on the clip timeline */}
              {brollSegments.length > 0 && (
                <div>
                  <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                    {brollSegments.map((seg, i) => (
                      <span
                        key={i}
                        className="absolute top-0 h-full bg-primary-500/80"
                        style={{
                          left: `${(seg.start / clipDuration) * 100}%`,
                          width: `${Math.max(2, ((seg.end - seg.start) / clipDuration) * 100)}%`,
                        }}
                      />
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    0:00 — {formatTime(clipDuration)}
                  </p>
                </div>
              )}

              {clip.broll_json == null ? (
                <p className="text-xs text-muted-foreground">
                  B-roll cutaways are planned automatically during each render.
                </p>
              ) : brollSegments.length === 0 ? (
                <p className="text-xs text-muted-foreground">B-roll is off for this clip.</p>
              ) : (
                <div className="space-y-1.5">
                  {brollSegments.map((seg, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs">
                      <span className="w-4 text-muted-foreground">{i + 1}.</span>
                      <Input
                        type="number"
                        min={0}
                        step={0.5}
                        value={seg.start}
                        onChange={(e) =>
                          updateBrollSegment(i, "start", Number(e.target.value))
                        }
                        className="h-7 w-16 px-1.5 text-[11px]"
                        aria-label="B-roll start (seconds)"
                      />
                      <span className="text-muted-foreground">→</span>
                      <Input
                        type="number"
                        min={0}
                        step={0.5}
                        value={seg.end}
                        onChange={(e) => updateBrollSegment(i, "end", Number(e.target.value))}
                        className="h-7 w-16 px-1.5 text-[11px]"
                        aria-label="B-roll end (seconds)"
                      />
                      <span className="text-[10px] text-muted-foreground">sec</span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="ml-auto h-6 w-6 text-muted-foreground hover:text-destructive"
                        aria-label="Remove B-roll scene"
                        onClick={() => removeBrollSegment(i)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Search */}
              <div className="space-y-2 border-t pt-3">
                <form
                  className="flex gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    searchBroll(brollQuery);
                  }}
                >
                  <Input
                    value={brollQuery}
                    onChange={(e) => setBrollQuery(e.target.value)}
                    placeholder="Search stock footage…"
                    className="h-8 text-xs"
                  />
                <Button type="submit" size="icon" variant="outline" className="h-8 w-8 shrink-0" disabled={brollSearching}>
                  {brollSearching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 shrink-0"
                  title="Upload your own MP4 (max 20 MB)"
                  aria-label="Upload MP4 B-roll"
                  onClick={() => brollFileRef.current?.click()}
                  disabled={brollUploading}
                >
                  {brollUploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                </Button>
                <input
                  ref={brollFileRef}
                  type="file"
                  accept="video/mp4,.mp4"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) useUploadedBroll(file);
                  }}
                />
                </form>
                <div className="flex flex-wrap gap-1">
                  {BROLL_CATEGORIES.map((cat) => (
                    <button
                      key={cat.label}
                      type="button"
                      onClick={() => {
                        setBrollQuery(cat.q);
                        searchBroll(cat.q);
                      }}
                      className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary-500/60 hover:text-primary-500"
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
                {brollResults && brollResults.length > 0 && (
                  <div className="grid max-h-56 grid-cols-3 gap-1.5 overflow-y-auto pr-1">
                    {brollResults.map((r, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => addBrollSegment(r)}
                        className="group relative aspect-[9/16] overflow-hidden rounded-md border bg-muted"
                        title="Add as B-roll scene"
                      >
                        {r.poster ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={r.poster}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <span className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
                            clip
                          </span>
                        )}
                        <span className="absolute inset-0 hidden items-center justify-center bg-black/50 group-hover:flex">
                          <Plus className="h-5 w-5 text-white" />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={generateBroll}
                  disabled={brollBusy}
                >
                  {brollBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  AI pick · {AI_CREDIT_COST} credits
                </Button>
                {clip.broll_json != null && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => setBrollMode("auto")}
                      disabled={brollBusy}
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Auto
                    </Button>
                    {brollSegments.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-muted-foreground"
                        onClick={() => setBrollMode("none")}
                        disabled={brollBusy}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Off
                      </Button>
                    )}
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Music */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <Music2 className="h-4 w-4 text-primary-500" /> Background music
              </p>
              <p className="text-xs text-muted-foreground">
                {project?.music_title
                  ? `${project.music_title} · ${project.music_artist ?? ""}${
                      project.music_mood ? ` (${project.music_mood})` : ""
                    }`
                  : "No background music yet."}
              </p>

              <div className="flex flex-wrap gap-1">
                {MUSIC_MOODS.map((mood) => (
                  <button
                    key={mood}
                    type="button"
                    onClick={() => {
                      setMusicMood(mood);
                      setMusicQuery("");
                      fetchMusic(mood, "");
                    }}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] capitalize text-muted-foreground transition-colors hover:border-primary-500/60 hover:text-primary-500",
                      musicMood === mood && "border-primary-500 text-primary-500"
                    )}
                  >
                    {mood}
                  </button>
                ))}
              </div>

              <form
                className="flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  fetchMusic(musicMood, musicQuery);
                }}
              >
                <Input
                  value={musicQuery}
                  onChange={(e) => setMusicQuery(e.target.value)}
                  placeholder="Search music…"
                  className="h-8 text-xs"
                />
                <Button type="submit" size="icon" variant="outline" className="h-8 w-8 shrink-0" disabled={musicLoading}>
                  {musicLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                </Button>
              </form>

              {musicTracks && musicTracks.length > 0 && (
                <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                  {musicTracks.map((track) => (
                    <div
                      key={track.id}
                      className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                    >
                      <button
                        type="button"
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors hover:border-primary-500/60 hover:text-primary-500",
                          previewingId === track.id && "border-primary-500 text-primary-500"
                        )}
                        aria-label={previewingId === track.id ? "Pause preview" : "Play preview"}
                        onClick={() => togglePreview(track)}
                      >
                        {previewingId === track.id ? (
                          <Pause className="h-3 w-3" />
                        ) : (
                          <Play className="h-3 w-3" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">{track.name}</p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {track.artist} · {formatTime(track.duration)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 shrink-0 px-2 text-[10px]"
                        onClick={() => useTrack(track, musicMood)}
                      >
                        Use
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={generateMusic}
                  disabled={musicBusy}
                >
                  {musicBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  AI pick · {AI_CREDIT_COST} credits
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => musicFileRef.current?.click()}
                  disabled={musicUploading}
                >
                  {musicUploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  Upload MP3
                </Button>
                <input
                  ref={musicFileRef}
                  type="file"
                  accept="audio/mpeg,.mp3"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) useUploadedMusic(file);
                  }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Music applies to the whole project on the next re-render. Uploads:
                MP3 only, max 20 MB.
              </p>
            </CardContent>
          </Card>

        </div>
      </div>
    </Reveal>
  );
}
