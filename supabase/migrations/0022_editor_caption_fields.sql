-- 0022: editor caption fields that never had a migration
--
-- The clip editor has been posting these columns with every save
-- (backend/src/routes/clips.js editSchema accepts them and writes them into
-- the UPDATE), but no migration ever created them. On any database built
-- purely from the migration files, the UPDATE failed with
-- "column clips.caption_x of relation clips does not exist" (Postgres 42703)
-- and the WHOLE save came back as "Failed to save clip" — nothing from the
-- last edit persisted: not the drag position, not the zoom, not the caption
-- look. This is the "it won't save the configurations from last edit" bug.
--
-- Column-by-column (defaults match what the editor and the render spec use):
--   caption_anim           — editor Animation picker id; editor/preview and
--                            render.js both fall back to 'pop'.
--   caption_words          — "words per screen" regroup size (0 = off).
--   caption_width          — caption wrap width as % of canvas (default 90).
--   caption_letter_spacing — letter spacing as % of font size (default 0).
--   caption_word_spacing   — extra literal spaces between words (default 0).
--   caption_x/caption_y    — custom drag anchor, % of canvas, block CENTER
--                            (the editor's translate(-50%,-50%) point). NULL
--                            = never dragged → the renderer uses the
--                            top/middle/bottom preset alignment.
--
-- video_scale/video_x/video_y live in 0021_video_zoom_pan.sql; text_overlays
-- in 0020. Run 0020, 0021 and 0022 in order if the database predates them.

alter table public.clips add column if not exists caption_anim text not null default 'pop';
alter table public.clips add column if not exists caption_words int not null default 0;
alter table public.clips add column if not exists caption_width int not null default 90;
alter table public.clips add column if not exists caption_letter_spacing int not null default 0;
alter table public.clips add column if not exists caption_word_spacing int not null default 0;
alter table public.clips add column if not exists caption_x numeric;
alter table public.clips add column if not exists caption_y numeric;
