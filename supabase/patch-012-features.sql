-- Patch 012: per-team feature switches (Team settings → Features).
-- {"chat": bool, "meetings": bool, "crm": bool}; an absent key keeps the default
-- (chat + meetings on, crm automatic once the team has CRM rows).
-- Additive only: old clients select teams.* and ignore the extra column.
alter table public.teams add column if not exists features jsonb;
