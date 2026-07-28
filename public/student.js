/* Student portal. */

let ME = null;
let SNAP = null;              // { user, window, todayMark, report }
let REPORT = null;            // report for the selected date range
let calCursor = new Date();   // month shown in the calendar
let GRACE_MINUTES = 15;       // fixed by the server; sent with the dashboard

/* ------------------------------------------------------------ navigation */

function showView(name) {
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  if (name === 'report') { loadReport(); loadExamHistory(); }
  if (name === 'exams') { loadExamList(); showExamScreen('list'); }
}

$$('#tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('#logoutBtn').addEventListener('click', logout);

/* ---------------------------------------------------------------- header */

function paintChip(user) {
  $('#chipName').textContent = user.name || user.email;
  $('#chipMeta').textContent = `${user.regNo}${user.batchName ? ` · ${user.batchName}` : ''}`;
  $('#chipAvatar').textContent = initials(user.name || user.email);
}

/* ================================================================ SETUP = */

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let chosenBatchId = null;

function renderBatchChoices(batches) {
  const mount = $('#batchChoices');
  if (!batches.length) {
    mount.innerHTML = `
      <div class="alert error" style="margin:0">
        <span class="ico" aria-hidden="true">⚠</span>
        <span>No batches have been set up yet. Your teacher creates these in the
        Teacher portal — please check back shortly.</span>
      </div>`;
    $('#joinBatchBtn').disabled = true;
    return;
  }

  mount.innerHTML = batches.map((b) => `
    <label class="batch-option">
      <input type="radio" name="batch" value="${esc(b.id)}" />
      <div class="body">
        <b>${esc(b.name)}</b>
        ${b.course ? `<span class="course">${esc(b.course)}</span>` : ''}
        <span class="time">${fmtClock(b.classStart)} – ${fmtClock(b.classEnd)}</span>
        <span class="days">${esc(daysLabel(b.classDays))}</span>
        ${b.notes ? `<span class="notes">${esc(b.notes)}</span>` : ''}
      </div>
    </label>`).join('');

  $$('#batchChoices input').forEach((input) => {
    input.addEventListener('change', () => {
      chosenBatchId = input.value;
      $('#joinBatchBtn').disabled = false;
    });
  });
}

$('#joinBatchBtn').addEventListener('click', async () => {
  if (!chosenBatchId) return;
  const btn = $('#joinBatchBtn');
  btn.disabled = true;
  try {
    const res = await api('/api/student/profile', {
      method: 'POST',
      body: { batchId: chosenBatchId },
    });
    ME = res.user;
    toast(res.message || 'Batch saved.', 'ok');
    await refresh();
    showView('mark');
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
});

/* ================================================================= MARK = */

function renderMark() {
  const { user, window: win, todayMark, report } = SNAP;

  $('#markAvatar').textContent = initials(user.name || user.email);
  $('#markGreeting').textContent = `Hello, ${(user.name || '').split(' ')[0] || 'there'}`;
  $('#markWhen').textContent = new Date().toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }) + (user.batch ? ` · ${user.batch.name} ${fmtClock(user.batch.classStart)}–${fmtClock(user.batch.classEnd)}` : '');

  const action = $('#markAction');
  const note = $('#markNote');

  if (todayMark) {
    const meta = STATUS[todayMark.status];
    action.innerHTML = `<div class="result-badge ${todayMark.status}">
        <span class="ico" aria-hidden="true">${meta.icon}</span>
        You are marked ${meta.label.toUpperCase()} today
      </div>`;
    note.textContent = `Recorded at ${fmtTime(todayMark.markedAt)}${todayMark.source === 'admin' ? ' by your teacher' : ''}.`;
  } else if (win.canMark) {
    const willBe = STATUS[win.wouldBe];
    action.innerHTML = `<button class="btn xl" id="markBtn">
        <span aria-hidden="true">${willBe.icon}</span> Mark me ${willBe.label.toLowerCase()}
      </button>`;
    note.textContent = win.message;
    $('#markBtn').addEventListener('click', markAttendance);
  } else {
    const cls = win.phase === 'closed' ? 'absent' : 'pending';
    action.innerHTML = `<div class="result-badge ${cls === 'absent' ? 'absent' : ''}"
        style="${cls === 'pending' ? 'background:var(--surface-2);border-color:var(--line-strong);color:var(--ink-2)' : ''}">
        <span class="ico" aria-hidden="true">${win.phase === 'closed' ? '✕' : '○'}</span>
        ${win.phase === 'closed' ? 'Attendance closed for today'
          : win.phase === 'not-class-day' ? 'No class today'
          : 'Attendance not open yet'}
      </div>`;
    note.textContent = win.message;
  }

  renderTimeline(user, win, todayMark);
  renderMarkStats(report);
  renderCalendar();
}

