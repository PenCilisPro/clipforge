-- 0009: caption stroke + shadow toggles (per clip)
alter table public.clips add column if not exists caption_stroke boolean not null default false;
alter table public.clips add column if not exists caption_shadow boolean not null default false;
