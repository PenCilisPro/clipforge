"use client";

import { useState } from "react";
import Link from "next/link";
import { Film, Link2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { formatDateTime, formatDuration } from "@/lib/utils";
import type { Project } from "@/lib/types";

export function ProjectCard({
  project,
  onDeleted,
}: {
  project: Project;
  onDeleted?: (id: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const clipCount = (project as Project & { clips?: { count: number }[] })
    .clips?.[0]?.count;

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" });
      toast.success("Project deleted");
      setConfirmOpen(false);
      onDeleted?.(project.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete project");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Link href={`/dashboard/projects/${project.id}`} className="group block">
        <Card className="h-full transition-all duration-300 group-hover:-translate-y-1 group-hover:border-primary-500/50 group-hover:shadow-lg group-hover:shadow-primary-500/10">
          <CardContent className="pt-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-500/10 transition-colors group-hover:bg-primary-500/20">
                <Film className="h-5 w-5 text-primary-500" />
              </div>
              <div
                className="flex items-center gap-1"
                onClick={(e) => e.preventDefault()}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 hover:text-destructive"
                  aria-label="Delete project"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setConfirmOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <StatusBadge status={project.status} />
              </div>
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

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this project?</DialogTitle>
            <DialogDescription>
              "{project.title ?? "Untitled project"}" and all of its clips will be
              permanently removed, including stored video files. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
