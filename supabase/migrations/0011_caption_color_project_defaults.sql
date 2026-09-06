-- ============================================================
-- ClipForge — caption text color + project-level caption defaults
-- Run in Supabase Dashboard → SQL Editor, or `supabase db push`
-- ============================================================

-- Per-clip caption text color. '#ffffff' means "template default"
-- (light-on-dark templates are white, light-background ones stay dark).
alter table public.clips add column if not exists caption_color text not null default '#ffffff';

-- Project-level caption defaults: chosen once on the New Project page and
-- seeded onto EVERY clip the project produces (see worker analyze stage).
alter table public.projects add column if not exists caption_style text not null default 'karaoke';
alter table public.projects add column if not exists caption_font text not null default 'anton';
alter table public.projects add column if not exists caption_color text not null default '#ffffff';
alter table public.projects add column if not exists caption_stroke boolean not null default false;
alter table public.projects add column if not exists caption_stroke_color text not null default '#000000';
alter table public.projects add column if not exists caption_stroke_size int not null default 4;
alter table public.projects add column if not exists caption_shadow boolean not null default false;
alter table public.projects add column if not exists caption_shadow_color text not null default '#000000';
alter table public.projects add column if not exists caption_shadow_size int not null default 6;

-- Six new caption templates (11 total) and six new fonts (16 total).
alter table public.clips drop constraint if exists clips_caption_style_check;
alter table public.clips
  add constraint clips_caption_style_check
  check (caption_style in (
    'classic', 'karaoke', 'bold-pop', 'neon', 'meme',
    'green-screen', 'highlighter', 'ocean', 'bubblegum', 'royal', 'minimal-mono'
  ));

alter table public.clips drop constraint if exists clips_caption_font_check;
alter table public.clips
  add constraint clips_caption_font_check
  check (caption_font in (
    'anton', 'bebas-neue', 'archivo-black', 'poppins', 'bangers', 'luckiest-guy',
    'titan-one', 'russo-one', 'righteous', 'permanent-marker',
    'lato', 'bungee', 'alfa-slab-one', 'black-ops-one', 'pacifico', 'lobster'
  ));
