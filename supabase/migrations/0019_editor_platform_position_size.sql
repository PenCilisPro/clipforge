-- 0019: StreamPal-style clip editor — caption position/size + output aspect
--
-- caption_position: vertical placement of the caption block on the canvas.
-- caption_size:     explicit caption font size in px (0 = template default).
-- output_aspect:    target canvas — 9:16 (TikTok/Shorts), 16:9 (X/Twitter),
--                   1:1 (Square). All render providers read these from the
--                   clip row via the render spec.

alter table public.clips add column if not exists caption_position text not null default 'bottom';
alter table public.clips drop constraint if exists clips_caption_position_check;
alter table public.clips
  add constraint clips_caption_position_check
  check (caption_position in ('top', 'middle', 'bottom'));

alter table public.clips add column if not exists caption_size int not null default 0;

alter table public.clips add column if not exists output_aspect text not null default '9:16';
alter table public.clips drop constraint if exists clips_output_aspect_check;
alter table public.clips
  add constraint clips_output_aspect_check
  check (output_aspect in ('9:16', '16:9', '1:1'));
