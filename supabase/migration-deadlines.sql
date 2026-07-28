-- ===========================================================================
--  Migration: the server keeps the per-question clock
--  Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--  Safe to run more than once. Nothing existing is touched.
--
--  Until now the countdown lived in the student's browser, and the browser told
--  the server when to lock a question. Anyone who paused that countdown in
--  DevTools kept the question open indefinitely. From here the server stamps
--  the moment a question is opened and works out the deadline itself, so the
--  browser's timer is only a display.
-- ===========================================================================

-- When the student first saw this question. The deadline is this instant plus
-- the exam's seconds_per_question, measured on the database clock.
alter table public.exam_answers
  add column if not exists opened_at timestamptz;

-- Existing in-flight rows have no open time. Treat the moment they were
-- answered as the moment they were opened; they are already locked or will be
-- graded on submit either way.
update public.exam_answers
   set opened_at = answered_at
 where opened_at is null;

comment on column public.exam_answers.opened_at is
  'Server-stamped moment the question was served. Deadline = opened_at + exams.seconds_per_question.';
