-- ===========================================================================
--  Migration: batches become teacher-managed, students only pick one.
--  Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--  Safe to run more than once. Existing students and attendance are KEPT.
--
--  What changes:
--    * new `batches` table — name, course, class times, class days
--    * each student now points at a batch (users.batch_id) instead of
--      carrying their own copy of the timetable
--    * any batch already typed in by a student is turned into a real batch
--      row first, so nobody loses their schedule
--    * the grace period is now a fixed 15 minutes in code, so the per-user
--      column goes away
-- ===========================================================================

-- ---------------------------------------------------------------- batches
create table if not exists public.batches (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  course       text not null default '',
  class_start  time not null,
  class_end    time not null,
  class_days   smallint[] not null default '{1,2,3,4,5}',   -- 0=Sun … 6=Sat
  is_active    boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  constraint batches_time_order check (class_end > class_start)
);

create unique index if not exists batches_name_key on public.batches (lower(name));

alter table public.batches enable row level security;

-- ------------------------------------------------- link students to batches
alter table public.users add column if not exists batch_id uuid;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'users_batch_id_fkey' and table_name = 'users'
  ) then
    alter table public.users
      add constraint users_batch_id_fkey
      foreign key (batch_id) references public.batches (id) on delete set null;
  end if;
end $$;

create index if not exists users_batch_id_idx on public.users (batch_id);

-- --------------------------------------------------------------- backfill
-- Turn every timetable a student already had into a real batch row, then
-- point that student at it. Runs only while the old columns still exist.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'batch'
  ) then

    insert into public.batches (name, course, class_start, class_end, class_days)
    select distinct on (lower(u.batch))
           u.batch,
           coalesce(u.course, ''),
           u.class_start,
           u.class_end,
           coalesce(u.class_days, '{1,2,3,4,5}')
    from public.users u
    where coalesce(u.batch, '') <> ''
      and u.class_start is not null
      and u.class_end is not null
      and u.class_end > u.class_start
    order by lower(u.batch), u.created_at
    on conflict do nothing;

    update public.users u
       set batch_id = b.id
      from public.batches b
     where u.batch_id is null
       and lower(coalesce(u.batch, '')) = lower(b.name);

  end if;
end $$;

-- ------------------------------------------------- retire the old columns
-- The old views read users.batch / users.course, so they have to go first —
-- Postgres refuses to drop a column anything still depends on. They are
-- recreated against the new shape at the bottom of this file.
drop view if exists public.student_attendance_summary cascade;
drop view if exists public.attendance_log            cascade;

-- The timetable now lives on the batch, so keeping per-user copies would mean
-- two sources of truth that can drift apart.
alter table public.users drop column if exists batch;
alter table public.users drop column if exists course;
alter table public.users drop column if exists class_start;
alter table public.users drop column if exists class_end;
alter table public.users drop column if exists class_days;
alter table public.users drop column if exists grace_minutes;
alter table public.users drop column if exists profile_completed;

-- ------------------------------------------------------------------ views
-- Rebuilt against the new shape: batch details now come from the join.
create view public.student_attendance_summary as
select
  u.id as user_id, u.reg_no, u.name, u.email,
  b.name as batch, b.course,
  count(a.id) filter (where a.status = 'present') as present,
  count(a.id) filter (where a.status = 'late')    as late,
  count(a.id) filter (where a.status = 'absent')  as absent_marked,
  count(a.id) filter (where a.status in ('present', 'late')) as attended,
  count(a.id) as days_recorded,
  case when count(a.id) = 0 then 0
       else round(count(a.id) filter (where a.status in ('present','late'))::numeric
                  * 100 / count(a.id), 1) end as percent,
  max(a.marked_at) as last_seen
from public.users u
left join public.batches b on b.id = u.batch_id
left join public.attendance a on a.user_id = u.id
where u.role = 'student'
group by u.id, u.reg_no, u.name, u.email, b.name, b.course;

create view public.attendance_log as
select
  a.id, a.attend_date, a.status, a.marked_at, a.source, a.ip,
  u.id as user_id, u.reg_no, u.name, u.email,
  b.name as batch, b.course
from public.attendance a
join public.users u on u.id = a.user_id
left join public.batches b on b.id = u.batch_id;
