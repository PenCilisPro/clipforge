"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Download, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { API_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { ClipCard } from "@/components/dashboard/clip-card";
import { PipelineTracker } from "@/components/dashboard/pipeline-tracker";
import { createClient } from "@/lib/supabase/client";
import type { Clip, Job, Project, TranscriptWord } from "@/lib/types";
import { cn } from "@/lib/utils";

interface TranscriptParagraph {
  start: number;
  text: string;
}

/** Same paragraph grouping the .md/.pdf/.docx exports use. */
const TRANSCRIPT_GAP_SECONDS = 3;
const TRANSCRIPT_MAX_WORDS = 60;

function transcriptParagraphs(words: TranscriptWord[]): TranscriptParagraph[] {
  const paragraphs: TranscriptParagraph[] = [];
  let current: TranscriptParagraph & { end: number; wordCount: number } | null = null;

  for (const w of words) {
    const start = Number(w.start);
    const text = String(w.word ?? "").trim();
    if (!Number.isFinite(start) || !text) continue;
    if (!current || start - current.end >= TRANSCRIPT_GAP_SECONDS || current.wordCount >= TRANSCRIPT_MAX_WORDS) {
      if (current?.text.trim()) paragraphs.push({ start: current.start, text: current.text });
      current = { start, end: Number(w.end) || start, text, wordCount: 0 };
    } else {
      current.end = Number(w.end) || current.end;
      current.text += ` ${text}`;
    }
    current.wordCount += 1;
  }
  if (current?.text.trim()) paragraphs.push({ start: current.start, text: current.text });
  return paragraphs;
}

function formatTs(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

const TRANSCRIPT_FORMATS = [
  { format: "md", label: "Markdown" },
  { format: "pdf", label: "PDF" },
  { format: "docx", label: "Word" },
] as const;

type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number]["format"];

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [project, setProject] = useState<Project | null>(null);
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [downloadingFormat, setDownloadingFormat] = useState<TranscriptFormat | null>(null);
  const [copied, setCopied] = useState(false);

  const isTranscriptProject = project?.project_mode === "transcript";

  async function downloadTranscript(format: TranscriptFormat) {
    if (!project) return;
    setDownloadingFormat(format);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(
        `${API_URL}/api/projects/${project.id}/transcript?format=${format}`,
        { headers: session ? { Authorization: `Bearer ${session.access_token}` } : undefined }
      );
      if (!res.ok) {
        let message = `Download failed (${res.status})`;
        try {
          message = (await res.json())?.error ?? message;
        } catch {
          // non-JSON error body
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const slug =
        (project.title ?? "transcript")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "transcript";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug}-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloadingFormat(null);
    }
  }

  async function copyTranscript() {
    const words = project?.transcript_json?.words ?? [];
    const text =
      transcriptParagraphs(words)
        .map((p) => `[${formatTs(p.start)}] ${p.text}`)
        .join("\n\n") || (project?.transcript_json?.transcript ?? "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access");
    }
  }

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

      <PipelineTracker
        jobs={jobs}
        projectStatus={project.status}
        mode={project.project_mode ?? "clips"}
      />

      {isTranscriptProject ? (
        <Card className="mt-8">
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <FileText className="h-4 w-4 text-primary-500" /> Transcript
                </p>
                <p className="text-xs text-muted-foreground">
                  {project.status === "done"
                    ? "Timestamped paragraphs — download or copy below."
                    : "Transcribing — the transcript will appear here when it's ready."}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={copyTranscript}
                  disabled={project.status !== "done"}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                {TRANSCRIPT_FORMATS.map(({ format, label }) => (
                  <Button
                    key={format}
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => downloadTranscript(format)}
                    disabled={project.status !== "done" || downloadingFormat != null}
                  >
                    {downloadingFormat === format ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {label}
                  </Button>
                ))}
              </div>
            </div>

            {project.status === "done" &&
              (() => {
                const words = project.transcript_json?.words ?? [];
                const paragraphs = transcriptParagraphs(words);
                if (paragraphs.length === 0) {
                  return (
                    <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                      No transcript available for this project.
                    </p>
                  );
                }
                return (
                  <div
                    className={cn(
                      "max-h-[480px] space-y-4 overflow-y-auto rounded-lg border bg-muted/30 p-4 pr-2"
                    )}
                  >
                    {paragraphs.map((p, i) => (
                      <p key={i} className="text-sm leading-relaxed">
                        <span className="mr-2 select-none font-mono text-xs text-primary-600 dark:text-primary-400">
                          [{formatTs(p.start)}]
                        </span>
                        {p.text}
                      </p>
                    ))}
                  </div>
                );
              })()}
          </CardContent>
        </Card>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
