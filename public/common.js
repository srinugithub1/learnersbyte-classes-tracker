/* Shared helpers: API calls, escaping, toasts, status vocabulary. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(pathname, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(pathname, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;          // some refusals carry detail worth showing
    throw err;
  }
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const initials = (name) => String(name || '?')
  .trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

/* Status vocabulary — icon + label travel with the colour everywhere, because
   present and absent are nearly identical for red-green colourblind readers. */
const STATUS = {
  present: { label: 'Present', icon: '✓', color: '#0ca30c' },
  late:    { label: 'Late',    icon: '!', color: '#fab219' },
  absent:  { label: 'Absent',  icon: '✕', color: '#d03b3b' },
  pending: { label: 'Not marked yet', icon: '○', color: '#7b849e' },
  'no-class': { label: 'No class', icon: '–', color: '#7b849e' },
};

const statusPill = (status) => {
  const s = STATUS[status] || STATUS.pending;
  const cls = ['present', 'late', 'absent'].includes(status) ? status : 'pending';
  return `<span class="pill ${cls}"><span class="ico" aria-hidden="true">${s.icon}</span>${s.label}</span>`;
};

function toast(message, kind = 'ok') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast show ${kind}`;
  el.textContent = message;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.className = 'toast'; }, 4200);
}

/* ------------------------------------------------------------ formatting */

const pad2 = (n) => String(n).padStart(2, '0');

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const fmtTime = (iso) => (iso
  ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  : '—');

const fmtDate = (value) => (value
  ? new Date(`${String(value).slice(0, 10)}T00:00:00`)
    .toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
  : '—');

const fmtDateShort = (value) => (value
  ? new Date(`${String(value).slice(0, 10)}T00:00:00`)
    .toLocaleDateString([], { day: '2-digit', month: 'short' })
  : '—');

const fmtDateTime = (iso) => (iso
  ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

const fmtMonth = (ym) => (ym
  ? new Date(`${ym}-01T00:00:00`).toLocaleDateString([], { month: 'short', year: '2-digit' })
  : '');

function fmtClock(hhmm) {
  if (!hhmm) return '—';
  const [h, m] = String(hhmm).split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(m)} ${suffix}`;
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const daysLabel = (days) => (days && days.length
  ? days.slice().sort().map((d) => DAY_SHORT[d]).join(', ')
  : 'Not set');

const meterClass = (percent) => (percent >= 75 ? 'good' : percent >= 50 ? 'mid' : 'bad');

function meter(percent) {
  return `<div class="meter">
    <div class="track"><div class="fill ${meterClass(percent)}" style="width:${Math.max(0, Math.min(100, percent))}%"></div></div>
    <b>${percent}%</b>
  </div>`;
}

/* --------------------------------------------------------------- session */

async function loadMe() {
  try {
    const { user } = await api('/api/auth/me');
    return user;
  } catch {
    return null;
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* leaving anyway */ }
  location.href = '/';
}

/** Sends the visitor to the page their role belongs on. */
function routeFor(user) {
  if (!user) return '/';
  return user.role === 'admin' ? '/admin.html' : '/student.html';
}

async function guardPage(expectedRole) {
  const user = await loadMe();
  if (!user) { location.replace('/'); return null; }
  if (expectedRole && user.role !== expectedRole) { location.replace(routeFor(user)); return null; }
  return user;
}

/* ----------------------------------------------------------- theme toggle */

function initTheme() {
  const saved = localStorage.getItem('udayanTheme');
  if (saved === 'dark' || saved === 'light') {
    document.documentElement.setAttribute('data-theme', saved);
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.hasAttribute('data-theme')
        && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('udayanTheme', next);
    document.dispatchEvent(new CustomEvent('themechange'));
  });
}
initTheme();
