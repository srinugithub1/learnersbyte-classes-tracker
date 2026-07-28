-- ===========================================================================
--  Migration: filling in attendance from before students signed up
--  Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--  Safe to run more than once. Nothing existing is touched.
--
--  Classes began before the portal did. Attendance was previously counted from
--  the day a student created their account, so anything recorded for an earlier
--  date was stored but never appeared in a report. These two dates fix that.
-- ===========================================================================

-- When this course actually began. Used as the default date when a teacher
-- fills in past attendance, so they are not typing it every time.
alter table public.batches
  add column if not exists start_date date;

-- The first day THIS student is accountable for.
--
-- Null means "from the day they signed up", which is right for someone who
-- joins mid-course. Set it to the course start date for students who were
-- attending before the portal existed, and their earlier class days will be
-- counted — including the ones they missed.
alter table public.users
  add column if not exists attendance_from date;

comment on column public.users.attendance_from is
  'First day this student is counted from. Null = their sign-up date.';

comment on column public.batches.start_date is
  'The day this course began. Default for back-filling past attendance.';
