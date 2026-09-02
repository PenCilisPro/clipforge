-- ============================================================
-- ClipForge — initial schema
-- Run in Supabase Dashboard → SQL Editor, or `supabase db push`
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- PROFILES — synced from auth.users via trigger
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  email             text,
  display_name      text,
  avatar_url        text,
  plan              text not null default 'free' check (plan in ('free', 'pro', 'business')),
  credits_remaining numeric not null default 60,
  theme_preference  text not null default 'system' check (theme_preference in ('light', 'dark', 'system')),
  created_at        timestamptz not null default now()
);

comment on table public.profiles is 'One row per user, auto-created on signup. credits_remaining = minutes of video that can still be processed.';

create or replace function public.handle_new_user ()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user ();

-- ------------------------------------------------------------
-- PROJECTS — one per source video
-- ------------------------------------------------------------
create table if not exists public.projects (
  id                  uuid primary key default gen_random_uuid (),
  user_id             uuid not null references auth.users (id) on delete cascade,
  title               text,
  source_url          text,
  source_type         text not null default 'url' check (source_type in ('url', 'upload')),
  original_video_path text,
  duration_seconds    numeric,
  transcript_json     jsonb,
  status              text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  error_message       text,
  created_at          timestamptz not null default now()
);

-- ------------------------------------------------------------
-- CLIPS — rendered vertical clips, children of a project
-- ------------------------------------------------------------
create table if not exists public.clips (
  id                  uuid primary key default gen_random_uuid (),
  project_id          uuid not null references public.projects (id) on delete cascade,
  user_id             uuid not null references auth.users (id) on delete cascade,
  title               text,
  hook_text           text,
  start_time          numeric not null default 0,
  end_time            numeric not null default 0,
  virality_score      numeric check (virality_score >= 0 and virality_score <= 100),
  reason              text,
  hashtags            text[] not null default '{}',
  caption_style       text not null default 'karaoke' check (caption_style in ('classic', 'karaoke', 'bold-pop')),
  raw_clip_path       text,
  srt_path            text,
  storage_path        text,
  thumbnail_path      text,
  shotstack_render_id text,
  status              text not null default 'queued' check (status in ('queued', 'rendering', 'ready', 'failed')),
  error_message       text,
  created_at          timestamptz not null default now()
);

-- ------------------------------------------------------------
-- JOBS — pipeline stage tracking (surfaced to the frontend UI)
-- ------------------------------------------------------------
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid (),
  project_id    uuid references public.projects (id) on delete cascade,
  clip_id       uuid references public.clips (id) on delete cascade,
  job_type      text not null check (job_type in ('download', 'transcribe', 'analyze', 'render', 'publish')),
  status        text not null default 'queued' check (status in ('queued', 'active', 'completed', 'failed')),
  error_message text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create or replace function public.touch_updated_at ()
returns trigger language plpgsql as $$
begin
  new.updated_at = now ();
  return new;
end;
$$;

drop trigger if exists jobs_touch_updated_at on public.jobs;
create trigger jobs_touch_updated_at
  before update on public.jobs
  for each row execute function public.touch_updated_at ();

-- ------------------------------------------------------------
-- SCHEDULED_POSTS — delayed social publishing
-- ------------------------------------------------------------
create table if not exists public.scheduled_posts (
  id                 uuid primary key default gen_random_uuid (),
  user_id            uuid not null references auth.users (id) on delete cascade,
  clip_id            uuid not null references public.clips (id) on delete cascade,
  platform           text not null check (platform in ('youtube', 'instagram', 'tiktok', 'facebook')),
  caption_text       text,
  scheduled_time_utc timestamptz not null,
  status             text not null default 'scheduled' check (status in ('scheduled', 'publishing', 'published', 'failed', 'canceled')),
  external_post_id   text,
  error_message      text,
  bullmq_job_id      text,
  created_at         timestamptz not null default now()
);