function renderTimeline(user, win, todayMark) {
  const timeline = $('#markTimeline');
  const labels = $('#markTimelineLabels');
  const show = Boolean(user.batch && user.batch.classStart) && win.phase !== 'not-class-day';
  timeline.style.display = show ? '' : 'none';
  labels.style.display = show ? '' : 'none';
  if (!show) return;

  const graceEnd = addMinutes(user.batch.classStart, GRACE_MINUTES);
  const phase = todayMark ? todayMark.status : win.phase;

  const segments = { present: false, late: false, over: false };
  if (phase === 'present') segments.present = true;
  else if (phase === 'late') { segments.present = true; segments.late = true; }
  else if (phase === 'closed' || phase === 'absent') { segments.present = segments.late = segments.over = true; }

  $$('#markTimeline .seg').forEach((seg) => {
    seg.className = `seg ${segments[seg.dataset.seg] ? `on ${seg.dataset.seg}` : ''}`;
  });

  labels.innerHTML = `
    <span>${fmtClock(user.batch.classStart)} start</span>
    <span>${fmtClock(graceEnd)} late after</span>
    <span>${fmtClock(user.batch.classEnd)} closes</span>`;
}

function addMinutes(hhmm, minutes) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const total = ((h * 60 + m + Number(minutes)) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function renderMarkStats(report) {
  $('#markStats').innerHTML = [
    { label: 'Attendance', value: `${report.percent}%`, foot: `${report.attended} of ${report.total} class days`, tone: report.percent >= 75 ? 'good' : report.percent >= 50 ? 'warn' : 'bad' },
    { label: 'Present', value: report.present, foot: 'on time', tone: 'good' },
    { label: 'Late', value: report.late, foot: 'after grace period', tone: 'warn' },
    { label: 'Absent', value: report.absent, foot: 'missed classes', tone: 'bad' },
    { label: 'Current streak', value: report.streak, foot: `best ${report.bestStreak}`, tone: 'accent' },
  ].map((s) => `
    <div class="stat ${s.tone}">
      <div class="label">${s.label}</div>
      <div class="value">${s.value}</div>
      <div class="foot">${s.foot}</div>
    </div>`).join('');
}

async function markAttendance() {
  const btn = $('#markBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const res = await api('/api/student/attendance', { method: 'POST' });
    SNAP = { user: res.user, window: res.window, todayMark: res.todayMark, report: res.report };
    ME = res.user;
    toast(res.message, res.already ? 'warn' : res.record.status === 'late' ? 'warn' : 'ok');
    renderMark();
  } catch (err) {
    toast(err.message, 'error');
    await refresh();
  }
}

/* -------------------------------------------------------------- calendar */

function renderCalendar() {
  const { user, report } = SNAP;
  const byDate = new Map(report.daily.map((d) => [d.date, d]));

  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  $('#calLabel').textContent = calCursor.toLocaleDateString([], { month: 'short', year: 'numeric' });

  const startPad = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = localDate();

  const cells = DAY_LABELS.map((d, i) =>
    `<div class="dow${i === 0 || i === 6 ? ' weekend' : ''}">${d}</div>`);
  for (let i = 0; i < startPad; i++) cells.push('<div class="day out"></div>');

  let weekendCount = 0;
  let holidayCount = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dow = new Date(`${date}T00:00:00`).getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isClassDay = user.batch && (user.batch.classDays || []).includes(dow);
    const entry = byDate.get(date);

    let cls = 'day';
    let icon = '';
    let title = fmtDate(date);

    if (entry) {
      cls += ` ${entry.status}`;
      icon = STATUS[entry.status].icon;
      title += ` — ${STATUS[entry.status].label}${entry.markedAt ? ` at ${fmtTime(entry.markedAt)}` : ''}`;
    } else if (isWeekend) {
      cls += ' weekend';
      title += ' — weekend holiday';
      weekendCount++;
    } else if (!isClassDay) {
      cls += ' noclass';
      title += ' — no class for your batch';
      holidayCount++;
    } else if (date > today) {
      cls += ' upcoming';
      title += ' — upcoming class';
    }
    if (date === today) cls += ' today';

    cells.push(`<div class="${cls}" title="${esc(title)}">
      ${icon ? `<span class="mk" aria-hidden="true">${icon}</span>` : ''}${day}
    </div>`);
  }

  $('#calendar').innerHTML = cells.join('');
  renderCalLegend(weekendCount + holidayCount);
}

