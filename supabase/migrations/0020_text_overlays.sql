-- 0020: Clip editor text overlays ("+ Add text")
--
-- text_overlays: jsonb array of editor-placed standalone text blocks —
--   [{ id, text, font, x, y, size, width, color, bold, bg }]
-- x/y are % of canvas (block center, matching the caption drag anchor),
-- size is font px on the output canvas (same model as caption_size),
-- width is the wrap width as % of canvas, bg toggles the caption-style box.
-- The worker passes them to the local/Modal ASS renderer, which draws them
-- with the caption mechanics (Layer 1, above captions).

alter table public.clips add column if not exists text_overlays jsonb;
