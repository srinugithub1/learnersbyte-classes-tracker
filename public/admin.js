/* Teacher (admin) portal. */

let ME = null;
let OVERVIEW = null;
let STUDENTS = [];
let BATCHES = [];

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GRACE_MINUTES = 15;   // fixed; mirrors schedule.js

/* ------------------------------------------------------------ navigation */

function showView(name) {
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  if (name === 'dashboard') loadOverview();
  if (name === 'batches') loadBatches();
  if (name === 'students') loadStudents();
  if (name === 'exams') { loadExams(); loadMakeups(); }
  if (name === 'reports') loadOverview();
  if (name === 'log') loadLog();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('#logoutBtn').addEventListener('click', logout);

/* ------------------------------------------------------------------ util */

const who = (student) => `
  <div class="who-cell">
    <div class="avatar">${esc(initials(student.name || student.email))}</div>
    <div>
      <b>${esc(student.name || '(no name)')}</b>
      <span>${esc(student.regNo)} · ${esc(student.email)}</span>
    </div>
  </div>`;

const classTime = (s) => (s.batch
  ? `${fmtClock(s.batch.classStart)}–${fmtClock(s.batch.classEnd)}<br><span class="small muted">${esc(daysLabel(s.batch.classDays))}</span>`
  : '<span class="muted">No batch</span>');

const batchLabel = (s) => (s.batch
  ? `${esc(s.batch.name)}<br><span class="small muted">${esc(s.batch.course || '')}</span>`
  : '<span class="pill pending"><span class="ico" aria-hidden="true">○</span>No batch</span>');

/* ---------------------------------------------------------------- paging */
/* Long lists are cut into pages. The rows themselves are already in the
   browser, so paging is pure slicing — no extra request per page. */

const PAGE_SIZE = 25;

function pageSlice(all, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(all.length / size));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  return {
    rows: all.slice(start, start + size),
    page: current,
    pages,
    total: all.length,
    first: all.length ? start + 1 : 0,
    last: Math.min(start + size, all.length),
  };
}

/** Renders the bar; returns '' when everything fits on one page. */
function pagerHTML(slice) {
  if (slice.pages <= 1) return '';
  return `
    <div class="pager">
      <button type="button" class="btn ghost sm" data-page="prev"
        ${slice.page === 1 ? 'disabled' : ''}>‹ Previous</button>
      <span class="small muted">
        ${slice.first}–${slice.last} of ${slice.total} · page ${slice.page} of ${slice.pages}
      </span>
      <button type="button" class="btn ghost sm" data-page="next"
        ${slice.page === slice.pages ? 'disabled' : ''}>Next ›</button>
    </div>`;
}

/** Wires the two buttons inside `root` to a handler taking the new page. */
function wirePager(root, slice, go) {
  $$('[data-page]', root).forEach((b) => {
    b.addEventListener('click', () => {
      go(b.dataset.page === 'next' ? slice.page + 1 : slice.page - 1);
    });
  });
}

/* ============================================================ DASHBOARD = */

function rangeQuery(fromId = 'fromDate', toId = 'toDate') {
  const params = new URLSearchParams();
  const from = $(`#${fromId}`) && $(`#${fromId}`).value;
  const to = $(`#${toId}`) && $(`#${toId}`).value;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return params.toString();
}

