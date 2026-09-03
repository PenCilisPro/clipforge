"use client";

import { StatusPill } from "@/components/dashboard/status-pill";
import type { ProjectStatus } from "@/lib/types";

const MAP: Record<
  ProjectStatus,
  { label: string; tone: "muted" | "info" | "success" | "destructive" }
> = {
  pending: { label: "Pending", tone: "muted" },
  processing: { label: "Processing", tone: "info" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "destructive" },
};

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const { label, tone } = MAP[status] ?? MAP.pending;
  return (
    <StatusPill label={label} tone={tone} pulse={status === "processing"} />
  );
}
