// Retrace interface: arrive -> reading -> results (and the PDF gallery).
import { analyze, revalue, refreshDerived } from './engine.js';
import { buildSVG } from './render.js';
import { scoreModel, diffCanvas } from './score.js';
import { buildWorkbook, tableFor } from './excel.js';
import { openPdf, chartsOnPage } from './pdf.js';
import { yearToDate } from './parse.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const SVGNS = 'http://www.w3.org/2000/svg';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const SAMPLES = [
  { file: 'samples/rate-corridor.png', label: 'Rate corridor' },
  { file: 'samples/conditions-index.png', label: 'Index with average' },
  { file: 'samples/growth-lines.png', label: 'Two lines' },
  { file: 'samples/growth-bars.png', label: 'Grouped bars' },
];

let cur = null;          // { model, canvas, png, name, score, fromPdf }
let pdfItems = [];       // gallery items
let busy = false;

// ---------- screens ----------
function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('on', s.id === id));
  const steps = $('#steps'), links = $('#navlinks');
  const idx = { reading: 1, results: 2, pdf: 2 }[id];
  steps.hidden = !idx; links.hidden = !!idx;
  if (idx) { $$('#steps i').forEach((d, i) => { d.className = i < idx ? 'on' : i === idx ? 'now' : ''; }); $('#stepname').textContent = id === 'reading' ? 'Reading' : 'Done'; }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms); }

// ---------- input ----------
$('#modkey').textContent = isMac ? '⌘' : 'Ctrl';
$('#choose').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value = ''; });
$('#home').addEventListener('click', () => { if (!busy) show('arrive'); });
window.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData ? e.clipboardData.items : [])];
  const it = items.find((i) => i.type.startsWith('image/') || i.type === 'application/pdf');
  if (it) { e.preventDefault(); handleFile(it.getAsFile()); }
});
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#veil').classList.add('on'); $('#stage').classList.add('over'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { $('#veil').classList.remove('on'); $('#stage').classList.remove('over'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#veil').classList.remove('on'); $('#stage').classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

const sg = $('#samples');
for (const s of SAMPLES) {
  const b = document.createElement('button'); b.className = 'sample';
  b.innerHTML = `<span class="t"><img src="${s.file}" alt="${s.label} sample chart" loading="lazy"></span><b>${s.label}</b>`;
  b.addEventListener('click', async () => { const r = await fetch(s.file); const blob = await r.blob(); handleFile(new File([blob], s.file.split('/').pop(), { type: blob.type })); });
  sg.appendChild(b);
}

async function handleFile(file) {
  if (busy) { toast('One moment — still reading the last one.'); return; }
  try {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) return await runPdf(file);
    if (!file.type.startsWith('image/')) { toast('That file isn’t an image or a PDF.'); return; }
    const { canvas, png } = await loadImage(file);
    await runImage(canvas, png, nameFrom(file.name));
  } catch (err) { console.error(err); busy = false; toast('Something went wrong reading that file. Try a clearer image.'); show('arrive'); }
}
const nameFrom = (n) => (n || 'chart').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || 'chart';

async function loadImage(file) {
  const url = URL.createObjectURL(file); const img = new Image(); img.src = url; await img.decode();
  let w = img.naturalWidth, h = img.naturalHeight; const k = Math.min(1, 1600 / Math.max(w, h));
  w = Math.round(w * k); h = Math.round(h * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  return { canvas: c, png: await canvasPng(c) };
}
const canvasPng = (c) => new Promise((r) => c.toBlob((b) => b.arrayBuffer().then((a) => r(new Uint8Array(a))), 'image/png'));

// ---------- reading ----------
function setCheck(k, state, text) {
  const li = $(`#checks li[data-k="${k}"]`); if (!li) return;
  li.classList.toggle('now', state === 'now'); li.classList.toggle('done', state === 'done');
  if (text) $('#c-' + k).textContent = text;
}
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

function axisSummary(m) {
  const parts = [];
  const L = m.left || m.right;
  if (L) { const vs = L.fit.inliers.map((P) => (L.isLog ? Math.pow(10, P.v) : P.v)); parts.push(`Y ${fmtNum(Math.min(...vs))} → ${fmtNum(Math.max(...vs))}${L.isLog ? ', log' : ''}${m.left && m.right ? ' (two axes)' : ''}`); }
  if (m.xAxis) {
    if (m.xAxis.kind === 'category') parts.push(`${m.xAxis.cats.length} categories`);
    else { const ins = m.xAxis.fit.inliers.map((P) => P.v); const lo = Math.min(...ins), hi = Math.max(...ins); parts.push(m.xAxis.kind === 'date' ? `X ${Math.round(lo)} → ${Math.round(hi)} (${{ month: 'months', quarter: 'quarters', fiscal: 'fiscal years', day: 'days' }[m.xAxis.dateKind] || 'years'})` : `X ${fmtNum(lo)} → ${fmtNum(hi)}`); }
  }
  return parts.join(' · ') || 'No scale found — showing pixel positions';
}
const fmtNum = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : +(+v).toFixed(3) + '');

