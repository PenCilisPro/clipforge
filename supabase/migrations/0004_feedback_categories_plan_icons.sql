-- ============================================================
-- ClipForge — feedback categories + ratings, pricing plan icons
-- Run in Supabase Dashboard → SQL Editor, or `supabase db push`
-- ============================================================

alter table public.feedback
  add column if not exists category text not null default 'general',
  add column if not exists rating int;

-- Scope the check to non-null values so legacy rows (NULL category is
-- impossible thanks to the default, NULL rating stays allowed).
do $$
begin
  alter table public.feedback
    add constraint feedback_category_check
    check (category in ('general', 'bug_report', 'feature_request', 'billing'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.feedback
    add constraint feedback_rating_check
    check (rating between 1 and 5);
exception when duplicate_object then null;
end $$;

create index if not exists feedback_category_idx on public.feedback (category, created_at desc);

-- Icon shown on the pricing card (lucide icon name, rendered client-side).
alter table public.pricing_plans add column if not exists icon text not null default 'sparkles';
