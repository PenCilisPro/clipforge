"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectCard } from "@/components/dashboard/project-card";
import { createClient } from "@/lib/supabase/client";
import type { Project } from "@/lib/types";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    const supabase = createClient();

    async function load() {
      const { data } = await supabase
        .from("projects")
        .select("*, clips(count)")
        .order("created_at", { ascending: false });
      setProjects((data as Project[]) ?? []);
    }

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
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
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
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