async function runImage(canvas, png, name, opts = {}) {
  busy = true;
  show('reading');
  $('#read-title').textContent = 'Reading your chart';
  $('#readsub').textContent = 'This takes a few seconds.';
  $$('#checks li').forEach((li) => li.classList.remove('now', 'done'));
  $('#c-chips').innerHTML = ''; $('#ocrbar').style.width = '0%';
  ['text', 'axes', 'legend', 'trace', 'check'].forEach((k, i) => $('#c-' + k).textContent = ['Labels, legend, title', 'Scale and units', 'Which colour is which', 'Pixel by pixel', 'Against your image'][i]);
  const W = canvas.width, H = canvas.height;
  const art = $('#art'); art.classList.remove('dim');
  $('#artimg').src = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  const ov = $('#ov'); ov.innerHTML = ''; ov.setAttribute('viewBox', `0 0 ${W} ${H}`);
  await frame(); await sleep(250);
  art.classList.add('dim');
  setCheck('text', 'now');
  const sz = Math.max(W, H) / 300; // overlay scale
  const onStage = async (stage, info) => {
    if (stage === 'ocr') { $('#ocrbar').style.width = Math.round(info.f * 100) + '%'; return; }
    if (stage === 'strip') { setCheck('text', 'now', 'Turning the rotated labels upright'); await frame(); return; }
    if (stage === 'axes') {
      setCheck('text', 'done', 'Labels, legend, title');
      const { plot, left, right, xAxis } = info;
      ov.appendChild(svgEl('rect', { class: 'box', x: plot.x0, y: plot.y0, width: plot.x1 - plot.x0, height: plot.y1 - plot.y0, rx: 4 * sz, fill: 'rgba(0,113,227,.035)', stroke: '#0071E3', 'stroke-width': 0.8 * sz, 'stroke-dasharray': `${3 * sz} ${3 * sz}` }));
      let d = 0;
      for (const a of [left, right].filter(Boolean)) for (const P of a.fit.inliers) ov.appendChild(svgEl('circle', { class: 'dot', cx: a === left ? plot.x0 : plot.x1, cy: P.p, r: 2.6 * sz, fill: '#0071E3', style: `animation-delay:${(d++) * 60}ms` }));
      if (xAxis) for (const b of xAxis.boxes) ov.appendChild(svgEl('circle', { class: 'dot', cx: b.cx, cy: plot.y1, r: 2.6 * sz, fill: '#0071E3', style: `animation-delay:${(d++) * 45}ms` }));
      const beam = svgEl('g', { class: 'beam' }); beam.appendChild(svgEl('line', { x1: plot.x0, x2: plot.x0, y1: plot.y0, y2: plot.y1, stroke: '#0071E3', 'stroke-width': sz })); ov.appendChild(beam);
      beam.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${plot.x1 - plot.x0}px)` }], { duration: 1600, iterations: Infinity, direction: 'alternate', easing: 'cubic-bezier(.65,0,.35,1)' });
      ov._beam = beam;
      setCheck('axes', 'now');
      await sleep(350);
      return;
    }
    if (stage === 'colours') { setCheck('axes', 'done'); setCheck('legend', 'now'); await frame(); }
  };
  const t0 = performance.now();
  const m = await analyze(canvas, onStage);
  setCheck('text', 'done'); setCheck('axes', 'done', axisSummary(m));
  // legend chips
  const chips = $('#c-chips'); chips.innerHTML = '';
  const list = m.pie ? m.pie.slices : (m.series || []);
  list.slice(0, 10).forEach((s, i) => { const c = document.createElement('span'); c.className = 'chip'; c.style.animationDelay = i * 80 + 'ms'; c.innerHTML = `<i style="background:${s.color}"></i>${esc(s.name)}`; chips.appendChild(c); });
  setCheck('legend', 'done', m.legend && m.legend.length ? 'Matched to the legend' : list.length ? 'No legend — named in order' : 'No coloured series found');
  setCheck('trace', 'now');
  if (ov._beam) ov._beam.remove();
  // draw what was traced
  for (const s of m.series || []) {
    let d = '';
    if (s.type === 'line' || s.type === 'step' || s.type === 'area' || s.type === 'band') d = s.points.filter((p) => p.px != null).map((p, i) => (i ? 'L' : 'M') + p.px + ',' + p.py.toFixed(1)).join('');
    if (d) { const p = svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': Math.max(1.6, (s.width || 1.5)) * 1.3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'trace-in' }); ov.appendChild(p); const len = p.getTotalLength ? p.getTotalLength() : 2000; p.style.setProperty('--len', len); p.style.strokeDasharray = len; }
    if (s.type === 'bar' || s.type === 'barh') s.points.filter((p) => p.rect).forEach((p, i) => { const r = p.rect; const e = svgEl('rect', { x: r.x0, y: r.y0, width: r.x1 - r.x0 + 1, height: r.y1 - r.y0 + 1, fill: s.color, class: 'dot', style: `animation-delay:${i * 70}ms` }); ov.appendChild(e); });
    if (s.type === 'scatter') s.points.forEach((p, i) => ov.appendChild(svgEl('circle', { cx: p.px, cy: p.py, r: Math.max(2, (s.markerSize || 5) / 2), fill: s.color, class: 'dot', style: `animation-delay:${Math.min(1200, i * 10)}ms` })));
  }
  const nPts = (m.series || []).reduce((n, s) => n + s.points.length, 0);
  setCheck('trace', 'done', m.pie ? `${m.pie.slices.length} slices` : `${(m.series || []).length} series · ${nPts.toLocaleString()} points`);
  setCheck('check', 'now');
  await sleep(Math.max(300, 1300 - (performance.now() - t0) * 0.1));
  const score = scoreModel(m);
  setCheck('check', 'done', `${score.trace.toFixed(1)}% match`);
  await sleep(500);
  cur = { model: m, canvas, png, name: (m.title && m.title.text) || name, score, fromPdf: opts.fromPdf || null };
  busy = false;
  if (!(m.series || []).length && !m.pie) { $('#read-title').textContent = 'No data series found'; $('#readsub').textContent = 'Retrace could not find coloured lines, bars or points in this image. Try a sharper screenshot of just the chart.'; return; }
  renderResults();
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- results ----------
let viewMode = 'wipe', wipeAt = 50;
function renderResults() {
  const { model: m, score } = cur;
  show('results');
  $('#res-title').textContent = `Rebuilt. ${score.trace.toFixed(1)}% match.`;
  const tbl = tableFor(m);
  cur.table = tbl;
  const nS = m.pie ? m.pie.slices.length : (m.series || []).length;
  const detail = tbl.nat ? (tbl.nat.grid.name === 'every pixel' ? ' points, one per pixel' : ` ${tbl.nat.grid.name} points`) : ' points';
  let sub = m.pie ? `${nS} slices` : `${nS} series · ${tbl.n.toLocaleString()}${detail}`;
  if (tbl.kind === 'date' && tbl.n) sub += ` · ${fmtCell(tbl.rows[1][0], tbl)} – ${fmtCell(tbl.rows[tbl.rows.length - 1][0], tbl)}`;
  if (tbl.kind === 'bar') sub = `${nS} series · ${tbl.n} categories`;
  $('#res-sub').textContent = sub;
  // back to the PDF gallery
  let back = $('#backpdf'); if (back) back.remove();
  if (cur.fromPdf) { back = document.createElement('button'); back.id = 'backpdf'; back.className = 'link-btn'; back.textContent = '← All charts in this PDF'; back.onclick = () => show('pdf'); $('.res-head > div').prepend(back); }
  renderCompare();
}

function rebuildSVG() { return buildSVG(cur.model); }

function renderCompare() {
  const m = cur.model; const view = $('#view'); view.innerHTML = '';
  const src = URL.createObjectURL(new Blob([cur.png], { type: 'image/png' }));
  $$('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === viewMode)));
  $('#hint').textContent = { wipe: 'Rebuilt on the left, your image on the right', side: 'Same size, same scale', diff: 'Only where the two disagree is marked' }[viewMode];
  if (viewMode === 'wipe') {
    view.innerHTML = `<div class="wipe" id="wipe"><img src="${src}" alt="Your original chart"><div class="rb" id="rb">${rebuildSVG()}</div><div class="handle" id="handle"></div><div class="knob" id="knob"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1D1D1F" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l-5 6 5 6M15 6l5 6-5 6"/></svg></div><span class="tag" style="left:12px">Rebuilt</span><span class="tag" style="right:12px">Original</span></div>
      <label class="slider">Drag to compare<input type="range" min="0" max="100" step="1" id="wiper" value="${wipeAt}" aria-label="Wipe position"></label>`;
    const setW = (v) => { wipeAt = Math.max(0, Math.min(100, v)); $('#rb').style.clipPath = `inset(0 ${100 - wipeAt}% 0 0)`; $('#handle').style.left = wipeAt + '%'; $('#knob').style.left = wipeAt + '%'; $('#wiper').value = Math.round(wipeAt); };
    setW(wipeAt);
    $('#wiper').addEventListener('input', (e) => setW(+e.target.value));
    const wp = $('#wipe'); let dragging = false;
    const at = (e) => { const r = wp.getBoundingClientRect(); setW(((e.clientX - r.left) / r.width) * 100); };
    wp.addEventListener('pointerdown', (e) => { dragging = true; wp.setPointerCapture(e.pointerId); at(e); });
    wp.addEventListener('pointermove', (e) => dragging && at(e));
    wp.addEventListener('pointerup', () => (dragging = false));
    // a gentle sweep on first view, so the comparison explains itself
    if (!renderCompare.swept) { renderCompare.swept = true; const t0 = performance.now(); const anim = (t) => { const k = Math.min(1, (t - t0) / 1600); setW(15 + 70 * (0.5 - 0.5 * Math.cos(k * Math.PI * 2)) ); if (k < 1) requestAnimationFrame(anim); else setW(50); }; requestAnimationFrame(anim); }
  } else if (viewMode === 'side') {
    view.innerHTML = `<div class="side" style="--ar:${m.W}/${m.H}"><figure><img src="${src}" alt="Your original chart"><figcaption>Original</figcaption></figure><figure><div class="rb">${rebuildSVG()}</div><figcaption>Rebuilt from the data</figcaption></figure></div>`;
  } else {
    const dc = diffCanvas(m, cur.canvas, cur.score.diff);
    view.innerHTML = `<div class="diffview"></div><div class="legend-diff"><span><i style="background:#FF3B30"></i>In your image, missed</span><span><i style="background:#0071E3"></i>Drawn, not in your image</span></div>`;
    $('.diffview').appendChild(dc);
  }
  // ribbon
  const rib = $('#ribbon'); rib.innerHTML = '';
  const r = cur.score.ribbon || [];
  r.forEach((v) => { const s = document.createElement('span'); s.style.background = v >= 0.9 ? 'var(--green)' : v >= 0.72 ? 'var(--amber)' : 'var(--red)'; rib.appendChild(s); });
  const weak = r.filter((v) => v < 0.9).length;
  $('#ribbon-cap').textContent = m.pie ? 'Slices are measured by angle around the centre' : weak === 0 ? 'Confidence along the horizontal axis · every stretch agrees with your image' : `Confidence along the horizontal axis · ${weak} short stretch${weak > 1 ? 'es' : ''} to glance at — usually where lines cross or hide behind each other`;
}
$$('.seg button').forEach((b) => b.addEventListener('click', () => { viewMode = b.dataset.v; renderCompare(); }));

function renderMetrics() {
  const s = cur.score; const m = cur.model;
  $('#m-trace').textContent = s.trace.toFixed(1) + '%';
  const off = 326.7 * (1 - Math.max(0, Math.min(1, s.trace / 100)));
  $('#ringfg').setAttribute('stroke', s.trace >= 90 ? '#34C759' : s.trace >= 75 ? '#FF9F0A' : '#FF3B30');
  requestAnimationFrame(() => $('#ringfg').setAttribute('stroke-dashoffset', off));
  $('#ring').setAttribute('aria-label', `${s.trace.toFixed(1)} percent trace match`);
  $('#m-trace-s').textContent = m.pie ? 'Slices re-drawn from their shares' : 'Rebuilt pixels that land on your image, and the reverse';
  $('#m-axis').textContent = s.axis != null ? s.axis.toFixed(2) + '%' : '—';
  $('#m-axis-s').textContent = s.axis != null ? `${s.axisLabels} tick labels sit on one ${m.left && m.left.isLog ? 'log' : 'straight'} scale` : 'No numeric scale to check';
  const a = s.anchors;
  $('#m-anch').textContent = a ? `${a.matched ?? a.n} of ${a.n}` : '—';
  $('#m-anch-s').textContent = a ? 'Values printed on the chart, used as ground truth' : 'None on this chart. When values are printed, Retrace checks itself against them.';
}

function fmtCell(v, tbl, c = 0) {
  if (v == null) return '';
  if (c === 0 && tbl.kind === 'date' && typeof v === 'number') {
    const d = new Date((v - 25569) * 86400000); const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    const f = tbl.dateFmt; if (f === 'yyyy') return String(d.getUTCFullYear()); if (f === 'mmm-yy') return mon + ' ' + d.getUTCFullYear(); return d.getUTCDate() + ' ' + mon + ' ' + d.getUTCFullYear();
  }
  return typeof v === 'number' ? (+v.toFixed(6)).toString() : String(v);
}
function renderTable() {
  const t = cur.table; const max = 400; const rows = t.rows;
  const head = '<thead><tr>' + rows[0].map((h) => `<th scope="col">${esc(h ?? '')}</th>`).join('') + '</tr></thead>';
  const body = rows.slice(1, max + 1).map((r) => '<tr>' + r.map((v, c) => `<td>${esc(fmtCell(v, t, c))}</td>`).join('') + '</tr>').join('');
  $('#table').innerHTML = head + '<tbody>' + body + '</tbody>';
  $('#rows-cap').textContent = rows.length - 1 > max ? `Showing ${max} of ${(rows.length - 1).toLocaleString()} rows` : `${(rows.length - 1).toLocaleString()} rows`;
  $('#table-note').textContent = t.nat ? (t.nat.grid.name === 'every pixel' ? 'On screen and in Excel: one row per pixel column, because no calendar grid redraws this chart faithfully.' : `The trace is pixel-level; this table is resampled to ${t.nat.grid.name} — the coarsest grid that redraws every series within a pixel.`) : '';
}

function renderSeries() {
  const m = cur.model; const box = $('#series'); box.innerHTML = '';
  const list = m.pie ? m.pie.slices : m.series;
  list.forEach((s, i) => {
    const row = document.createElement('div'); row.className = 'srow';
    const dual = !!(m.left && m.right) && !m.pie;
    row.innerHTML = `<input type="color" value="${s.color}" aria-label="Colour of ${esc(s.name)}"><input type="text" value="${esc(s.name)}" aria-label="Name of series ${i + 1}">${dual ? `<select aria-label="Axis"><option value="0">Left axis</option><option value="1">Right axis</option></select>` : `<span class="hint" style="font-size:12px">${s.type || 'slice'}</span>`}${m.pie ? '' : `<button class="x" aria-label="Remove ${esc(s.name)}">✕</button>`}`;
    const [color, name] = $$('input', row);
    color.addEventListener('input', () => { s.color = color.value.toUpperCase(); if (s.segments) s.segments.forEach((g) => (g.color = s.color)); refresh(); });
    name.addEventListener('change', () => { s.name = name.value.trim() || s.name; s.named = true; refresh(); });
    if (dual) { const sel = $('select', row); sel.value = String(s.axis || 0); sel.addEventListener('change', () => { s.axis = +sel.value; for (const p of s.points) { const a = [m.left, m.right][s.axis]; if (p.py != null) { const v = a.fit.a + a.fit.b * p.py; p.y = a.isLog ? Math.pow(10, v) : v; } } refresh(); }); }
    const x = $('.x', row); if (x) x.addEventListener('click', () => { m.series.splice(m.series.indexOf(s), 1); refresh(true); });
    box.appendChild(row);
  });
}

function renderAxes() {
  const m = cur.model; const box = $('#axes'); box.innerHTML = '';
  const add = (label, a, kind) => {
    const ins = a.fit.inliers; if (ins.length < 2) return;
    const sorted = [...ins].sort((p, q) => p.p - q.p); const A = sorted[0], B = sorted[sorted.length - 1];
    const val = (P) => (a.isLog ? Math.pow(10, P.v) : P.v);
    const show = (P) => (kind === 'date' ? +P.v.toFixed(2) : +val(P).toFixed(6));
    const div = document.createElement('div');
    div.innerHTML = `<p class="hint" style="margin:14px 0 0;font-weight:500;color:var(--ink)">${label}</p><div class="axrow"><label>${kind === 'x' || kind === 'date' ? 'Left-most label' : 'Top label'}<input inputmode="decimal" value="${show(A)}"></label><label>${kind === 'x' || kind === 'date' ? 'Right-most label' : 'Bottom label'}<input inputmode="decimal" value="${show(B)}"></label></div>`;
    const [i1, i2] = $$('input', div);
    const apply = () => {
      const v1 = parseFloat(i1.value), v2 = parseFloat(i2.value); if (!isFinite(v1) || !isFinite(v2) || v1 === v2) { toast('Enter two different numbers.'); return; }
      const t1 = a.isLog ? Math.log10(v1) : v1, t2 = a.isLog ? Math.log10(v2) : v2;
      const b = (t2 - t1) / (B.p - A.p); a.fit.a = t1 - b * A.p; a.fit.b = b;
      a.fit.inliers.forEach((P) => (P.v = a.fit.a + b * P.p));
      revalue(m); cur.score = scoreModel(m); refresh(); toast('Re-scaled every point.');
    };
    i1.addEventListener('change', apply); i2.addEventListener('change', apply);
    box.appendChild(div);
  };
  if (m.left) add(m.right ? 'Left axis' : 'Vertical axis', m.left, 'y');
  if (m.right) add('Right axis', m.right, 'y');
  if (m.xAxis && m.xAxis.kind !== 'category') add(m.xAxis.kind === 'date' ? 'Horizontal axis (years, decimals for months)' : 'Horizontal axis', m.xAxis, m.xAxis.kind === 'date' ? 'date' : 'x');
  $('#axispanel').hidden = !box.children.length;
}

function refresh(rescore) {
  if (rescore) cur.score = scoreModel(cur.model);
  refreshDerived(cur.model);
  cur.table = tableFor(cur.model);
  renderCompare();
}

// ---------- export ----------
const safeFile = (n) => (n || 'chart').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chart';
function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); }
$('#dl').addEventListener('click', async () => {
  const blob = await buildWorkbook([{ model: cur.model, png: cur.png, name: cur.name, score: cur.score.trace, axisScore: cur.score.axis }], { title: cur.name });
  save(blob, safeFile(cur.name) + '.xlsx'); toast('Excel file saved, with a live chart inside.');
});

// ---------- PDF ----------
async function runPdf(file) {
  busy = true; pdfItems = [];
  show('pdf');
  const grid = $('#pdfgrid'); grid.innerHTML = '';
  $('#pdf-title').textContent = 'Looking for charts…';
  const name = nameFrom(file.name);
  $('#wbname').textContent = safeFile(name) + '.xlsx';
  const doc = await openPdf(file);
  $('#pdf-sub').textContent = `${file.name} · ${doc.numPages} page${doc.numPages > 1 ? 's' : ''}`;
  let found = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    $('#pdf-title').textContent = `Reading page ${p} of ${doc.numPages}…`;
    let crops = [];
    try { crops = await chartsOnPage(doc, p); } catch (e) { console.warn(e); }
    for (const c of crops) {
      const card = document.createElement('div'); card.className = 'pcard pending';
      card.innerHTML = `<div class="t"><div class="shimmer"></div></div><div class="row"><input type="checkbox" checked aria-label="Include in workbook"><div class="nm"><b>Reading…</b><span>Page ${p}</span></div></div>`;
      grid.appendChild(card);
      let m;
      try { m = await analyze(c.canvas, async () => {}); } catch (e) { console.warn(e); card.remove(); continue; }
      const ok = (m.series && m.series.length && (m.left || m.right || m.xAxis)) || m.pie;
      if (!ok) { card.remove(); continue; }
      const png = await canvasPng(c.canvas); const score = scoreModel(m);
      const item = { model: m, canvas: c.canvas, png, page: p, score, name: (m.title && m.title.text) || `Page ${p} chart`, include: true };
      pdfItems.push(item); found++;
      card.classList.remove('pending'); if (score.trace < 85) card.classList.add('warn');
      const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      const desc = m.pie ? 'Pie' : [...new Set(m.series.map((s) => ({ line: 'Line', step: 'Steps', bar: 'Bars', barh: 'Bars', area: 'Area', band: 'Band', scatter: 'Scatter' }[s.type])))].join(', ');
      card.innerHTML = `<div class="t" title="Open"><img src="${url}" alt="Chart on page ${p}"></div><div class="row"><input type="checkbox" checked aria-label="Include ${esc(item.name)} in workbook"><div class="nm"><b>${esc(item.name)}</b><span>${desc} · page ${p}</span></div><button class="badge ${score.trace >= 85 ? 'good' : 'warn'}">${score.trace >= 85 ? score.trace.toFixed(1) + '%' : 'Review ' + Math.round(score.trace) + '%'}</button></div>`;
      const open = () => { cur = { model: m, canvas: c.canvas, png, name: item.name, score, fromPdf: true }; renderResults(); };
      $('.t', card).addEventListener('click', open); $('.badge', card).addEventListener('click', open);
      $('input', card).addEventListener('change', (e) => { item.include = e.target.checked; tabs(); });
      tabs();
    }
  }
  busy = false;
  $('#pdf-title').textContent = found ? `${found} chart${found > 1 ? 's' : ''} found.` : 'No charts found.';
  $('#pdf-sub').textContent = found ? 'Each one becomes its own sheet, with its own Excel chart.' : 'Retrace looks for plotted lines, bars and points. Scanned pages work best at high resolution.';
}
function tabs() { const t = $('#wbtabs'); t.innerHTML = '<span>Contents</span>' + pdfItems.filter((i) => i.include).map((i) => `<span>${esc(i.name.slice(0, 24))}</span>`).join(''); }
$('#dlall').addEventListener('click', async () => {
  const sel = pdfItems.filter((i) => i.include); if (!sel.length) { toast('Pick at least one chart.'); return; }
  const blob = await buildWorkbook(sel.map((i) => ({ model: i.model, png: i.png, name: i.name, page: i.page, score: i.score.trace, axisScore: i.score.axis })), { title: $('#wbname').textContent });
  save(blob, $('#wbname').textContent); toast(`Workbook saved — ${sel.length} sheet${sel.length > 1 ? 's' : ''} plus contents.`);
});

// keyboard: Esc goes home
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !busy) show('arrive'); });

// On GitHub Pages, point the GitHub link at this repository
{ const m = location.hostname.match(/^([^.]+)\.github\.io$/i); if (m) { const repo = location.pathname.split('/').filter(Boolean)[0]; $('#ghlink').href = `https://github.com/${m[1]}/${repo && !/\.html$/.test(repo) ? repo : m[1] + '.github.io'}`; } else $('#ghlink').hidden = true; }
