-- ===========================================================================
--  Migration: exams
--  Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--  Safe to run more than once. Nothing existing is touched.
-- ===========================================================================

-- ------------------------------------------------------------------ exams
create table if not exists public.exams (
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

create index if not exists exams_batch_idx on public.exams (batch_id, exam_date desc);
create index if not exists exams_date_idx  on public.exams (exam_date desc);

-- -------------------------------------------------------- exam questions
-- `options` holds [{ "key": "A", "text": "…" }, …] for multiple choice and is
-- an empty array for fill-in-the-blank.

create table if not exists public.exam_questions (
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

create index if not exists exam_questions_exam_idx on public.exam_questions (exam_id, position);

-- ------------------------------------------------------------------ view
create or replace view public.exam_overview as
select
  e.id, e.title, e.exam_date, e.start_time, e.total_questions, e.total_marks,
  e.seconds_per_question, e.question_mode, e.source, e.status, e.created_at,
  b.id as batch_id, b.name as batch_name, b.course,
  (select count(*) from public.exam_questions q where q.exam_id = e.id) as questions_added
from public.exams e
join public.batches b on b.id = e.batch_id;

-- ================================================================ SECURITY
alter table public.exams          enable row level security;
alter table public.exam_questions enable row level security;
