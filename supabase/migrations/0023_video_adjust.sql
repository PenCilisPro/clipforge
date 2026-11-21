-- ============================================================
-- ClipForge — CapCut-style video adjust controls
-- Run in Supabase Dashboard → SQL Editor (or `supabase db push`).
--
-- video_volume      0–2 (1 = unchanged; 0 = muted) — all render providers
-- video_rotate      0 | 90 | 180 | 270 — Local/Modal renderer
-- video_flip        'none' | 'h' | 'v' — Local/Modal renderer
-- video_brightness  -50..50 (maps to eq=brightness=b/100)
-- video_contrast    -50..50 (maps to eq=contrast=1+c/100)
-- video_saturation  -100..100 (maps to eq=saturation=1+s/100)
-- ============================================================

alter table public.clips
  add column if not exists video_volume numeric not null default 1,
  add column if not exists video_rotate int not null default 0,
  add column if not exists video_flip text not null default 'none',
  add column if not exists video_brightness numeric not null default 0,
  add column if not exists video_contrast numeric not null default 0,
  add column if not exists video_saturation numeric not null default 0;

do $$
begin
  alter table public.clips
    add constraint clips_video_volume_check check (video_volume >= 0 and video_volume <= 2);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.clips
    add constraint clips_video_rotate_check check (video_rotate in (0, 90, 180, 270));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.clips
    add constraint clips_video_flip_check check (video_flip in ('none', 'h', 'v'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.clips
    add constraint clips_video_brightness_check check (video_brightness >= -50 and video_brightness <= 50);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.clips
    add constraint clips_video_contrast_check check (video_contrast >= -50 and video_contrast <= 50);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.clips
    add constraint clips_video_saturation_check check (video_saturation >= -100 and video_saturation <= 100);
exception when duplicate_object then null;
end $$;
