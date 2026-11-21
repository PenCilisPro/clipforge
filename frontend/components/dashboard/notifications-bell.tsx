"use client";

/**
 * Dashboard notification bell. Derives alerts from real project activity —
 * finished/failed renders — rather than a separate notifications system.
 * Unread count = alerts newer than the last "seen" timestamp (localStorage).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, CheckCheck, Loader2, XCircle } from "lucide-react";

import { apiFetch } from "@/lib/api";
import type { Project } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";

const SEEN_KEY = "cf-alerts-last-seen";

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [alerts, setAlerts] = useState<Project[]>([]);
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const loadedOnce = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const raw = localStorage.getItem(SEEN_KEY);
    const ts = raw ? Number(raw) : NaN;
    setLastSeen(Number.isFinite(ts) ? ts : 0);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { projects } = await apiFetch<{ projects: Project[] }>("/api/projects");
      const interesting = (projects ?? [])
        .filter((p) => p.status === "done" || p.status === "failed")
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 8);
      setAlerts(interesting);
    } catch {
      // Bell stays quiet when the backend is unreachable.
    } finally {
      setLoading(false);
    }
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !loadedOnce.current) {
      loadedOnce.current = true;
      void load();
    }
    if (next) {
      const now = Date.now();
      localStorage.setItem(SEEN_KEY, String(now));
      setLastSeen(now);
    }
  }

  // Dismiss on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const unread = alerts.filter((p) => {
    const ts = new Date(p.created_at).getTime();
    return lastSeen != null && ts > lastSeen;
  }).length;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={toggle}
        className={cn(
          "relative rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground",
          open && "bg-accent text-foreground"
        )}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary-500 px-1 text-[9px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-11 z-50 w-80 overflow-hidden rounded-xl border bg-card shadow-lg"
          >
            <div className="border-b px-3 py-2 text-xs font-semibold">Notifications</div>
            <div className="max-h-72 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </div>
              ) : alerts.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 py-7 text-center">
                  <CheckCheck className="h-5 w-5 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">
                    You&apos;re all caught up — finished and failed projects show up here.
                  </p>
                </div>
              ) : (
                alerts.map((p) => (
                  <Link
                    key={p.id}
                    href={`/dashboard/projects/${p.id}`}
                    onClick={() => setOpen(false)}
                    className="flex items-start gap-2.5 border-b px-3 py-2.5 last:border-b-0 hover:bg-accent/60"
                  >
                    {p.status === "failed" ? (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    ) : (
                      <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-emerald-500 bg-emerald-500/20" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {p.title ?? "Untitled project"}{" "}
                        {p.status === "failed" ? "failed" : "finished rendering"}
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        {formatDateTime(p.created_at)}
                      </span>
                    </span>
                  </Link>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
