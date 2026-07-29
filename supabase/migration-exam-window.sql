-- Learner's Byte — a fixed finish time and a pass mark for exams.
--
-- Run this in Supabase -> SQL Editor -> New query. Safe to run twice.
--
-- end_time   : the wall-clock time the paper shuts. Until now the finish was
--              worked out from the per-question timer (questions x seconds),
--              which meant the teacher could not simply say "it ends at 11:00".
--              Left null, the old behaviour still applies.
-- pass_marks : the score needed to pass. Left null, no pass or fail is shown.
--
-- Both are in the school's timezone, like every other time in this app.

alter table public.exams
  add column if not exists end_time time;

alter table public.exams
  add column if not exists pass_marks numeric(8,2);

-- A finish before the start would make the paper impossible to sit.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'exams_end_after_start'
  ) then
    alter table public.exams
      add constraint exams_end_after_start
      check (end_time is null or end_time > start_time);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'exams_pass_marks_sane'
  ) then
    alter table public.exams
      add constraint exams_pass_marks_sane
      check (pass_marks is null or (pass_marks >= 0 and pass_marks <= total_marks));
  end if;
end $$;
