-- 0016: project-level AI B-roll toggle (new project page).
-- true = auto-plan B-roll with AI at render time (previous behavior),
-- false = render without B-roll unless the clip has an editor plan.
alter table public.projects
  add column if not exists broll_enabled boolean not null default true;
