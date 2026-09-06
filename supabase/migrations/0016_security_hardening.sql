-- ============================================================
-- ClipForge — security hardening
-- Run in Supabase Dashboard → SQL Editor (or `supabase db push`).
--
-- 1. profiles: authenticated users may only edit non-privileged profile
--    columns (plan / credits_remaining were client-writable before).
-- 2. clips.user_id must match the owning project's user_id — blocks
--    inserting a clip that points at someone else's project.
-- 3. scheduled_posts.clip_id must reference the user's own clip — blocks
--    publishing someone else's clip to your own social account.
--
-- The backend/worker use the service-role key (bypassrls + full grants),
-- so all legit flows keep working. Direct client writes to the five data
-- tables are revoked; clients keep SELECT (dashboard + realtime) and the
-- backend API remains the only write path. The settings page writes
-- display_name/avatar_url directly, so those columns stay granted.
-- ============================================================

-- ------------------------------------------------------------
-- 1. profiles — lock privileged columns away from client-side writes
-- ------------------------------------------------------------
revoke update on table public.profiles from authenticated;
grant update (display_name, avatar_url, theme_preference)
  on table public.profiles to authenticated;

-- ------------------------------------------------------------
-- 2. Direct client writes to data tables are revoked. Row policies
--    stay in place for SELECT (dashboard reads + realtime). Writes go
--    through the backend API (service role) only.
-- ------------------------------------------------------------
revoke insert, update, delete on table public.projects           from authenticated;
revoke insert, update, delete on table public.clips              from authenticated;
revoke insert, update, delete on table public.jobs               from authenticated;
revoke insert, update, delete on table public.scheduled_posts    from authenticated;
revoke insert, update, delete on table public.social_connections from authenticated;

-- ------------------------------------------------------------
-- 3. Integrity triggers (apply to every role, so they also catch
--    backend bugs). With invoker rights, an authenticated caller that
--    cannot SELECT the parent row gets NULL — treated as a violation.
-- ------------------------------------------------------------
create or replace function public.enforce_clip_owner_matches_project ()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from (
    select p.user_id from public.projects p where p.id = new.project_id
  ) then
    raise exception 'clip.user_id must match the owning project''s user_id';
  end if;
  return new;
end;
$$;

drop trigger if exists clips_owner_matches_project on public.clips;
create trigger clips_owner_matches_project
  before insert or update of project_id, user_id on public.clips
  for each row execute function public.enforce_clip_owner_matches_project ();

create or replace function public.enforce_scheduled_post_own_clip ()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from (
    select c.user_id from public.clips c where c.id = new.clip_id
  ) then
    raise exception 'scheduled_posts.clip_id must reference the user''s own clip';
  end if;
  return new;
end;
$$;

drop trigger if exists scheduled_posts_own_clip on public.scheduled_posts;
create trigger scheduled_posts_own_clip
  before insert or update of clip_id, user_id on public.scheduled_posts
  for each row execute function public.enforce_scheduled_post_own_clip ();