-- ------------------------------------------------------------
-- SOCIAL_CONNECTIONS — OAuth tokens per platform (encrypted)
-- ------------------------------------------------------------
create table if not exists public.social_connections (
  id                      uuid primary key default gen_random_uuid (),
  user_id                 uuid not null references auth.users (id) on delete cascade,
  platform                text not null check (platform in ('youtube', 'instagram', 'tiktok', 'facebook')),
  access_token_encrypted  text,
  refresh_token_encrypted text,
  token_expires_at        timestamptz,
  platform_account_id     text,
  platform_username       text,
  connected_at            timestamptz not null default now(),
  unique (user_id, platform)
);

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------
create index if not exists projects_user_idx       on public.projects (user_id, created_at desc);
create index if not exists clips_project_idx       on public.clips (project_id);
create index if not exists clips_user_idx          on public.clips (user_id);
create index if not exists jobs_project_idx        on public.jobs (project_id, created_at desc);
create index if not exists scheduled_user_idx      on public.scheduled_posts (user_id, scheduled_time_utc desc);
create index if not exists social_user_idx         on public.social_connections (user_id);

-- ------------------------------------------------------------
-- Row Level Security — users only ever touch their own rows
-- ------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.projects           enable row level security;
alter table public.clips              enable row level security;
alter table public.jobs               enable row level security;
alter table public.scheduled_posts    enable row level security;
alter table public.social_connections enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid () = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid () = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid () = id);

drop policy if exists "projects_user_all" on public.projects;
create policy "projects_user_all" on public.projects
  for all using (auth.uid () = user_id) with check (auth.uid () = user_id);

drop policy if exists "clips_user_all" on public.clips;
create policy "clips_user_all" on public.clips
  for all using (auth.uid () = user_id) with check (auth.uid () = user_id);

drop policy if exists "jobs_user_all" on public.jobs;
create policy "jobs_user_all" on public.jobs
  for all using (
    exists (select 1 from public.projects p where p.id = jobs.project_id and p.user_id = auth.uid ())
  ) with check (
    exists (select 1 from public.projects p where p.id = jobs.project_id and p.user_id = auth.uid ())
  );

drop policy if exists "scheduled_posts_user_all" on public.scheduled_posts;
create policy "scheduled_posts_user_all" on public.scheduled_posts
  for all using (auth.uid () = user_id) with check (auth.uid () = user_id);

drop policy if exists "social_connections_user_all" on public.social_connections;
create policy "social_connections_user_all" on public.social_connections
  for all using (auth.uid () = user_id) with check (auth.uid () = user_id);

-- ------------------------------------------------------------
-- Storage buckets
--   source-videos : private  — raw downloads / uploads
--   clips         : private  — raw trims, SRTs and final renders
--   assets        : public   — thumbnails
-- (The worker + backend use the service-role key and bypass RLS;
--  these policies let the browser client read/write its own folders.)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values
  ('source-videos', 'source-videos', false),
  ('clips',         'clips',         false),
  ('assets',        'assets',        true)
on conflict (id) do nothing;

drop policy if exists "source_videos_user_insert" on storage.objects;
create policy "source_videos_user_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'source-videos' and (storage.foldername (name))[1] = auth.uid ()::text);

drop policy if exists "source_videos_user_read" on storage.objects;
create policy "source_videos_user_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'source-videos' and (storage.foldername (name))[1] = auth.uid ()::text);

drop policy if exists "clips_user_read" on storage.objects;
create policy "clips_user_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'clips' and (storage.foldername (name))[1] = auth.uid ()::text);

drop policy if exists "assets_public_read" on storage.objects;
create policy "assets_public_read" on storage.objects
  for select using (bucket_id = 'assets');

-- ------------------------------------------------------------
-- Realtime — let the dashboard listen to pipeline progress
-- ------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.projects;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.clips;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.jobs;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.scheduled_posts;
exception when duplicate_object then null;
end $$;
