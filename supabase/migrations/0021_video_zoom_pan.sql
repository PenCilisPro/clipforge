-- 0021: CapCut-style frame zoom & pan (editor "Frame" tab)
--
-- The clip editor already previews video_scale/video_x/video_y and posts them
-- with every edit save, but the backend schema had no such fields — zod
-- stripped them, so the settings were silently dropped: re-opening the editor
-- reset the zoom to 100% and the final render never zoomed at all.
--
--   video_scale — zoom as % of the fitted frame (100 = untouched, 50-300),
--                 applied about the canvas center, exactly like the editor's
--                 `scale(videoScale/100)` transform.
--   video_x/y   — pan offset as % of the output canvas (-50..50), mirroring
--                 `translate(videoX%, videoY%)`. NOT multiplied by the zoom,
--                 same as the CSS transform. The local/Modal renderer clamps
--                 the pan to what the zoomed frame can actually show (the
--                 editor's videoMaxPan: ±(zoom-100)/2 % while zoomed in).
-- Captions and text overlays burn AFTER this transform, so text stays put —
-- the editor's overlay layer sits outside the transformed video element too.

alter table public.clips add column if not exists video_scale numeric not null default 100;
alter table public.clips add column if not exists video_x numeric not null default 0;
alter table public.clips add column if not exists video_y numeric not null default 0;
