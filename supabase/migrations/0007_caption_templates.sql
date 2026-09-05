-- 0007: caption templates + expanded font set
-- Extends clips.caption_style with the two new templates (neon, meme) and
-- clips.caption_font with six new caption fonts. Existing values are kept so
-- old clips keep rendering.

alter table public.clips drop constraint if exists clips_caption_style_check;
alter table public.clips
  add constraint clips_caption_style_check
  check (caption_style in ('classic', 'karaoke', 'bold-pop', 'neon', 'meme'));

alter table public.clips drop constraint if exists clips_caption_font_check;
alter table public.clips
  add constraint clips_caption_font_check
  check (caption_font in (
    'anton', 'bebas-neue', 'archivo-black', 'poppins',
    'bangers', 'luckiest-guy', 'titan-one', 'russo-one', 'righteous',
    'permanent-marker'
  ));
