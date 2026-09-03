"use client";

import Link from "next/link";
import { Film, Link2, Upload } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { formatDateTime, formatDuration } from "@/lib/utils";
import type { Project } from "@/lib/types";

export function ProjectCard({ project }: { project: Project }) {
  const clipCount = (project as Project & { clips?: { count: number }[] })
    .clips?.[0]?.count;

  return (
    <Link href={`/dashboard/projects/${project.id}`} className="group block">
      <Card className="h-full transition-all group-hover:border-primary-500/50 group-hover:shadow-md">
        <CardContent className="pt-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-500/10">
              <Film className="h-5 w-5 text-primary-500" />
            </div>
            <StatusBadge status={project.status} />
          </div>
          <h3 className="mt-3 truncate font-semibold group-hover:text-primary-600 dark:group-hover:text-primary-400">
            {project.title ?? "Untitled project"}
          </h3>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {project.source_type === "url" ? (
                <Link2 className="h-3.5 w-3.5" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {project.source_type === "url" ? "Link" : "Upload"}
            </span>
            {project.duration_seconds != null && (
              <span>{formatDuration(project.duration_seconds)}</span>
            )}
            {clipCount != null && clipCount > 0 && (
              <span>
                {clipCount} clip{clipCount === 1 ? "" : "s"}
              </span>
            )}
            <span>{formatDateTime(project.created_at)}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
