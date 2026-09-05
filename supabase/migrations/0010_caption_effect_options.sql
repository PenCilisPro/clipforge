-- 0010: user-configurable stroke/shadow color + size (per clip)
alter table public.clips add column if not exists caption_stroke_color text not null default '#000000';
alter table public.clips add column if not exists caption_stroke_size int not null default 4;
alter table public.clips add column if not exists caption_shadow_color text not null default '#000000';
alter table public.clips add column if not exists caption_shadow_size int not null default 6;
