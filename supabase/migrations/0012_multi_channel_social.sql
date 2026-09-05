-- Multiple channels per platform: relax the one-account-per-platform rule and
-- track which connection each scheduled post publishes through.
alter table public.social_connections
  drop constraint if exists social_connections_user_id_platform_key;

alter table public.social_connections
  add constraint social_connections_user_platform_account_key
  unique (user_id, platform, platform_account_id);

alter table public.scheduled_posts
  add column if not exists social_connection_id uuid
  references public.social_connections (id) on delete set null;
