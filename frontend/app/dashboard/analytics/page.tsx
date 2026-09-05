"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Clapperboard,
  Film,
  Scissors,
  Video,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Reveal } from "@/components/dashboard/reveal";

interface ProjectRow {
  id: string;
  status: string;
  created_at: string;
  duration_seconds: number | null;
}

interface ClipRow {
  id: string;
  status: string;
  created_at: string;
}

interface PostRow {
  id: string;
  platform: string;
  status: string;
  scheduled_time_utc: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CHART_DAYS = 14;

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export default function AnalyticsPage() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [clips, setClips] = useState<ClipRow[] | null>(null);
  const [posts, setPosts] = useState<PostRow[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("projects")
      .select("id, status, created_at, duration_seconds")
      .order("created_at", { ascending: false })
      .limit(500)
      .then(({ data }) => setProjects((data as ProjectRow[]) ?? []));
    supabase
      .from("clips")
      .select("id, status, created_at")
      .order("created_at", { ascending: false })
      .limit(1000)
      .then(({ data }) => setClips((data as ClipRow[]) ?? []));
    supabase
      .from("scheduled_posts")
      .select("id, platform, status, scheduled_time_utc")
      .order("scheduled_time_utc", { ascending: false })
      .limit(500)
      .then(({ data }) => setPosts((data as PostRow[]) ?? []));
  }, []);

  const stats = useMemo(() => {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

    const clipsLast7 = (clips ?? []).filter(
      (c) => new Date(c.created_at) >= weekAgo
    ).length;
    const projectsLast30 = (projects ?? []).filter(
      (p) => new Date(p.created_at) >= monthAgo
    ).length;
    const published = (posts ?? []).filter((p) => p.status === "published").length;
    const scheduled = (posts ?? []).filter((p) => p.status === "scheduled").length;
    const minutesProcessed =
      (projects ?? []).reduce((sum, p) => sum + (Number(p.duration_seconds) || 0), 0) / 60;

    // Clips per day for the last CHART_DAYS days.
    const days: { label: string; key: string; count: number }[] = [];
    for (let i = CHART_DAYS - 1; i >= 0; i--) {
      const day = new Date(now.getTime() - i * DAY_MS);
      days.push({
        key: dayKey(day),
        label: day.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        count: 0,
      });
    }
    const byDay = new Map(days.map((d) => [d.key, d]));
    for (const clip of clips ?? []) {
      const bucket = byDay.get(dayKey(new Date(clip.created_at)));
      if (bucket) bucket.count++;
    }

    // Published/scheduled per platform.
    const platformOrder = ["youtube", "instagram", "tiktok", "facebook"];
    const platformCounts = new Map<string, number>();
    for (const post of posts ?? []) {
      if (post.status === "published" || post.status === "scheduled") {
        platformCounts.set(post.platform, (platformCounts.get(post.platform) ?? 0) + 1);
      }
    }
    const platforms = platformOrder
      .map((p) => ({ platform: p, count: platformCounts.get(p) ?? 0 }))
      .filter((p) => p.count > 0);
    const maxDay = Math.max(1, ...days.map((d) => d.count));

    return {
      totalProjects: projects?.length ?? 0,
      totalClips: clips?.length ?? 0,
      clipsLast7,
      projectsLast30,
      published,
      scheduled,
      minutesProcessed: Math.round(minutesProcessed),
      days,
      platforms,
      maxDay,
    };
  }, [projects, clips, posts]);

  const loading = projects === null || clips === null || posts === null;

  return (
    <Reveal className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Your ClipForge usage at a glance — projects, clips and publishing.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)
        ) : (
          <>
            <StatCard
              icon={Video}
              label="Projects"
              value={stats.totalProjects}
              hint={`${stats.projectsLast30} in the last 30 days`}
            />
            <StatCard
              icon={Scissors}
              label="Clips generated"
              value={stats.totalClips}
              hint={`${stats.clipsLast7} in the last 7 days`}
            />
            <StatCard
              icon={Clapperboard}
              label="Source minutes processed"
              value={stats.minutesProcessed}
              hint="Total length of videos you've uploaded"
            />
            <StatCard
              icon={Film}
              label="Posts published"
              value={stats.published}
              hint={`${stats.scheduled} scheduled for later`}
            />
          </>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-primary-500" />
            Clips per day
          </CardTitle>
          <CardDescription>Last {CHART_DAYS} days</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="flex h-40 items-end gap-1.5">
              {stats.days.map((day) => (
                <div key={day.key} className="group flex flex-1 flex-col items-center gap-1">
                  <span className="text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    {day.count}
                  </span>
                  <div
                    className="w-full rounded-t bg-primary-500/70 transition-colors group-hover:bg-primary-500"
                    style={{ height: `${Math.max(2, (day.count / stats.maxDay) * 120)}px` }}
                    title={`${day.label}: ${day.count} clip${day.count === 1 ? "" : "s"}`}
                  />
                  <span className="w-full truncate text-center text-[10px] text-muted-foreground">
                    {day.label}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Publishing by platform</CardTitle>
          <CardDescription>Published + scheduled posts</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : stats.platforms.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing published or scheduled yet — connect a channel and schedule your
              first post.
            </p>
          ) : (
            <div className="space-y-3">
              {stats.platforms.map(({ platform, count }) => (
                <div key={platform} className="flex items-center gap-3">
                  <span className="w-20 text-sm capitalize">{platform}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary-500"
                      style={{
                        width: `${(count / Math.max(...stats.platforms.map((p) => p.count))) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="w-8 text-right text-sm tabular-nums">{count}</span>
                </div>
              ))}
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
  hint,
}: {
  icon: typeof Film;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-500/10">
          <Icon className="h-5 w-5 text-primary-500" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold tabular-nums">{value}</p>
          <Badge variant="secondary" className="mt-1 max-w-full truncate text-[10px] font-normal">
            {hint}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
