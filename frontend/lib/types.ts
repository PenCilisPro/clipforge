export type Plan = "free" | "pro" | "business";

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  plan: Plan;
  credits_remaining: number;
  theme_preference: string;
  created_at: string;
}

export type ProjectStatus = "pending" | "processing" | "done" | "failed";

export interface Project {
  id: string;
  user_id: string;
  title: string | null;
  source_url: string | null;
  source_type: "url" | "upload";
  original_video_path: string | null;
  duration_seconds: number | null;
  transcript_json: { transcript?: string; words?: TranscriptWord[] } | null;
  status: ProjectStatus;
  error_message: string | null;
  created_at: string;
  clip_length_pref?: string;
  music_url?: string | null;
  music_storage_path?: string | null;
  music_title?: string | null;
  music_artist?: string | null;
  music_mood?: string | null;
  clips?: Clip[];
}

export type ClipStatus = "queued" | "rendering" | "ready" | "failed";

export interface Clip {
  id: string;
  project_id: string;
  user_id: string;
  title: string | null;
  hook_text: string | null;
  start_time: number;
  end_time: number;
  virality_score: number | null;
  reason: string | null;
  hashtags: string[];
  caption_style: "classic" | "karaoke" | "bold-pop" | "neon" | "meme";
  caption_stroke: boolean;
  caption_shadow: boolean;
  caption_stroke_color: string;
  caption_stroke_size: number;
  caption_shadow_color: string;
  caption_shadow_size: number;
  caption_font:
    | "anton"
    | "bebas-neue"
    | "archivo-black"
    | "poppins"
    | "bangers"
    | "luckiest-guy"
    | "titan-one"
    | "russo-one"
    | "righteous"
    | "permanent-marker";
  srt_override: string | null;
  /** null = AI-planned at render, [] = explicitly off, otherwise [{start,end,src}] */
  broll_json: { start: number; end: number; src: string }[] | null;
  raw_clip_path: string | null;
  srt_path: string | null;
  storage_path: string | null;
  thumbnail_path: string | null;
  shotstack_render_id: string | null;
  status: ClipStatus;
  error_message: string | null;
  created_at: string;
}

export type JobType = "download" | "transcribe" | "analyze" | "render" | "publish";
export type JobStatus = "queued" | "active" | "completed" | "failed";

export interface Job {
  id: string;
  project_id: string | null;
  clip_id: string | null;
  job_type: JobType;
  status: JobStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export type Platform = "youtube" | "instagram" | "tiktok" | "facebook";
export type ScheduledStatus = "scheduled" | "publishing" | "published" | "failed" | "canceled";

export interface ScheduledPost {
  id: string;
  user_id: string;
  clip_id: string;
  platform: Platform;
  caption_text: string | null;
  scheduled_time_utc: string;
  status: ScheduledStatus;
  external_post_id: string | null;
  error_message: string | null;
  created_at: string;
  clips?: { title: string | null } | null;
}

export interface SocialConnection {
  id: string;
  user_id: string;
  platform: Platform;
  platform_account_id: string | null;
  platform_username: string | null;
  connected_at: string;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export const PIPELINE_STAGES: { key: JobType; label: string }[] = [
  { key: "download", label: "Downloading video" },
  { key: "transcribe", label: "Transcribing audio" },
  { key: "analyze", label: "AI finding viral moments" },
  { key: "render", label: "Rendering clips" },
];

export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: "YouTube Shorts",
  instagram: "Instagram Reels",
  tiktok: "TikTok",
  facebook: "Facebook Reels",
};

export const CAPTION_STYLES: { key: Clip["caption_style"]; label: string; description: string }[] = [
  { key: "classic", label: "Classic", description: "Clean white captions" },
  { key: "karaoke", label: "Karaoke", description: "White captions on brand-orange box" },
  { key: "bold-pop", label: "Bold Pop", description: "Big uppercase captions on dark boxes" },
  { key: "neon", label: "Neon", description: "Glowing cyan captions on dark slabs" },
  { key: "meme", label: "Meme", description: "Heavy uppercase captions on black chips" },
];

export const CAPTION_FONTS: {
  key: NonNullable<Clip["caption_font"]>;
  label: string;
  cssVar: string;
}[] = [
  { key: "anton", label: "Anton", cssVar: "var(--font-caption-anton)" },
  { key: "bebas-neue", label: "Bebas Neue", cssVar: "var(--font-caption-bebas)" },
  { key: "archivo-black", label: "Archivo Black", cssVar: "var(--font-caption-archivo)" },
  { key: "poppins", label: "Poppins Bold", cssVar: "var(--font-caption-poppins)" },
  { key: "bangers", label: "Bangers", cssVar: "var(--font-caption-bangers)" },
  { key: "luckiest-guy", label: "Luckiest Guy", cssVar: "var(--font-caption-luckiest)" },
  { key: "titan-one", label: "Titan One", cssVar: "var(--font-caption-titan)" },
  { key: "russo-one", label: "Russo One", cssVar: "var(--font-caption-russo)" },
  { key: "righteous", label: "Righteous", cssVar: "var(--font-caption-righteous)" },
  { key: "permanent-marker", label: "Permanent Marker", cssVar: "var(--font-caption-marker)" },
];
