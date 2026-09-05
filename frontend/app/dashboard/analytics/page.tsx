"use client";

import { useEffect, useState } from "react";
import {
  BarChart3,
  Eye,
  Heart,
  Loader2,
  MessageCircle,
  Video,
} from "lucide-react";

import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Reveal } from "@/components/dashboard/reveal";

interface PlatformVideo {
  post_id: string;
  video_id: string;
  clip_title: string | null;
  title: string;
  thumbnail: string | null;
  views: number;
  likes: number;
  comments: number;
  published_at: string;
}

interface PlatformAnalytics {
  totals: {
    views: number;
    likes: number;
    comments: number;
    published: number;
  };
  videos: PlatformVideo[];
  unavailable_platforms: string[];
  youtube_error: string | null;
}

function formatCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<PlatformAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishedCount, setPublishedCount] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<PlatformAnalytics>("/api/analytics/platform");
      setAnalytics(data);
    } catch {
      setAnalytics(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // Published count from the user's own rows (works even without YouTube).
    createClient()
      .from("scheduled_posts")
      .select("id", { count: "exact", head: true })
      .eq("status", "published")
      .then(({ count }) => setPublishedCount(count ?? 0));
  }, []);

  const totals = analytics?.totals;
  const videos = analytics?.videos ?? [];

  return (
    <Reveal className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Views and engagement for the clips you've published through ClipForge.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)
        ) : (
          <>
            <StatCard icon={Eye} label="Total views" value={totals ? formatCount(totals.views) : "—"} />
            <StatCard icon={Heart} label="Total likes" value={totals ? formatCount(totals.likes) : "—"} />
            <StatCard icon={MessageCircle} label="Total comments" value={totals ? formatCount(totals.comments) : "—"} />
            <StatCard icon={Video} label="Posts published" value={String(publishedCount ?? totals?.published ?? 0)} />
          </>
        )}
      </div>

      {analytics && analytics.youtube_error && (
        <Card className="border-destructive/30">
          <CardContent className="p-4 text-sm text-destructive">
            Couldn't load YouTube stats: {analytics.youtube_error}
          </CardContent>
        </Card>
      )}

      {analytics && analytics.unavailable_platforms.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Views for {analytics.unavailable_platforms.join(", ")} aren't shown — those
          platforms require extra insights permissions that the app doesn't request.
          YouTube stats are fetched live from the YouTube Data API.
        </p>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Video performance</CardTitle>
          <CardDescription>Published clips sorted by views</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : videos.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No published videos yet — schedule a post and its views will show up
              here once it's live.
            </p>
          ) : (
            <div className="space-y-3">
              {videos.map((video) => {
                const watchUrl = `https://www.youtube.com/watch?v=${video.video_id}`;
                return (
                  <a
                    key={video.post_id}
                    href={watchUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:border-primary-500/50"
                  >
                    {video.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={video.thumbnail}
                        alt=""
                        className="h-14 w-24 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded bg-muted">
                        <Video className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{video.title}</p>
                      <p className="text-xs text-muted-foreground">
                        Published {formatDateTime(video.published_at)}
                      </p>
                      {video.clip_title && video.clip_title !== video.title && (
                        <Badge variant="secondary" className="mt-1 max-w-full truncate text-[10px] font-normal">
                          {video.clip_title}
                        </Badge>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-4 text-sm">
                      <span className="flex items-center gap-1" title="Views">
                        <Eye className="h-4 w-4 text-muted-foreground" />
                        {formatCount(video.views)}
                      </span>
                      <span className="flex items-center gap-1" title="Likes">
                        <Heart className="h-4 w-4 text-muted-foreground" />
                        {formatCount(video.likes)}
                      </span>
                      <span className="hidden items-center gap-1 sm:flex" title="Comments">
                        <MessageCircle className="h-4 w-4 text-muted-foreground" />
                        {formatCount(video.comments)}
                      </span>
                    </div>
                  </a>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </Reveal>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Eye;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-500/10">
          <Icon className="h-5 w-5 text-primary-500" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
