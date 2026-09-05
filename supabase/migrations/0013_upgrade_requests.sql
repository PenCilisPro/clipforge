-- Free-upgrade requests: users apply for a complimentary Pro subscription;
-- admins review and approve/reject from the admin page.
create table public.upgrade_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone_country text not null,
  phone_number text not null,
  header text not null,
  plan_use text not null,
  other_info text,
  attachment_path text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  admin_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.upgrade_requests enable row level security;

create policy upgrade_requests_user_select
  on public.upgrade_requests for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy upgrade_requests_user_insert
  on public.upgrade_requests for insert
  to authenticated
  with check ((select auth.uid()) = user_id);
