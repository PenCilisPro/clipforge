-- ============================================================
-- ClipForge — user uploads (music/b-roll) + plan credit amounts
-- Run in Supabase Dashboard → SQL Editor, or `supabase db push`
-- ============================================================

-- ------------------------------------------------------------
-- 1. New plan credit amounts (monthly allotments)
-- ------------------------------------------------------------
update public.pricing_plans set credits_per_month = 600  where plan_key = 'free';
update public.pricing_plans set credits_per_month = 3000 where plan_key = 'pro';
update public.pricing_plans set credits_per_month = 3000 where plan_key = 'business';

-- ------------------------------------------------------------
-- 2. Uploaded music: projects may point at a file in user-uploads
--    instead of a Jamendo URL. music_storage_path wins over music_url.
-- ------------------------------------------------------------
alter table public.projects add column if not exists music_storage_path text;

-- ------------------------------------------------------------
-- 3. Private bucket for user uploads (mp3 music, mp4 b-roll).
--    Objects live under "<auth.uid>/music/..." or "<auth.uid>/broll/...".
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('user-uploads', 'user-uploads', false)
on conflict (id) do nothing;

drop policy if exists "user_uploads_user_insert" on storage.objects;
create policy "user_uploads_user_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'user-uploads' and (storage.foldername (name))[1] = auth.uid ()::text);

drop policy if exists "user_uploads_user_read" on storage.objects;
create policy "user_uploads_user_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'user-uploads' and (storage.foldername (name))[1] = auth.uid ()::text);
