"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { onAuthStateChanged } from "firebase/auth";

import { auth } from "@/lib/firebase";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectCard } from "@/components/dashboard/project-card";
import { Reveal } from "@/components/dashboard/reveal";
import { createClient } from "@/lib/supabase/client";
import type { Project } from "@/lib/types";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // Primary path: the backend's admin-SDK read. One round trip returns
    // projects AND their clip counts, and it doesn't share a transport with
    // the Firestore client on this page.
    async function loadViaBackend(): Promise<Project[]> {
      const { projects } = await apiFetch<{ projects: Project[] }>(
        "/api/projects"
      );
      return projects ?? [];
    }

    // Fallback path: the Firestore shim. Its transport intermittently dies
    // with "INTERNAL ASSERTION FAILED: Unexpected state", and embed counts
    // cost one query per project, so it's slow — but it works when the
    // backend is unreachable. Race it with a timeout so a hang can't leave
    // the skeletons up forever.
    async function loadViaFirestore(): Promise<Project[]> {
      const result = await Promise.race([
        supabase
          .from("projects")
          .select("*, clips(count)")
          .order("created_at", { ascending: false }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (result) {
        const { data, error } = result;
        if (!error && data) return data as Project[];
      }
      throw new Error("Firestore project read failed");
    }

    async function load() {
      try {
        const projects = await loadViaBackend();
        if (!cancelled) setProjects(projects);
        dropRealtime();
      } catch (backendErr) {
        console.warn("Backend project read failed, using Firestore:", backendErr);
        try {
          const projects = await loadViaFirestore();
          if (!cancelled) setProjects(projects);
          ensureRealtime();
        } catch (e) {
          console.error("Failed to load projects:", e);
          if (!cancelled) setProjects((prev) => (prev === null ? [] : prev));
        }
      }
    }

    // The query needs the Firebase session (apiFetch attaches the ID token);
    // load once auth is ready. Don't also call load() unconditionally —
    // that duplicated every request and the pre-auth call stalled on the
    // shim's 3s auth wait.
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) load();
    });

    // Realtime refresh is a fallback-only affordance: while the backend is
    // healthy it's the source of truth and the page reloads on demand, so
    // keeping a Firestore onSnapshot channel open just wedges the flaky
    // client transport ("INTERNAL ASSERTION FAILED") and re-triggers load()
    // in a loop. Subscribe only after a backend failure, drop it on recovery.
    let channel: ReturnType<typeof supabase.channel> | undefined;
    function ensureRealtime() {
      if (channel) return;
      channel = supabase
        .channel("projects-list")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "projects" },
          () => load()
        )
        .subscribe();
    }
    function dropRealtime() {
      if (channel) {
        supabase.removeChannel(channel);
        channel = undefined;
      }
    }

    return () => {
      cancelled = true;
      unsub();
      dropRealtime();
    };
  }, []);

  return (
    <Reveal className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Paste a link or upload a video to forge new clips.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/new">
            <Plus /> New Project
          </Link>
        </Button>
      </div>

      {projects === null ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="mt-16 rounded-xl border border-dashed p-12 text-center">
          <p className="font-medium">No projects yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first project and ClipForge will find the viral moments
            for you.
          </p>
          <Button asChild className="mt-5">
            <Link href="/dashboard/new">
              <Plus /> Create Project
            </Link>
          </Button>
        </div>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {projects.map((project, i) => (
            <Reveal key={project.id} delay={i * 0.06}>
              <ProjectCard
                project={project}
                onDeleted={(id) =>
                  setProjects((prev) =>
                    prev ? prev.filter((p) => p.id !== id) : prev
                  )
                }
              />
            </Reveal>
          ))}
        </div>
      )}
    </Reveal>
  );
}
