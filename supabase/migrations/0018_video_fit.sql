-- 0018: per-clip 9:16 layout choice — "cover" zooms a landscape (16:9) source
-- to fill the 9:16 canvas (edges cropped); "contain" keeps the whole original
-- frame visible, with the empty space filled by a zoomed-in copy of the video.
-- video_background_blur controls whether that background copy is blurred
-- (off = plain black bars).
alter table public.clips add column if not exists video_fit text not null default 'cover';
alter table public.clips drop constraint if exists clips_video_fit_check;
alter table public.clips
  add constraint clips_video_fit_check
  check (video_fit in ('cover', 'contain'));
alter table public.clips add column if not exists video_background_blur boolean not null default true;

-- Project-level defaults: chosen on the New Project page and seeded onto
-- EVERY clip the project produces (see worker analyze stage).
alter table public.projects add column if not exists video_fit text not null default 'cover';
alter table public.projects add column if not exists video_background_blur boolean not null default true;
