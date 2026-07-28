/* Hand-rolled SVG charts — no libraries.
 *
 * Encoding rules followed here:
 *  - present / late / absent use the fixed status tokens, ALWAYS with an icon
 *    and text label, because present(green) and absent(red) sit only ΔE 4.1
 *    apart under deuteranopia. Absent segments also carry a diagonal hatch, so
 *    the distinction survives with no colour vision at all.
 *  - Single-series charts use one colour for every mark and carry no legend
 *    (the title names the series).
 *  - Hairline solid grid, 2px lines, 2px surface gaps between stacked fills,
 *    selective direct labels, and a hover tooltip on every plot.
 *  - Every chart has a table-view twin, so no value is reachable only by hover.
 */

const CHART = {
  present: '#0ca30c',
  late: '#fab219',
  absent: '#d03b3b',
  get series1() {
    return getComputedStyle(document.documentElement).getPropertyValue('--series-1').trim() || '#2a78d6';
  },
  get surface() {
    return getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#ffffff';
  },
};

const STATUS_ORDER = ['present', 'late', 'absent'];
const STATUS_META = {
  present: { label: 'Present', icon: '✓' },
  late: { label: 'Late', icon: '!' },
  absent: { label: 'Absent', icon: '✕' },
};

/* ------------------------------------------------------------- tooltip */

