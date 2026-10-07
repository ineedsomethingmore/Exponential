-- Exponential — Supabase schema.
-- Run this once in the SQL editor of the project. Safe to re-run (idempotent where possible).

create extension if not exists "pgcrypto";

-- ─── People ─────────────────────────────────────────────────────────────────
-- One row per signed-in Google account, mirrored from auth.users by a trigger.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  name text not null default '',
  photo text,
  color text not null default '#5b8def',
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, photo)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  )
  on conflict (id) do update set
    email = excluded.email,
    name = case when excluded.name <> '' then excluded.name else profiles.name end,
    photo = coalesce(excluded.photo, profiles.photo);
  -- Invitations were keyed by email before the person existed; attach them now.
  update public.team_members set user_id = new.id where user_id is null and lower(email) = lower(new.email);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.handle_new_user();

-- ─── Teams ──────────────────────────────────────────────────────────────────
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  icon text,
  retro_fields jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- Membership. `user_id` is null for an invite that hasn't signed in yet.
create table if not exists public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  email text not null,
  user_id uuid references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('moderator', 'member')),
  color text not null default '#5b8def',
  created_at timestamptz not null default now(),
  primary key (team_id, email)
);
create index if not exists team_members_user on public.team_members(user_id);

-- ─── Plan ───────────────────────────────────────────────────────────────────
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  lane int not null default 0,
  color text,
  notes text,
  assignees uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);
create index if not exists projects_team on public.projects(team_id);

create table if not exists public.deadlines (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null,
  date date not null,
  notes text,
  updated_at timestamptz not null default now()
);
create index if not exists deadlines_team on public.deadlines(team_id);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  person_id uuid references public.profiles(id) on delete cascade, -- null = unassigned (project backlog)
  title text not null,
  date date,              -- null = backlog
  end_date date,
  status text not null default 'todo' check (status in ('todo', 'progress', 'review', 'done', 'cancelled')),
  sort_order int not null default 0,
  notes text,
  created_by uuid references public.profiles(id),
  reviewer_id uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_team on public.tasks(team_id);

