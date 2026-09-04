"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { CAPTION_FONTS, CAPTION_STYLES, type Clip } from "@/lib/types";
import { cuesToSrtText, parseSrt, type SrtCue } from "@/lib/srt-client";
import { Reveal } from "@/components/dashboard/reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export default function ClipEditPage() {
  const router = useRouter();
  const params = useParams<{ id: string; clipId: string }>();
  const supabase = useCallback(() => createClient(), []);

  const [loading, setLoading] = useState(true);
  const [clip, setClip] = useState<Clip | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isFinalRender, setIsFinalRender] = useState(true);

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
        const { project } = await apiFetch<{
          project: { clips: Clip[] };
        }>(`/api/projects/${params.id}`);
        const found = (project.clips as Clip[]).find((c) => c.id === params.clipId);
        if (!found) throw new Error("Clip not found");
        setClip(found);
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
                <Label className="text-xs">Caption style</Label>
                <Select
                  value={captionStyle}
                  onValueChange={(v) => setCaptionStyle(v as Clip["caption_style"])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CAPTION_STYLES.map((style) => (
                      <SelectItem key={style.key} value={style.key}>
                        {style.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {CAPTION_STYLES.find((s) => s.key === captionStyle)?.description}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Caption font</Label>
                <Select
                  value={captionFont}
                  onValueChange={(v) => setCaptionFont(v as NonNullable<Clip["caption_font"]>)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CAPTION_FONTS.map((font) => (
                      <SelectItem key={font.key} value={font.key}>
                        <span style={{ fontFamily: font.cssVar }}>{font.label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
