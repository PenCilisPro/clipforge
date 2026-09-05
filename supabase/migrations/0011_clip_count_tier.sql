-- 0011: user-chosen clip count tier per project (gated by plan/admin in the backend)
alter table public.projects add column if not exists clip_count_tier text not null default '1-5';
alter table public.projects add constraint clip_count_tier_check
  check (clip_count_tier in ('1-5', '6-10', '11-15'));