async function loadOverview() {
  try {
    const qs = rangeQuery();
    OVERVIEW = await api('/api/admin/overview' + (qs ? `?${qs}` : ''));
    $('#exportBtn').href = '/api/admin/export.csv' + (qs ? `?${qs}` : '');
    $('#exportBtn2').href = '/api/admin/export.csv' + (qs ? `?${qs}` : '');
    renderDashboard();
    renderReports();
    loadResets();
    loadExamScores();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderDashboard() {
  const o = OVERVIEW;
  $('#dashDate').textContent = new Date().toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  $('#dashStats').innerHTML = [
    { label: 'Students', value: o.counts.students, foot: 'registered', tone: '' },
    { label: 'Marked today', value: o.counts.markedToday, foot: `of ${o.counts.students}`, tone: 'good' },
    { label: 'Overall attendance', value: `${o.totals.percent}%`, foot: 'across all class days', tone: o.totals.percent >= 75 ? 'good' : 'warn' },
    { label: 'Below 75%', value: o.counts.atRisk, foot: 'need attention', tone: o.counts.atRisk ? 'bad' : 'good' },
  ].map((s) => `
    <div class="stat ${s.tone}">
      <div class="label">${s.label}</div>
      <div class="value">${s.value}</div>
      <div class="foot">${s.foot}</div>
    </div>`).join('');

  renderTodayTable();
}

let TODAY_PAGE = 1;

function renderTodayTable() {
  const term = ($('#dashSearch').value || '').trim().toLowerCase();
  const matching = OVERVIEW.rows.filter((r) => !term
    || `${r.student.name} ${r.student.email} ${r.student.regNo} ${r.student.batchName}`.toLowerCase().includes(term));

  const slice = pageSlice(matching, TODAY_PAGE);
  TODAY_PAGE = slice.page;
  const rows = slice.rows;

  $('#todayPager').innerHTML = pagerHTML(slice);
  wirePager($('#todayPager'), slice, (p) => { TODAY_PAGE = p; renderTodayTable(); });

  $('#todayTable tbody').innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td>${who(r.student)}</td>
      <td class="small">${batchLabel(r.student)}</td>
      <td class="small">${classTime(r.student)}</td>
      <td>${statusPill(r.today.status)}</td>
      <td class="small">${r.today.markedAt ? fmtTime(r.today.markedAt) : '—'}
        ${r.today.source === 'admin' ? '<br><span class="small muted">by teacher</span>' : ''}</td>
      <td>${meter(r.percent)}</td>
      <td>
        <select data-mark="${r.student.id}" aria-label="Set today's status for ${esc(r.student.name)}">
          <option value="">— set —</option>
          <option value="present" ${r.today.status === 'present' ? 'selected' : ''}>✓ Present</option>
          <option value="late" ${r.today.status === 'late' ? 'selected' : ''}>! Late</option>
          <option value="absent" ${r.today.status === 'absent' ? 'selected' : ''}>✕ Absent</option>
          <option value="clear">Clear record</option>
        </select>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="7" class="table-empty">${term ? 'No student matches that search.' : 'No students have signed up yet.'}</td></tr>`;

  $$('#todayTable [data-mark]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      try {
        await api('/api/admin/attendance', {
          method: 'POST',
          body: { userId: sel.dataset.mark, date: OVERVIEW.today, status: sel.value },
        });
        toast('Attendance updated.', 'ok');
        await loadOverview();
      } catch (err) {
        toast(err.message, 'error');
        sel.value = '';
      }
    });
  });
}
$('#dashSearch').addEventListener('input', () => {
  TODAY_PAGE = 1;               // a new search starts at the top of the results
  if (OVERVIEW) renderTodayTable();
});

/* pending password resets */
async function loadResets() {
  try {
    const { resets } = await api('/api/admin/resets');
    if (!resets.length) { $('#resetSlot').innerHTML = ''; return; }
    $('#resetSlot').innerHTML = `
      <div class="card">
        <header><div><h2>Password reset requests</h2>
          <p>Pass the link to the student — it expires in an hour and works once.</p></div></header>
        <div class="table-wrap"><table>
          <thead><tr><th>Student</th><th>Requested</th><th>Expires</th><th>Reset link</th></tr></thead>
          <tbody>${resets.map((r) => `
            <tr>
              <td>${r.student ? `<b>${esc(r.student.name || r.student.email)}</b><br><span class="small muted">${esc(r.student.email)}</span>` : '—'}</td>
              <td class="small">${fmtDateTime(r.createdAt)}</td>
              <td class="small">${fmtTime(r.expiresAt)}</td>
              <td class="small muted">Sent to the server console when requested</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
  } catch { /* not fatal */ }
}

/* ============================================================== BATCHES = */

async function loadBatches() {
  try {
    const data = await api('/api/admin/batches');
    BATCHES = data.batches;
    renderBatches(data.unassigned);
    fillBatchFilter();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function fillBatchFilter() {
  for (const id of ['#batchFilter', '#backfillBatch']) {
    const sel = $(id);
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = '<option value="">All batches</option>' +
      BATCHES.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
    sel.value = current;
  }
}

function renderBatches(unassigned) {
  $('#batchUnassigned').innerHTML = unassigned
    ? `<div class="alert info">
         <span class="ico" aria-hidden="true">ℹ</span>
         <span><strong>${unassigned} student${unassigned === 1 ? '' : 's'}</strong> ${unassigned === 1 ? 'has' : 'have'}
         not picked a batch yet, so ${unassigned === 1 ? 'their' : 'their'} attendance is not being counted.
         They choose one when they log in, or you can set it from the Students tab.</span>
       </div>`
    : '';

  $('#batchTable tbody').innerHTML = BATCHES.length ? BATCHES.map((b) => `
    <tr>
      <td><b>${esc(b.name)}</b>${b.notes ? `<br><span class="small muted">${esc(b.notes)}</span>` : ''}</td>
      <td class="small">${esc(b.course || '—')}</td>
      <td class="small nowrap">${fmtClock(b.classStart)} – ${fmtClock(b.classEnd)}</td>
      <td class="small">${esc(daysLabel(b.classDays))}</td>
      <td class="tnum">${b.studentCount}</td>
      <td>${b.isActive
        ? '<span class="pill present"><span class="ico" aria-hidden="true">✓</span>Running</span>'
        : '<span class="pill pending"><span class="ico" aria-hidden="true">○</span>Paused</span>'}</td>
      <td class="nowrap"><button class="btn ghost sm" data-editbatch="${b.id}">Edit</button></td>
    </tr>`).join('')
    : `<tr><td colspan="7" class="table-empty">
         No batches yet. Create one so students have something to join.
       </td></tr>`;

  $$('#batchTable [data-editbatch]').forEach((btn) =>
    btn.addEventListener('click', () => batchForm(BATCHES.find((b) => b.id === btn.dataset.editbatch))));
}

/** Create or edit a batch. Pass nothing to create. */
function batchForm(batch = null) {
  const editing = Boolean(batch);
  const value = batch || {
    name: '', course: '', classStart: '10:00', classEnd: '11:00',
    classDays: [1, 2, 3, 4, 5], isActive: true, notes: '',
  };

  modal({
    title: editing ? `Edit ${batch.name}` : 'New batch',
    body: `
      <form id="batchFormEl">
        <div class="row">
          <label class="field"><span>Batch name <i class="req">*</i></span>
            <input type="text" name="name" value="${esc(value.name)}"
                   placeholder="e.g. Morning Batch" maxlength="60" required /></label>
          <label class="field"><span>Course <i class="req">*</i></span>
            <input type="text" name="course" value="${esc(value.course)}"
                   placeholder="e.g. Class 10 Mathematics" maxlength="80" required /></label>
        </div>

        <div class="row" style="margin-top:14px">
          <label class="field"><span>Class starts <i class="req">*</i></span>
            <input type="time" name="classStart" value="${esc(value.classStart)}" required /></label>
          <label class="field"><span>Class ends <i class="req">*</i></span>
            <input type="time" name="classEnd" value="${esc(value.classEnd)}" required /></label>
          <label class="field"><span>Status</span>
            <select name="isActive">
              <option value="true" ${value.isActive ? 'selected' : ''}>Running</option>
              <option value="false" ${!value.isActive ? 'selected' : ''}>Paused (hidden from students)</option>
            </select></label>
        </div>

        <div class="field" style="margin-top:16px"><span>Class days <i class="req">*</i></span>
          ${dayPickerHTML(value.classDays)}</div>

        <label class="field"><span>Notes for students (optional)</span>
          <input type="text" name="notes" value="${esc(value.notes)}"
                 placeholder="e.g. Held on Zoom, link shared on WhatsApp" maxlength="300" /></label>

        <p class="small muted">Students are marked <strong>late ${GRACE_MINUTES} minutes</strong>
        after the start time. That is fixed for every batch.</p>
      </form>`,
    footer: `${editing ? '<button class="btn danger" id="batchDelete" style="margin-right:auto">Delete</button>' : ''}
             <button class="btn ghost" data-close>Cancel</button>
             <button class="btn" id="batchSave">${editing ? 'Save changes' : 'Create batch'}</button>`,
    onMount: (host, close) => {
      $('#batchSave', host).addEventListener('click', async () => {
        const form = $('#batchFormEl', host);
        if (!form.reportValidity()) return;
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = {
          name: data.name,
          course: data.course,
          classStart: data.classStart,
          classEnd: data.classEnd,
          notes: data.notes,
          isActive: data.isActive === 'true',
          classDays: $$('input[name="classDays"]:checked', form).map((i) => Number(i.value)),
        };
        if (!payload.classDays.length) { toast('Pick at least one class day.', 'error'); return; }

        try {
          if (editing) {
            await api('/api/admin/batches/update', { method: 'POST', body: { id: batch.id, ...payload } });
            toast('Batch updated.', 'ok');
          } else {
            await api('/api/admin/batches', { method: 'POST', body: payload });
            toast('Batch created.', 'ok');
          }
          close();
          loadBatches();
          if (!$('#view-dashboard').hidden) loadOverview();
        } catch (err) {
          toast(err.message, 'error');
        }
      });

      const del = $('#batchDelete', host);
      if (del) {
        del.addEventListener('click', async () => {
          const count = batch.studentCount || 0;
          const warning = count
            ? `\n\n${count} student${count === 1 ? '' : 's'} will be left without a batch and will have to pick a new one.`
            : '';
          if (!confirm(`Delete the batch "${batch.name}"?${warning}\n\nAttendance records are kept.`)) return;
          try {
            const res = await api('/api/admin/batches/delete', { method: 'POST', body: { id: batch.id } });
            toast(res.message || 'Batch deleted.', 'ok');
            close();
            loadBatches();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      }
    },
  });
}

$('#addBatchBtn').addEventListener('click', () => batchForm());

/* ============================================================= STUDENTS = */

async function loadStudents() {
  try {
    if (!BATCHES.length) {
      try {
        const data = await api('/api/admin/batches');
        BATCHES = data.batches;
        fillBatchFilter();
      } catch { /* filter stays empty */ }
    }
    const params = new URLSearchParams();
    if ($('#studentSearch').value.trim()) params.set('search', $('#studentSearch').value.trim());
    if ($('#roleFilter').value) params.set('role', $('#roleFilter').value);
    if ($('#batchFilter').value) params.set('batchId', $('#batchFilter').value);
    const { students } = await api('/api/admin/students' + (params.toString() ? `?${params}` : ''));
    STUDENTS = students;
    renderStudents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderStudents() {
  $('#studentTable tbody').innerHTML = STUDENTS.length ? STUDENTS.map((s) => `
    <tr>
      <td class="tnum">${esc(s.regNo)}</td>
      <td>${who(s)}</td>
      <td class="small">${esc(s.phone || '—')}</td>
      <td class="small">${s.role === 'admin' ? '<span class="muted">—</span>' : batchLabel(s)}</td>
      <td class="small">${s.role === 'admin' ? '<span class="muted">—</span>' : classTime(s)}</td>
      <td><span class="pill ${s.role === 'admin' ? 'neutral' : 'neutral'}">${s.role === 'admin' ? 'Teacher' : 'Student'}</span></td>
      <td>${s.isActive
        ? '<span class="pill present"><span class="ico" aria-hidden="true">✓</span>Active</span>'
        : '<span class="pill absent"><span class="ico" aria-hidden="true">✕</span>Disabled</span>'}</td>
      <td class="nowrap">
        <button class="btn ghost sm" data-open="${s.id}">Open</button>
        <button class="btn ghost sm" data-edit="${s.id}">Edit</button>
      </td>
    </tr>`).join('')
    : '<tr><td colspan="8" class="table-empty">No accounts match. Students appear here as they sign up.</td></tr>';

  $$('#studentTable [data-edit]').forEach((b) =>
    b.addEventListener('click', () => editStudent(STUDENTS.find((s) => s.id === b.dataset.edit))));
  $$('#studentTable [data-open]').forEach((b) =>
    b.addEventListener('click', () => openStudent(b.dataset.open)));
}

let searchTimer;
$('#studentSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadStudents, 260);
});
$('#roleFilter').addEventListener('change', loadStudents);
$('#batchFilter').addEventListener('change', loadStudents);

/* ---------------------------------------------------------------- modals */

function modal({ title, body, footer, onMount }) {
  const host = $('#modalSlot');
  host.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header><h2>${esc(title)}</h2><button class="iconbtn" data-close>✕</button></header>
        <div class="body">${body}</div>
        ${footer ? `<footer>${footer}</footer>` : ''}
      </div>
    </div>`;

  const close = () => { host.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $$('[data-close]', host).forEach((b) => b.addEventListener('click', close));
  $('.modal-backdrop', host).addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) close();
  });
  if (onMount) onMount(host, close);
  return close;
}

function dayPickerHTML(selected = []) {
  return `<div class="daypicker">${DAY_LABELS.map((label, i) => `
    <label>
      <input type="checkbox" name="classDays" value="${i}" ${selected.includes(i) ? 'checked' : ''} />
      <span>${label}</span>
    </label>`).join('')}</div>`;
}

/* --------------------------------------------------------- add / edit --- */

$('#addStudentBtn').addEventListener('click', () => {
  modal({
    title: 'Add a person',
    body: `
      <form id="addForm">
        <div class="row">
          <label class="field"><span>Full name <i class="req">*</i></span>
            <input type="text" name="name" maxlength="80" required /></label>
          <label class="field"><span>Role</span>
            <select name="role"><option value="student">Student</option><option value="admin">Teacher (admin)</option></select></label>
        </div>
        <div class="row" style="margin-top:14px">
          <label class="field"><span>Email <i class="req">*</i></span>
            <input type="email" name="email" required /></label>
          <label class="field"><span>Phone</span>
            <input type="tel" name="phone" maxlength="20" /></label>
        </div>
        <label class="field" style="margin-top:14px"><span>Temporary password <i class="req">*</i></span>
          <input type="text" name="password" placeholder="At least 8 characters, one letter and one number" required /></label>
        <p class="small muted">Share this password with them — they can change it after logging in.
        They will set their own batch, course and class time on first login.</p>
      </form>`,
    footer: `<button class="btn ghost" data-close>Cancel</button>
             <button class="btn" id="addSave">Create account</button>`,
    onMount: (host, close) => {
      $('#addSave', host).addEventListener('click', async () => {
        const form = $('#addForm', host);
        if (!form.reportValidity()) return;
        try {
          await api('/api/admin/students', {
            method: 'POST',
            body: Object.fromEntries(new FormData(form).entries()),
          });
          toast('Account created.', 'ok');
          close();
          loadStudents();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    },
  });
});

function editStudent(student) {
  if (!student) return;
  modal({
    title: `Edit ${student.name || student.email}`,
    body: `
      <form id="editForm">
        <div class="row">
          <label class="field"><span>Full name</span>
            <input type="text" name="name" value="${esc(student.name)}" maxlength="80" /></label>
          <label class="field"><span>Phone</span>
            <input type="tel" name="phone" value="${esc(student.phone)}" maxlength="20" /></label>
        </div>
        <label class="field" style="margin-top:14px"><span>Email (their login)</span>
          <input type="email" name="email" value="${esc(student.email)}" /></label>

        <label class="field" style="margin-top:14px"><span>Batch</span>
          <select name="batchId">
            <option value="">— no batch —</option>
            ${BATCHES.map((b) => `
              <option value="${esc(b.id)}" ${student.batchId === b.id ? 'selected' : ''}>
                ${esc(b.name)} · ${fmtClock(b.classStart)}–${fmtClock(b.classEnd)} · ${esc(daysLabel(b.classDays))}
              </option>`).join('')}
          </select></label>
        <p class="small muted" style="margin:-8px 0 16px">
          The batch sets their class time and days. Edit those on the Batches tab.
        </p>

        <div class="row" style="margin-top:6px">
          <label class="field"><span>Role</span>
            <select name="role">
              <option value="student" ${student.role === 'student' ? 'selected' : ''}>Student</option>
              <option value="admin" ${student.role === 'admin' ? 'selected' : ''}>Teacher (admin)</option>
            </select></label>
          <label class="field"><span>Account status</span>
            <select name="isActive">
              <option value="true" ${student.isActive ? 'selected' : ''}>Active</option>
              <option value="false" ${!student.isActive ? 'selected' : ''}>Disabled</option>
            </select></label>
        </div>

        <label class="field" style="margin-top:14px"><span>Set a new password (optional)</span>
          <input type="text" name="newPassword" placeholder="Leave blank to keep their current password" /></label>
      </form>`,
    footer: `<button class="btn danger" id="editDelete" style="margin-right:auto">Delete</button>
             <button class="btn ghost" data-close>Cancel</button>
             <button class="btn" id="editSave">Save changes</button>`,
    onMount: (host, close) => {
      $('#editSave', host).addEventListener('click', async () => {
        const form = $('#editForm', host);
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = {
          id: student.id,
          name: data.name,
          phone: data.phone,
          email: data.email,
          batchId: data.batchId || null,
          role: data.role,
          isActive: data.isActive === 'true',
        };
        if (data.newPassword) payload.newPassword = data.newPassword;
        try {
          await api('/api/admin/student/update', { method: 'POST', body: payload });
          toast('Saved.', 'ok');
          close();
          loadStudents();
          if (!$('#view-dashboard').hidden) loadOverview();
        } catch (err) {
          toast(err.message, 'error');
        }
      });

      $('#editDelete', host).addEventListener('click', async () => {
        if (!confirm(`Delete ${student.name || student.email} and all their attendance records?\n\nThis cannot be undone.`)) return;
        try {
          await api('/api/admin/student/delete', { method: 'POST', body: { id: student.id } });
          toast('Account deleted.', 'ok');
          close();
          loadStudents();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    },
  });
}

/* ------------------------------------------------------ student detail -- */

async function openStudent(id) {
  try {
    const { student, report, marks } = await api(`/api/admin/student?id=${encodeURIComponent(id)}`);
    const recent = report.daily.slice().reverse().slice(0, 60);

    modal({
      title: student.name || student.email,
      body: `
        <div class="stats" style="margin-bottom:16px">
          ${[
            { label: 'Attendance', value: `${report.percent}%`, tone: report.percent >= 75 ? 'good' : 'bad' },
            { label: 'Present', value: report.present, tone: 'good' },
            { label: 'Late', value: report.late, tone: 'warn' },
            { label: 'Absent', value: report.absent, tone: 'bad' },
          ].map((s) => `<div class="stat ${s.tone}"><div class="label">${s.label}</div><div class="value">${s.value}</div></div>`).join('')}
        </div>

        <dl style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0 0 18px">
          ${[
            ['Reg. no.', student.regNo], ['Email', student.email], ['Phone', student.phone || '—'],
            ['Batch', student.batch ? student.batch.name : 'No batch'],
            ['Course', student.batch ? student.batch.course || '—' : '—'],
            ['Class time', student.batch ? `${fmtClock(student.batch.classStart)} – ${fmtClock(student.batch.classEnd)}` : 'Not set'],
            ['Class days', student.batch ? daysLabel(student.batch.classDays) : 'Not set'],
            ['Joined', fmtDate(student.createdAt)], ['Last login', fmtDateTime(student.lastLoginAt)],
          ].map(([k, v]) => `<dt class="small muted">${k}</dt><dd style="margin:0">${esc(v)}</dd>`).join('')}
        </dl>

        <h3 style="margin-bottom:10px">Recent class days</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Status</th><th>Marked at</th><th>Change</th></tr></thead>
          <tbody>${recent.length ? recent.map((d) => `
            <tr>
              <td class="small">${fmtDate(d.date)}</td>
              <td>${statusPill(d.status)}</td>
              <td class="small">${fmtTime(d.markedAt)}${d.source === 'admin' ? ' <span class="muted">(teacher)</span>' : ''}</td>
              <td>
                <select data-set="${d.date}">
                  <option value="">— set —</option>
                  <option value="present">✓ Present</option>
                  <option value="late">! Late</option>
                  <option value="absent">✕ Absent</option>
                  <option value="clear">Clear</option>
                </select>
              </td>
            </tr>`).join('')
            : '<tr><td colspan="4" class="table-empty">No class days recorded yet.</td></tr>'}
          </tbody>
        </table></div>`,
      footer: `<button class="btn ghost" data-close>Close</button>`,
      onMount: (host) => {
        $$('[data-set]', host).forEach((sel) => {
          sel.addEventListener('change', async () => {
            if (!sel.value) return;
            try {
              await api('/api/admin/attendance', {
                method: 'POST',
                body: { userId: student.id, date: sel.dataset.set, status: sel.value },
              });
              toast(`Updated ${fmtDate(sel.dataset.set)}.`, 'ok');
              if (!$('#view-dashboard').hidden || !$('#view-reports').hidden) loadOverview();
            } catch (err) {
              toast(err.message, 'error');
              sel.value = '';
            }
          });
        });
      },
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ================================================================ EXAMS = */

let EXAMS = [];
let CURRENT_EXAM = null;    // the draft being built
let DRAFT_QUESTIONS = [];   // question rows in the editor

async function loadExams() {
  try {
    if (!BATCHES.length) {
      const data = await api('/api/admin/batches');
      BATCHES = data.batches;
      fillBatchFilter();
    }
    fillExamBatchSelects();

    const filter = $('#examBatchFilter').value;
    const { exams } = await api('/api/admin/exams' + (filter ? `?batchId=${filter}` : ''));
    EXAMS = exams;
    renderExamTable();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function fillExamBatchSelects() {
  const options = BATCHES.map((b) =>
    `<option value="${esc(b.id)}">${esc(b.name)}${b.course ? ` — ${esc(b.course)}` : ''}</option>`).join('');

  const picker = $('#examBatch');
  if (picker && !picker.value) {
    picker.innerHTML = BATCHES.length
      ? `<option value="">Choose a batch…</option>${options}`
      : '<option value="">No batches yet — create one first</option>';
  }
  const filter = $('#examBatchFilter');
  const keep = filter.value;
  filter.innerHTML = `<option value="">All batches</option>${options}`;
  filter.value = keep;

  if (!$('#examDate').value) $('#examDate').value = localDate();
}
$('#examBatchFilter').addEventListener('change', loadExams);

function renderExamTable() {
  $('#examTable tbody').innerHTML = EXAMS.length ? EXAMS.map((e) => `
    <tr>
      <td><b>${esc(e.title || 'Untitled exam')}</b></td>
      <td class="small">${esc(e.batch ? e.batch.name : '—')}</td>
      <td class="small nowrap">${fmtDate(e.examDate)}<br><span class="muted">${fmtClock(e.startTime)}</span></td>
      <td class="small">${MODE_LABEL[e.questionMode]}</td>
      <td class="tnum">${e.questionCount ?? 0} / ${e.totalQuestions}</td>
      <td class="tnum">${e.totalMarks}</td>
      <td class="small">${e.source === 'upload'
        ? `⭱ Upload${e.sourceFilename ? `<br><span class="muted">${esc(e.sourceFilename)}</span>` : ''}`
        : '✎ Manual'}</td>
      <td>${e.status === 'published'
        ? '<span class="pill present"><span class="ico" aria-hidden="true">✓</span>Published</span>'
        : '<span class="pill pending"><span class="ico" aria-hidden="true">○</span>Draft</span>'}</td>
      <td class="nowrap">
        <button class="btn ghost sm" data-openexam="${e.id}">Open</button>
        <button class="btn ghost sm" data-results="${e.id}">Results</button>
        <button class="btn ghost sm" data-delexam="${e.id}">Delete</button>
      </td>
    </tr>`).join('')
    : '<tr><td colspan="9" class="table-empty">No exams yet. Fill in the form above to create one.</td></tr>';

  $$('#examTable [data-openexam]').forEach((b) =>
    b.addEventListener('click', () => openExam(b.dataset.openexam)));
  $$('#examTable [data-results]').forEach((b) =>
    b.addEventListener('click', () => openExamResults(b.dataset.results)));
  $$('#examTable [data-delexam]').forEach((b) =>
    b.addEventListener('click', () => deleteExam(b.dataset.delexam)));
}

const MODE_LABEL = {
  fill: 'Fill in the blanks',
  mcq: 'Multiple choice',
  both: 'Both',
};

/* ---- step 1: exam settings ------------------------------------------- */

let examMode = 'both';
$$('#examMode button').forEach((btn) => {
  btn.addEventListener('click', () => {
    examMode = btn.dataset.mode;
    $$('#examMode button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    updateExamHint();
  });
});

/* Who the paper goes to. 'selected' is how a makeup is kept private. */
let examAudience = 'batch';
let PICKED = new Set();          // student ids for a restricted paper
let PICK_POOL = [];              // students in the chosen batch
let MISSED_IDS = new Set();      // who has missed a paper in this batch

$$('#examAudience button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    examAudience = btn.dataset.audience;
    $$('#examAudience button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    $('#examStudentPick').classList.toggle('hidden', examAudience !== 'selected');
    if (examAudience === 'selected') await loadPickList();
  });
});

$('#examBatch').addEventListener('change', () => {
  PICKED.clear();
  if (examAudience === 'selected') loadPickList();
});

/** The students in the chosen batch, flagged with who has missed a paper. */
async function loadPickList() {
  const batchId = $('#examBatch').value;
  if (!batchId) { $('#examStudentList').innerHTML = ''; return; }
  $('#examStudentList').innerHTML = '<p class="small muted">Loading…</p>';
  try {
    const [{ students }, { requests }] = await Promise.all([
      api(`/api/admin/students?batchId=${encodeURIComponent(batchId)}`),
      api('/api/admin/makeups?status=pending'),
    ]);
    PICK_POOL = students;
    MISSED_IDS = new Set(requests.map((r) => r.userId));
    renderPickList();
  } catch (err) {
    $('#examStudentList').innerHTML = `<p class="small muted">${esc(err.message)}</p>`;
  }
}

function renderPickList() {
  if (!PICK_POOL.length) {
    $('#examStudentList').innerHTML = '<p class="small muted">No students in this batch yet.</p>';
    $('#pickCount').textContent = 'none chosen';
    return;
  }
  $('#examStudentList').innerHTML = PICK_POOL.map((s) => `
    <label class="pick-item ${PICKED.has(s.id) ? 'on' : ''}">
      <input type="checkbox" value="${esc(s.id)}" ${PICKED.has(s.id) ? 'checked' : ''} />
      <span class="pick-name">${esc(s.name)}</span>
      <span class="small muted">${esc(s.regNo || s.email)}</span>
      ${MISSED_IDS.has(s.id)
        ? '<span class="pill late"><span class="ico" aria-hidden="true">⏳</span>Asked for a makeup</span>'
        : ''}
    </label>`).join('');

  $$('#examStudentList input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) PICKED.add(cb.value); else PICKED.delete(cb.value);
      cb.closest('.pick-item').classList.toggle('on', cb.checked);
      updatePickCount();
    });
  });
  updatePickCount();
}

const updatePickCount = () => {
  $('#pickCount').textContent = PICKED.size
    ? `${PICKED.size} student${PICKED.size === 1 ? '' : 's'} chosen`
    : 'none chosen';
};

$('#pickMissed').addEventListener('click', () => {
  MISSED_IDS.forEach((id) => PICKED.add(id));
  renderPickList();
});
$('#pickClear').addEventListener('click', () => { PICKED.clear(); renderPickList(); });

function updateExamHint() {
  const form = $('#examForm');
  const q = Number(form.totalQuestions.value) || 0;
  const marks = Number(form.totalMarks.value) || 0;
  const secs = Number(form.secondsPerQuestion.value) || 0;
  const per = q ? Math.round((marks / q) * 100) / 100 : 0;
  const total = q * secs;
  $('#examSummaryHint').textContent = q && marks && secs
    ? `${q} questions · ${per} mark${per === 1 ? '' : 's'} each · total exam time ${
        total >= 60 ? `${Math.round(total / 60)} min` : `${total} sec`}.`
    : '';
}
['totalQuestions', 'totalMarks', 'secondsPerQuestion'].forEach((name) =>
  $(`#examForm [name="${name}"]`).addEventListener('input', updateExamHint));

$('#examForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.batchId) { toast('Choose a batch first.', 'error'); return; }
  if (examAudience === 'selected' && !PICKED.size) {
    toast('Choose at least one student for this paper.', 'error');
    return;
  }

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await api('/api/admin/exams', {
      method: 'POST',
      body: {
        batchId: data.batchId,
        title: data.title,
        examDate: data.examDate,
        startTime: data.startTime,
        totalQuestions: Number(data.totalQuestions),
        totalMarks: Number(data.totalMarks),
        secondsPerQuestion: Number(data.secondsPerQuestion),
        questionMode: examMode,
        instructions: data.instructions,
        audience: examAudience,
        studentIds: [...PICKED],
        // Set when the teacher came here from a paper's Results screen, so the
        // matching requests are approved and linked to this new paper.
        missedExamId: MAKEUP_FOR_EXAM || undefined,
      },
    });
    CURRENT_EXAM = res.exam;
    DRAFT_QUESTIONS = [];
    enterStep2();
    toast('Exam created. Now build the question paper.', 'ok');
    loadExams();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function setStep(n) {
  $$('#examSteps .step').forEach((s) => {
    const step = Number(s.dataset.step);
    s.classList.toggle('on', step === n);
    s.classList.toggle('done', step < n);
  });
}

function enterStep2() {
  const e = CURRENT_EXAM;
  $('#examStep1').classList.add('hidden');
  $('#examListCard').classList.add('hidden');
  $('#examStep2').classList.remove('hidden');
  setStep(2);

  $('#examStep2Sub').textContent =
    `${e.title || 'Untitled exam'} · ${e.batch ? e.batch.name : ''} · ${fmtDate(e.examDate)} ${fmtClock(e.startTime)} · ` +
    `${e.totalQuestions} questions · ${e.totalMarks} marks · ${e.secondsPerQuestion}s each`;

  $('#manualHint').textContent = e.questionMode === 'fill'
    ? 'This exam is fill-in-the-blank. Write the question with ____ where the answer goes.'
    : e.questionMode === 'mcq'
      ? 'This exam is multiple choice. Add the options and tick the correct one.'
      : 'You can mix fill-in-the-blank and multiple-choice questions in this exam.';

  $('#addFillBtn').hidden = e.questionMode === 'mcq';
  $('#addMcqBtn').hidden = e.questionMode === 'fill';

  if (!DRAFT_QUESTIONS.length) {
    addQuestion(e.questionMode === 'mcq' ? 'mcq' : 'fill');
  } else {
    renderQuestions();
  }
  $('#examStep2').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#examBack1').addEventListener('click', () => {
  $('#examStep2').classList.add('hidden');
  $('#examStep1').classList.remove('hidden');
  $('#examListCard').classList.remove('hidden');
  setStep(1);
});
$('#examShowList').addEventListener('click', () => {
  $('#examListCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---- step 2 tabs ------------------------------------------------------ */

$$('#paperTabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('#paperTabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    const manual = btn.dataset.paper === 'manual';
    $('#paperManual').hidden = !manual;
    $('#paperUpload').hidden = manual;
  });
});

/* ---- manual question editor ------------------------------------------- */

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function addQuestion(type) {
  DRAFT_QUESTIONS.push({
    type,
    questionText: '',
    options: type === 'mcq'
      ? [{ key: 'A', text: '' }, { key: 'B', text: '' }, { key: 'C', text: '' }, { key: 'D', text: '' }]
      : [],
    correctAnswer: '',
    marks: perQuestionMarks(),
  });
  renderQuestions();
}
$('#addFillBtn').addEventListener('click', () => addQuestion('fill'));
$('#addMcqBtn').addEventListener('click', () => addQuestion('mcq'));

function perQuestionMarks() {
  const e = CURRENT_EXAM;
  if (!e) return 1;
  const n = Math.max(DRAFT_QUESTIONS.length + 1, 1);
  return Math.round((e.totalMarks / Math.max(e.totalQuestions, n)) * 100) / 100;
}

/** Where the editor draws right now: the manual tab, or the upload review. */
function questionMount() {
  const review = $('#uploadQuestions');
  if (review && !$('#paperUpload').hidden) return review;
  return $('#questionList');
}

function renderQuestions() {
  const mount = questionMount();
  if (!mount) return;
  if (!DRAFT_QUESTIONS.length) {
    mount.innerHTML = '<div class="table-empty">No questions yet — add one below.</div>';
    return;
  }

  mount.innerHTML = DRAFT_QUESTIONS.map((q, i) => `
    <div class="q-card" data-q="${i}">
      <div class="q-head">
        <span class="q-num">${i + 1}</span>
        <span class="q-type">${q.type === 'mcq' ? 'Multiple choice' : 'Fill in the blank'}</span>
        <div class="spacer"></div>
        <label class="field" style="margin:0;width:96px">
          <input type="number" class="q-marks" value="${q.marks}" min="0" step="0.5"
                 title="Marks for this question" aria-label="Marks for question ${i + 1}" />
        </label>
        <button class="iconbtn q-del" title="Remove question ${i + 1}">✕</button>
      </div>

      <label class="field">
        <span>Question</span>
        <textarea class="q-text" rows="2" placeholder="${q.type === 'fill'
          ? 'e.g. The capital of France is ____.'
          : 'e.g. Which planet is closest to the Sun?'}">${esc(q.questionText)}</textarea>
      </label>

      ${q.type === 'mcq' ? `
        <div class="q-options">
          ${q.options.map((o, oi) => `
            <div class="opt-row ${q.correctAnswer === o.key ? 'correct' : ''}">
              <span class="opt-key">${esc(o.key)}</span>
              <input type="text" class="opt-text" data-oi="${oi}" value="${esc(o.text)}"
                     placeholder="Option ${o.key}" aria-label="Option ${o.key} for question ${i + 1}" />
              <label class="pick">
                <input type="radio" name="correct-${i}" class="opt-correct" data-oi="${oi}"
                       ${q.correctAnswer === o.key ? 'checked' : ''} />
                Correct
              </label>
            </div>`).join('')}
          <button class="btn link add-opt" type="button">+ add option</button>
        </div>`
      : `
        <label class="field">
          <span>Correct answer</span>
          <input type="text" class="q-answer" value="${esc(q.correctAnswer)}"
                 placeholder="e.g. Paris" />
        </label>`}
    </div>`).join('');

  wireQuestionCard(mount);
}

function wireQuestionCard(mount) {
  const at = (el) => Number(el.closest('.q-card').dataset.q);

  $$('.q-text', mount).forEach((el) =>
    el.addEventListener('input', () => { DRAFT_QUESTIONS[at(el)].questionText = el.value; }));

  $$('.q-answer', mount).forEach((el) =>
    el.addEventListener('input', () => { DRAFT_QUESTIONS[at(el)].correctAnswer = el.value; }));

  $$('.q-marks', mount).forEach((el) =>
    el.addEventListener('input', () => { DRAFT_QUESTIONS[at(el)].marks = Number(el.value) || 0; }));

  $$('.opt-text', mount).forEach((el) =>
    el.addEventListener('input', () => {
      DRAFT_QUESTIONS[at(el)].options[Number(el.dataset.oi)].text = el.value;
    }));

  $$('.opt-correct', mount).forEach((el) =>
    el.addEventListener('change', () => {
      const q = DRAFT_QUESTIONS[at(el)];
      q.correctAnswer = q.options[Number(el.dataset.oi)].key;
      renderQuestions();
    }));

  $$('.add-opt', mount).forEach((el) =>
    el.addEventListener('click', () => {
      const q = DRAFT_QUESTIONS[at(el)];
      if (q.options.length >= LETTERS.length) { toast('Six options is the maximum.', 'warn'); return; }
      q.options.push({ key: LETTERS[q.options.length], text: '' });
      renderQuestions();
    }));

  $$('.q-del', mount).forEach((el) =>
    el.addEventListener('click', () => {
      DRAFT_QUESTIONS.splice(at(el), 1);
      renderQuestions();
    }));
}

$('#saveQuestionsBtn').addEventListener('click', saveQuestions);

async function saveQuestions() {
  if (!CURRENT_EXAM) { toast('Create the exam first.', 'error'); return; }
  if (!DRAFT_QUESTIONS.length) { toast('Add at least one question.', 'error'); return; }

  const btn = $('#saveQuestionsBtn');
  btn.disabled = true;
  try {
    const res = await api('/api/admin/exams/questions', {
      method: 'POST',
      body: { examId: CURRENT_EXAM.id, questions: DRAFT_QUESTIONS },
    });
    CURRENT_EXAM = res.exam;
    setStep(3);
    toast(res.message, 'ok');

    const expected = CURRENT_EXAM.totalQuestions;
    if (res.questions.length !== expected) {
      toast(`Saved ${res.questions.length} questions — you planned ${expected}.`, 'warn');
    }
    await loadExams();
    openExam(CURRENT_EXAM.id);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ---- upload ----------------------------------------------------------- */

const dropzone = $('#dropzone');
const fileInput = $('#examFile');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) handleUpload(fileInput.files[0]);
});

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}

async function handleUpload(file) {
  if (!CURRENT_EXAM) { toast('Create the exam first.', 'error'); return; }
  if (file.size > 12 * 1024 * 1024) { toast('That file is larger than 12 MB.', 'error'); return; }

  $('#uploadResult').innerHTML =
    '<div class="alert info"><span class="ico">⏳</span><span>Reading the paper…</span></div>';

  try {
    const contentBase64 = await readAsBase64(file);
    const res = await api('/api/admin/exams/parse', {
      method: 'POST',
      body: { filename: file.name, contentBase64, mode: CURRENT_EXAM.questionMode },
    });
    DRAFT_QUESTIONS = res.questions.map((q) => ({
      type: q.type,
      questionText: q.questionText,
      options: q.options,
      correctAnswer: q.correctAnswer,
      marks: Math.round((CURRENT_EXAM.totalMarks / Math.max(res.questions.length, 1)) * 100) / 100,
    }));
    renderUploadResult(res, file.name);
  } catch (err) {
    $('#uploadResult').innerHTML =
      `<div class="alert error"><span class="ico">⚠</span><span>${esc(err.message)}</span></div>`;
  }
}

function renderUploadResult(res, filename) {
  const found = res.questions.length;
  const withAnswers = res.questions.filter((q) => q.correctAnswer).length;
  const mcq = res.questions.filter((q) => q.type === 'mcq').length;

  $('#uploadResult').innerHTML = `
    <div class="parse-summary">
      <div class="stat"><div class="label">Questions read</div><div class="value">${found}</div>
        <div class="foot">planned ${CURRENT_EXAM.totalQuestions}</div></div>
      <div class="stat ${withAnswers === found && found ? 'good' : 'bad'}">
        <div class="label">With answers</div><div class="value">${withAnswers}</div>
        <div class="foot">of ${found}</div></div>
      <div class="stat"><div class="label">Multiple choice</div><div class="value">${mcq}</div>
        <div class="foot">${found - mcq} fill-in-the-blank</div></div>
    </div>

    ${res.warnings.length ? `
      <div class="alert error">
        <span class="ico" aria-hidden="true">⚠</span>
        <span><strong>Check these before saving:</strong><ul style="margin:6px 0 0 18px;padding:0">
          ${res.warnings.slice(0, 12).map((w) => `<li>${esc(w)}</li>`).join('')}
          ${res.warnings.length > 12 ? `<li>…and ${res.warnings.length - 12} more</li>` : ''}
        </ul></span>
      </div>` : `
      <div class="alert success">
        <span class="ico" aria-hidden="true">✓</span>
        <span>Every question was read with an answer. Check them below, then save.</span>
      </div>`}

    <details class="raw-text">
      <summary>Show the raw text read from ${esc(filename)} (${res.characters.toLocaleString()} characters)</summary>
      <pre>${esc(res.textPreview)}</pre>
    </details>

    <h3 style="margin:18px 0 10px">Review and edit</h3>
    <div id="uploadQuestions"></div>
    <div class="row" style="margin-top:14px">
      <button class="btn ghost" id="uploadAddFill" type="button">+ Fill in the blank</button>
      <button class="btn ghost" id="uploadAddMcq" type="button">+ Multiple choice</button>
      <div class="spacer" style="margin-left:auto"></div>
      <button class="btn" id="uploadSaveBtn" type="button">Save question paper</button>
    </div>`;

  // The review list uses the very same editor as the manual tab.
  renderQuestions();

  $('#uploadAddFill').addEventListener('click', () => addQuestion('fill'));
  $('#uploadAddMcq').addEventListener('click', () => addQuestion('mcq'));
  $('#uploadSaveBtn').addEventListener('click', () => saveQuestionsFrom(filename));
}

async function saveQuestionsFrom(filename) {
  const btn = $('#uploadSaveBtn');
  btn.disabled = true;
  try {
    const res = await api('/api/admin/exams/questions', {
      method: 'POST',
      body: { examId: CURRENT_EXAM.id, questions: DRAFT_QUESTIONS, sourceFilename: filename },
    });
    CURRENT_EXAM = res.exam;
    setStep(3);
    toast(`${res.message} From ${filename}.`, 'ok');
    await loadExams();
    openExam(CURRENT_EXAM.id);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

/* ---- view / publish / delete ------------------------------------------ */

async function openExam(id) {
  try {
    const { exam, questions } = await api(`/api/admin/exam?id=${encodeURIComponent(id)}`);
    const totalMarks = questions.reduce((sum, q) => sum + q.marks, 0);

    modal({
      title: exam.title || 'Untitled exam',
      body: `
        <dl style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0 0 18px">
          ${[
            ['Batch', exam.batch ? exam.batch.name : '—'],
            ['Course', exam.batch ? exam.batch.course || '—' : '—'],
            ['Date & time', `${fmtDate(exam.examDate)} at ${fmtClock(exam.startTime)}`],
            ['Question style', MODE_LABEL[exam.questionMode]],
            ['Questions', `${questions.length} saved (planned ${exam.totalQuestions})`],
            ['Marks', `${totalMarks} allotted (planned ${exam.totalMarks})`],
            ['Time per question', `${exam.secondsPerQuestion} seconds`],
            ['Source', exam.source === 'upload' ? `Uploaded ${exam.sourceFilename || 'file'}` : 'Created manually'],
          ].map(([k, v]) => `<dt class="small muted">${k}</dt><dd style="margin:0">${esc(v)}</dd>`).join('')}
        </dl>

        ${questions.length ? questions.map((q) => `
          <div class="q-card">
            <div class="q-head">
              <span class="q-num">${q.position}</span>
              <span class="q-type">${q.type === 'mcq' ? 'Multiple choice' : 'Fill in the blank'}</span>
              <div class="spacer"></div>
              <span class="small muted">${q.marks} mark${q.marks === 1 ? '' : 's'}</span>
            </div>
            <p style="margin-bottom:10px">${esc(q.questionText)}</p>
            ${q.type === 'mcq' ? `
              <div>${q.options.map((o) => `
                <div class="opt-row ${o.key === q.correctAnswer ? 'correct' : ''}">
                  <span class="opt-key">${esc(o.key)}</span>
                  <span>${esc(o.text)}</span>
                </div>`).join('')}</div>`
              : `<div class="answer-strip"><span>Answer:</span> <b>${esc(q.correctAnswer)}</b></div>`}
          </div>`).join('')
          : '<div class="table-empty">No questions saved for this exam yet.</div>'}`,
      footer: `
        <button class="btn danger" id="examDelete" style="margin-right:auto">Delete exam</button>
        <button class="btn ghost" data-close>Close</button>
        ${questions.length ? `<button class="btn" id="examPublish">${
          exam.status === 'published' ? 'Move back to draft' : 'Publish exam'}</button>` : ''}`,
      onMount: (host, close) => {
        const publish = $('#examPublish', host);
        if (publish) {
          publish.addEventListener('click', async () => {
            try {
              await api('/api/admin/exams/update', {
                method: 'POST',
                body: { id: exam.id, status: exam.status === 'published' ? 'draft' : 'published' },
              });
              toast(exam.status === 'published' ? 'Moved back to draft.' : 'Exam published.', 'ok');
              close();
              loadExams();
            } catch (err) { toast(err.message, 'error'); }
          });
        }
        $('#examDelete', host).addEventListener('click', async () => {
          if (!confirm(`Delete "${exam.title || 'this exam'}" and all its questions?\n\nThis cannot be undone.`)) return;
          try {
            await api('/api/admin/exams/delete', { method: 'POST', body: { id: exam.id } });
            toast('Exam deleted.', 'ok');
            close();
            loadExams();
          } catch (err) { toast(err.message, 'error'); }
        });
      },
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---- makeups ----------------------------------------------------------- */

/* Set when the teacher is building a makeup for a specific missed paper, so
   the new exam can approve and link the matching requests. */
let MAKEUP_FOR_EXAM = null;

/**
 * Jump from a paper's results into the exam wizard, pre-loaded with the
 * students who missed it. The teacher then writes a fresh paper for them.
 */
function startMakeupFor(exam, missedRows) {
  MAKEUP_FOR_EXAM = exam.id;

  showView('exams');
  setStep(1);
  $('#examStep1').classList.remove('hidden');
  $('#examStep2').classList.add('hidden');
  $('#examListCard').classList.remove('hidden');

  const form = $('#examForm');
  form.batchId.value = exam.batchId;
  form.title.value = `${exam.title || 'Exam'} — makeup`;
  form.totalQuestions.value = exam.totalQuestions;
  form.totalMarks.value = exam.totalMarks;
  form.secondsPerQuestion.value = exam.secondsPerQuestion;

  // Switch to "selected students" and tick everyone who missed.
  const selBtn = $('#examAudience button[data-audience="selected"]');
  examAudience = 'selected';
  $$('#examAudience button').forEach((b) => b.setAttribute('aria-pressed', String(b === selBtn)));
  $('#examStudentPick').classList.remove('hidden');

  PICKED = new Set(missedRows.map((r) => r.student.id));
  loadPickList().then(() => { renderPickList(); });

  updateExamHint();
  toast(`Write a fresh paper for the ${missedRows.length} student${
    missedRows.length === 1 ? '' : 's'} who missed it.`, 'ok');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadMakeups() {
  try {
    const { requests, pendingCount } = await api('/api/admin/makeups');
    const pending = requests.filter((r) => r.status === 'pending');

    $('#makeupCard').classList.toggle('hidden', !requests.length);
    $('#makeupCount').textContent = pendingCount;
    $('#makeupCount').classList.toggle('zero', !pendingCount);

    if (!requests.length) return;

    $('#makeupList').innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Student</th><th>Missed paper</th><th>Reason</th><th>Asked</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${requests.map((r) => `
          <tr>
            <td>${r.student ? who(r.student) : '—'}</td>
            <td>${esc((r.exam && r.exam.title) || 'Untitled exam')}
              <span class="small muted">${r.exam ? fmtDate(r.exam.examDate) : ''}</span></td>
            <td class="small">${r.reason ? esc(r.reason) : '<span class="muted">—</span>'}</td>
            <td class="small">${fmtDateTime(r.createdAt)}</td>
            <td>${r.status === 'pending'
              ? '<span class="pill late"><span class="ico" aria-hidden="true">⏳</span>Waiting</span>'
              : r.status === 'approved'
                ? `<span class="pill present"><span class="ico" aria-hidden="true">✓</span>Approved</span>
                   <span class="small muted">${esc((r.makeupExam && r.makeupExam.title) || 'paper set')}</span>`
                : '<span class="pill absent"><span class="ico" aria-hidden="true">✕</span>Declined</span>'}</td>
            <td>${r.status === 'pending' ? `
              <button class="btn sm" data-makeup-set="${esc(r.examId)}">Set paper</button>
              <button class="btn ghost sm" data-makeup-no="${esc(r.id)}">Decline</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    // "Set paper" opens the wizard for everyone waiting on that same exam, so
    // one makeup paper can cover them all.
    $$('#makeupList [data-makeup-set]').forEach((b) => {
      b.addEventListener('click', async () => {
        const examId = b.dataset.makeupSet;
        const group = pending.filter((r) => r.examId === examId);
        const exam = group[0] && group[0].exam;
        if (!exam) { toast('That exam is no longer available.', 'error'); return; }
        startMakeupFor(exam, group.map((r) => ({ student: r.student })));
      });
    });

    $$('#makeupList [data-makeup-no]').forEach((b) =>
      b.addEventListener('click', () => rejectMakeup(b.dataset.makeupNo)));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function rejectMakeup(id) {
  modal({
    title: 'Decline this request',
    body: `
      <p class="small muted">The student will see your reason, so a short line helps.</p>
      <label class="field" style="margin-top:12px">
        <span>Reason (optional)</span>
        <textarea id="rejectNote" rows="3" maxlength="500"
          placeholder="For example: you were marked absent without informing us."></textarea>
      </label>`,
    footer: `<button class="btn ghost" data-close>Cancel</button>
             <button class="btn danger" id="confirmReject">Decline request</button>`,
    onMount: (host, close) => {
      $('#confirmReject', host).addEventListener('click', async () => {
        try {
          await api('/api/admin/makeups/reject', {
            method: 'POST', body: { id, note: $('#rejectNote', host).value.trim() },
          });
          close();
          toast('Request declined.', 'ok');
          loadMakeups();
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

/* ---- who scored what --------------------------------------------------- */

async function openExamResults(examId) {
  try {
    const { exam, rows, summary } = await api(`/api/admin/exam/results?examId=${encodeURIComponent(examId)}`);

    modal({
      title: `Results — ${exam.title || 'Untitled exam'}`,
      body: `
        <div class="stats compact" style="margin-bottom:18px">
          <div class="stat"><div class="label">Students</div><div class="value">${summary.students}</div></div>
          <div class="stat good"><div class="label">Submitted</div><div class="value">${summary.submitted}</div>
            <div class="foot">${summary.notStarted} not started</div></div>
          <div class="stat accent"><div class="label">Average</div><div class="value">${summary.average}%</div></div>
          <div class="stat good"><div class="label">Highest</div><div class="value">${summary.highest}%</div></div>
          <div class="stat bad"><div class="label">Lowest</div><div class="value">${summary.lowest}%</div></div>
          <div class="stat"><div class="label">Passed</div><div class="value">${summary.passed}</div>
            <div class="foot">40% or above</div></div>
          ${summary.missed ? `
          <div class="stat bad"><div class="label">Missed</div><div class="value">${summary.missed}</div>
            <div class="foot">${summary.awaitingDecision} waiting on you</div></div>` : ''}
        </div>

        ${summary.missed ? `
        <div class="alert warn" style="margin-bottom:16px">
          <b>${summary.missed} student${summary.missed === 1 ? '' : 's'} missed this paper.</b>
          Set them a makeup and only they will see it — the rest of the batch cannot.
          <button class="btn sm" id="setMakeup" style="margin-top:8px">Set a makeup paper</button>
        </div>` : ''}

        <div class="table-wrap"><table>
          <thead><tr>
            <th>Student</th><th>Status</th><th class="tnum">Correct</th><th class="tnum">Wrong</th>
            <th class="tnum">Unanswered</th><th class="tnum">Score</th><th>Submitted</th><th></th>
          </tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td>${who(r.student)}</td>
              <td>${r.status === 'submitted'
                ? '<span class="pill present"><span class="ico" aria-hidden="true">✓</span>Submitted</span>'
                : r.status === 'in_progress'
                  ? '<span class="pill late"><span class="ico" aria-hidden="true">!</span>In progress</span>'
                  : r.makeupStatus === 'approved'
                    ? '<span class="pill present"><span class="ico" aria-hidden="true">★</span>Makeup set</span>'
                    : r.makeupStatus === 'pending'
                      ? '<span class="pill late"><span class="ico" aria-hidden="true">⏳</span>Asked for a makeup</span>'
                      : r.makeupStatus === 'rejected'
                        ? '<span class="pill absent"><span class="ico" aria-hidden="true">✕</span>Declined</span>'
                        : r.missed
                          ? '<span class="pill absent"><span class="ico" aria-hidden="true">✕</span>Missed</span>'
                          : '<span class="pill pending"><span class="ico" aria-hidden="true">○</span>Not started</span>'}</td>
              <td class="tnum" style="color:var(--present);font-weight:650">${r.correctCount}</td>
              <td class="tnum" style="color:var(--absent);font-weight:650">${r.wrongCount}</td>
              <td class="tnum">${r.unansweredCount}</td>
              <td>${r.status === 'submitted'
                ? `${meter(r.percent)}<span class="small muted">${r.score}/${r.totalMarks}</span>`
                : '<span class="muted">—</span>'}</td>
              <td class="small">${r.submittedAt ? fmtDateTime(r.submittedAt) : '—'}</td>
              <td>${r.attemptId && r.status === 'submitted'
                ? `<button class="btn ghost sm" data-paper="${r.attemptId}">Paper</button>` : ''}</td>
            </tr>`).join('')
            : '<tr><td colspan="8" class="table-empty">No students in this batch yet.</td></tr>'}
          </tbody>
        </table></div>`,
      footer: '<button class="btn ghost" data-close>Close</button>',
      onMount: (host, close) => {
        $$('[data-paper]', host).forEach((b) =>
          b.addEventListener('click', () => showStudentPaper(b.dataset.paper)));
        const makeupBtn = $('#setMakeup', host);
        if (makeupBtn) {
          makeupBtn.addEventListener('click', () => {
            close();
            startMakeupFor(exam, rows.filter((r) => r.missed));
          });
        }
      },
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Admins may read any student's marked paper. */
async function showStudentPaper(attemptId) {
  try {
    const { attempt, results } = await api(`/api/student/exam/result?attemptId=${encodeURIComponent(attemptId)}`);
    modal({
      title: `${attempt.student ? attempt.student.name : 'Student'} — marked paper`,
      body: `
        <div class="stats compact" style="margin-bottom:16px">
          <div class="stat accent"><div class="label">Score</div>
            <div class="value">${attempt.score}/${attempt.totalMarks}</div>
            <div class="foot">${attempt.percent}%</div></div>
          <div class="stat good"><div class="label">Correct</div><div class="value">${attempt.correctCount}</div></div>
          <div class="stat bad"><div class="label">Wrong</div><div class="value">${attempt.wrongCount}</div></div>
          <div class="stat"><div class="label">Unanswered</div><div class="value">${attempt.unansweredCount}</div></div>
        </div>
        ${results.map((r) => `
          <div class="marked ${r.isCorrect ? 'right' : r.attempted ? 'wrong' : 'skipped'}">
            <div class="marked-head">
              <span class="q-num">${r.position}</span>
              <span class="q-type">${r.type === 'mcq' ? 'Multiple choice' : 'Fill in the blank'}</span>
              <div class="spacer" style="margin-left:auto"></div>
              <span class="pill ${r.isCorrect ? 'present' : r.attempted ? 'absent' : 'pending'}">
                <span class="ico" aria-hidden="true">${r.isCorrect ? '✓' : r.attempted ? '✕' : '○'}</span>
                ${r.isCorrect ? `+${r.marksAwarded}` : r.attempted ? 'Wrong' : 'Not answered'}
              </span>
            </div>
            <p class="marked-q">${esc(r.questionText)}</p>
            <div class="answer-lines">
              <div><span>Their answer</span><b>${r.attempted ? esc(r.yourAnswer) : '— not answered —'}</b></div>
              <div><span>Correct answer</span><b class="good">${esc(r.correctAnswer)}</b></div>
            </div>
          </div>`).join('')}`,
      footer: '<button class="btn ghost" data-close>Close</button>',
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---- all scores, for the Reports tab ---------------------------------- */

async function loadExamScores() {
  const mount = $('#examScores');
  if (!mount) return;
  try {
    const { attempts } = await api('/api/admin/exam/scores');
    if (!attempts.length) {
      mount.innerHTML = '<div class="table-empty">No student has submitted an exam yet.</div>';
      return;
    }

    const average = Math.round((attempts.reduce((s, a) => s + a.percent, 0) / attempts.length) * 10) / 10;
    const passed = attempts.filter((a) => a.percent >= 40).length;

    mount.innerHTML = `
      <div class="stats compact" style="margin-bottom:16px">
        <div class="stat"><div class="label">Papers submitted</div><div class="value">${attempts.length}</div></div>
        <div class="stat accent"><div class="label">Average score</div><div class="value">${average}%</div></div>
        <div class="stat good"><div class="label">Passed</div><div class="value">${passed}</div>
          <div class="foot">40% or above</div></div>
        <div class="stat bad"><div class="label">Below 40%</div><div class="value">${attempts.length - passed}</div></div>
      </div>

      <div class="table-wrap"><table>
        <thead><tr>
          <th>Student</th><th>Exam</th><th>Batch</th><th class="tnum">Correct</th>
          <th class="tnum">Wrong</th><th class="tnum">Unanswered</th><th class="tnum">Score</th>
          <th>Submitted</th><th></th>
        </tr></thead>
        <tbody>${attempts.map((a) => `
          <tr>
            <td>${a.student ? who(a.student) : '—'}</td>
            <td class="small"><b>${esc(a.exam ? a.exam.title || 'Untitled' : '—')}</b><br>
              <span class="muted">${a.exam ? fmtDate(a.exam.examDate) : ''}</span></td>
            <td class="small">${esc(a.exam ? a.exam.batchName : '—')}</td>
            <td class="tnum" style="color:var(--present);font-weight:650">${a.correctCount}</td>
            <td class="tnum" style="color:var(--absent);font-weight:650">${a.wrongCount}</td>
            <td class="tnum">${a.unansweredCount}</td>
            <td>${meter(a.percent)}<span class="small muted">${a.score}/${a.totalMarks}</span></td>
            <td class="small">${fmtDateTime(a.submittedAt)}</td>
            <td><button class="btn ghost sm" data-paper="${a.id}">Paper</button></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    $$('#examScores [data-paper]').forEach((b) =>
      b.addEventListener('click', () => showStudentPaper(b.dataset.paper)));
  } catch (err) {
    mount.innerHTML = `<div class="alert error"><span class="ico">⚠</span><span>${esc(err.message)}</span></div>`;
  }
}

async function deleteExam(id) {
  const exam = EXAMS.find((e) => e.id === id);
  if (!confirm(`Delete "${exam ? exam.title || 'this exam' : 'this exam'}" and all its questions?`)) return;
  try {
    await api('/api/admin/exams/delete', { method: 'POST', body: { id } });
    toast('Exam deleted.', 'ok');
    loadExams();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ============================================================== REPORTS = */

function renderReports() {
  const o = OVERVIEW;
  if (!o) return;

  $('#reportStats').innerHTML = [
    { label: 'Overall attendance', value: `${o.totals.percent}%`, foot: 'present or late', tone: o.totals.percent >= 75 ? 'good' : 'warn' },
    { label: 'Present', value: o.totals.present, foot: 'on-time check-ins', tone: 'good' },
    { label: 'Late', value: o.totals.late, foot: 'after grace period', tone: 'warn' },
    { label: 'Absent', value: o.totals.absent, foot: 'missed class days', tone: 'bad' },
    { label: 'Class days counted', value: o.totals.total, foot: 'across all students', tone: '' },
  ].map((s) => `<div class="stat ${s.tone}">
      <div class="label">${s.label}</div><div class="value">${s.value}</div><div class="foot">${s.foot}</div>
    </div>`).join('');

  /* donut */
  donut($('#donutChart'), o.totals);
  legend($('#donutLegend'), { present: o.totals.present, late: o.totals.late, absent: o.totals.absent });
  $('#donutTable').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Status</th><th class="tnum">Days</th><th class="tnum">Share</th></tr></thead>
      <tbody>${['present', 'late', 'absent'].map((key) => `
        <tr><td>${statusPill(key)}</td><td class="tnum">${o.totals[key]}</td>
        <td class="tnum">${o.totals.total ? Math.round((o.totals[key] / o.totals.total) * 1000) / 10 : 0}%</td></tr>`).join('')}
      </tbody></table></div>`;

  /* per-student bars, lowest first — one series, one colour */
  const bars = o.rows.slice()
    .filter((r) => r.total > 0)
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 12)
    .map((r) => ({
      label: r.student.name || r.student.email,
      value: r.percent,
      tip: `<div class="t-row"><span class="swatch" style="background:#0ca30c"></span>✓ Present<span class="t-val">${r.present}</span></div>
            <div class="t-row"><span class="swatch" style="background:#fab219"></span>! Late<span class="t-val">${r.late}</span></div>
            <div class="t-row"><span class="swatch" style="background:#d03b3b"></span>✕ Absent<span class="t-val">${r.absent}</span></div>`,
    }));
  valueBars($('#barsChart'), bars);
  if (o.rows.length > 12) {
    $('#barsChart').insertAdjacentHTML('beforeend',
      `<p class="small muted" style="margin-top:10px">Showing the 12 lowest of ${o.rows.length} students — the full list is in the table view and the summary below.</p>`);
  }
  $('#barsTable').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Student</th><th class="tnum">Attendance</th><th class="tnum">Present</th><th class="tnum">Late</th><th class="tnum">Absent</th></tr></thead>
      <tbody>${o.rows.length ? o.rows.slice().sort((a, b) => a.percent - b.percent).map((r) => `
        <tr><td>${esc(r.student.name || r.student.email)}</td><td class="tnum">${r.percent}%</td>
        <td class="tnum">${r.present}</td><td class="tnum">${r.late}</td><td class="tnum">${r.absent}</td></tr>`).join('')
        : '<tr><td colspan="5" class="table-empty">No students yet.</td></tr>'}
      </tbody></table></div>`;

  /* daily trend */
  const points = o.daily.map((d) => ({
    label: fmtDateShort(d.date),
    title: fmtDate(d.date),
    value: d.percent,
    tip: `<div class="t-row"><span class="swatch" style="background:#0ca30c"></span>✓ Present<span class="t-val">${d.present}</span></div>
          <div class="t-row"><span class="swatch" style="background:#fab219"></span>! Late<span class="t-val">${d.late}</span></div>
          <div class="t-row"><span class="swatch" style="background:#d03b3b"></span>✕ Absent<span class="t-val">${d.absent}</span></div>`,
  }));
  trendLine($('#trendChart'), points, { yLabel: 'Class attendance' });
  $('#trendTable').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th class="tnum">Present</th><th class="tnum">Late</th><th class="tnum">Absent</th><th class="tnum">Attendance</th></tr></thead>
      <tbody>${o.daily.length ? o.daily.slice().reverse().map((d) => `
        <tr><td>${fmtDate(d.date)}</td><td class="tnum">${d.present}</td><td class="tnum">${d.late}</td>
        <td class="tnum">${d.absent}</td><td class="tnum">${d.percent}%</td></tr>`).join('')
        : '<tr><td colspan="5" class="table-empty">No class days yet.</td></tr>'}
      </tbody></table></div>`;

  /* summary table */
  $('#summaryTable tbody').innerHTML = o.rows.length
    ? o.rows.slice().sort((a, b) => a.percent - b.percent).map((r) => `
      <tr style="cursor:pointer" data-open="${r.student.id}">
        <td>${who(r.student)}</td>
        <td class="small">${esc(r.student.batchName || '—')}</td>
        <td class="tnum">${r.present}</td>
        <td class="tnum">${r.late}</td>
        <td class="tnum">${r.absent}</td>
        <td class="tnum">${r.total}</td>
        <td>${meter(r.percent)}</td>
        <td class="tnum">${r.streak}</td>
        <td class="small">${fmtDateTime(r.lastSeen)}</td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="table-empty">No students yet.</td></tr>';

  $$('#summaryTable [data-open]').forEach((tr) =>
    tr.addEventListener('click', () => openStudent(tr.dataset.open)));
}

$('#applyRange').addEventListener('click', loadOverview);
$('#clearRange').addEventListener('click', () => {
  $('#fromDate').value = '';
  $('#toDate').value = '';
  $$('#quickRange button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  loadOverview();
});
$$('#quickRange button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const days = Number(btn.dataset.days);
    const from = new Date();
    from.setDate(from.getDate() - days + 1);
    $('#fromDate').value = localDate(from);
    $('#toDate').value = localDate(new Date());
    $$('#quickRange button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    loadOverview();
  });
});

$$('.viewtoggle').forEach((group) => {
  const key = group.dataset.toggle;
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $$('button', group).forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    const showTable = btn.dataset.mode === 'table';
    $(`#${key}Chart`).hidden = showTable;
    $(`#${key}Table`).hidden = !showTable;
    const lg = $(`#${key}Legend`);
    if (lg) lg.hidden = showTable;
  });
});

/* ================================================================== LOG = */

async function loadLog() {
  try {
    const qs = rangeQuery('logFrom', 'logTo');
    const { entries } = await api('/api/admin/log' + (qs ? `?${qs}` : ''));
    $('#logTable tbody').innerHTML = entries.length ? entries.map((e) => `
      <tr>
        <td class="small">${fmtDate(e.date)}</td>
        <td>${e.student ? who(e.student) : '—'}</td>
        <td class="small">${esc(e.student ? e.student.batchName || '—' : '—')}</td>
        <td>${statusPill(e.status)}</td>
        <td class="small">${fmtDateTime(e.markedAt)}</td>
        <td class="small">${e.source === 'admin' ? 'Teacher' : 'Student'}</td>
        <td class="small muted">${esc(e.ip || '—')}</td>
      </tr>`).join('')
      : '<tr><td colspan="7" class="table-empty">No attendance recorded in this range.</td></tr>';
  } catch (err) {
    toast(err.message, 'error');
  }
}
$('#logApply').addEventListener('click', loadLog);
$('#logClear').addEventListener('click', () => {
  $('#logFrom').value = '';
  $('#logTo').value = '';
  loadLog();
});

/* ================================================================= BOOT = */

(async function boot() {
  const user = await guardPage('admin');
  if (!user) return;
  ME = user;
  $('#chipName').textContent = user.name || user.email;
  $('#chipAvatar').textContent = initials(user.name || user.email);

  await loadOverview();
  showView('dashboard');

  document.addEventListener('themechange', () => { if (OVERVIEW) renderReports(); });
})();

/* ------------------------------------------------- filling in past days --- */
/* Classes ran before the portal did. This lets a teacher record those days so
   they appear in every report — without it, a student's percentage only covers
   the period since they signed up. */

let BACKFILL_ROWS = [];
let BACKFILL_SET = new Map();          // "userId|date" -> chosen status
let BACKFILL_DATA = null;              // the last reply, so a page turn can redraw
let BACKFILL_PAGE = 1;

const backfillKey = (row) => `${row.student.id}|${row.date}`;

$('#backfillToggle').addEventListener('click', async () => {
  const body = $('#backfillBody');
  const open = body.classList.toggle('hidden');
  $('#backfillToggle').textContent = open ? 'Open' : 'Close';

  // The batch list is fetched by the Batches tab. A teacher who opens this
  // straight from Today has never been there, so the dropdown would hold
  // nothing but "All batches".
  if (!open && !BATCHES.length) await loadBatches();

  if (!open && !$('#backfillFrom').value) {
    // Default to the last week, ending yesterday — today is already covered by
    // the roll call above.
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const end = new Date();
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    $('#backfillFrom').value = iso(start);
    $('#backfillTo').value = iso(end);
    $('#backfillFrom').max = iso(new Date());
    $('#backfillTo').max = iso(new Date());
  }
});

$('#backfillLoad').addEventListener('click', loadBackfill);
for (const id of ['#backfillFrom', '#backfillTo', '#backfillBatch', '#backfillIncludeAbsent']) {
  $(id).addEventListener('change', () => { if (BACKFILL_ROWS.length) loadBackfill(); });
}

async function loadBackfill() {
  const from = $('#backfillFrom').value;
  const to = $('#backfillTo').value;
  if (!from || !to) { toast('Pick a from date and a to date.', 'error'); return; }
  if (from > to) { toast('The from date must come before the to date.', 'error'); return; }

  const batchId = $('#backfillBatch').value;
  $('#backfillResult').innerHTML = '<p class="small muted">Loading…</p>';
  BACKFILL_SET = new Map();
  BACKFILL_PAGE = 1;

  try {
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      + (batchId ? `&batchId=${encodeURIComponent(batchId)}` : '')
      + ($('#backfillIncludeAbsent').checked ? '&includeAbsent=1' : '');
    const data = await api(`/api/admin/attendance/gaps?${q}`);
    BACKFILL_ROWS = data.rows;
    renderBackfill(data);
  } catch (err) {
    BACKFILL_ROWS = [];
    $('#backfillResult').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
}

function renderBackfill(data) {
  BACKFILL_DATA = data;
  if (!data.rows.length) {
    $('#backfillResult').innerHTML = `
      <div class="alert success">
        Nothing to fill in — every student already has a record on every class
        day between ${fmtDate(data.from)} and ${fmtDate(data.to)}.
        ${data.includeAbsent ? '' : 'Days marked absent are not counted as missing.'}
      </div>`;
    return;
  }

  const { counts } = data;
  const slice = pageSlice(data.rows, BACKFILL_PAGE);
  BACKFILL_PAGE = slice.page;

  $('#backfillResult').innerHTML = `
    <div class="alert info">
      <b>${data.rows.length} record${data.rows.length === 1 ? '' : 's'} to fill in</b>
      — ${counts.students} student${counts.students === 1 ? '' : 's'}
      across ${counts.days} class day${counts.days === 1 ? '' : 's'}.
      ${data.includeAbsent
        ? `${counts.missing} never recorded, ${counts.absent} marked absent.`
        : 'Every one of these has no record at all — not present, late or absent.'}
    </div>
    ${data.truncated ? `
      <div class="alert warn">
        Showing the first ${data.rows.length} of ${data.total}. Narrow the range or
        pick one batch to see the rest — the ones not shown are not saved.
      </div>` : ''}

    <div class="pick-toolbar">
      <button class="btn" id="backfillSave" disabled>Save changes</button>
      <button type="button" class="btn ghost sm" data-all="present">Set all present</button>
      <button type="button" class="btn ghost sm" data-all="late">Set all late</button>
      <button type="button" class="btn ghost sm" data-all="absent">Set all absent</button>
      <button type="button" class="btn ghost sm" data-all="reset">Undo changes</button>
      <span class="small muted" id="backfillCount">nothing changed yet</span>
    </div>
    <p class="small muted" style="margin:-6px 0 12px">
      "Set all" covers every record found, not just this page. Your choices are
      kept while you turn pages — Save writes them all in one go.
    </p>

    <div class="table-wrap"><table>
      <thead><tr>
        <th>Date</th><th>Student</th><th>Batch</th><th>Recorded</th><th>Set to</th>
      </tr></thead>
      <tbody>${slice.rows.map((r) => `
        <tr data-key="${esc(backfillKey(r))}">
          <td class="small">${fmtDate(r.date)}<br /><span class="muted">${esc(r.weekday)}</span></td>
          <td>${who(r.student)}</td>
          <td class="small">${esc(r.student.batchName || '—')}</td>
          <td>${r.status
            ? statusPill(r.status)
            : '<span class="small muted">not recorded</span>'}</td>
          <td>
            <div class="setter" role="group" aria-label="Set status">
              <button type="button" data-set="present" title="Present">✓</button>
              <button type="button" data-set="late"    title="Late">!</button>
              <button type="button" data-set="absent"  title="Absent">✕</button>
              <button type="button" data-set="clear"   title="Remove the record">−</button>
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>

    <div id="backfillPager">${pagerHTML(slice)}</div>`;

  wirePager($('#backfillPager'), slice, (p) => {
    BACKFILL_PAGE = p;
    renderBackfill(data);                       // choices live in BACKFILL_SET
    $('#backfillResult').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  $$('#backfillResult [data-set]').forEach((b) => {
    b.addEventListener('click', () => {
      const row = b.closest('tr');
      const key = row.dataset.key;
      const status = b.dataset.set;
      if (BACKFILL_SET.get(key) === status) BACKFILL_SET.delete(key);
      else BACKFILL_SET.set(key, status);
      paintBackfillRow(row);
      updateBackfillCount();
    });
  });

  $$('#backfillResult [data-all]').forEach((b) => {
    b.addEventListener('click', () => {
      const what = b.dataset.all;
      if (what === 'reset') BACKFILL_SET.clear();
      else data.rows.forEach((r) => BACKFILL_SET.set(backfillKey(r), what));
      $$('#backfillResult tbody tr').forEach(paintBackfillRow);
      updateBackfillCount();
    });
  });

  $('#backfillSave').addEventListener('click', saveBackfill);

  // A page turn redraws the table, so re-show what was already chosen.
  $$('#backfillResult tbody tr').forEach(paintBackfillRow);
  updateBackfillCount();
}

function paintBackfillRow(row) {
  const chosen = BACKFILL_SET.get(row.dataset.key) || null;
  row.classList.toggle('changed', Boolean(chosen));
  $$('[data-set]', row).forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.set === chosen)));
}

function updateBackfillCount() {
  const n = BACKFILL_SET.size;
  const save = $('#backfillSave');
  const count = $('#backfillCount');
  if (count) {
    count.textContent = n ? `${n} record${n === 1 ? '' : 's'} to save` : 'nothing changed yet';
  }
  if (save) save.disabled = n === 0;
}

/**
 * Saved in chunks. A month of back-fill can be thousands of records, and one
 * giant request is the thing most likely to time out — several smaller ones
 * finish, and a failure part-way tells the teacher exactly how far it got.
 */
async function saveBackfill() {
  const btn = $('#backfillSave');
  const entries = [...BACKFILL_SET].map(([key, status]) => {
    const [userId, date] = key.split('|');
    return { userId, date, status };
  });

  const CHUNK = 300;
  let saved = 0;
  let cleared = 0;
  const problems = [];

  btn.disabled = true;
  try {
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      btn.textContent = entries.length > CHUNK
        ? `Saving ${Math.min(i + CHUNK, entries.length)} of ${entries.length}…`
        : 'Saving…';
      const res = await api('/api/admin/attendance/bulk', {
        method: 'POST', body: { entries: slice },
      });
      saved += res.saved || 0;
      cleared += res.cleared || 0;
      if (res.problems) problems.push(...res.problems);
    }

    toast(`Saved ${saved} record${saved === 1 ? '' : 's'}${cleared ? `, cleared ${cleared}` : ''}.`, 'ok');
    if (problems.length) toast(`${problems.length} could not be saved.`, 'warn');

    await loadBackfill();
    loadOverview();
  } catch (err) {
    toast(saved
      ? `${saved} saved, then it stopped: ${err.message}`
      : err.message, 'error');
    await loadBackfill();
  } finally {
    btn.textContent = 'Save changes';
    updateBackfillCount();
  }
}