let tipEl = null;
function tip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function showTip(evt, html) {
  const el = tip();
  el.innerHTML = html;
  el.classList.add('show');
  const box = el.getBoundingClientRect();
  let x = evt.clientX + 14;
  let y = evt.clientY - box.height - 12;
  if (x + box.width > innerWidth - 8) x = evt.clientX - box.width - 14;
  if (y < 8) y = evt.clientY + 18;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${y}px`;
}
const hideTip = () => tip().classList.remove('show');

function attachTip(node, htmlFactory) {
  node.addEventListener('mouseenter', (e) => showTip(e, htmlFactory()));
  node.addEventListener('mousemove', (e) => showTip(e, htmlFactory()));
  node.addEventListener('mouseleave', hideTip);
  node.addEventListener('focus', (e) => {
    const r = node.getBoundingClientRect();
    showTip({ clientX: r.left + r.width / 2, clientY: r.top }, htmlFactory());
  });
  node.addEventListener('blur', hideTip);
}

const tipRow = (color, label, value) =>
  `<div class="t-row"><span class="swatch" style="background:${color}"></span>${label}<span class="t-val">${value}</span></div>`;

/* --------------------------------------------------------------- helpers */

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/** Diagonal hatch so "absent" is distinguishable without colour vision. */
function hatchDefs(id) {
  const defs = el('defs');
  const pattern = el('pattern', {
    id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
  });
  pattern.appendChild(el('rect', { width: 6, height: 6, fill: CHART.absent }));
  pattern.appendChild(el('rect', { width: 2.4, height: 6, fill: 'rgba(255,255,255,.55)' }));
  defs.appendChild(pattern);
  return defs;
}

const fillFor = (status, hatchId) =>
  (status === 'absent' && hatchId ? `url(#${hatchId})` : CHART[status]);

let uid = 0;
const nextId = () => `ch${++uid}`;

/* =========================================================== DONUT ====== */
/* Part-to-whole at a glance, 3 segments, every segment directly labelled. */

function donut(mount, { present = 0, late = 0, absent = 0 }) {
  mount.innerHTML = '';
  const total = present + late + absent;
  const values = { present, late, absent };

  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const r = 84;
  const thickness = 26;
  const hatchId = nextId();

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${size} ${size}`,
    role: 'img', 'aria-label':
      `Attendance breakdown: ${present} present, ${late} late, ${absent} absent, out of ${total} class days.`,
  });
  svg.appendChild(hatchDefs(hatchId));

  if (!total) {
    svg.appendChild(el('circle', {
      cx, cy, r, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': thickness,
    }));
    const empty = el('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', class: 'value-label' });
    empty.textContent = 'No data yet';
    svg.appendChild(empty);
    mount.appendChild(svg);
    return;
  }

  // 2px surface gap between segments — a gap, never a stroke around the mark.
  const gapDeg = total > 1 ? 1.6 : 0;
  let angle = -90;

  for (const key of STATUS_ORDER) {
    const value = values[key];
    if (!value) continue;
    const sweep = (value / total) * 360 - gapDeg;
    if (sweep <= 0) continue;

    const path = el('path', {
      d: arcPath(cx, cy, r, angle, angle + sweep),
      fill: 'none',
      stroke: fillFor(key, hatchId),
      'stroke-width': thickness,
      tabindex: '0',
      role: 'listitem',
    });
    const pct = Math.round((value / total) * 1000) / 10;
    attachTip(path, () => `<div class="t-title">${STATUS_META[key].icon} ${STATUS_META[key].label}</div>` +
      tipRow(CHART[key], `${value} of ${total} days`, `${pct}%`));
    svg.appendChild(path);
    angle += sweep + gapDeg;
  }

  const attended = present + late;
  const pct = Math.round((attended / total) * 1000) / 10;

  const big = el('text', { x: cx, y: cy - 2, 'text-anchor': 'middle' });
  big.setAttribute('style', 'font-size:30px;font-weight:680;fill:var(--ink)');
  big.textContent = `${pct}%`;
  svg.appendChild(big);

  const sub = el('text', { x: cx, y: cy + 19, 'text-anchor': 'middle', class: 'axis-label' });
  sub.textContent = `${attended} of ${total} days`;
  svg.appendChild(sub);

  mount.appendChild(svg);
}

function arcPath(cx, cy, r, startDeg, endDeg) {
  const toXY = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x1, y1] = toXY(startDeg);
  const [x2, y2] = toXY(endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

/* ====================================================== TREND (line) ==== */
/* One series (attendance %) — one colour, no legend, crosshair on hover. */

function trendLine(mount, points, { yLabel = 'Attendance %' } = {}) {
  mount.innerHTML = '';
  if (!points.length) return emptyPlot(mount, 'No class days in this range yet.');

  const W = 720;
  const H = 240;
  const P = { top: 16, right: 18, bottom: 30, left: 40 };
  const innerW = W - P.left - P.right;
  const innerH = H - P.top - P.bottom;

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': `${yLabel} over time, ${points.length} points.`,
  });
  svg.setAttribute('style', `min-width:${Math.max(320, points.length * 26)}px`);

  const x = (i) => P.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v) => P.top + innerH - (Math.max(0, Math.min(100, v)) / 100) * innerH;

  for (const t of [0, 25, 50, 75, 100]) {
    svg.appendChild(el('line', {
      class: 'grid-line', x1: P.left, x2: W - P.right, y1: y(t), y2: y(t),
    }));
    const label = el('text', { x: P.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'axis-label' });
    label.textContent = `${t}%`;
    svg.appendChild(label);
  }
  svg.appendChild(el('line', {
    class: 'axis-line', x1: P.left, x2: W - P.right, y1: y(0), y2: y(0),
  }));

  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
  svg.appendChild(el('path', {
    d, fill: 'none', stroke: CHART.series1, 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  // Endpoint marker + direct label (selective — not a number on every point).
  const last = points[points.length - 1];
  svg.appendChild(el('circle', {
    cx: x(points.length - 1), cy: y(last.value), r: 4.5,
    fill: CHART.series1, stroke: CHART.surface, 'stroke-width': 2,
  }));
  const endLabel = el('text', {
    x: Math.min(x(points.length - 1) + 8, W - P.right - 30),
    y: y(last.value) - 9, class: 'value-label',
  });
  endLabel.textContent = `${last.value}%`;
  svg.appendChild(endLabel);

  const every = Math.max(1, Math.ceil(points.length / 8));
  points.forEach((p, i) => {
    if (i % every === 0 || i === points.length - 1) {
      const t = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'axis-label' });
      t.textContent = p.label;
      svg.appendChild(t);
    }
  });

  // Hit areas are far wider than the marks, per the 24px minimum.
  const band = innerW / Math.max(points.length, 1);
  points.forEach((p, i) => {
    const hit = el('rect', {
      class: 'hit', x: x(i) - band / 2, y: P.top, width: Math.max(band, 24), height: innerH,
      tabindex: '0', role: 'listitem',
    });
    const cross = el('line', {
      x1: x(i), x2: x(i), y1: P.top, y2: P.top + innerH,
      stroke: CHART.series1, 'stroke-width': 1, opacity: 0,
    });
    hit.addEventListener('mouseenter', () => { cross.setAttribute('opacity', '.4'); });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('opacity', '0'); });
    attachTip(hit, () => `<div class="t-title">${p.title || p.label}</div>` +
      (p.tip || tipRow(CHART.series1, yLabel, `${p.value}%`)));
    svg.appendChild(cross);
    svg.appendChild(hit);
  });

  mount.appendChild(svg);
}

/* =============================================== STACKED MONTHLY BARS === */

function stackedBars(mount, rows) {
  mount.innerHTML = '';
  if (!rows.length) return emptyPlot(mount, 'No months to show yet.');

  const W = 720;
  const H = 250;
  const P = { top: 18, right: 16, bottom: 44, left: 40 };
  const innerW = W - P.left - P.right;
  const innerH = H - P.top - P.bottom;
  const hatchId = nextId();

  const maxTotal = Math.max(...rows.map((r) => r.total), 1);
  const slot = innerW / rows.length;
  const barW = Math.min(46, slot * 0.6);

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`,
    role: 'img', 'aria-label': 'Class days per month, split by present, late and absent.',
  });
  svg.setAttribute('style', `min-width:${Math.max(320, rows.length * 64)}px`);
  svg.appendChild(hatchDefs(hatchId));

  const y = (v) => P.top + innerH - (v / maxTotal) * innerH;

  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const value = Math.round((maxTotal / ticks) * i);
    svg.appendChild(el('line', { class: 'grid-line', x1: P.left, x2: W - P.right, y1: y(value), y2: y(value) }));
    const label = el('text', { x: P.left - 8, y: y(value) + 4, 'text-anchor': 'end', class: 'axis-label' });
    label.textContent = value;
    svg.appendChild(label);
  }
  svg.appendChild(el('line', { class: 'axis-line', x1: P.left, x2: W - P.right, y1: y(0), y2: y(0) }));

  rows.forEach((row, i) => {
    const cx = P.left + slot * i + slot / 2;
    let cursor = 0;

    for (const key of STATUS_ORDER) {
      const value = row[key] || 0;
      if (!value) continue;
      const top = y(cursor + value);
      const bottom = y(cursor);
      // 2px surface gap between stacked segments — a gap, not a border.
      const height = Math.max(bottom - top - (cursor > 0 ? 2 : 0), 1);

      const rect = el('rect', {
        x: cx - barW / 2, y: top, width: barW, height,
        fill: fillFor(key, hatchId), rx: 3, tabindex: '0', role: 'listitem',
      });
      attachTip(rect, () => `<div class="t-title">${row.label}</div>` +
        tipRow(CHART.present, '✓ Present', row.present) +
        tipRow(CHART.late, '! Late', row.late) +
        tipRow(CHART.absent, '✕ Absent', row.absent) +
        tipRow('transparent', 'Attendance', `${row.percent}%`));
      svg.appendChild(rect);
      cursor += value;
    }

    const pct = el('text', { x: cx, y: y(row.total) - 7, 'text-anchor': 'middle', class: 'value-label' });
    pct.textContent = `${row.percent}%`;
    svg.appendChild(pct);

    const label = el('text', { x: cx, y: H - 22, 'text-anchor': 'middle', class: 'axis-label' });
    label.textContent = row.label;
    svg.appendChild(label);
  });

  mount.appendChild(svg);
}

