-- ============================================================
-- ClipForge — caption fonts (HTML caption rendering)
-- Run in Supabase Dashboard → SQL Editor, or `supabase db push`
-- ============================================================

alter table public.clips add column if not exists caption_font text not null default 'anton';

do $$
begin
  alter table public.clips
    add constraint clips_caption_font_check
    check (caption_font in ('anton', 'bebas-neue', 'archivo-black', 'poppins'));
exception when duplicate_object then null;
end $$;
