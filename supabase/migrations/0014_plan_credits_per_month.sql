-- Monthly credit allotments per plan (editable from the admin Pricing tab)
-- plus per-user refill tracking.
alter table public.pricing_plans
  add column if not exists credits_per_month int not null default 0;

update public.pricing_plans set credits_per_month = 360 where plan_key = 'free';
update public.pricing_plans set credits_per_month = 2000 where plan_key = 'pro';
update public.pricing_plans set credits_per_month = 3000 where plan_key = 'business';

alter table public.profiles
  add column if not exists credits_refreshed_at timestamptz;
