"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Link2, Loader2, Music, Upload } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { cn, formatDuration, safeUploadName } from "@/lib/utils";
import { Reveal } from "@/components/dashboard/reveal";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";

const CLIP_COUNT_TIERS = [
  { value: "1-5", label: "1–5 clips" },
  { value: "6-10", label: "6–10 clips", tier: "pro" },
  { value: "11-15", label: "11–15 clips", tier: "pro" },
] as const;

const CLIP_LENGTHS = [
  { value: "10-14", label: "10–14 seconds" },
  { value: "15-30", label: "15–30 seconds" },
  { value: "31-45", label: "31–45 seconds" },
  { value: "60+", label: "Above 1 minute" },
  { value: "ai_optimized", label: "AI optimized" },
];

const MOODS = [
  "upbeat",
  "chill",
  "dramatic",
  "corporate",
  "energetic",
  "happy",
  "epic",
  "background",
];

interface MusicTrack {
  id: string;
  name: string;
  artist: string;
  duration: number;
  audio: string;
  image: string | null;
}

export default function NewProjectPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);

  // Render preferences
  const [clipCountTier, setClipCountTier] = useState("1-5");
  const [clipLength, setClipLength] = useState("ai_optimized");
  const [plan, setPlan] = useState<string>("free");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { profile } = await apiFetch<{
          profile: { plan?: string; is_admin?: boolean };
        }>("/api/me");
        setPlan(profile.plan ?? "free");
        setIsAdmin(Boolean(profile.is_admin));
      } catch {
        // Non-fatal: the backend re-checks entitlements on create anyway.
      }
    })();
  }, []);

  const paidFeatures = plan === "pro" || plan === "business" || isAdmin;
  const [mood, setMood] = useState("upbeat");
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<MusicTrack | null>(null);

  async function loadTracks(chosenMood: string) {
    setTracksLoading(true);
    setSelectedTrack(null);
    try {
      const data = await apiFetch<{ configured: boolean; tracks: MusicTrack[] }>(
        `/api/music?mood=${encodeURIComponent(chosenMood)}`
      );
      setTracks(data.tracks);
      if (!data.configured) {
        toast.info("Music catalog isn't configured yet — create the project without music.");
      }
    } catch {
      setTracks([]);
      toast.error("Couldn't load music — you can still create the project.");
    } finally {
      setTracksLoading(false);
    }
  }

  async function getUserId(): Promise<string> {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw new Error("Not signed in");
    return session.user.id;
  }

  function musicFields() {
    return selectedTrack
      ? {
          music_url: selectedTrack.audio,
          music_title: selectedTrack.name,
          music_artist: selectedTrack.artist,
          music_mood: mood,
        }
      : {};
  }

  async function createProject(body: Record<string, unknown>) {
    await apiFetch("/api/projects", {
      method: "POST",
      body: { clip_count_tier: clipCountTier, clip_length_pref: clipLength, ...musicFields(), ...body },
    });
  }

  async function handleUrlSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await createProject({
        source_type: "url",
        source_url: url,
        title: title || null,
      });
      toast.success("Project created", {
        description: "The pipeline is running — follow progress on the project page.",
      });
      router.push("/dashboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create project");
    } finally {
      setBusy(false);
    }
  }

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (selected) setFile(selected);
  }

  async function handleUploadSubmit() {
    if (!file) return;
    setBusy(true);
    setUploadPct(0);
    try {
      const userId = await getUserId();
      const supabase = createClient();

      // Files over the free-plan 50 MB per-upload cap are split in the browser
      // into ~40 MB parts; the worker stitches them back together locally.
      const PART_BYTES = 40 * 1024 * 1024;
      let storagePath: string;
      if (file.size <= PART_BYTES) {
        storagePath = `${userId}/${Date.now()}-${safeUploadName(file.name)}`;
        const { error } = await supabase.storage
          .from("source-videos")
          .upload(storagePath, file, { cacheControl: "3600", upsert: false });
        if (error) throw error;
        setUploadPct(100);
      } else {
        const uploadId = `${Date.now()}-${safeUploadName(file.name).replace(/\.[^.]+$/, "")}`;
        const folder = `${userId}/parts/${uploadId}`;
        const parts: string[] = [];
        for (let offset = 0, i = 0; offset < file.size; offset += PART_BYTES, i++) {
          const partPath = `${folder}/part-${String(i).padStart(5, "0")}`;
          const chunk = file.slice(offset, offset + PART_BYTES);
          const { error } = await supabase.storage.from("source-videos").upload(partPath, chunk, {
            cacheControl: "3600",
            upsert: false,
            contentType: "application/octet-stream",
          });
          if (error) throw error;
          parts.push(partPath);
          setUploadPct(Math.min(99, Math.round(((offset + PART_BYTES) / file.size) * 100)));
        }
        // Manifest is the project's storage_path — its presence means every
        // part made it, and the worker keys off the .json suffix.
        const manifestPath = `${folder}/manifest.json`;
        const { error: manifestError } = await supabase.storage
          .from("source-videos")
          .upload(
            manifestPath,
            new Blob([JSON.stringify({ parts, size: file.size })], {
              type: "application/json",
            }),
            { contentType: "application/json", upsert: false }
          );
        if (manifestError) throw manifestError;
        storagePath = manifestPath;
        setUploadPct(100);
      }

      await createProject({
        source_type: "upload",
        storage_path: storagePath,
        title: title || file.name,
      });

      toast.success("Upload complete", {
        description: "Transcription and AI analysis are starting now.",
      });
      router.push("/dashboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(false);
      setUploadPct(null);
    }
  }

  return (
    <Reveal className="mx-auto max-w-2xl">
      <Button variant="ghost" size="sm" asChild className="mb-4 -ml-2">
        <Link href="/dashboard">
          <ArrowLeft /> Back to projects
        </Link>
      </Button>

      <h1 className="text-2xl font-bold tracking-tight">New Project</h1>
      <p className="text-sm text-muted-foreground">
        ClipForge will transcribe the video, find viral moments and render
        vertical captioned clips.
      </p>

      <Tabs defaultValue="url" className="mt-6">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="url">
            <Link2 className="mr-2 h-4 w-4" /> Paste a link
          </TabsTrigger>
          <TabsTrigger value="upload">
            <Upload className="mr-2 h-4 w-4" /> Upload a file
          </TabsTrigger>
        </TabsList>

        <TabsContent value="url">
          <Card>
            <CardHeader>
              <CardTitle>Video URL</CardTitle>
              <CardDescription>
                YouTube, Vimeo, Zoom recordings and most podcast hosts are
                supported.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleUrlSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="url">Link</Label>
                  <Input
                    id="url"
                    type="url"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="title">Project name (optional)</Label>
                  <Input
                    id="title"
                    placeholder="Ep. 42 — Scaling a SaaS to $1M"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <Button type="submit" className="w-full" size="lg" disabled={busy}>
                  {busy && <Loader2 className="animate-spin" />}
                  Create Project
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="upload">
          <Card>
            <CardHeader>
              <CardTitle>Upload video</CardTitle>
              <CardDescription>
                MP4, MOV, WEBM or MKV — uploaded straight to your Supabase
                Storage.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 text-center transition-colors",
                  dragOver
                    ? "border-primary-500 bg-primary-500/5"
                    : "border-border hover:border-primary-500/50"
                )}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped) setFile(dropped);
                }}
              >
                <Upload className="h-8 w-8 text-primary-500" />
                {file ? (
                  <>
                    <p className="mt-3 text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(file.size / 1024 / 1024).toFixed(1)} MB — click to
                      change
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-3 text-sm font-medium">
                      Click to select or drag &amp; drop
                    </p>
                    <p className="text-xs text-muted-foreground">
                      MP4, MOV, WEBM, MKV up to 4K
                    </p>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/*"
                  className="hidden"
                  onChange={pickFile}
                />
              </div>

              {uploadPct != null && uploadPct < 100 && (
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full score-gradient transition-all"
                    style={{ width: `${uploadPct}%` }}
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="upload-title">Project name (optional)</Label>
                <Input
                  id="upload-title"
                  placeholder="My webinar recording"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <Button
                className="w-full"
                size="lg"
                disabled={!file || busy}
                onClick={handleUploadSubmit}
              >
                {busy && <Loader2 className="animate-spin" />}
                Upload &amp; Create Project
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Preferences — shared by both creation paths */}
      <div className="mt-6 space-y-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Number of clips</CardTitle>
            <CardDescription>
              How many clips should the AI pick from this video? Tiers above
              5 clips need a Pro subscription.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select
              value={clipCountTier}
              onValueChange={setClipCountTier}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLIP_COUNT_TIERS.map((option) => {
                  const locked = "tier" in option && !paidFeatures;
                  return (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={locked}
                    >
                      {option.label}
                      {locked ? " — Pro" : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {!paidFeatures && (
              <p className="mt-2 text-xs text-muted-foreground">
                Upgrade to Pro to generate up to 15 clips per video.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Clip length</CardTitle>
            <CardDescription>
              How long should the generated clips be? "AI optimized" lets the AI
              pick the most engaging length per moment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select value={clipLength} onValueChange={setClipLength}>
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLIP_LENGTHS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Music className="h-4 w-4 text-primary-500" /> Background music
              (optional)
            </CardTitle>
            <CardDescription>
              Pick a mood to browse the free-to-use Jamendo catalog. The track
              plays quietly under the voiceover in every clip.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Select
                value={mood}
                onValueChange={(v) => {
                  setMood(v);
                  loadTracks(v);
                }}
              >
                <SelectTrigger className="w-full sm:w-56">
                  <SelectValue placeholder="Choose a mood" />
                </SelectTrigger>
                <SelectContent>
                  {MOODS.map((m) => (
                    <SelectItem key={m} value={m} className="capitalize">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedTrack && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedTrack(null)}
                >
                  Clear
                </Button>
              )}
            </div>

            {tracksLoading && (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            )}

            {!tracksLoading && tracks != null && tracks.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No tracks found for this mood — try another one.
              </p>
            )}

            {!tracksLoading &&
              tracks?.map((track) => {
                const selected = selectedTrack?.id === track.id;
                return (
                  <div
                    key={track.id}
                    className={cn(
                      "space-y-2 rounded-lg border p-3 transition-colors",
                      selected
                        ? "border-primary-500 bg-primary-500/5"
                        : "hover:border-primary-500/40"
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{track.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {track.artist} · {formatDuration(track.duration)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={selected ? "default" : "outline"}
                        onClick={() =>
                          setSelectedTrack(selected ? null : track)
                        }
                      >
                        {selected ? "Selected" : "Use track"}
                      </Button>
                    </div>
                    {/* Jamendo preview player */}
                    <audio
                      controls
                      preload="none"
                      src={track.audio}
                      className="h-8 w-full"
                    />
                  </div>
                );
              })}

            {tracks != null && tracks.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Music by Jamendo artists (Creative Commons licenses).
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </Reveal>
  );
}
