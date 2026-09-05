"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Film,
  Loader2,
  Music2,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
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

  async function useTrack(track: MusicTrack, mood: string) {
    if (!project) return;
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
                      />
                      <p className="mt-1.5 text-xs font-semibold">{style.label}</p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {CAPTION_STYLES.find((s) => s.key === captionStyle)?.description}
                </p>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={captionStroke}
                    onChange={(e) => setCaptionStroke(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  Stroke
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={captionShadow}
                    onChange={(e) => setCaptionShadow(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  Shadow
                </label>
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
              <p className="text-[11px] text-muted-foreground">
                Music applies to the whole project on the next re-render.
              </p>
            </CardContent>
          </Card>

        </div>
      </div>
    </Reveal>
  );
}
