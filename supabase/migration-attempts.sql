-- ===========================================================================
--  Migration: students sit exams
--  Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--  Safe to run more than once. Nothing existing is touched.
-- ===========================================================================

-- Instructions shown to students before they press Start.
alter table public.exams add column if not exists instructions text not null default '';

-- ---------------------------------------------------------- exam attempts
-- One attempt per student per exam, enforced by the unique constraint below,
-- so a refresh or a second tab can never start a second sitting.

create table if not exists public.exam_attempts (
  id                uuid primary key default gen_random_uuid(),
  exam_id           uuid not null references public.exams (id) on delete cascade,
  user_id           uuid not null references public.users (id) on delete cascade,
  status            text not null default 'in_progress' check (status in ('in_progress', 'submitted')),
  started_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  score             numeric(8,2) not null default 0,
  total_marks       numeric(8,2) not null default 0,
  correct_count     integer not null default 0,
  wrong_count       integer not null default 0,
  unanswered_count  integer not null default 0,
  question_count    integer not null default 0,
  unique (exam_id, user_id)
);

create index if not exists exam_attempts_exam_idx on public.exam_attempts (exam_id, score desc);
create index if not exists exam_attempts_user_idx on public.exam_attempts (user_id, started_at desc);

-- ----------------------------------------------------------- exam answers
-- `locked` is set when the question's timer runs out. A locked row is never
-- updated again, so a student cannot come back and change it.

create table if not exists public.exam_answers (
  id             uuid primary key default gen_random_uuid(),
  attempt_id     uuid not null references public.exam_attempts (id) on delete cascade,
  question_id    uuid not null references public.exam_questions (id) on delete cascade,
  answer         text not null default '',
  locked         boolean not null default false,
  is_correct     boolean,
  marks_awarded  numeric(6,2) not null default 0,
  answered_at    timestamptz not null default now(),
  unique (attempt_id, question_id)
);

create index if not exists exam_answers_attempt_idx on public.exam_answers (attempt_id);

-- ------------------------------------------------------------------ views
create or replace view public.exam_results as
select
  a.id as attempt_id, a.status, a.started_at, a.submitted_at,
  a.score, a.total_marks, a.correct_count, a.wrong_count,
  a.unanswered_count, a.question_count,
  case when a.total_marks = 0 then 0
       else round(a.score * 100 / a.total_marks, 1) end as percent,
  e.id as exam_id, e.title as exam_title, e.exam_date, e.start_time,
  u.id as user_id, u.reg_no, u.name, u.email,
  b.id as batch_id, b.name as batch_name
from public.exam_attempts a
join public.exams e on e.id = a.exam_id
join public.users u on u.id = a.user_id
left join public.batches b on b.id = u.batch_id;

-- ================================================================ SECURITY
alter table public.exam_attempts enable row level security;
alter table public.exam_answers  enable row level security;