create table if not exists public.retros (
  team_id uuid not null references public.teams(id) on delete cascade,
  week date not null,     -- the Monday
  answers jsonb not null default '{}',
  notes text,
  updated_at timestamptz not null default now(),
  primary key (team_id, week)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  to_user uuid not null references public.profiles(id) on delete cascade,
  from_user uuid references public.profiles(id),
  kind text not null,
  text text not null,
  ref_kind text not null,
  ref_id uuid not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_to on public.notifications(to_user, read);

-- ─── Helpers for policies ───────────────────────────────────────────────────
create or replace function public.is_member(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members where team_id = t and user_id = auth.uid());
$$;

create or replace function public.is_moderator(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members where team_id = t and user_id = auth.uid() and role = 'moderator');
$$;

-- Creating a team: insert the team and make the caller its first moderator, atomically.
create or replace function public.create_team(team_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  tid uuid;
  me_email text;
begin
  select email into me_email from public.profiles where id = auth.uid();
  if me_email is null then raise exception 'not signed in'; end if;
  insert into public.teams (name, created_by) values (team_name, auth.uid()) returning id into tid;
  insert into public.team_members (team_id, email, user_id, role) values (tid, me_email, auth.uid(), 'moderator');
  return tid;
end $$;

-- ─── Row-level security ─────────────────────────────────────────────────────
alter table public.profiles      enable row level security;
alter table public.teams         enable row level security;
alter table public.team_members  enable row level security;
alter table public.projects      enable row level security;
alter table public.deadlines     enable row level security;
alter table public.tasks         enable row level security;
alter table public.retros        enable row level security;
alter table public.notifications enable row level security;

-- profiles: everyone signed in can read (names/photos of teammates); you edit only yourself
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for update to authenticated using (id = auth.uid());

-- teams: members read; moderators edit; anyone may create (via create_team)
drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams for select to authenticated using (public.is_member(id));
drop policy if exists teams_update on public.teams;
create policy teams_update on public.teams for update to authenticated using (public.is_moderator(id));
drop policy if exists teams_delete on public.teams;
create policy teams_delete on public.teams for delete to authenticated using (public.is_moderator(id));

-- team_members: members see the roster; moderators manage it
drop policy if exists members_read on public.team_members;
create policy members_read on public.team_members for select to authenticated using (public.is_member(team_id));
drop policy if exists members_write on public.team_members;
create policy members_write on public.team_members for all to authenticated
  using (public.is_moderator(team_id)) with check (public.is_moderator(team_id));

-- plan data: any member may read and write within their team
do $$
declare t text;
begin
  foreach t in array array['projects', 'deadlines', 'tasks', 'retros'] loop
    execute format('drop policy if exists %I_member on public.%I', t, t);
    execute format('create policy %I_member on public.%I for all to authenticated using (public.is_member(team_id)) with check (public.is_member(team_id))', t, t);
  end loop;
end $$;

-- notifications: any member may create one for a teammate; you see and manage your own,
-- and the sender may amend/retract what they sent (undo/redo re-sends the same row)
drop policy if exists notif_read on public.notifications;
create policy notif_read on public.notifications for select to authenticated using (to_user = auth.uid() or from_user = auth.uid());
drop policy if exists notif_insert on public.notifications;
create policy notif_insert on public.notifications for insert to authenticated with check (public.is_member(team_id));
drop policy if exists notif_update on public.notifications;
create policy notif_update on public.notifications for update to authenticated using (to_user = auth.uid() or from_user = auth.uid());
drop policy if exists notif_delete on public.notifications;
create policy notif_delete on public.notifications for delete to authenticated using (to_user = auth.uid() or from_user = auth.uid());

-- ─── Realtime ───────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['teams', 'team_members', 'projects', 'deadlines', 'tasks', 'retros', 'notifications', 'profiles'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- updated_at maintenance
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['projects', 'deadlines', 'tasks', 'retros'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;
-- Creates the caller's profile row if the sign-up trigger didn't (e.g. the user existed before the schema).
create or replace function public.ensure_profile()
returns void language plpgsql security definer set search_path = public as $$
declare u record;
begin
  select id, email, raw_user_meta_data into u from auth.users where id = auth.uid();
  if u.id is null then raise exception 'not signed in'; end if;
  insert into public.profiles (id, email, name, photo)
  values (
    u.id,
    lower(u.email),
    coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)),
    coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
  )
  on conflict (id) do nothing;
  update public.team_members set user_id = u.id where user_id is null and lower(email) = lower(u.email);
end $$;
-- When someone is invited by email and already has an account, link the membership immediately.
create or replace function public.attach_member()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is null then
    select id into new.user_id from public.profiles where lower(email) = lower(new.email);
  end if;
  new.email = lower(new.email);
  return new;
end $$;

drop trigger if exists team_members_attach on public.team_members;
create trigger team_members_attach before insert on public.team_members
  for each row execute function public.attach_member();
-- Tasks can come from a project's to-do list or be subtasks of another task.
alter table public.tasks add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.tasks add column if not exists parent_id uuid references public.tasks(id) on delete set null;
create index if not exists tasks_project on public.tasks(project_id);
create index if not exists tasks_parent on public.tasks(parent_id);
-- Project/subtask backlogs hold tasks nobody has taken yet.
alter table public.tasks alter column person_id drop not null;
-- Project groups: a colour and a vertical section in the master plan.
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null,
  color text not null default '#5b8def',
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists groups_team on public.groups(team_id);
alter table public.groups enable row level security;
drop policy if exists groups_member on public.groups;
create policy groups_member on public.groups for all to authenticated using (public.is_member(team_id)) with check (public.is_member(team_id));
alter table public.projects add column if not exists group_id uuid references public.groups(id) on delete set null;
do $$ begin
  execute 'alter publication supabase_realtime add table public.groups';
exception when duplicate_object then null; end $$;
-- 009: The retro template (objective, key results, health checks) lives on the team.
alter table public.teams add column if not exists retro_template jsonb;
-- 012: Per-team feature switches (Team settings → Features); absent = chat+meetings on, crm auto.
alter table public.teams add column if not exists features jsonb;
-- 008: Soft deletion — deleted projects/tasks keep their row for 7 days ("Recently deleted").
alter table public.projects add column if not exists deleted_at timestamptz;
alter table public.tasks add column if not exists deleted_at timestamptz;
-- 007: The reviewer's "Completed" verdict lives on the task; the task itself returns to In progress.
alter table public.tasks add column if not exists review_done boolean not null default false;
-- 006: Realtime DELETE events normally carry only the old primary key, so subscriptions filtered on
-- team_id (or to_user) never receive them and deletions don't propagate live. Full replica identity
-- puts the whole old row in the event, letting the filters match.
do $$
declare t text;
begin
  foreach t in array array['projects', 'deadlines', 'tasks', 'retros', 'team_members', 'groups', 'notifications'] loop
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;