/** Status swatches plus the holiday and upcoming markers the calendar adds. */
function renderCalLegend(holidays) {
  $('#calLegend').innerHTML = [
    ['present', '✓', 'Present'],
    ['late', '!', 'Late'],
    ['absent', '✕', 'Absent'],
    ['holiday', '—', `Holiday${holidays ? ` (${holidays})` : ''}`],
    ['upcoming', '', 'Upcoming'],
  ].map(([swatch, icon, label]) => `
    <span class="item">
      <span class="swatch ${swatch}"></span>
      ${icon ? `<span aria-hidden="true">${icon}</span>` : ''}
      ${label}
    </span>`).join('');
}

$('#calPrev').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); });
$('#calNext').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); });

/* =============================================================== REPORT = */

function rangeQuery() {
  const params = new URLSearchParams();
  if ($('#fromDate').value) params.set('from', $('#fromDate').value);
  if ($('#toDate').value) params.set('to', $('#toDate').value);
  return params.toString();
}

async function loadReport() {
  try {
    const qs = rangeQuery();
    const res = await api('/api/student/report' + (qs ? `?${qs}` : ''));
    REPORT = res.report;
    renderReport();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderReport() {
  const r = REPORT;

  $('#reportStats').innerHTML = [
    { label: 'Attendance', value: `${r.percent}%`, foot: `${r.attended} of ${r.total} class days`, tone: r.percent >= 75 ? 'good' : r.percent >= 50 ? 'warn' : 'bad' },
    { label: 'Punctuality', value: `${r.punctuality}%`, foot: 'of attended days were on time', tone: 'accent' },
    { label: 'Present', value: r.present, foot: 'on time', tone: 'good' },
    { label: 'Late', value: r.late, foot: 'arrived after grace', tone: 'warn' },
    { label: 'Absent', value: r.absent, foot: 'missed', tone: 'bad' },
    { label: 'Best streak', value: r.bestStreak, foot: `current ${r.streak}`, tone: 'accent' },
  ].map((s) => `
    <div class="stat ${s.tone}">
      <div class="label">${s.label}</div>
      <div class="value">${s.value}</div>
      <div class="foot">${s.foot}</div>
    </div>`).join('');

  /* donut */
  donut($('#donutChart'), r);
  legend($('#donutLegend'), { present: r.present, late: r.late, absent: r.absent });
  $('#donutTable').innerHTML = statusTable(r);

  /* monthly stacked bars */
  const months = r.monthly.map((m) => ({ ...m, label: fmtMonth(m.month) }));
  stackedBars($('#monthlyChart'), months);
  legend($('#monthlyLegend'));
  $('#monthlyTable').innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Month</th><th class="tnum">Present</th><th class="tnum">Late</th><th class="tnum">Absent</th><th class="tnum">Class days</th><th class="tnum">Attendance</th></tr></thead>
      <tbody>${months.length ? months.map((m) => `
        <tr><td>${esc(m.label)}</td><td class="tnum">${m.present}</td><td class="tnum">${m.late}</td>
        <td class="tnum">${m.absent}</td><td class="tnum">${m.total}</td><td class="tnum">${m.percent}%</td></tr>`).join('')
        : '<tr><td colspan="6" class="table-empty">No months yet.</td></tr>'}
      </tbody>
    </table></div>`;

  /* running attendance */
  let attended = 0;
  const points = r.daily.map((d, i) => {
    if (d.status !== 'absent') attended++;
    const value = Math.round((attended / (i + 1)) * 1000) / 10;
    return {
      label: fmtDateShort(d.date),
      title: fmtDate(d.date),
      value,
      tip: `<div class="t-row"><span class="swatch" style="background:${STATUS[d.status].color}"></span>
              ${STATUS[d.status].icon} ${STATUS[d.status].label}<span class="t-val">${value}%</span></div>`,
    };
  });
  trendLine($('#trendChart'), points, { yLabel: 'Running attendance' });
  $('#trendTable').innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Status</th><th class="tnum">Running %</th></tr></thead>
      <tbody>${points.length ? points.map((p, i) => `
        <tr><td>${esc(p.title)}</td><td>${statusPill(r.daily[i].status)}</td><td class="tnum">${p.value}%</td></tr>`).join('')
        : '<tr><td colspan="3" class="table-empty">No class days yet.</td></tr>'}
      </tbody>
    </table></div>`;

  /* day by day */
  const rows = r.daily.slice().reverse();
  $('#dailyTable tbody').innerHTML = rows.length
    ? rows.map((d) => `
      <tr>
        <td>${fmtDate(d.date)}</td>
        <td>${DAY_LABELS[new Date(`${d.date}T00:00:00`).getDay()]}</td>
        <td>${statusPill(d.status)}</td>
        <td>${fmtTime(d.markedAt)}</td>
        <td>${d.source === 'admin' ? 'Teacher' : d.source === 'self' ? 'You' : '—'}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="table-empty">No class days in this range yet.</td></tr>';
}

function statusTable(r) {
  const rows = [
    ['present', r.present], ['late', r.late], ['absent', r.absent],
  ];
  return `<div class="table-wrap"><table>
    <thead><tr><th>Status</th><th class="tnum">Days</th><th class="tnum">Share</th></tr></thead>
    <tbody>${rows.map(([key, value]) => `
      <tr><td>${statusPill(key)}</td><td class="tnum">${value}</td>
      <td class="tnum">${r.total ? Math.round((value / r.total) * 1000) / 10 : 0}%</td></tr>`).join('')}
      <tr><td><strong>Total class days</strong></td><td class="tnum"><strong>${r.total}</strong></td><td class="tnum">100%</td></tr>
    </tbody>
  </table></div>`;
}

/* chart / table toggles */
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

$('#applyRange').addEventListener('click', loadReport);
$('#clearRange').addEventListener('click', () => {
  $('#fromDate').value = '';
  $('#toDate').value = '';
  $$('#quickRange button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  loadReport();
});
$$('#quickRange button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const days = Number(btn.dataset.days);
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days + 1);
    $('#fromDate').value = localDate(from);
    $('#toDate').value = localDate(to);
    $$('#quickRange button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    loadReport();
  });
});

/* ============================================================== PROFILE = */

function renderProfile() {
  const u = ME;
  $('#contactForm').name.value = u.name || '';
  $('#contactForm').phone.value = u.phone || '';
  $('#profileEmail').value = u.email;

  const b = u.batch;
  $('#classSummary').innerHTML = `
    <dl style="display:grid;grid-template-columns:auto 1fr;gap:10px 18px;margin:0">
      ${[
        ['Registration no.', u.regNo],
        ['Batch', b ? b.name : 'Not set'],
        ['Course', b && b.course ? b.course : 'Not set'],
        ['Class time', b ? `${fmtClock(b.classStart)} – ${fmtClock(b.classEnd)}` : 'Not set'],
        ['Class days', b ? daysLabel(b.classDays) : 'Not set'],
        ['Late after', `${GRACE_MINUTES} minutes past start`],
        ['Joined', fmtDate(u.createdAt)],
      ].map(([k, v]) => `<dt class="small muted">${k}</dt><dd style="margin:0;font-weight:550">${esc(v)}</dd>`).join('')}
      ${b && b.notes ? `<dt class="small muted">Notes</dt><dd style="margin:0">${esc(b.notes)}</dd>` : ''}
    </dl>
    <p class="small muted" style="margin-top:16px">
      Your batch decides the class time and days. Only your teacher can change a
      batch or move you to a different one.
    </p>`;
}

$('#contactForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  try {
    const res = await api('/api/student/contact', { method: 'POST', body: data });
    ME = res.user;
    paintChip(ME);
    renderProfile();
    toast('Details saved.', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    await api('/api/auth/change-password', { method: 'POST', body: data });
    form.reset();
    toast('Password changed.', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ================================================================= BOOT = */

async function refresh() {
  const data = await api('/api/student/dashboard');
  SNAP = data;
  ME = data.user;
  if (data.graceMinutes) GRACE_MINUTES = data.graceMinutes;
  paintChip(ME);

  if (!ME.batchId) {
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-setup'; });
    $('#tabs').style.visibility = 'hidden';
    renderBatchChoices(data.batches || []);
    return false;
  }

  $('#tabs').style.visibility = '';
  renderMark();
  renderProfile();
  return true;
}

(async function boot() {
  const user = await guardPage('student');
  if (!user) return;

  try {
    const ready = await refresh();
    if (ready) showView('mark');
  } catch (err) {
    toast(err.message, 'error');
  }

  // Keep the mark tab honest as the class window opens and closes.
  setInterval(async () => {
    if ($('#view-mark').hidden || !ME || !ME.batchId) return;
    try { await refresh(); } catch { /* transient */ }
  }, 60000);

  document.addEventListener('themechange', () => {
    if (REPORT && !$('#view-report').hidden) renderReport();
  });
})();
