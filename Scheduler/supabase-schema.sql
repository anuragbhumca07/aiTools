-- Run this in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/dhdzftmlrkuwcsgmgihe/sql

-- User credentials (platform API keys, encrypted JSON)
create table if not exists public.user_credentials (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users(id) on delete cascade not null,
  platform    text not null,
  config_json text not null,
  updated_at  timestamptz default now(),
  unique (user_id, platform)
);
alter table public.user_credentials enable row level security;
create policy "own credentials" on public.user_credentials for all using (auth.uid() = user_id);

-- Schedules
create table if not exists public.schedules (
  id           bigserial primary key,
  user_id      uuid references auth.users(id) on delete cascade not null,
  name         text not null,
  category     text not null,
  subcategory  text not null,
  format       text not null default '16:9',
  freq_type    text not null,
  freq_value   text,
  run_time     text not null default '09:00',
  run_day      int not null default 1,
  cron_expr    text not null,
  platforms    text not null default '[]',
  active       boolean not null default true,
  created_at   timestamptz default now(),
  last_run     timestamptz,
  next_run     timestamptz,
  total_runs   int not null default 0,
  total_errors int not null default 0
);
alter table public.schedules enable row level security;
create policy "own schedules" on public.schedules for all using (auth.uid() = user_id);

-- Jobs
create table if not exists public.jobs (
  id          bigserial primary key,
  schedule_id bigint references public.schedules(id) on delete cascade not null,
  user_id     uuid references auth.users(id) on delete cascade not null,
  status      text not null default 'running',
  video_url   text,
  question    text,
  options     text,
  correct_idx int,
  error       text,
  created_at  timestamptz default now()
);
alter table public.jobs enable row level security;
create policy "own jobs" on public.jobs for all using (auth.uid() = user_id);

-- Postings
create table if not exists public.postings (
  id         bigserial primary key,
  job_id     bigint references public.jobs(id) on delete cascade not null,
  platform   text not null,
  status     text not null default 'pending',
  post_url   text,
  error      text,
  created_at timestamptz default now()
);
alter table public.postings enable row level security;
create policy "own postings" on public.postings for all
  using (exists (select 1 from public.jobs j where j.id = job_id and j.user_id = auth.uid()));
