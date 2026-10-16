"use client";

/**
 * Music library: browse the Jamendo catalog by mood, preview tracks,
 * and apply a track to any of your projects (free — no AI credits).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Music, Pause, Play, Search } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Track {
  id: string;
  name: string;
  artist: string;
  duration: number;
  audio: string;
  image: string | null;
}

interface ProjectLite {
  id: string;
  title: string | null;
  original_filename?: string | null;
  music_title?: string | null;
}

const MOODS = [
  "upbeat", "chill", "dramatic", "corporate", "energetic", "happy", "epic", "background",
];

export default function MusicPage() {
  const [mood, setMood] = useState("background");
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [targetProject, setTargetProject] = useState<string>("");
  const [applying, setApplying] = useState(false);

  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Load the catalog whenever the mood changes.
  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ configured: boolean; tracks: Track[] }>(
        `/api/music?mood=${encodeURIComponent(mood)}`
      );
      setConfigured(data.configured);
      setTracks(data.tracks);
    } catch {
      toast.error("Couldn't load the music catalog");
      setTracks([]);
    } finally {
      setLoading(false);
    }
  }, [mood]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Load the user's projects for the "apply to" dropdown.
  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<{ project: ProjectLite[] } | ProjectLite[]>("/api/projects");
        // The projects route returns a list (shape may be wrapped); normalize:
        const list = Array.isArray(data) ? data : (data as { project?: ProjectLite[] }).project ?? [];
        setProjects(list as ProjectLite[]);
      } catch {
        // Non-fatal — applying can still fail loudly later.
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tracks ?? [];
    return (tracks ?? []).filter(
      (t) => t.name.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)
    );
  }, [tracks, query]);

  function togglePreview(track: Track) {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    if (playingId === track.id) {
      setPlayingId(null);
      return;
    }
    const audio = new Audio(track.audio);
    audioRef.current = audio;
    audio.play().catch(() => toast.error("Preview failed for this track"));
    setPlayingId(track.id);
    audio.onended = () => setPlayingId(null);
  }

  async function applyToProject(track: Track) {
    if (!targetProject) {
      toast.error("Pick a project first");
      return;
    }
    setApplying(true);
    try {
      await apiFetch(`/api/projects/${targetProject}/music`, {
        method: "POST",
        body: {
          music_url: track.audio,
          music_title: track.name,
          music_artist: track.artist,
          music_mood: mood,
        },
      });
      toast.success(`"${track.name}" applied — re-render the project's clips to hear it`);
      setProjects((prev) =>
        prev.map((p) =>
          p.id === targetProject
            ? { ...p, music_title: track.name }
            : p
        )
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to apply music");
    } finally {
      setApplying(false);
    }
  }

  function fmtDur(s: number) {
    if (!s) return "";
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-500/15 text-primary-300">
          <Music className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Music library</h1>
          <p className="text-xs text-zinc-500">
            Free-to-use background music by Jamendo artists (Creative Commons).
          </p>
        </div>
      </div>

      {/* Mood chips */}
      <div className="flex flex-wrap gap-2">
        {MOODS.map((m) => (
          <button
            key={m}
            onClick={() => setMood(m)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-xs font-medium capitalize transition-colors",
              mood === m
                ? "border-primary-500 bg-primary-500/15 text-primary-200"
                : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/25 hover:text-zinc-200"
            )}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tracks or artists…"
          className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-2 pl-9 pr-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-primary-500/60"
        />
      </div>

      {/* Tracks */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          <span className="ml-3">Loading catalog…</span>
        </div>
      ) : !configured ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 text-center text-sm text-zinc-400">
          The music catalog isn&apos;t configured yet (Jamendo client id missing).
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 text-center text-sm text-zinc-400">
          No tracks match — try another mood or search term.
        </div>
      ) : (
        <div className="grid gap-3">
          {filtered.map((track) => (
            <div
              key={track.id}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 transition-colors hover:border-white/20"
            >
              {track.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={track.image} alt="" className="h-12 w-12 rounded-lg object-cover" />
              ) : (
                <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-white/5 text-zinc-500">
                  <Music className="h-5 w-5" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-100">{track.name}</p>
                <p className="truncate text-xs text-zinc-500">
                  {track.artist}
                  {track.duration ? ` · ${fmtDur(track.duration)}` : ""}
                </p>
              </div>
              <button
                onClick={() => togglePreview(track)}
                aria-label={playingId === track.id ? "Stop preview" : "Preview track"}
                className="rounded-full border border-white/10 bg-white/5 p-2 text-zinc-200 hover:bg-white/10"
              >
                {playingId === track.id ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </button>
              <button
                onClick={() => void applyToProject(track)}
                disabled={applying || !targetProject}
                title={targetProject ? "Apply to selected project" : "Pick a project first"}
                className="rounded-full bg-white px-3.5 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Apply target */}
      <div className="sticky bottom-0 flex items-center gap-3 rounded-xl border border-white/10 bg-[#161619] p-4">
        <span className="text-xs text-zinc-400">Apply to project:</span>
        <select
          value={targetProject}
          onChange={(e) => setTargetProject(e.target.value)}
          className="flex-1 rounded-lg border border-white/10 bg-[#101013] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-primary-500/60"
        >
          <option value="">Choose a project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || p.original_filename || p.id.slice(0, 8)}
              {p.music_title ? ` — current: ${p.music_title}` : ""}
            </option>
          ))}
        </select>
        <p className="hidden text-[10px] text-zinc-600 sm:block">
          Applies instantly · re-render clips to hear the new track
        </p>
      </div>
    </div>
  );
}