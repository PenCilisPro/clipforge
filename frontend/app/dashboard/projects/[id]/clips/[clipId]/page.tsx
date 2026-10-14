"use client";

/**
 * Full-screen clip editor â€” StreamPal-style workspace. All logic lives in
 * <ClipEditor />; the dashboard shell renders this route without its
 * sidebar/header (see components/dashboard/shell.tsx).
 */
import { useParams } from "next/navigation";

import { ClipEditor } from "@/components/dashboard/clip-editor";

export default function ClipEditPage() {
  const params = useParams<{ id: string; clipId: string }>();

  return <ClipEditor projectId={params.id} clipId={params.clipId} />;
}
