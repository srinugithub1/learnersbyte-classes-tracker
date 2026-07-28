-- ===========================================================================
--  Migration: makeup exams for students who missed a paper
--  Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--  Safe to run more than once. Nothing existing is touched.
--
--  A makeup is a real second exam, not a reopening of the first. The teacher
--  writes a fresh paper and releases it to named students only, so nobody who
--  already sat the original can see it and nobody can pass the questions on.
-- ===========================================================================

-- ------------------------------------------------------- who an exam is for
-- 'batch'    — everyone in the batch (how every exam has worked so far)
-- 'selected' — only the students listed in exam_participants
alter table public.exams
  add column if not exists audience text not null default 'batch';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'exams_audience_check') then
    alter table public.exams
      add constraint exams_audience_check check (audience in ('batch', 'selected'));
  end if;
end $$;

-- The named students, used only when audience = 'selected'.
create table if not exists public.exam_participants (
  id         uuid primary key default gen_random_uuid(),
  exam_id    uuid not null references public.exams (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete cascade,
  added_by   uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (exam_id, user_id)
);

create index if not exists exam_participants_exam_idx on public.exam_participants (exam_id);
create index if not exists exam_participants_user_idx on public.exam_participants (user_id);

-- --------------------------------------------------------- makeup requests
-- exam_id is the paper the student MISSED. makeup_exam_id, once the teacher
-- has decided, is the replacement paper they were given. One request per
-- student per missed exam, so nobody can ask twice.
create table if not exists public.exam_makeups (
  id             uuid primary key default gen_random_uuid(),
  exam_id        uuid not null references public.exams (id) on delete cascade,
  user_id        uuid not null references public.users (id) on delete cascade,
  makeup_exam_id uuid references public.exams (id) on delete set null,
  reason         text not null default '',
  status         text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected')),
  source         text not null default 'student'
                 check (source in ('student', 'teacher')),
  decision_note  text not null default '',
  decided_by     uuid references public.users (id) on delete set null,
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  unique (exam_id, user_id)
);

create index if not exists exam_makeups_exam_idx   on public.exam_makeups (exam_id);
create index if not exists exam_makeups_user_idx   on public.exam_makeups (user_id, created_at desc);
create index if not exists exam_makeups_status_idx on public.exam_makeups (status, created_at desc);

-- Marks an attempt as a second chance, so reports stay honest about it.
alter table public.exam_attempts
  add column if not exists is_makeup boolean not null default false;

-- ================================================================ SECURITY
alter table public.exam_participants enable row level security;
alter table public.exam_makeups      enable row level security;
