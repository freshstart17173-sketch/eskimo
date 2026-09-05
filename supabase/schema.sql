-- Eskimo Studio — Supabase schema
--
-- One table, one row per (anonymous) user: the whole app already keeps a
-- single JSON blob in localStorage (songs/edges/session/venueName), so the
-- cloud copy mirrors that shape exactly rather than normalizing into
-- separate songs/edges tables. That keeps Store.pullRemote/pushRemote in
-- index.html a couple of lines instead of a real backend.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query) after creating your project. See TODO.md -> "Your tasks" for the
-- rest of the setup (getting the URL/anon key, enabling anonymous auth).

create table if not exists public.library (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.library enable row level security;

-- Each user (anonymous or not) can only ever read/write their own row.
create policy "read own library" on public.library
  for select using (auth.uid() = user_id);

create policy "insert own library" on public.library
  for insert with check (auth.uid() = user_id);

create policy "update own library" on public.library
  for update using (auth.uid() = user_id);

-- Anonymous sign-ins must be turned on for this to work at all (there's no
-- login screen yet — see TODO.md): Project Settings -> Authentication ->
-- Providers -> Anonymous Sign-Ins -> Enable.
