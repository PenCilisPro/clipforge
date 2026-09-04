-- ============================================================
-- ClipForge — clip length prefs, music, b-roll support, branding,
-- feedback replies/attachments
-- Run in Supabase Dashboard → SQL Editor, or `supabase db push`
-- ============================================================

-- Project-level render preferences
alter table public.projects
  add column if not exists clip_length_pref text not null default 'ai_optimized',
  add column if not exists music_url text,
  add column if not exists music_title text,
  add column if not exists music_artist text,
  add column if not exists music_mood text;

do $$
begin
  alter table public.projects
    add constraint projects_clip_length_check
    check (clip_length_pref in ('10-14', '15-30', '31-45', '60+', 'ai_optimized'));
exception when duplicate_object then null;
end $$;

-- Manual caption overrides from the clip editor
alter table public.clips add column if not exists srt_override text;

-- Feedback: optional contact email, screenshot, admin response
alter table public.feedback
  add column if not exists contact_email text,
  add column if not exists screenshot_path text,
  add column if not exists admin_reply text,
  add column if not exists admin_replied_at timestamptz;

-- App branding (custom logo/favicon uploaded by an admin)
create table if not exists public.app_branding (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_branding enable row level security;

drop policy if exists "branding_public_read" on public.app_branding;
create policy "branding_public_read" on public.app_branding
  for select using (true);
