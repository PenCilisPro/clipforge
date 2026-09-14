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

    async function load() {
      // The direct Firestore read dies with "INTERNAL ASSERTION FAILED:
      // Unexpected state" when the WebChannel transport breaks mid-query,
      // and the rejection escapes this function as an unhandled rejection —
      // leaving the skeletons up forever. Race it with a timeout and fall
      // back to the backend (admin SDK, own connection) on failure, hang,
      // or empty result.
      try {
        const result = await Promise.race([
          supabase
            .from("projects")
            .select("*, clips(count)")
            .order("created_at", { ascending: false }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
        ]);
        if (result) {
          const { data, error } = result;
          if (!error && (data?.length ?? 0) > 0) {
            setProjects(data as Project[]);
            return;
          }
        }
      } catch (e) {
        console.warn("Firestore project read failed, using backend:", e);
      }
      try {
        const { projects } = await apiFetch<{ projects: Project[] }>(
          "/api/projects"
        );
        setProjects(projects ?? []);
      } catch (e) {
        console.error("Failed to load projects:", e);
        setProjects((prev) => (prev === null ? [] : prev));
      }
    }

    // The query needs the Firebase session; if it hasn't restored yet the
    // shim would query unscoped and get denied. Load once auth is ready.
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) load();
    });

    load();

    const channel = supabase
      .channel("projects-list")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "projects" },
        () => load()
      )
      .subscribe();

    return () => {
      unsub();
      supabase.removeChannel(channel);
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
