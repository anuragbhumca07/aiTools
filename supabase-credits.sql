-- Run this in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/dhdzftmlrkuwcsgmgihe/sql

-- User credits table
create table if not exists public.user_credits (
  user_id    uuid references auth.users(id) on delete cascade primary key,
  balance    integer not null default 1000,
  updated_at timestamptz default now()
);
alter table public.user_credits enable row level security;
create policy "users can view own credits"  on public.user_credits for select using (auth.uid() = user_id);
create policy "users can update own credits" on public.user_credits for update using (auth.uid() = user_id);

-- Auto-create 1000 credits on new user signup
create or replace function public.handle_new_user_credits()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_credits (user_id, balance)
  values (new.id, 1000)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_credits on auth.users;
create trigger on_auth_user_created_credits
  after insert on auth.users
  for each row execute procedure public.handle_new_user_credits();

-- Atomic credit deduction function (prevents negative balance)
create or replace function public.deduct_credit(amount integer default 10)
returns integer language plpgsql security definer as $$
declare new_balance integer;
begin
  -- Ensure the user has a credits row (handles existing users)
  insert into public.user_credits (user_id, balance)
  values (auth.uid(), 1000)
  on conflict (user_id) do nothing;

  update public.user_credits
  set balance = balance - amount, updated_at = now()
  where user_id = auth.uid() and balance >= amount
  returning balance into new_balance;

  if not found then
    raise exception 'Insufficient credits';
  end if;

  return new_balance;
end;
$$;

-- Initialize credits for all existing users who don't have a record yet
insert into public.user_credits (user_id, balance)
select id, 1000 from auth.users
on conflict (user_id) do nothing;
