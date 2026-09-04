-- ============================================================
-- ClipForge — editable pricing plans (admin-managed)
-- Run in Supabase Dashboard → SQL Editor, or `supabase db push`
-- ============================================================

create table if not exists public.pricing_plans (
  plan_key      text primary key check (plan_key in ('free', 'pro', 'business')),
  name          text not null,
  tagline       text not null default '',
  monthly_price numeric not null default 0,
  annual_price  numeric not null default 0,
  credits_label text not null default '',
  features      text[] not null default '{}',
  cta_label     text not null default 'Get started',
  highlighted   boolean not null default false,
  sort_order    int not null default 0,
  updated_at    timestamptz not null default now()
);

comment on table public.pricing_plans is 'Pricing page content, editable from the admin page. plan_key maps to profiles.plan; name/features/price are display values.';

create trigger pricing_plans_touch_updated_at
  before update on public.pricing_plans
  for each row execute function public.touch_updated_at ();

alter table public.pricing_plans enable row level security;

-- The landing page reads this anonymously; writes go through the backend's
-- service-role key (admin-gated) and bypass RLS.
drop policy if exists "pricing_public_read" on public.pricing_plans;
create policy "pricing_public_read" on public.pricing_plans
  for select using (true);

insert into public.pricing_plans
  (plan_key, name, tagline, monthly_price, annual_price, credits_label, features, cta_label, highlighted, sort_order)
values
  ('free', 'Free', 'For trying things out', 0, 0,
   '60 upload minutes / month',
   array[
     'Up to 3 clips per video',
     '3 caption style presets',
     'ClipForge watermark on clips',
     'Download clips as MP4',
     'Community support'
   ],
   'Start Free', false, 0),
  ('pro', 'Pro', 'For serious creators', 29, 23,
   '600 upload minutes / month',
   array[
     'Up to 10 clips per video',
     'All caption styles + logo watermark',
     'No watermark on exports',
     'Multi-platform scheduling',
     'Priority cloud rendering',
     'Email support'
   ],
   'Get Pro', true, 1),
  ('business', 'Business', 'For teams & agencies', 99, 79,
   '3,000 upload minutes / month',
   array[
     'Everything in Pro',
     '5 team seats',
     'API access + webhooks',
     'Custom brand kit presets',
     'Social publishing for all platforms',
     'Dedicated support'
   ],
   'Get Business', false, 2)
on conflict (plan_key) do nothing;
