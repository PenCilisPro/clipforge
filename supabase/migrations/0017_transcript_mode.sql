-- ============================================================
-- ClipForge — transcript-only project mode
-- Run in Supabase Dashboard → SQL Editor (or `supabase db push`).
--
-- project_mode = 'clips' (default: full pipeline, existing behavior)
--             | 'transcript'   (download → transcribe → done; no AI
--                               analysis, no clip rows, no renders)
-- ============================================================

alter table public.projects
  add column if not exists project_mode text not null default 'clips';

-- Existing rows already got the default; add the check constraint separately
-- so re-runs are safe (DO block swallows the duplicate-object error).
do $$
begin
  alter table public.projects
    add constraint projects_project_mode_check
    check (project_mode in ('clips', 'transcript'));
exception
  when duplicate_object then null;
end $$;
