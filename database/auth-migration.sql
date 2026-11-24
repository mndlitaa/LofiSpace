-- Run this once in Supabase SQL Editor for an existing LofiSpace database.
-- It links Supabase Auth accounts to the existing numeric users table without
-- changing task, journal, soundtrack, or focus-session IDs.
alter table public.users
  add column if not exists auth_user_id uuid references auth.users(id) on delete cascade;
alter table public.users
  add column if not exists avatar_frame text not null default 'sunny';
create unique index if not exists idx_users_auth_user_id_unique
  on public.users(auth_user_id);
