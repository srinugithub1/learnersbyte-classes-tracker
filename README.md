# Learner's Byte — Online Attendance & Exam Portal

Two portals, one Supabase database:

- **Student portal** — sign up, log in, set your class details once, then click
  one button each day to mark attendance. See your own report with charts.
- **Teacher (admin) portal** — full access to every student and every record:
  create, edit, delete, override any day's status, and export everything.

Present / Late / Absent are decided automatically from each student's own class
time. Zero npm dependencies (Node 18+).

## Setup

**1. Create the tables.** Supabase Dashboard → **SQL Editor → New query** →
paste all of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
Safe to run more than once.

**2. Add credentials.**

```bash
cp .env.example .env
```

Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (Project Settings → API →
**service_role** secret, not the anon key), plus `ADMIN_EMAIL` /
`ADMIN_PASSWORD` for the first teacher account. `.env` is git-ignored.

**3. Run.**

```bash
node server.js         # http://localhost:3000
```

The first start creates the admin account from `.env`. Students create their own
accounts from the sign-up tab.

## How attendance is decided

Each student sets their class start time, end time, class days and a grace
period. From then on the button decides the status by the clock:

```
 opens 30 min before start ─┬─ up to start + grace ─────► PRESENT
                            ├─ after grace, before end ─► LATE
                            └─ after class end ─────────► closed; day is ABSENT
```

- A day with **no record is absent** — but only on that student's class days,
  and only from the day they joined. Weekends, non-class days and dates before
  sign-up are never counted against anyone.
- **One record per student per day**, enforced by a database unique constraint —
  double clicks and two open tabs cannot produce a second row.
- Class details are **locked after the student saves them**, so nobody can move
  their own class time to dodge a late mark. Teachers can edit them any time.

All times use the **server's local timezone** — run the server in the same
timezone as your classes.

## Forgot password

Requesting a reset creates a single-use token (SHA-256 hashed in the database,
valid one hour). No mail server is configured, so the link is **printed to the
server console** and shown on screen in local use; pending requests are listed
in the Teacher portal. To email it instead, send `resetUrl` from
`POST /api/auth/forgot` in [server.js](server.js) — that is the only line to change.

Set `SHOW_RESET_LINK=false` in `.env` to stop showing the link on-page.

## Security

- Passwords are **scrypt hashes** with a per-password random salt; parameters
  travel with the hash. Plain text is never stored or returned.
- Sessions are **HMAC-signed HttpOnly cookies** (`SameSite=Lax`), so they can't
  be read by JavaScript, forged, or replayed cross-site.
- Row Level Security is **on with no policies** — the anon key can read and
  write nothing. Every request goes through the server, which checks the session
  and role itself.
- Login and forgot-password give the **same answer whether or not the account
  exists**, so neither can be used to discover who has an account.

## Database

| Table | Holds |
| --- | --- |
| `users` | students and admins (`role`), profile, class schedule, password hash |
| `attendance` | one row per student per day: status, timestamp, source, IP |
| `password_resets` | hashed single-use reset tokens with expiry |

Views `student_attendance_summary` and `attendance_log` are available for
querying directly in the Supabase dashboard.

Adding a field later needs no migration for per-student extras — `users.extra`
is a JSONB column.

## Tests

```bash
node test/logic.test.js    # passwords, sessions, class timing, report maths
node test/e2e.test.js      # full flow against a running server + live database
```

The e2e run creates `e2e-…@example.test` accounts and deletes them afterwards.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | HTTP API and routing |
| `store.js` | all Supabase access (PostgREST over `fetch`) |
| `auth.js` | password hashing, session cookies, reset tokens |
| `schedule.js` | class-time rules and report aggregation |
| `env.js` | minimal `.env` loader |
| `public/index.html` | login / sign up / forgot password |
| `public/student.html` + `student.js` | student portal |
| `public/admin.html` + `admin.js` | teacher portal |
| `public/charts.js` | hand-rolled SVG donut, trend and bar charts |
| `public/common.js` | shared helpers |
| `supabase/schema.sql` | tables, indexes, views, RLS |

## Chart accessibility

Present (green) and absent (red) are only ΔE 4.1 apart under deuteranopia —
effectively identical for red-green colourblind readers. So status is **never
carried by colour alone**: every status shows an icon (`✓` `!` `✕`) and its
label, absent segments carry a diagonal hatch, and every chart has a
**Table** toggle with the same numbers.

## Students on other devices

Run the server, find your PC's LAN IP (`ipconfig`), and share
`http://<your-ip>:3000`. For students at home, use a tunnel (`ngrok http 3000`)
or deploy the server with the same environment variables set.

## Deploying to Vercel

The app runs unchanged locally (`node server.js`) and on Vercel, where it is
serverless — there is no long-running process, so `server.listen()` is never
called. `api/[...path].js` receives every `/api/*` request and hands it to the
same handler; `public/` is served by Vercel's CDN.

1. Push this repo to GitHub.
2. Vercel → **Add New… → Project** → import the repo.
3. Framework preset: **Other**. Leave build and output settings empty — there is
   nothing to build and no dependencies to install.
4. Add these **Environment Variables** (Production, Preview and Development):

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | your project URL |
   | `SUPABASE_SERVICE_KEY` | the **service_role** secret |
   | `TZ` | `Asia/Calcutta` |
   | `APP_TIMEZONE` | `Asia/Calcutta` |
   | `ADMIN_EMAIL` | the first teacher login |
   | `ADMIN_PASSWORD` | a strong password — not the example one |
   | `ADMIN_NAME` | the teacher's name |

5. Deploy, then run any migrations in `supabase/` that have not been applied.

### Why `TZ` matters

Class times, the fixed 15-minute grace period and exam windows are all worked
out on the server's own clock. Every cloud host defaults to UTC, which would put
a 10:00 class at 15:30 and mark half the students absent — silently, and
plausibly enough that nobody would notice for days. The server therefore checks
its timezone at startup and **refuses to run** if it disagrees with
`APP_TIMEZONE`, rather than being quietly wrong. `Asia/Kolkata` is accepted as
the same clock.

### A note on the Hobby plan

Vercel's free Hobby plan is for **non-commercial** use. Running a school's
attendance system on it is fine while nobody is being charged; if these classes
are a paid service, that needs a Pro plan.
