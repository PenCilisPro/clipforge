"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { ClipCard } from "@/components/dashboard/clip-card";
import { PipelineTracker } from "@/components/dashboard/pipeline-tracker";
import { createClient } from "@/lib/supabase/client";
import type { Clip, Job, Project } from "@/lib/types";

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [project, setProject] = useState<Project | null>(null);
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    async function load() {
      const { data: projectData } = await supabase
        .from("projects")
        .select("*")
        .eq("id", projectId)
        .maybeSingle();
      if (!projectData) {
        setNotFound(true);
        return;
      }
      setProject(projectData as Project);

      const { data: clipsData } = await supabase
        .from("clips")
        .select("*")
        .eq("project_id", projectId)
        .order("start_time");
      setClips((clipsData as Clip[]) ?? []);

      const { data: jobsData } = await supabase
        .from("jobs")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true });
      setJobs((jobsData as Job[]) ?? []);
    }

    load();

    const channel = supabase
      .channel(`project-${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "jobs", filter: `project_id=eq.${projectId}` },
        () => load()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "clips", filter: `project_id=eq.${projectId}` },
        () => load()
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "projects", filter: `id=eq.${projectId}` },
        () => load()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center">
        <p className="text-lg font-semibold">Project not found</p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/dashboard">Back to projects</Link>
        </Button>
      </div>
    );
  }

  if (!project || jobs === null) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 rounded-xl" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-72 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Button variant="ghost" size="sm" asChild className="mb-4 -ml-2">
        <Link href="/dashboard">
          <ArrowLeft /> All projects
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {project.title ?? "Untitled project"}
          </h1>
          {project.source_url && (
            <a
              href={project.source_url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block max-w-md truncate text-sm text-muted-foreground hover:text-primary-500"
            >
              {project.source_url}
            </a>
          )}
        </div>
        <StatusBadge status={project.status} />
      </div>

      {project.status === "failed" && project.error_message && (
        <Card className="mt-4 border-destructive/50">
          <CardContent className="pt-4 text-sm text-destructive">
            {project.error_message}
          </CardContent>
        </Card>
      )}

      <PipelineTracker jobs={jobs} projectStatus={project.status} />

      <h2 className="mb-4 mt-8 text-lg font-semibold">
        Clips{" "}
        {clips && clips.length > 0 && (
          <span className="text-muted-foreground">({clips.length})</span>
        )}
      </h2>

      {clips === null ? null : clips.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {project.status === "processing" || project.status === "pending"
              ? "AI is still analyzing your video — clips will appear here."
              : "No clips were generated for this project."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {clips.map((clip) => (
            <ClipCard key={clip.id} clip={clip} />
          ))}
        </div>
      )}
    </div>
  );
}