/* ================================================ SIMPLE VALUE BARS ===== */
/* One series -> one colour for every bar (never a value-ramp on categories). */

function valueBars(mount, rows, { unit = '%', max = 100 } = {}) {
  mount.innerHTML = '';
  if (!rows.length) return emptyPlot(mount, 'Nothing to show yet.');

  const rowH = 34;
  const W = 720;
  const H = rows.length * rowH + 14;
  const labelW = 168;
  const trackX = labelW + 10;
  const trackW = W - trackX - 58;

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`,
    role: 'img', 'aria-label': 'Comparison bars.',
  });

  rows.forEach((row, i) => {
    const cy = i * rowH + 8;
    const width = Math.max((Math.max(0, row.value) / max) * trackW, 2);

    const name = el('text', { x: 0, y: cy + 17, class: 'axis-label' });
    name.setAttribute('style', 'fill:var(--ink);font-size:13px');
    name.textContent = row.label.length > 24 ? `${row.label.slice(0, 23)}…` : row.label;
    svg.appendChild(name);

    svg.appendChild(el('rect', {
      x: trackX, y: cy + 5, width: trackW, height: 14, rx: 4, fill: 'var(--surface-3)',
    }));
    const bar = el('rect', {
      x: trackX, y: cy + 5, width, height: 14, rx: 4,
      fill: row.color || CHART.series1, tabindex: '0', role: 'listitem',
    });
    attachTip(bar, () => `<div class="t-title">${row.label}</div>` +
      (row.tip || tipRow(row.color || CHART.series1, 'Value', `${row.value}${unit}`)));
    svg.appendChild(bar);

    const value = el('text', { x: W - 4, y: cy + 17, 'text-anchor': 'end', class: 'value-label' });
    value.textContent = `${row.value}${unit}`;
    svg.appendChild(value);
  });

  mount.appendChild(svg);
}

function emptyPlot(mount, message) {
  const div = document.createElement('div');
  div.className = 'table-empty';
  div.textContent = message;
  mount.appendChild(div);
}

/* -------------------------------------------------------------- legend */

function legend(mount, counts) {
  mount.innerHTML = STATUS_ORDER.map((key) => `
    <span class="item">
      <span class="swatch ${key}"></span>
      <span aria-hidden="true">${STATUS_META[key].icon}</span>
      ${STATUS_META[key].label}
      ${counts && counts[key] !== undefined ? `<b>${counts[key]}</b>` : ''}
    </span>`).join('');
}
