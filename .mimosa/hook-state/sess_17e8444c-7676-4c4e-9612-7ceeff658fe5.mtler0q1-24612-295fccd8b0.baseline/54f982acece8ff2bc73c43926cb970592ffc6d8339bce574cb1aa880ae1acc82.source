"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Loader2, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/dashboard/status-pill";
import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { PLATFORM_LABELS, type Platform, type ScheduledPost } from "@/lib/types";
import { cn } from "@/lib/utils";

const PLATFORM_TONES: Record<
  Platform,
  "default" | "info" | "success" | "warning" | "destructive" | "muted"
> = {
  youtube: "destructive",
  instagram: "warning",
  tiktok: "default",
  facebook: "info",
};

const STATUS_TONES: Record<
  string,
  "default" | "info" | "success" | "warning" | "destructive" | "muted"
> = {
  scheduled: "default",
  publishing: "info",
  published: "success",
  failed: "destructive",
  canceled: "muted",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export default function CalendarPage() {
  const supabase = useMemo(() => createClient(), []);
  const [posts, setPosts] = useState<ScheduledPost[] | null>(null);
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [rescheduleFor, setRescheduleFor] = useState<ScheduledPost | null>(null);
  const [newTime, setNewTime] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data } = await supabase
      .from("scheduled_posts")
      .select("*, clips(title)")
      .order("scheduled_time_utc", { ascending: true });
    setPosts((data as ScheduledPost[]) ?? []);
  }

  useEffect(() => {
    load();
    const channel = supabase
      .channel("scheduled-posts")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "scheduled_posts" },
        () => load()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const monthGrid = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const weeks: Date[][] = [];
    const current = new Date(start);
    for (let w = 0; w < 6; w++) {
      const week: Date[] = [];
      for (let d = 0; d < 7; d++) {
        week.push(new Date(current));
        current.setDate(current.getDate() + 1);
      }
      weeks.push(week);
      if (current.getMonth() !== cursor.getMonth() && w >= 4) break;
    }
    return weeks;
  }, [cursor]);

  const postsByDay = useMemo(() => {
    const map = new Map<string, ScheduledPost[]>();
    for (const post of posts ?? []) {
      const date = new Date(post.scheduled_time_utc);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      map.set(key, [...(map.get(key) ?? []), post]);
    }
    return map;
  }, [posts]);

  async function handleCancel(post: ScheduledPost) {
    setBusy(true);
    try {
      await apiFetch(`/api/schedule/${post.id}`, {
        method: "PATCH",
        body: { action: "cancel" },
      });
      toast.success("Post canceled");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  function openReschedule(post: ScheduledPost) {
    setRescheduleFor(post);
    const local = new Date(post.scheduled_time_utc);
    const pad = (n: number) => n.toString().padStart(2, "0");
    setNewTime(
      `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(
        local.getDate()
      )}T${pad(local.getHours())}:${pad(local.getMinutes())}`
    );
  }

  async function handleReschedule() {
    if (!rescheduleFor) return;
    setBusy(true);
    try {
      await apiFetch(`/api/schedule/${rescheduleFor.id}`, {
        method: "PATCH",
        body: { scheduled_time_utc: new Date(newTime).toISOString() },
      });
      toast.success("Post rescheduled");
      setRescheduleFor(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reschedule failed");
    } finally {
      setBusy(false);
    }
  }

  const selectedPosts = selectedDay
    ? postsByDay.get(
        `${selectedDay.getFullYear()}-${selectedDay.getMonth()}-${selectedDay.getDate()}`
      ) ?? []
    : [];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Publishing Calendar
          </h1>
          <p className="text-sm text-muted-foreground">
            All scheduled posts across platforms, in your local timezone.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() =>
              setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))
            }
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-40 text-center font-semibold">
            {cursor.toLocaleString(undefined, { month: "long", year: "numeric" })}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() =>
              setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))
            }
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      <Card className="mt-6">
        <CardContent className="p-2 sm:p-4">
          <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
            {WEEKDAYS.map((day) => (
              <div key={day} className="py-1">
                {day}
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {monthGrid.flat().map((day, i) => {
              const inMonth = day.getMonth() === cursor.getMonth();
              const isToday = sameDay(day, new Date());
              const dayPosts = postsByDay.get(
                `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
              );
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelectedDay(day)}
                  className={cn(
                    "flex min-h-20 flex-col items-start gap-1 rounded-md border p-1.5 text-left transition-colors hover:border-primary-500/50",
                    !inMonth && "opacity-40",
                    selectedDay && sameDay(day, selectedDay) && "border-primary-500 bg-primary-500/5",
                    isToday && "ring-1 ring-primary-500/60"
                  )}
                >
                  <span
                    className={cn(
                      "text-xs",
                      isToday
                        ? "font-bold text-primary-500"
                        : "text-muted-foreground"
                    )}
                  >
                    {day.getDate()}
                  </span>
                  {dayPosts?.slice(0, 3).map((post) => (
                    <span
                      key={post.id}
                      className={cn(
                        "w-full truncate rounded px-1 py-0.5 text-[10px] font-medium",
                        post.status === "scheduled" &&
                          "bg-primary-500/15 text-primary-600 dark:text-primary-400",
                        post.status === "published" &&
                          "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                        post.status === "failed" &&
                          "bg-red-500/15 text-red-600 dark:text-red-400",
                        post.status === "publishing" && "bg-blue-500/15 text-blue-600 dark:text-blue-400",
                        post.status === "canceled" && "bg-muted text-muted-foreground"
                      )}
                    >
                      {PLATFORM_LABELS[post.platform].split(" ")[0]} ·{" "}
                      {new Date(post.scheduled_time_utc).toLocaleTimeString(
                        undefined,
                        { hour: "numeric", minute: "2-digit" }
                      )}
                    </span>
                  ))}
                  {dayPosts && dayPosts.length > 3 && (
                    <span className="text-[10px] text-muted-foreground">
                      +{dayPosts.length - 3} more
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {selectedDay && (
        <Card className="mt-6">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">
                {selectedDay.toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </h2>
              <Button variant="ghost" size="sm" onClick={() => setSelectedDay(null)}>
                Close
              </Button>
            </div>

            {selectedPosts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No posts scheduled for this day.
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {selectedPosts.map((post) => (
                  <li
                    key={post.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={cn(
                            PLATFORM_TONES[post.platform] === "default" &&
                              "border-transparent bg-primary text-primary-foreground",
                            PLATFORM_TONES[post.platform] === "destructive" &&
                              "border-transparent bg-red-500/15 text-red-600 dark:text-red-400",
                            PLATFORM_TONES[post.platform] === "warning" &&
                              "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
                            PLATFORM_TONES[post.platform] === "info" &&
                              "border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400"
                          )}
                        >
                          {PLATFORM_LABELS[post.platform]}
                        </Badge>
                        <StatusPill
                          label={post.status}
                          tone={STATUS_TONES[post.status] ?? "muted"}
                          pulse={post.status === "publishing"}
                        />
                      </div>
                      <p className="mt-1 truncate text-sm">
                        {post.clips?.title ?? "Clip"} ·{" "}
                        <span className="text-muted-foreground">
                          {new Date(post.scheduled_time_utc).toLocaleTimeString(
                            undefined,
                            { hour: "numeric", minute: "2-digit" }
                          )}
                        </span>
                      </p>
                      {post.error_message && (
                        <p className="mt-1 text-xs text-destructive">
                          {post.error_message}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {post.status === "scheduled" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openReschedule(post)}
                          >
                            Reschedule
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            disabled={busy}
                            onClick={() => handleCancel(post)}
                          >
                            <Trash2 /> Cancel
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog
        open={rescheduleFor !== null}
        onOpenChange={(open) => !open && setRescheduleFor(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reschedule post</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reschedule-time">New date &amp; time</Label>
            <Input
              id="reschedule-time"
              type="datetime-local"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRescheduleFor(null)}>
              Cancel
            </Button>
            <Button onClick={handleReschedule} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
