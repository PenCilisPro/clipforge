-- ============================================================
-- ClipForge — feedback
-- Run in Supabase Dashboard → SQL Editor, or `supabase db push`
-- ============================================================

create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid (),
  user_id    uuid not null references auth.users (id) on delete cascade,
  message    text not null check (char_length(message) between 1 and 4000),
  created_at timestamptz not null default now()
);

comment on table public.feedback is 'Free-form user feedback, surfaced on the admin page.';

create index if not exists feedback_created_idx on public.feedback (created_at desc);

alter table public.feedback enable row level security;

drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own" on public.feedback
  for insert to authenticated
  with check (auth.uid () = user_id);

drop policy if exists "feedback_select_own" on public.feedback;
create policy "feedback_select_own" on public.feedback
  for select to authenticated
  using (auth.uid () = user_id);
