"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Film, Loader2, Music2, Plus, RotateCcw, Save, Sparkles, Trash2 } from "lucide-react";
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
  const [resetSrt, setResetSrt] = useState(false);
  const [startTime, setStartTime] = useState("0");
  const [endTime, setEndTime] = useState("0");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { project: loaded, } = await apiFetch<{
          project: { clips: Clip[] } & Project;
        }>(`/api/projects/${params.id}`);
        const found = (loaded.clips as Clip[]).find((c) => c.id === params.clipId);
        if (!found) throw new Error("Clip not found");
        setClip(found);
        setProject(loaded);
        setCaptionStyle(found.caption_style ?? "karaoke");
        setCaptionFont(found.caption_font ?? "anton");
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
            Edit captions, pick a style, trim the window, then re-render.
          </p>
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          {saving ? "Re-rendering…" : "Save & re-render"}
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* Preview + timing + style */}
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
                <AnimatedCaptionPreview style={captionStyle} fontKey={captionFont} />
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
                      <CaptionPreview style={style.key} fontKey={captionFont} />
                      <p className="mt-1.5 text-xs font-semibold">{style.label}</p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {CAPTION_STYLES.find((s) => s.key === captionStyle)?.description}
                </p>
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

          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <Sparkles className="h-4 w-4 text-primary-500" /> AI enhancements
                </p>
                {credits != null && (
                  <span className="text-xs text-muted-foreground">
                    {credits} credits left
                  </span>
                )}
              </div>

              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <Film className="h-3.5 w-3.5 text-muted-foreground" /> B-roll
                </p>
                {clip.broll_json == null ? (
                  <p className="text-xs text-muted-foreground">
                    B-roll cutaways are planned automatically during each render.
                  </p>
                ) : clip.broll_json.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    B-roll is off for this clip.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {clip.broll_json.map((seg, i) => (
                      <Badge key={i} variant="secondary" className="text-[10px]">
                        {formatTime(seg.start)}–{formatTime(seg.end)}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={generateBroll}
                    disabled={brollBusy}
                  >
                    {brollBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {clip.broll_json == null || clip.broll_json.length === 0 ? "Generate" : "Regenerate"} · {AI_CREDIT_COST} credits
                  </Button>
                  {clip.broll_json != null && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => setBrollMode("auto")}
                      disabled={brollBusy}
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Auto
                    </Button>
                  )}
                  {clip.broll_json != null && clip.broll_json.length > 0 && (
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
                </div>
              </div>

              <div className="space-y-2 border-t pt-3">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <Music2 className="h-3.5 w-3.5 text-muted-foreground" /> Background music
                </p>
                <p className="text-xs text-muted-foreground">
                  {project?.music_title
                    ? `${project.music_title} · ${project.music_artist ?? ""}${
                        project.music_mood ? ` (${project.music_mood})` : ""
                      }`
                    : "No background music yet."}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={generateMusic}
                  disabled={musicBusy}
                >
                  {musicBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {project?.music_title ? "Pick another" : "Pick with AI"} · {AI_CREDIT_COST} credits
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Music applies to the whole project on the next re-render.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Caption editor */}
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
                        onChange={(e) =>
                          updateCue(cue.id, { end: Number(e.target.value) })
                        }
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
      </div>
    </Reveal>
  );
}
