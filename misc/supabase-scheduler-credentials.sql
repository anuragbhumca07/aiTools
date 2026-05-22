-- ── Scheduler Credentials Table ──────────────────────────────────────────────
-- Run this in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/dhdzftmlrkuwcsgmgihe/sql

create table if not exists public.scheduler_credentials (
  user_id    uuid references auth.users(id) on delete cascade,
  platform   text not null,
  config_json jsonb not null default '{}'::jsonb,
  updated_at  timestamptz default now(),
  primary key (user_id, platform)
);

-- Enable Row Level Security (users can only see/edit their own credentials)
alter table public.scheduler_credentials enable row level security;

drop policy if exists "Users manage own scheduler credentials" on public.scheduler_credentials;
create policy "Users manage own scheduler credentials"
  on public.scheduler_credentials
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
