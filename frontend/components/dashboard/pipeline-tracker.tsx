"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { PIPELINE_STAGES, type Job, type ProjectStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Shows the 4 pipeline stages with live status derived from the jobs table.
 */
export function PipelineTracker({
  jobs,
  projectStatus,
}: {
  jobs: Job[];
  projectStatus: ProjectStatus;
}) {
  const stageState = PIPELINE_STAGES.map((stage) => {
    const stageJobs = jobs.filter((job) => job.job_type === stage.key);
    const latest = stageJobs[stageJobs.length - 1];
    return {
      ...stage,
      status: latest?.status ?? "queued",
      error: latest?.error_message ?? null,
    };
  });

  const completed = stageState.filter((s) => s.status === "completed").length;
  const progress =
    projectStatus === "done"
      ? 100
      : projectStatus === "failed"
        ? Math.max(10, (completed / stageState.length) * 100)
        : (completed / stageState.length) * 100 +
          (stageState.some((s) => s.status === "active") ? 12 : 0);

  const visible =
    projectStatus !== "done" ||
    stageState.some((s) => s.status === "active" || s.status === "queued");

  return (
    <Card className="mt-6">
      <CardContent className="pt-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Pipeline</h2>
          <span className="text-xs text-muted-foreground">
            {projectStatus === "done"
              ? "Completed"
              : projectStatus === "failed"
                ? "Failed"
                : `${Math.min(100, Math.round(progress))}%`}
          </span>
        </div>
        <Progress value={Math.min(100, progress)} className="mt-2" />

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stageState.map((stage) => (
            <div
              key={stage.key}
              className={cn(
                "rounded-lg border p-3 transition-colors",
                stage.status === "active" && "border-primary-500/60 bg-primary-500/5",
                stage.status === "completed" && "border-emerald-500/40",
                stage.status === "failed" && "border-destructive/50"
              )}
            >
              <div className="flex items-center gap-2">
                {stage.status === "completed" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : stage.status === "active" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary-500" />
                ) : stage.status === "failed" ? (
                  <XCircle className="h-4 w-4 text-destructive" />
                ) : (
                  <span className="h-4 w-4 rounded-full border-2 border-muted-foreground/30" />
                )}
                <span className="text-xs font-medium leading-tight">
                  {stage.label}
                </span>
              </div>
              {stage.error && (
                <p className="mt-2 line-clamp-2 text-[11px] text-destructive">
                  {stage.error}
                </p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
