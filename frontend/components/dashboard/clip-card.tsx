"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  CalendarClock,
  Download,
  Loader2,
  Pencil,
  RefreshCcw,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScheduleModal } from "@/components/dashboard/schedule-modal";
import { CaptionStyleDialog } from "@/components/dashboard/caption-style-dialog";
import { StatusPill } from "@/components/dashboard/status-pill";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import { formatDuration } from "@/lib/utils";
import { CAPTION_STYLES, type Clip } from "@/lib/types";

export function ClipCard({ clip }: { clip: Clip }) {
  const supabase = useMemo(() => createClient(), []);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [retryLoading, setRetryLoading] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [captionOpen, setCaptionOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadUrl() {
      if (!clip.storage_path || clip.status !== "ready") return;
      const { data } = await supabase.storage
        .from("clips")
        .createSignedUrl(clip.storage_path, 60 * 60);
      if (!cancelled) setVideoUrl(data?.signedUrl ?? null);
    }

    loadUrl();
    return () => {
      cancelled = true;
    };
  }, [clip.storage_path, clip.status, supabase]);

  async function handleDownload() {
    if (!clip.storage_path) return;
    setDownloadLoading(true);
    try {
      const { data } = await supabase.storage
        .from("clips")
        .createSignedUrl(clip.storage_path, 60, {
          download: `${(clip.title ?? "clip").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4`,
        });
      if (data?.signedUrl) {
        window.open(data.signedUrl, "_blank");
      } else {
        throw new Error("Could not generate download link");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Download failed");
    } finally {
      setDownloadLoading(false);
    }
  }

  async function handleRetry() {
    setRetryLoading(true);
    try {
      await apiFetch(`/api/clips/${clip.id}/regenerate`, {
        method: "POST",
        // apiFetch stringifies the body itself — a pre-stringified value would go
      // out double-encoded and the backend would reject it with a 400.
      body: { caption_style: clip.caption_style ?? "karaoke" },
      });
      toast.success("Render requeued");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Retry failed");
    } finally {
      setRetryLoading(false);
    }
  }

  const thumbUrl = clip.thumbnail_path
    ? supabase.storage.from("assets").getPublicUrl(clip.thumbnail_path).data
        .publicUrl
    : null;

  const duration = clip.end_time - clip.start_time;

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="relative aspect-[9/16] max-h-72 w-full overflow-hidden bg-zinc-900">
        {clip.status === "ready" && videoUrl ? (
          <video
            src={videoUrl}
            poster={thumbUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center">
            {clip.status === "failed" ? (
              <>
                <XCircle className="h-8 w-8 text-destructive" />
                <p className="px-4 text-xs text-destructive">
                  {clip.error_message ?? "Render failed"}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1"
                  onClick={handleRetry}
                  disabled={retryLoading}
                >
                  {retryLoading && <Loader2 className="animate-spin" />}
                  <RefreshCcw className="h-4 w-4" />
                  Retry render
                </Button>
              </>
            ) : (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
                <StatusPill
                  label={clip.status === "rendering" ? "Rendering" : "Queued"}
                  tone="info"
                  pulse
                />
              </>
            )}
          </div>
        )}
        {clip.status === "ready" && (
          <span className="score-gradient absolute right-2 top-2 rounded-md px-2 py-0.5 text-xs font-bold text-white shadow">
            {clip.virality_score != null ? Math.round(clip.virality_score) : "—"}
          </span>
        )}
      </div>

      <CardContent className="flex flex-1 flex-col gap-3 pt-4">
        <div>
          <h3 className="line-clamp-2 font-semibold leading-snug">
            {clip.title ?? "Untitled clip"}
          </h3>
          {clip.hook_text && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {clip.hook_text}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">{formatDuration(duration)}</Badge>
          <Badge variant="secondary">
            {CAPTION_STYLES.find((s) => s.key === clip.caption_style)?.label ??
              clip.caption_style}
          </Badge>
          {clip.hashtags.slice(0, 2).map((tag) => (
            <Badge key={tag} variant="outline" className="text-primary-600 dark:text-primary-400">
              {tag}
            </Badge>
          ))}
        </div>

        <div className="mt-auto grid grid-cols-2 gap-2 pt-1">
          <Button
            size="sm"
            onClick={() => setScheduleOpen(true)}
            disabled={clip.status !== "ready"}
          >
            <CalendarClock /> Schedule
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleDownload}
            disabled={clip.status !== "ready" || downloadLoading}
          >
            {downloadLoading ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Download />
            )}
            Download
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="col-span-2 text-muted-foreground"
            onClick={() => setCaptionOpen(true)}
            disabled={clip.status === "queued"}
          >
            <RefreshCcw /> Regenerate captions
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="col-span-2"
            asChild
            disabled={clip.status === "queued"}
          >
            <Link href={`/dashboard/projects/${clip.project_id}/clips/${clip.id}`}>
              <Pencil /> Edit clip (captions, style, trim)
            </Link>
          </Button>
        </div>
      </CardContent>

      <ScheduleModal
        clip={clip}
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
      />
      <CaptionStyleDialog
        clip={clip}
        open={captionOpen}
        onOpenChange={setCaptionOpen}
      />
    </Card>
  );
}
