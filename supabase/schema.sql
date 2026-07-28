-- ===========================================================================
--  Learner's Byte — Supabase schema (v3)
--  Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--
--  FRESH INSTALLS ONLY. If you already have data, run
--  supabase/migration-batches.sql instead — it upgrades in place and keeps
--  your students and attendance.
-- ===========================================================================

drop view  if exists public.exam_overview               cascade;
drop view  if exists public.attendance_log              cascade;
drop view  if exists public.student_attendance_summary  cascade;
drop table if exists public.exam_questions              cascade;
drop table if exists public.exams                       cascade;
drop table if exists public.password_resets             cascade;
drop table if exists public.attendance                  cascade;
drop table if exists public.users                       cascade;
drop table if exists public.batches                     cascade;

-- ---------------------------------------------------------------- batches
-- Created and edited by teachers only. A batch owns the timetable; students
-- just pick one, so there is a single source of truth for class times.

create table public.batches (
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

create unique index batches_name_key on public.batches (lower(name));

-- ------------------------------------------------------------------ users
-- Students AND admins live here, separated by `role`. Passwords are stored as
-- scrypt hashes (salt + parameters embedded) — never in plain text.
-- The grace period is a fixed 15 minutes in code, so it is not a column.

create sequence if not exists user_reg_seq start 1;

create table public.users (
  id             uuid primary key default gen_random_uuid(),
  reg_no         text not null unique
                   default 'UD' || lpad(nextval('user_reg_seq')::text, 4, '0'),
  email          text not null,
  password_hash  text not null,
  role           text not null default 'student' check (role in ('student', 'admin')),

  name           text not null default '',
  phone          text not null default '',
  batch_id       uuid references public.batches (id) on delete set null,

  extra          jsonb not null default '{}'::jsonb,   -- room for future fields
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  last_login_at  timestamptz
);

create unique index users_email_key on public.users (lower(email));
create index users_role_idx     on public.users (role);
create index users_batch_id_idx on public.users (batch_id);

-- ------------------------------------------------------------- attendance
-- One row per student per day. "absent" is normally derived (no row = absent)
-- but can also be written explicitly by a teacher override.

create table public.attendance (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  attend_date date not null,
  status      text not null check (status in ('present', 'late', 'absent')),
  marked_at   timestamptz not null default now(),
  source      text not null default 'self' check (source in ('self', 'admin')),
  ip          text,
  note        text,
  -- A student can be marked at most once per day. Double-clicks, refreshes
  -- and two open tabs can never produce a second row.
  unique (user_id, attend_date)
);

create index attendance_user_idx on public.attendance (user_id, attend_date desc);
create index attendance_date_idx on public.attendance (attend_date desc);

-- -------------------------------------------------------- password resets
-- Only the SHA-256 hash of the reset token is stored, so a leaked table row
-- cannot be used to take over an account.

create table public.password_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index password_resets_user_idx on public.password_resets (user_id, created_at desc);

-- ------------------------------------------------------------------ exams
create table public.exams (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid not null references public.batches (id) on delete cascade,
  title                text not null default '',
  exam_date            date not null,
  start_time           time not null,
  total_questions      integer not null check (total_questions > 0 and total_questions <= 200),
  total_marks          numeric(8,2) not null check (total_marks > 0),
  seconds_per_question integer not null default 60 check (seconds_per_question > 0),
  question_mode        text not null default 'both' check (question_mode in ('fill', 'mcq', 'both')),
  source               text not null default 'manual' check (source in ('manual', 'upload')),
  source_filename      text,
  status               text not null default 'draft' check (status in ('draft', 'published')),
  created_by           uuid references public.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz
);

create index exams_batch_idx on public.exams (batch_id, exam_date desc);
create index exams_date_idx  on public.exams (exam_date desc);

create table public.exam_questions (
  id             uuid primary key default gen_random_uuid(),
  exam_id        uuid not null references public.exams (id) on delete cascade,
  position       integer not null check (position > 0),
  type           text not null check (type in ('fill', 'mcq')),
  question_text  text not null,
  options        jsonb not null default '[]'::jsonb,
  correct_answer text not null default '',
  marks          numeric(6,2) not null default 1 check (marks >= 0),
  seconds        integer,
  created_at     timestamptz not null default now(),
  unique (exam_id, position)
);

create index exam_questions_exam_idx on public.exam_questions (exam_id, position);

-- ------------------------------------------------------------------ views
create view public.exam_overview as
select
  e.id, e.title, e.exam_date, e.start_time, e.total_questions, e.total_marks,
  e.seconds_per_question, e.question_mode, e.source, e.status, e.created_at,
  b.id as batch_id, b.name as batch_name, b.course,
  (select count(*) from public.exam_questions q where q.exam_id = e.id) as questions_added
from public.exams e
join public.batches b on b.id = e.batch_id;

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

-- ================================================================ SECURITY
-- RLS is ON with NO policies, so the anon/public key can read and write
-- nothing. Every request goes through the Node server, which uses the
-- service_role key and enforces login + role checks itself.

alter table public.batches         enable row level security;
alter table public.users           enable row level security;
alter table public.attendance      enable row level security;
alter table public.password_resets enable row level security;
alter table public.exams           enable row level security;
alter table public.exam_questions  enable row level security;
