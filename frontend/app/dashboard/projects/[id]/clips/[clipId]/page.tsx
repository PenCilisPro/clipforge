"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Copy,
  Film,
  Loader2,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import type { Clip, Project } from "@/lib/types";
import { cuesToSrtText, parseSrt, type SrtCue } from "@/lib/srt-client";
import { clamp, cuesFromTranscript, MIN_CLIP_SECONDS } from "@/lib/timeline";
import { TimelineEditor, type BrollSegment } from "@/components/dashboard/timeline-editor";
import {
  CaptionStyleControls,
  DEFAULT_CAPTION_STYLE,
  type CaptionStyleValue,
} from "@/components/dashboard/caption-style-controls";
import { Reveal } from "@/components/dashboard/reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn, safeUploadName } from "@/lib/utils";

const AI_CREDIT_COST = 10;

/** Synthetic id for the AI-picked track's preview player. */
const AI_PICKED_ID = "ai-picked";

/** Music (MP3) and B-roll (MP4) uploads may not exceed this size. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const BROLL_CATEGORIES: { label: string; q: string }[] = [
  { label: "Nature", q: "nature landscape" },
  { label: "City", q: "city street aerial" },
  { label: "People", q: "people walking" },
  { label: "Business", q: "business office work" },
  { label: "Tech", q: "technology computer" },
  { label: "Food", q: "food cooking" },
  { label: "Sports", q: "sports action" },
  { label: "Abstract", q: "abstract background" },
];

const MUSIC_MOODS = [
  "upbeat",
  "chill",
  "dramatic",
  "corporate",
  "energetic",
  "happy",
  "epic",
  "background",
];

interface StockResult {
  url: string;
  poster: string | null;
  provider: string;
  duration: number;
}

interface MusicTrack {
  id: string;
  name: string;
  artist: string;
  duration: number;
  audio: string;
  image: string | null;
}

function formatTime(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export default function ClipEditPage() {
  const router = useRouter();
  const params = useParams<{ id: string; clipId: string }>();
  const supabase = useCallback(() => createClient(), []);

  const [loading, setLoading] = useState(true);
  const [clip, setClip] = useState<Clip | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isFinalRender, setIsFinalRender] = useState(true);
  const [credits, setCredits] = useState<number | null>(null);
  const [brollBusy, setBrollBusy] = useState(false);
  const [musicBusy, setMusicBusy] = useState(false);

  const [cues, setCues] = useState<SrtCue[]>([]);
  const [caption, setCaption] = useState<CaptionStyleValue>(DEFAULT_CAPTION_STYLE);
  const [resetSrt, setResetSrt] = useState(false);
  const [startTime, setStartTime] = useState("0");
  const [endTime, setEndTime] = useState("0");
  const [saving, setSaving] = useState(false);

  // Source video for the timeline editor (signed URL; null for split uploads).
  const [sourceVideoUrl, setSourceVideoUrl] = useState<string | null>(null);
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);

  const [brollQuery, setBrollQuery] = useState("");
  const [brollResults, setBrollResults] = useState<StockResult[] | null>(null);
  const [brollSearching, setBrollSearching] = useState(false);

  const [musicMood, setMusicMood] = useState("background");
  const [musicQuery, setMusicQuery] = useState("");
  const [musicTracks, setMusicTracks] = useState<MusicTrack[] | null>(null);
  const [musicLoading, setMusicLoading] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [musicUploading, setMusicUploading] = useState(false);
  const [brollUploading, setBrollUploading] = useState(false);
  // The track the AI just picked — shown with its own preview player.
  const [aiPickedTrack, setAiPickedTrack] = useState<{
    name: string;
    artist: string;
    mood: string;
    audio: string;
  } | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicFileRef = useRef<HTMLInputElement | null>(null);
  const brollFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { project: loaded } = await apiFetch<{
          project: { clips: Clip[] } & Project;
        }>(`/api/projects/${params.id}`);
        const found = (loaded.clips as Clip[]).find((c) => c.id === params.clipId);
        if (!found) throw new Error("Clip not found");
        setClip(found);
        setProject(loaded);
        setCaption({
          caption_style: found.caption_style ?? "karaoke",
          caption_font: found.caption_font ?? "anton",
          caption_color: found.caption_color ?? "#ffffff",
          caption_stroke: found.caption_stroke ?? false,
          caption_stroke_color: found.caption_stroke_color ?? "#000000",
          caption_stroke_size: found.caption_stroke_size ?? 4,
          caption_shadow: found.caption_shadow ?? false,
          caption_shadow_color: found.caption_shadow_color ?? "#000000",
          caption_shadow_size: found.caption_shadow_size ?? 6,
        });
        setStartTime(String(Number(found.start_time)));
        setEndTime(String(Number(found.end_time)));
        lastTrimRef.current = { start: Number(found.start_time), end: Number(found.end_time) };

        // Manual overrides show up directly; otherwise fetch the stored SRT.
        if (found.srt_override) {
          setCues(parseSrt(found.srt_override));
        }

        const playback = await apiFetch<{
          video_url: string;
          srt_url: string | null;
          is_final_render: boolean;
        }>(`/api/clips/${params.clipId}/playback`);
        setVideoUrl(playback.video_url);
        setIsFinalRender(playback.is_final_render);

        // Source video powers the CapCut-style timeline (split uploads: null).
        try {
          const src = await apiFetch<{
            video_url: string | null;
            split: boolean;
            duration: number | null;
          }>(`/api/clips/${params.clipId}/source-playback`);
          setSourceVideoUrl(src.video_url);
          setSourceDuration(src.duration);
        } catch {
          // Non-fatal: the timeline degrades to handle-only trimming.
        }

        if (!found.srt_override && playback.srt_url) {
          const res = await fetch(playback.srt_url);
          if (res.ok) setCues(parseSrt(await res.text()));
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load clip");
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id, params.clipId]);

  async function loadCredits() {
    try {
      const me = await apiFetch<{ profile: { credits_remaining: number } }>("/api/me");
      setCredits(me.profile.credits_remaining);
    } catch {
      // non-critical — the endpoints re-check server-side
    }
  }

  useEffect(() => {
    loadCredits();
  }, []);

  async function fetchMusic(mood: string, q: string) {
    setMusicLoading(true);
    try {
      const res = await apiFetch<{ tracks: MusicTrack[] }>(
        `/api/music?mood=${encodeURIComponent(mood)}${q ? `&q=${encodeURIComponent(q)}` : ""}`
      );
      setMusicTracks(res.tracks);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Music search failed");
    } finally {
      setMusicLoading(false);
    }
  }

  function updateCue(id: string, patch: Partial<SrtCue>) {
    setCues((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    setResetSrt(false);
  }

  function addCue() {
    const last = cues[cues.length - 1];
    const start = last ? last.end + 0.2 : 0;
    setCues((prev) => [
      ...prev,
      { id: crypto.randomUUID(), start, end: start + 1.5, text: "New caption" },
    ]);
    setResetSrt(false);
  }

  // ---------- B-roll ----------

  async function saveBrollSegments(segments: NonNullable<Clip["broll_json"]>) {
    if (!clip) return;
    try {
      const res = await apiFetch<{ broll: NonNullable<Clip["broll_json"]> }>(
        `/api/clips/${clip.id}/broll/segments`,
        { method: "POST", body: { segments } }
      );
      setClip({ ...clip, broll_json: res.broll });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save B-roll");
    }
  }

  async function searchBroll(q: string) {
    if (!clip || !q.trim()) return;
    setBrollSearching(true);
    try {
      const res = await apiFetch<{ results: StockResult[] }>(
        `/api/clips/${clip.id}/broll/search?q=${encodeURIComponent(q.trim())}`
      );
      setBrollResults(res.results);
      if (res.results.length === 0) toast.info("No stock clips found for that search");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "B-roll search failed");
    } finally {
      setBrollSearching(false);
    }
  }

  async function addBrollSegment(result: StockResult) {
    if (!clip) return;
    const duration = Math.max(3, Number(endTime) - Number(startTime));
    const segments = Array.isArray(clip.broll_json) ? clip.broll_json : [];
    if (segments.length >= 8) {
      toast.error("A clip can hold at most 8 B-roll scenes — remove one first");
      return;
    }
    const lastEnd = segments.length > 0 ? segments[segments.length - 1].end : 0;
    const start = Math.min(Math.max(lastEnd + 1, 0), Math.max(0, duration - 3));
    const end = Math.min(start + 3, duration);
    await saveBrollSegments([...segments, { start, end, src: result.url }]);
    toast.success("B-roll scene added — adjust its timing below");
  }

  async function useUploadedBroll(file: File) {
    if (!clip || !validateUpload(file, "video")) return;
    const segments = Array.isArray(clip.broll_json) ? clip.broll_json : [];
    if (segments.length >= 8) {
      toast.error("A clip can hold at most 8 B-roll scenes — remove one first");
      return;
    }
    setBrollUploading(true);
    try {
      const userId = await getUserId();
      const path = `${userId}/broll/${Date.now()}-${safeUploadName(file.name)}`;
      const { error } = await supabase()
        .storage.from("user-uploads")
        .upload(path, file, { cacheControl: "3600", upsert: false, contentType: "video/mp4" });
      if (error) throw error;

      const duration = Math.max(3, Number(endTime) - Number(startTime));
      const lastEnd = segments.length > 0 ? segments[segments.length - 1].end : 0;
      const start = Math.min(Math.max(lastEnd + 1, 0), Math.max(0, duration - 3));
      const end = Math.min(start + 3, duration);
      await saveBrollSegments([...segments, { start, end, src: `storage:user-uploads/${path}` }]);
      toast.success("Uploaded B-roll added — adjust its timing below");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "B-roll upload failed");
    } finally {
      setBrollUploading(false);
      if (brollFileRef.current) brollFileRef.current.value = "";
    }
  }

  async function removeBrollSegment(index: number) {
    if (!clip || !Array.isArray(clip.broll_json)) return;
    await saveBrollSegments(clip.broll_json.filter((_, i) => i !== index));
  }

  async function updateBrollSegment(index: number, field: "start" | "end", value: number) {
    if (!clip || !Array.isArray(clip.broll_json)) return;
    const next = clip.broll_json.map((s, i) => (i === index ? { ...s, [field]: value } : s));
    setClip({ ...clip, broll_json: next });
    await saveBrollSegments(next);
  }

  async function generateBroll() {
    if (!clip || brollBusy) return;
    setBrollBusy(true);
    try {
      const res = await apiFetch<{ broll: Clip["broll_json"]; credits_remaining: number }>(
        `/api/clips/${clip.id}/broll/ai`,
        { method: "POST" }
      );
      setClip({ ...clip, broll_json: res.broll });
      setCredits(res.credits_remaining);
      const count = res.broll?.length ?? 0;
      toast.success(
        count > 0 ? `B-roll ready — ${count} scene${count === 1 ? "" : "s"} added` : "No B-roll moments found for this clip",
        { description: `10 credits used · applies when you re-render · ${res.credits_remaining} left` }
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "B-roll generation failed");
    } finally {
      setBrollBusy(false);
    }
  }

  async function setBrollMode(mode: "auto" | "none") {
    if (!clip || brollBusy) return;
    setBrollBusy(true);
    try {
      const res = await apiFetch<{ broll_json: Clip["broll_json"] }>(`/api/clips/${clip.id}/broll`, {
        method: "POST",
        body: { mode },
      });
      setClip({ ...clip, broll_json: res.broll_json });
      toast.success(mode === "auto" ? "B-roll set to automatic" : "B-roll turned off for this clip");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update B-roll");
    } finally {
      setBrollBusy(false);
    }
  }

  // ---------- Timeline editor ----------

  // Mirrors the trim window synchronously so repeated pointer-move events
  // (which can land between React renders) never double-apply cue shifts.
  const lastTrimRef = useRef<{ start: number; end: number } | null>(null);

  function handleTrim(newStart: number, newEnd: number) {
    const oldStart = lastTrimRef.current?.start ?? Number(startTime);
    lastTrimRef.current = { start: newStart, end: newEnd };
    setStartTime(String(Number(newStart.toFixed(1))));
    setEndTime(String(Number(newEnd.toFixed(1))));

    // Captions belong to the spoken words in the source, so shifting the
    // window shifts their clip-relative times by the same amount. Lines that
    // end up outside the window are dropped at save (a hint offers auto-fill).
    const shift = Number((newStart - oldStart).toFixed(1));
    if (shift !== 0) {
      setCues((prev) =>
        prev.map((c) => ({
          ...c,
          start: Number((c.start - shift).toFixed(1)),
          end: Number((c.end - shift).toFixed(1)),
        }))
      );
    }
  }

  function handleTrimCommit() {
    // Once per trim drag: keep stored B-roll inside the final window so
    // renders stay valid, persisting through the existing segments endpoint.
    if (!clip || !Array.isArray(clip.broll_json) || !lastTrimRef.current) return;
    const winLen = lastTrimRef.current.end - lastTrimRef.current.start;
    const clamped = clip.broll_json
      .map((s) => ({
        ...s,
        start: clamp(s.start, 0, Math.max(0, winLen - 0.5)),
        end: clamp(s.end, 0.5, winLen),
      }))
      .filter((s) => s.end - s.start >= 0.5)
      .map((s) => ({ ...s, start: Number(s.start.toFixed(1)), end: Number(s.end.toFixed(1)) }));
    if (JSON.stringify(clamped) !== JSON.stringify(clip.broll_json)) {
      setClip({ ...clip, broll_json: clamped });
      void saveBrollSegments(clamped);
    }
  }

  function updateBrollFromTimeline(segments: BrollSegment[], commit: boolean) {
    setClip((prev) => (prev ? { ...prev, broll_json: segments } : prev));
    if (commit) void saveBrollSegments(segments);
  }

  /**
   * Split into two clips at the playhead (source seconds). Caption cues and
   * B-roll segments are divided at the boundary and sent pre-split; the
   * backend turns the current row into part 1, creates part 2 and re-renders
   * both immediately (no Save step needed).
   */
  async function handleSplit(atSource: number) {
    if (!clip || saving) return;
    const start = Number(startTime);
    const end = Number(endTime);
    const at = clamp(atSource, start + MIN_CLIP_SECONDS, end - MIN_CLIP_SECONDS);
    if (at - start < MIN_CLIP_SECONDS || end - at < MIN_CLIP_SECONDS) {
      toast.error("Both parts must be at least 3 seconds long");
      return;
    }

    const boundary = Number((at - start).toFixed(1));
    const part1: SrtCue[] = [];
    const part2: SrtCue[] = [];
    for (const c of cues) {
      if (c.end <= boundary) part1.push(c);
      else if (c.start >= boundary) {
        part2.push({
          ...c,
          id: crypto.randomUUID(),
          start: Number((c.start - boundary).toFixed(1)),
          end: Number((c.end - boundary).toFixed(1)),
        });
      } else {
        // Cue spans the split — keep the piece on each side if it's readable.
        if (boundary - c.start >= 0.3) part1.push({ ...c, end: boundary });
        if (c.end - boundary >= 0.3) {
          part2.push({ ...c, id: crypto.randomUUID(), start: 0, end: Number((c.end - boundary).toFixed(1)) });
        }
      }
    }

    const splitSegments = (segs: BrollSegment[]) => {
      const p1: BrollSegment[] = [];
      const p2: BrollSegment[] = [];
      for (const s of segs) {
        if (s.end <= boundary) p1.push(s);
        else if (s.start >= boundary) {
          p2.push({
            ...s,
            start: Number((s.start - boundary).toFixed(1)),
            end: Number((s.end - boundary).toFixed(1)),
          });
        } else {
          if (boundary - s.start >= 0.5) p1.push({ ...s, end: boundary });
          if (s.end - boundary >= 0.5) {
            p2.push({ ...s, start: 0, end: Number((s.end - boundary).toFixed(1)) });
          }
        }
      }
      return [p1, p2] as const;
    };
    const [brollPart1, brollPart2] = Array.isArray(clip.broll_json)
      ? splitSegments(clip.broll_json)
      : [undefined, undefined];

    setSaving(true);
    try {
      await apiFetch(`/api/clips/${clip.id}/split`, {
        method: "POST",
        body: {
          at,
          srt_part1: cuesToSrtText(part1),
          srt_part2: cuesToSrtText(part2),
          ...(brollPart1 !== undefined ? { broll_part1: brollPart1, broll_part2: brollPart2 } : {}),
        },
      });
      toast.success("Clip split — both parts are re-rendering");
      router.push(`/dashboard/projects/${params.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to split clip");
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate() {
    if (!clip || saving) return;
    setSaving(true);
    try {
      await apiFetch(`/api/clips/${clip.id}/duplicate`, { method: "POST" });
      toast.success("Clip duplicated — rendering the copy");
      router.push(`/dashboard/projects/${params.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to duplicate clip");
    } finally {
      setSaving(false);
    }
  }

  function autoFillCaptions() {
    const words = project?.transcript_json?.words ?? [];
    const next = cuesFromTranscript(words, Number(startTime), Number(endTime));
    if (next.length === 0) {
      toast.error("No transcript words inside this window");
      return;
    }
    setCues(next);
    setResetSrt(false);
    toast.success(
      `Filled ${next.length} caption line${next.length === 1 ? "" : "s"} from the transcript`
    );
  }

  // ---------- Music ----------

  function stopPreview() {
    previewAudioRef.current?.pause();
    setPreviewingId(null);
  }

  function togglePreview(track: MusicTrack) {
    if (previewingId === track.id) {
      stopPreview();
      return;
    }
    let audio = previewAudioRef.current;
    if (!audio) {
      audio = new Audio();
      previewAudioRef.current = audio;
      audio.addEventListener("ended", () => setPreviewingId(null));
    }
    audio.src = track.audio;
    audio.play().catch(() => toast.error("Couldn't play the preview"));
    setPreviewingId(track.id);
  }

  async function getUserId(): Promise<string> {
    const { data } = await supabase().auth.getSession();
    if (!data.session) throw new Error("Not signed in");
    return data.session.user.id;
  }

  function validateUpload(file: File, kind: "audio" | "video") {
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error("File is too large — uploads can't exceed 20 MB");
      return false;
    }
    const ok =
      kind === "audio"
        ? file.type === "audio/mpeg" || /\.mp3$/i.test(file.name)
        : file.type === "video/mp4" || /\.mp4$/i.test(file.name);
    if (!ok) {
      toast.error(kind === "audio" ? "Only MP3 files are supported" : "Only MP4 files are supported");
      return false;
    }
    return true;
  }

  async function useUploadedMusic(file: File) {
    if (!project || !validateUpload(file, "audio")) return;
    setMusicUploading(true);
    try {
      const userId = await getUserId();
      const path = `${userId}/music/${Date.now()}-${safeUploadName(file.name)}`;
      const { error } = await supabase()
        .storage.from("user-uploads")
        .upload(path, file, { cacheControl: "3600", upsert: false, contentType: "audio/mpeg" });
      if (error) throw error;

      const title = file.name.replace(/\.[^.]+$/, "").slice(0, 200);
      await apiFetch(`/api/projects/${project.id}/music`, {
        method: "POST",
        body: {
          music_storage_path: path,
          music_title: title,
          music_mood: musicMood,
        },
      });
      stopPreview();
      setAiPickedTrack(null);
      setProject({
        ...project,
        music_url: null,
        music_storage_path: path,
        music_title: title,
        music_artist: "Your upload",
        music_mood: musicMood,
      });
      toast.success(`Music: ${title}`, {
        description: "Your uploaded track applies on the next re-render",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Music upload failed");
    } finally {
      setMusicUploading(false);
      if (musicFileRef.current) musicFileRef.current.value = "";
    }
  }

  async function useTrack(track: MusicTrack, mood: string) {
    if (!project) return;
    stopPreview();
    setAiPickedTrack(null);
    try {
      await apiFetch(`/api/projects/${project.id}/music`, {
        method: "POST",
        body: {
          music_url: track.audio,
          music_title: track.name,
          music_artist: track.artist,
          music_mood: mood,
        },
      });
      setProject({
        ...project,
        music_url: track.audio,
        music_storage_path: null,
        music_title: track.name,
        music_artist: track.artist,
        music_mood: mood,
      });
      toast.success(`Music: ${track.name}`, {
        description: "Applies to the project on the next re-render",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set music");
    }
  }

  async function generateMusic() {
    if (!clip || musicBusy) return;
    setMusicBusy(true);
    try {
      const res = await apiFetch<{
        track: { name: string; artist: string; audio: string; mood: string };
        credits_remaining: number;
      }>(`/api/clips/${clip.id}/music/ai`, { method: "POST" });
      setProject((prev) =>
        prev
          ? {
              ...prev,
              music_url: res.track.audio,
              music_storage_path: null,
              music_title: res.track.name,
              music_artist: res.track.artist,
              music_mood: res.track.mood,
            }
          : prev
      );
      setAiPickedTrack({
        name: res.track.name,
        artist: res.track.artist,
        mood: res.track.mood,
        audio: res.track.audio,
      });
      setCredits(res.credits_remaining);
      toast.success(`Music: ${res.track.name}`, {
        description: `${res.track.artist} · ${res.track.mood} · 10 credits used · applies on re-render`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Music generation failed");
    } finally {
      setMusicBusy(false);
    }
  }

  // ---------- Save ----------

  async function save() {
    if (!clip || saving) return;
    const start = Number(startTime);
    const end = Number(endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3) {
      toast.error("Clip must be at least 3 seconds long");
      return;
    }
    // Caption times are clip-relative — lines outside the trim window no
    // longer belong to this clip and are dropped (the pipeline regenerates
    // captions when the override comes back empty).
    const winLen = end - start;
    const inWindow = cues.filter((c) => c.end > 0.05 && c.start < winLen - 0.05);
    const dropped = cues.length - inWindow.length;
    if (!resetSrt) {
      for (const cue of inWindow) {
        if (!cue.text.trim()) {
          toast.error("Caption lines can't be empty — delete the line instead");
          return;
        }
      }
    }

    setSaving(true);
    try {
      await apiFetch(`/api/clips/${clip.id}/edit`, {
        method: "POST",
        body: {
          ...caption,
          start_time: start,
          end_time: end,
          ...(resetSrt
            ? { srt_content: "" } // clear override → pipeline regenerates
            : inWindow.length > 0
              ? { srt_content: cuesToSrtText(inWindow) }
              : cues.length > 0
                ? { srt_content: "" } // every line drifted out of the window
                : {}),
        },
      });
      toast.success("Saved — re-render started", {
        description:
          dropped > 0
            ? `${dropped} caption line${dropped === 1 ? "" : "s"} outside the trim window will be regenerated.`
            : "The clip will show its new look once rendering finishes.",
      });
      router.push(`/dashboard/projects/${params.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save clip");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <Skeleton className="aspect-[9/16] max-h-72 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (!clip) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="font-medium">Clip not found</p>
        <Button asChild variant="outline" className="mt-4">
          <Link href={`/dashboard/projects/${params.id}`}>Back to project</Link>
        </Button>
      </div>
    );
  }

  const clipDuration = Math.max(3, Number(endTime) - Number(startTime));
  const brollSegments = Array.isArray(clip.broll_json) ? clip.broll_json : [];
  const outsideCues = cues.filter((c) => c.end <= 0.05 || c.start >= clipDuration - 0.05).length;
  const hasTranscriptWords = (project?.transcript_json?.words?.length ?? 0) > 0;

  return (
    <Reveal className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-1">
            <Link href={`/dashboard/projects/${params.id}`}>
              <ArrowLeft /> Back to project
            </Link>
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">
            Edit — {clip.title ?? "Untitled clip"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Trim the clip, retime captions and B-roll on the timeline, pick a
            style, add music — then re-render.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleDuplicate} disabled={saving}>
            <Copy /> Duplicate
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {saving ? "Re-rendering…" : "Save & re-render"}
          </Button>
        </div>
      </div>

      {/* CapCut-style manual timeline editor (source video canvas) */}
      <Card>
        <CardContent className="p-4">
          <TimelineEditor
            videoUrl={sourceVideoUrl}
            sourceDuration={sourceDuration}
            start={Number(startTime)}
            end={Number(endTime)}
            onTrim={handleTrim}
            onTrimCommit={handleTrimCommit}
            onSplit={handleSplit}
            cues={cues}
            onCuesChange={(next) => {
              setCues(next);
              setResetSrt(false);
            }}
            broll={clip.broll_json}
            onBrollChange={updateBrollFromTimeline}
            musicTitle={project?.music_title ?? null}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* Preview + captions/timing | captions editor + B-roll + Music */}
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="aspect-[9/16] max-h-96 w-full bg-zinc-900">
              {videoUrl ? (
                <video
                  key={videoUrl}
                  src={videoUrl}
                  controls
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  No video yet
                </div>
              )}
            </div>
            <CardContent className="p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Last render</p>
              <Badge variant={isFinalRender ? "default" : "secondary"}>
                {isFinalRender ? "Final render" : "Raw trim preview"}
              </Badge>
            </CardContent>
          </Card>

          {/* Caption style */}
          <Card>
            <CardContent className="space-y-4 p-4">
              <CaptionStyleControls
                value={caption}
                onChange={(patch) => setCaption((prev) => ({ ...prev, ...patch }))}
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={resetSrt}
                  onChange={(e) => setResetSrt(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                />
                Reset captions to AI-generated (discards edits below)
              </label>
            </CardContent>
          </Card>
        </div>

        {/* Caption editor + B-roll + Music */}
        <div className="space-y-4">
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">Captions</p>
                <p className="text-xs text-muted-foreground">
                  Each line appears on screen during its time range. Times are
                  relative to the clip start.
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {hasTranscriptWords && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={autoFillCaptions}
                    title="Rebuild caption lines from the transcript for the current trim window"
                  >
                    <Sparkles /> Auto-fill
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={addCue}>
                  <Plus /> Add line
                </Button>
              </div>
            </div>

            {outsideCues > 0 && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                {outsideCues} caption line{outsideCues === 1 ? " sits" : "s sit"} outside the
                trim window and will be dropped on save.{" "}
                {hasTranscriptWords
                  ? "Auto-fill rebuilds them for the new window."
                  : "Consider resetting to AI-generated."}
              </div>
            )}

            {resetSrt ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Captions will be regenerated from the transcript when you save.
              </p>
            ) : (
              <div className="max-h-[480px] space-y-2 overflow-y-auto pr-1">
                {cues.map((cue) => (
                  <div key={cue.id} className="flex items-start gap-2">
                    <div className="w-32 shrink-0 space-y-1">
                      <Input
                        className="h-7 px-2 text-[11px]"
                        type="number"
                        step={0.1}
                        min={0}
                        value={cue.start}
                        onChange={(e) =>
                          updateCue(cue.id, { start: Number(e.target.value) })
                        }
                      />
                      <Input
                        className="h-7 px-2 text-[11px]"
                        type="number"
                        step={0.1}
                        min={0}
                        value={cue.end}
                        onChange={(e) => updateCue(cue.id, { end: Number(e.target.value) })}
                      />
                    </div>
                    <Textarea
                      className="min-h-[52px] flex-1 text-sm"
                      value={cue.text}
                      onChange={(e) => updateCue(cue.id, { text: e.target.value })}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Delete caption line"
                      onClick={() => setCues((prev) => prev.filter((c) => c.id !== cue.id))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {cues.length === 0 && (
                  <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No captions yet — add a line or reset to AI-generated.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

          {/* B-roll */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <Film className="h-4 w-4 text-primary-500" /> B-roll
                </p>
                {credits != null && (
                  <span className="text-xs text-muted-foreground">{credits} credits</span>
                )}
              </div>

              {/* Where the scenes sit on the clip timeline */}
              {brollSegments.length > 0 && (
                <div>
                  <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                    {brollSegments.map((seg, i) => (
                      <span
                        key={i}
                        className="absolute top-0 h-full bg-primary-500/80"
                        style={{
                          left: `${(seg.start / clipDuration) * 100}%`,
                          width: `${Math.max(2, ((seg.end - seg.start) / clipDuration) * 100)}%`,
                        }}
                      />
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    0:00 — {formatTime(clipDuration)}
                  </p>
                </div>
              )}

              {clip.broll_json == null ? (
                <p className="text-xs text-muted-foreground">
                  B-roll cutaways are planned automatically during each render.
                </p>
              ) : brollSegments.length === 0 ? (
                <p className="text-xs text-muted-foreground">B-roll is off for this clip.</p>
              ) : (
                <div className="space-y-1.5">
                  {brollSegments.map((seg, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs">
                      <span className="w-4 text-muted-foreground">{i + 1}.</span>
                      <Input
                        type="number"
                        min={0}
                        step={0.5}
                        value={seg.start}
                        onChange={(e) =>
                          updateBrollSegment(i, "start", Number(e.target.value))
                        }
                        className="h-7 w-16 px-1.5 text-[11px]"
                        aria-label="B-roll start (seconds)"
                      />
                      <span className="text-muted-foreground">→</span>
                      <Input
                        type="number"
                        min={0}
                        step={0.5}
                        value={seg.end}
                        onChange={(e) => updateBrollSegment(i, "end", Number(e.target.value))}
                        className="h-7 w-16 px-1.5 text-[11px]"
                        aria-label="B-roll end (seconds)"
                      />
                      <span className="text-[10px] text-muted-foreground">sec</span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="ml-auto h-6 w-6 text-muted-foreground hover:text-destructive"
                        aria-label="Remove B-roll scene"
                        onClick={() => removeBrollSegment(i)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Search */}
              <div className="space-y-2 border-t pt-3">
                <form
                  className="flex gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    searchBroll(brollQuery);
                  }}
                >
                  <Input
                    value={brollQuery}
                    onChange={(e) => setBrollQuery(e.target.value)}
                    placeholder="Search stock footage…"
                    className="h-8 text-xs"
                  />
                <Button type="submit" size="icon" variant="outline" className="h-8 w-8 shrink-0" disabled={brollSearching}>
                  {brollSearching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 shrink-0"
                  title="Upload your own MP4 (max 20 MB)"
                  aria-label="Upload MP4 B-roll"
                  onClick={() => brollFileRef.current?.click()}
                  disabled={brollUploading}
                >
                  {brollUploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                </Button>
                <input
                  ref={brollFileRef}
                  type="file"
                  accept="video/mp4,.mp4"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) useUploadedBroll(file);
                  }}
                />
                </form>
                <div className="flex flex-wrap gap-1">
                  {BROLL_CATEGORIES.map((cat) => (
                    <button
                      key={cat.label}
                      type="button"
                      onClick={() => {
                        setBrollQuery(cat.q);
                        searchBroll(cat.q);
                      }}
                      className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary-500/60 hover:text-primary-500"
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
                {brollResults && brollResults.length > 0 && (
                  <div className="grid max-h-56 grid-cols-3 gap-1.5 overflow-y-auto pr-1">
                    {brollResults.map((r, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => addBrollSegment(r)}
                        className="group relative aspect-[9/16] overflow-hidden rounded-md border bg-muted"
                        title="Add as B-roll scene"
                      >
                        {r.poster ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={r.poster}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <span className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
                            clip
                          </span>
                        )}
                        <span className="absolute inset-0 hidden items-center justify-center bg-black/50 group-hover:flex">
                          <Plus className="h-5 w-5 text-white" />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={generateBroll}
                  disabled={brollBusy}
                >
                  {brollBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  AI pick · {AI_CREDIT_COST} credits
                </Button>
                {clip.broll_json != null && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => setBrollMode("auto")}
                      disabled={brollBusy}
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Auto
                    </Button>
                    {brollSegments.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-muted-foreground"
                        onClick={() => setBrollMode("none")}
                        disabled={brollBusy}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Off
                      </Button>
                    )}
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Music */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <Music2 className="h-4 w-4 text-primary-500" /> Background music
              </p>

              {/* The track the AI picked — name + playable preview */}
              {aiPickedTrack && (
                <div className="flex items-center gap-2 rounded-md border border-primary-500/50 bg-primary-500/5 px-2 py-1.5">
                  <button
                    type="button"
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors hover:border-primary-500/60 hover:text-primary-500",
                      previewingId === AI_PICKED_ID && "border-primary-500 text-primary-500"
                    )}
                    aria-label={previewingId === AI_PICKED_ID ? "Pause preview" : "Play preview"}
                    onClick={() =>
                      togglePreview({
                        id: AI_PICKED_ID,
                        name: aiPickedTrack.name,
                        artist: aiPickedTrack.artist,
                        duration: 0,
                        audio: aiPickedTrack.audio,
                        image: null,
                      })
                    }
                  >
                    {previewingId === AI_PICKED_ID ? (
                      <Pause className="h-3 w-3" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{aiPickedTrack.name}</p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {aiPickedTrack.artist} · {aiPickedTrack.mood}
                    </p>
                  </div>
                  <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary-500" />
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {project?.music_title
                  ? `${project.music_title} · ${project.music_artist ?? ""}${
                      project.music_mood ? ` (${project.music_mood})` : ""
                    }`
                  : "No background music yet."}
              </p>

              <div className="flex flex-wrap gap-1">
                {MUSIC_MOODS.map((mood) => (
                  <button
                    key={mood}
                    type="button"
                    onClick={() => {
                      setMusicMood(mood);
                      setMusicQuery("");
                      fetchMusic(mood, "");
                    }}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] capitalize text-muted-foreground transition-colors hover:border-primary-500/60 hover:text-primary-500",
                      musicMood === mood && "border-primary-500 text-primary-500"
                    )}
                  >
                    {mood}
                  </button>
                ))}
              </div>

              <form
                className="flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  fetchMusic(musicMood, musicQuery);
                }}
              >
                <Input
                  value={musicQuery}
                  onChange={(e) => setMusicQuery(e.target.value)}
                  placeholder="Search music…"
                  className="h-8 text-xs"
                />
                <Button type="submit" size="icon" variant="outline" className="h-8 w-8 shrink-0" disabled={musicLoading}>
                  {musicLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                </Button>
              </form>

              {musicTracks && musicTracks.length > 0 && (
                <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                  {musicTracks.map((track) => (
                    <div
                      key={track.id}
                      className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                    >
                      <button
                        type="button"
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors hover:border-primary-500/60 hover:text-primary-500",
                          previewingId === track.id && "border-primary-500 text-primary-500"
                        )}
                        aria-label={previewingId === track.id ? "Pause preview" : "Play preview"}
                        onClick={() => togglePreview(track)}
                      >
                        {previewingId === track.id ? (
                          <Pause className="h-3 w-3" />
                        ) : (
                          <Play className="h-3 w-3" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">{track.name}</p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {track.artist} · {formatTime(track.duration)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 shrink-0 px-2 text-[10px]"
                        onClick={() => useTrack(track, musicMood)}
                      >
                        Use
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={generateMusic}
                  disabled={musicBusy}
                >
                  {musicBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  AI pick · {AI_CREDIT_COST} credits
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => musicFileRef.current?.click()}
                  disabled={musicUploading}
                >
                  {musicUploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  Upload MP3
                </Button>
                <input
                  ref={musicFileRef}
                  type="file"
                  accept="audio/mpeg,.mp3"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) useUploadedMusic(file);
                  }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Music applies to the whole project on the next re-render. Uploads:
                MP3 only, max 20 MB.
              </p>
            </CardContent>
          </Card>

        </div>
      </div>
    </Reveal>
  );
}
