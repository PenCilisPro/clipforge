-- 0008: editor b-roll + AI credit spending
-- clips.broll_json: null = auto-plan at render, [] = explicitly off,
-- [{start,end,src}] = a plan generated from the clip editor.
alter table public.clips add column if not exists broll_json jsonb;

-- Atomic credit spend: returns the new balance, or nothing when the user
-- can't afford it (caller treats an empty result as 402).
create or replace function public.deduct_credits(p_user_id uuid, p_amount integer)
returns integer
language sql
as $$
  update public.profiles
     set credits_remaining = credits_remaining - p_amount
   where id = p_user_id
     and credits_remaining >= p_amount
  returning credits_remaining;
$$;
