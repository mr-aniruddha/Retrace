// Excel workbook with real, editable Excel charts styled like the source. Written by hand (OOXML) with JSZip.
import { yearToDate, dateToExcel, niceRound } from './parse.js';
import { median } from './image.js';

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EMU = 9525; // per pixel at 96 dpi
const col = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const hex6 = (h) => (h || '#000000').replace('#', '').toUpperCase().slice(0, 6);
const pt100 = (px) => Math.round(Math.max(6, px * 0.75) * 100); // px font -> hundredths of a point
const fontPx = (h) => Math.max(7, h * 1.32);
const lum = (h) => { const v = parseInt(hex6(h), 16); return ((v >> 16) & 255) * 0.3 + ((v >> 8) & 255) * 0.59 + (v & 255) * 0.11; };

// ---------- natural frequency ----------

const GRIDS_DATE = [
  { name: 'annual', step: 1, fmt: 'yyyy' },
  { name: 'quarterly', step: 0.25, fmt: 'mmm-yy' },
  { name: 'monthly', step: 1 / 12, fmt: 'mmm-yy' },
  { name: 'weekly', step: 7 / 365.25, fmt: 'dd-mmm-yy' },
  { name: 'daily', step: 1 / 365.25, fmt: 'dd-mmm-yy' },
];

function interpAt(xs, ys, x) {
  if (x < xs[0] || x > xs[xs.length - 1]) return null;
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  const t = xs[hi] === xs[lo] ? 0 : (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

// Pick the coarsest regular grid that redraws every series within a pixel; else keep pixel detail.
export function naturalTable(m) {
  const cont = (m.series || []).filter((s) => ['line', 'step', 'area', 'band'].includes(s.type));
  const isDate = m.xAxis && m.xAxis.kind === 'date';
  if (!cont.length || !m.xAxis || m.xAxis.kind === 'category') return null;
  const xs0 = Math.min(...cont.map((s) => s.points[0].x)), xs1 = Math.max(...cont.map((s) => s.points[s.points.length - 1].x));
  const pxPerUnit = Math.abs(1 / m.xAxis.fit.b);
  const yScale = (s) => { const a = [m.left, m.right][s.axis] || m.left || m.right; return a ? Math.abs(1 / a.fit.b) : 1; };
  let grids;
  if (isDate) grids = GRIDS_DATE;
  else { const st = (m.xTicks && m.xTicks.step) || 1; grids = [1, 2, 4, 5, 10, 20, 50, 100].map((k) => ({ name: 'step ' + niceRound(st / k, st), step: st / k, fmt: null })); }
  const series = cont.map((s) => ({ s, xs: s.points.map((p) => p.x), ys: s.points.map((p) => p.y), lx: s.lower ? s.lower.map((p) => p.x) : null, ly: s.lower ? s.lower.map((p) => p.y) : null }));
  for (const g of grids) {
    if (g.step * pxPerUnit < 0.9) break; // finer than the pixels: no point
    const start = Math.ceil((xs0 - 1e-9) / g.step) * g.step;
    const grid = []; for (let x = start; x <= xs1 + 1e-9; x += g.step) grid.push(+x.toFixed(10));
    if (grid.length < 3) continue;
    let ok = true;
    for (const S of series) {
      const gy = grid.map((x) => interpAt(S.xs, S.ys, x));
      const gx = grid.filter((_, i) => gy[i] != null), gv = gy.filter((v) => v != null);
      if (gx.length < 2) { ok = false; break; }
      const errs = [];
      for (let i = 0; i < S.xs.length; i++) { const r = interpAt(gx, gv, S.xs[i]); if (r != null) errs.push(Math.abs(r - S.ys[i]) * yScale(S.s)); }
      errs.sort((a, b) => a - b);
      const meanE = errs.reduce((a, b) => a + b, 0) / (errs.length || 1), p95 = errs[Math.floor(errs.length * 0.95)] || 0;
      // tolerance: within a pixel, or within the grid spacing when the grid is as fine as the pixels
      const sp = g.step * pxPerUnit;
      const fine = sp <= 2.5;
      if (meanE > (fine ? Math.max(0.6, 0.85 * sp) : 0.6) || p95 > (fine ? Math.max(1.6, 3.5 * sp) : 1.6)) { ok = false; break; }
    }
    if (ok) return buildRows(grid, series, g, isDate, m);
  }
  // pixel detail
  const all = [...new Set(series.flatMap((S) => S.xs.map((x) => +x.toFixed(8))))].sort((a, b) => a - b);
  return buildRows(all, series, { name: 'every pixel', step: null, fmt: isDate ? 'dd-mmm-yy' : null }, isDate, m);
}

function buildRows(grid, series, g, isDate, m) {
  const rows = grid.map((x) => ({ x, vals: series.flatMap((S) => {
    const v = interpAt(S.xs, S.ys, x);
    if (S.s.type === 'band') { const lo = interpAt(S.lx, S.ly, x); return [lo, v]; }
    return [v];
  }) })).filter((r) => r.vals.some((v) => v != null));
  const heads = series.flatMap((S) => (S.s.type === 'band' ? [S.s.name + ' (lower)', S.s.name + ' (upper)'] : [S.s.name]));
  const ranges = series.map((S) => { const a = [m.left, m.right][S.s.axis] || m.left || m.right; return a && a.fit ? Math.abs(a.fit.range || 1) : 1; });
  // round to what the image can resolve
  let ci = 0;
  series.forEach((S, k) => { const n = S.s.type === 'band' ? 2 : 1; for (let j = 0; j < n; j++) { rows.forEach((r) => { if (r.vals[ci] != null) r.vals[ci] = niceRound(r.vals[ci], ranges[k]); }); ci++; } });
  return { grid: g, isDate, heads, rows, series: series.map((S) => S.s) };
}

// Calendar-clean dates: month grids land on the 1st, everything else on whole days
function snapDate(x, gridName) {
  if (['annual', 'quarterly', 'monthly'].includes(gridName)) {
    const y = Math.floor(x + 1e-6); const mo = Math.round((x - y) * 12);
    return dateToExcel(new Date(Date.UTC(y + Math.floor(mo / 12), mo % 12, 1)));
  }
  return Math.round(dateToExcel(yearToDate(x)));
}

function groupStart(bars, i) { const r = bars.map((s) => s.points[i] && s.points[i].rect).filter(Boolean); return r.length ? Math.min(...r.map((q) => q.x0 + q.y0)) : 0; }

// ---------- worksheet / chart XML ----------

function cellXml(r, c, v, style) {
  const ref = col(c) + (r + 1);
  if (v == null || v === '') return '';
  if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

const STY = { header: 1, mmmyy: 2, yyyy: 3, ddmmmyy: 4, title: 5, note: 6, num: 0 };
const dateStyle = (fmt) => (fmt === 'yyyy' ? STY.yyyy : fmt === 'dd-mmm-yy' ? STY.ddmmmyy : STY.mmmyy);

// Table for one chart: returns {cells: [[...]], refs for chart}
export function tableFor(m) {
  const out = { rows: [], refs: {} };
  if (m.pie) {
    out.rows.push(['Slice', 'Share (%)']);
    m.pie.slices.forEach((s) => out.rows.push([s.name, +(s.share * 100).toFixed(2)]));
    out.kind = 'pie'; out.n = m.pie.slices.length; return out;
  }
  const bars = (m.series || []).filter((s) => s.type === 'bar' || s.type === 'barh');
  if (bars.length) {
    const cats = m.series.categories || bars[0].points.map((p) => p.cat);
    const pos = (s) => median(s.points.filter((p) => p.rect).map((p) => (s.type === 'barh' ? p.rect.y0 : p.rect.x0) - (p.groupLo || 0)));
    bars.sort((a, b) => median(a.points.map((p, i) => (p.rect ? p.rect.x0 + p.rect.y0 - groupStart(bars, i) : 0))) - median(b.points.map((p, i) => (p.rect ? p.rect.x0 + p.rect.y0 - groupStart(bars, i) : 0))));
    out.rows.push(['Category', ...bars.map((s) => s.name)]);
    cats.forEach((c, i) => out.rows.push([c, ...bars.map((s) => (s.points[i] && s.points[i].y != null ? +(+s.points[i].y).toFixed(4) : null))]));
    out.kind = 'bar'; out.series = bars; out.n = cats.length; return out;
  }
  const nat = naturalTable(m);
  if (nat) {
    const xHead = nat.isDate ? 'Date' : (m.xAxisTitle || 'X');
    out.rows.push([xHead, ...nat.heads]);
    nat.rows.forEach((r) => out.rows.push([nat.isDate ? snapDate(r.x, nat.grid.name) : niceRound(r.x, 1), ...r.vals]));
    out.kind = nat.isDate ? 'date' : 'xy'; out.nat = nat; out.n = nat.rows.length; out.dateFmt = nat.grid.fmt;
  }
  const sc = (m.series || []).filter((s) => s.type === 'scatter');
  if (sc.length) {
    out.scatterStart = out.rows.length ? out.rows[0].length + 1 : 0;
    const maxN = Math.max(...sc.map((s) => s.points.length));
    if (!out.rows.length) { out.rows.push([]); for (let i = 0; i < maxN; i++) out.rows.push([]); out.kind = 'xy'; }
    while (out.rows.length < maxN + 1) out.rows.push(new Array(out.rows[0].length).fill(null));
    sc.forEach((s, k) => {
      const c0 = out.scatterStart + k * 2;
      out.rows[0][c0] = s.name + ' x'; out.rows[0][c0 + 1] = s.name + ' y';
      s.points.forEach((p, i) => { out.rows[i + 1][c0] = +(+p.x).toFixed(5); out.rows[i + 1][c0 + 1] = +(+p.y).toFixed(5); });
    });
    out.scatter = sc;
  }
  out.n = out.rows.length - 1;
  return out;
}

function sheetXml(table, drawingRid, extraRows = []) {
  const rows = []; const T = table.rows;
  T.forEach((r, i) => {
    const cells = r.map((v, c) => {
      let st = 0;
      if (i === 0) st = STY.header;
      else if (c === 0 && (table.kind === 'date')) st = dateStyle(table.dateFmt);
      return cellXml(i, c, v, st);
    }).join('');
    rows.push(`<row r="${i + 1}">${cells}</row>`);
  });
  extraRows.forEach(([r, c, v, st]) => rows.push(`<row r="${r + 1}">${cellXml(r, c, v, st)}</row>`));
  const widths = (T[0] || []).map((h, c) => `<col min="${c + 1}" max="${c + 1}" width="${Math.max(11, Math.min(36, String(h || '').length + 3))}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>${widths ? `<cols>${widths}</cols>` : ''}
<sheetData>${rows.join('')}</sheetData>${drawingRid ? `<drawing r:id="${drawingRid}"/>` : ''}</worksheet>`;
}

const txPr = (sizePx, color, rot, bold, font = 'Arial') => `<c:txPr><a:bodyPr${rot ? ` rot="${rot}" vert="horz"` : ''}/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${pt100(sizePx)}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${hex6(color)}"/></a:solidFill><a:latin typeface="${font}"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
const ln = (color, wPx, dash) => color ? `<a:ln w="${Math.round(Math.max(0.5, wPx * 0.75) * 12700)}" cap="rnd"><a:solidFill><a:srgbClr val="${hex6(color)}"/></a:solidFill>${dash && dash !== 'solid' ? `<a:prstDash val="${dash === 'dot' ? 'sysDot' : dash === 'longDash' ? 'lgDash' : 'dash'}"/>` : ''}<a:round/></a:ln>` : '<a:ln><a:noFill/></a:ln>';
const ref = (sheet, c, r0, r1) => `'${sheet.replace(/'/g, "''")}'!$${col(c)}$${r0 + 1}:$${col(c)}$${r1 + 1}`;
const cellRef = (sheet, c, r) => `'${sheet.replace(/'/g, "''")}'!$${col(c)}$${r + 1}`;

function numFmtFor(axisInfo) {
  if (!axisInfo) return 'General';
  const d = axisInfo.dec || 0; const base = d ? '0.' + '0'.repeat(d) : '0';
  return axisInfo.pct ? base + '"%"' : base;
}
function dateFmtFor(m) {
  const X = m.xTicks; const sample = X && X.ticks && X.ticks[0] ? X.ticks[0].text : '';
  if (/^\d{2}$/.test(sample)) return 'yy';
  if (/^FY/i.test(sample)) return '"FY"yy';
  if (/^[A-Za-z]{3}-\d{2}$/.test(sample)) return 'mmm-yy';
  if (/^[A-Za-z]{3} \d{4}$/.test(sample)) return 'mmm yyyy';
  if (/^Q\d/i.test(sample)) return '"Q"q yy';
  return 'yyyy';
}

function layoutXml(x, y, w, h, inner) {
  const c = (v) => Math.max(0, Math.min(1, v)).toFixed(4);
  return `<c:layout><c:manualLayout>${inner ? '<c:layoutTarget val="inner"/>' : ''}<c:xMode val="edge"/><c:yMode val="edge"/><c:x val="${c(x)}"/><c:y val="${c(y)}"/><c:w val="${c(w)}"/><c:h val="${c(h)}"/></c:manualLayout></c:layout>`;
}

export function chartXml(m, table, sheet) {
  const W = m.W, H = m.H; const P = m.plot;
  const n = table.n; const r0 = 1, r1 = n;
  const parts = []; const axIds = { cat: 1001, val: 1002, cat2: 1003, val2: 1004 }; const hideIdx = [];
  let [YL, YR] = m.yTicks || [];
  const gridRows = (m.rulesInfo && m.rulesInfo.rows) || [];
  const hasGrid = YL && gridRows.length >= 2;
  const gridColor = hasGrid ? parseInt(hex6([...gridRows].sort((a, b) => lum(a.color) - lum(b.color))[Math.floor(gridRows.length / 2)].color), 16) : null;
  const xAxisLine = gridRows.find((r) => Math.abs(r.y - P.y1) <= 4);
  const yAxisLine = ((m.rulesInfo && m.rulesInfo.cols) || []).find((c) => Math.abs(c.x - P.x0) <= 4);
  const title = m.title;
  const bold = !!(title && title.bold);
  // ---- title
  const titleXml = title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${pt100(fontPx(title.size))}" b="${bold ? 1 : 0}"/></a:pPr><a:r><a:rPr lang="en-US" sz="${pt100(fontPx(title.size))}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${hex6(title.color)}"/></a:solidFill><a:latin typeface="${title.serif ? 'Georgia' : 'Arial'}"/></a:rPr><a:t>${esc(title.text)}</a:t></a:r></a:p></c:rich></c:tx>${layoutXml(title.box.x0 / W, Math.max(0, title.box.y0 - 2) / H, 0, 0, false)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>';
  // ---- series xml
  const serLine = (s, idx, cIdx, catRef, isScatter) => {
    const segs = s.segments && s.segments.length > 1 ? s.segments : null;
    const nameRef = cellRef(sheet, cIdx, 0);
    const spPr = `<c:spPr>${ln(s.color, s.width || 1.5, s.dash)}</c:spPr>`;
    let dpts = '';
    if (segs && table.nat) {
      // colour each stretch of the line like the source
      const xs = table.nat.rows.map((r) => r.x);
      dpts = xs.map((x, i) => { const px = m.xToPx(x); const seg = segs.find((g) => px >= g.from - 1 && px <= g.to + 1) || segs[0]; return seg.color !== s.color || seg.dash !== s.dash ? `<c:dPt><c:idx val="${i}"/><c:marker><c:symbol val="none"/></c:marker><c:bubble3D val="0"/><c:spPr>${ln(seg.color, seg.width || s.width || 1.5, seg.dash)}</c:spPr></c:dPt>` : ''; }).join('');
    }
    if (isScatter) return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/><c:tx><c:strRef><c:f>${nameRef}</c:f></c:strRef></c:tx>${spPr}<c:marker><c:symbol val="none"/></c:marker>${dpts}<c:xVal><c:numRef><c:f>${catRef}</c:f></c:numRef></c:xVal><c:yVal><c:numRef><c:f>${ref(sheet, cIdx, r0, r1)}</c:f></c:numRef></c:yVal><c:smooth val="0"/></c:ser>`;
    return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/><c:tx><c:strRef><c:f>${nameRef}</c:f></c:strRef></c:tx>${spPr}<c:marker><c:symbol val="none"/></c:marker>${dpts}<c:cat><c:numRef><c:f>${catRef}</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>${ref(sheet, cIdx, r0, r1)}</c:f></c:numRef></c:val><c:smooth val="0"/></c:ser>`;
  };
  const axisFont = (Y) => txPr(fontPx(Y ? Y.h : 10), Y ? Y.color : '#333333');
  const valAx = (id, crossId, Y, side, del) => {
    const sc = Y && Y.min != null ? `${Y.isLog ? '<c:logBase val="10"/>' : ''}<c:orientation val="minMax"/><c:max val="${Y.max}"/><c:min val="${Y.min}"/>` : '<c:orientation val="minMax"/>';
    return `<c:valAx><c:axId val="${id}"/><c:scaling>${sc}</c:scaling><c:delete val="${del ? 1 : 0}"/><c:axPos val="${side === 'r' ? 'r' : 'l'}"/>${hasGrid && side !== 'r' ? `<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="${gridColor.toString(16).padStart(6, '0').toUpperCase()}"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>` : ''}<c:numFmt formatCode="${esc(numFmtFor(Y))}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr>${yAxisLine && side !== 'r' ? ln(yAxisLine.color, 1) : '<a:ln><a:noFill/></a:ln>'}</c:spPr>${axisFont(Y)}<c:crossAx val="${crossId}"/><c:crosses val="${side === 'r' ? 'max' : 'autoZero'}"/><c:crossBetween val="${table.kind === 'bar' ? 'between' : 'midCat'}"/>${Y && Y.step && !Y.isLog ? `<c:majorUnit val="${Y.step}"/>` : ''}</c:valAx>`;
  };
  const X = m.xTicks;
  const xFont = txPr(fontPx(X ? X.h : 10), X ? X.color : '#333333', X && X.rotated ? '-5400000' : null);
  const xLine = xAxisLine ? ln(xAxisLine.color, 1) : '<a:ln><a:noFill/></a:ln>';
  let plotXml = '', axesXml = '';
  if (table.kind === 'pie') {
    const pie = m.pie; const donut = pie.donut;
    const dpts = pie.slices.map((s, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${hex6(s.color)}"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="${hex6('#' + m.bg.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''))}"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join('');
    const ser = `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${cellRef(sheet, 1, 0)}</c:f></c:strRef></c:tx>${dpts}<c:cat><c:strRef><c:f>${ref(sheet, 0, 1, n)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${ref(sheet, 1, 1, n)}</c:f></c:numRef></c:val></c:ser>`;
    plotXml = donut ? `<c:doughnutChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/><c:holeSize val="${Math.round((pie.inner / pie.r) * 100)}"/></c:doughnutChart>` : `<c:pieChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/></c:pieChart>`;
    const pl = layoutXml((pie.cx - pie.r) / W, (pie.cy - pie.r) / H, (2 * pie.r) / W, (2 * pie.r) / H, true);
    return wrapChart(titleXml, `<c:plotArea>${pl}${plotXml}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>`, legendXml(m, W, H), m);
  }
  if (table.kind === 'bar') {
    const bars = table.series; const horiz = bars[0].type === 'barh';
    if (YL && !horiz) { const feet = bars.flatMap((s) => s.points.filter((p) => p.rect).map((p) => m.left ? m.left.fit.a + m.left.fit.b * (p.rect.y1 + 0.5) : 0)); const lo = Math.min(...feet); if (isFinite(lo) && lo < YL.min) YL = { ...YL, min: YL.step ? Math.floor(lo / YL.step * 2) / 2 * YL.step : lo }; }
    // geometry: gap between groups vs bar width
    const pts = bars.flatMap((s) => s.points.filter((p) => p.rect));
    const bw = median(pts.map((p) => (horiz ? p.rect.y1 - p.rect.y0 + 1 : p.rect.x1 - p.rect.x0 + 1))) || 10;
    const centres = (m.series.categories || []).map((_, i) => { const r = bars.map((s) => s.points[i] && s.points[i].rect).filter(Boolean); return r.length ? (horiz ? (Math.min(...r.map((q) => q.y0)) + Math.max(...r.map((q) => q.y1))) / 2 : (Math.min(...r.map((q) => q.x0)) + Math.max(...r.map((q) => q.x1))) / 2) : null; }).filter((v) => v != null);
    const spacing = centres.length > 1 ? median(centres.slice(1).map((c, i) => c - centres[i])) : bw * 3;
    const stacked = bars[0].stacked; const groupW = stacked ? bw : bw * bars.length;
    const gap = Math.max(0, Math.min(500, Math.round(((spacing - groupW) / bw) * 100)));
    const sers = bars.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>${cellRef(sheet, i + 1, 0)}</c:f></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${hex6(s.color)}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/><c:cat><c:strRef><c:f>${ref(sheet, 0, r0, r1)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${ref(sheet, i + 1, r0, r1)}</c:f></c:numRef></c:val></c:ser>`).join('');
    plotXml = `<c:barChart><c:barDir val="${horiz ? 'bar' : 'col'}"/><c:grouping val="${stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${sers}<c:gapWidth val="${gap}"/><c:overlap val="${stacked ? 100 : 0}"/><c:axId val="${axIds.cat}"/><c:axId val="${axIds.val}"/></c:barChart>`;
    const catAx = `<c:catAx><c:axId val="${axIds.cat}"/><c:scaling><c:orientation val="${horiz ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${horiz ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/><c:spPr>${xLine}</c:spPr>${xFont}<c:crossAx val="${axIds.val}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
    axesXml = catAx + valAx(axIds.val, axIds.cat, horiz ? null : YL, 'l', false);
  } else {
    // lines / areas / bands on a date or number axis; scatter series on value axes
    const nat = table.nat; const isDate = table.kind === 'date';
    const catRef = ref(sheet, 0, r0, r1);
    let ci = 1; const lines = [[], []], areas = [[], []], bands = [[], []];
    const sers = nat ? nat.series : [];
    sers.forEach((s) => { if (s.type === 'band') { bands[s.axis || 0].push({ s, c: ci }); ci += 2; } else { (s.type === 'area' ? areas : lines)[s.axis || 0].push({ s, c: ci }); ci++; } });
    let idx = 0; const groups = [];
    for (const side of [0, 1]) {
      const ax = side ? [axIds.cat2, axIds.val2] : [axIds.cat, axIds.val];
      if (bands[side].length || areas[side].length) {
        let sx = '';
        // a band = invisible lower part + visible thickness, stacked
        for (const { s, c } of bands[side]) {
          hideIdx.push(idx);
          sx += `<c:ser><c:idx val="${idx}"/><c:order val="${idx++}"/><c:tx><c:v>${esc(s.name)} base</c:v></c:tx><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:cat><c:numRef><c:f>${catRef}</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>${ref(sheet, c, r0, r1)}</c:f></c:numRef></c:val></c:ser>`;
          sx += `<c:ser><c:idx val="${idx}"/><c:order val="${idx++}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="${hex6(s.color)}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:cat><c:numRef><c:f>${catRef}</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>${ref(sheet, table.bandHelper[s.name], r0, r1)}</c:f></c:numRef></c:val></c:ser>`;
        }
        if (sx) groups.push(`<c:areaChart><c:grouping val="stacked"/><c:varyColors val="0"/>${sx}<c:axId val="${ax[0]}"/><c:axId val="${ax[1]}"/></c:areaChart>`);
        if (areas[side].length) groups.push(`<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${areas[side].map(({ s, c }) => `<c:ser><c:idx val="${idx}"/><c:order val="${idx++}"/><c:tx><c:strRef><c:f>${cellRef(sheet, c, 0)}</c:f></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${hex6(s.color)}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:cat><c:numRef><c:f>${catRef}</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>${ref(sheet, c, r0, r1)}</c:f></c:numRef></c:val></c:ser>`).join('')}<c:axId val="${ax[0]}"/><c:axId val="${ax[1]}"/></c:areaChart>`);
      }
      if (lines[side].length) {
        const body = lines[side].map(({ s, c }) => serLine(s, idx++, c, catRef, !isDate)).join('');
        groups.push(isDate || bands[side].length || areas[side].length
          ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${body}<c:marker val="1"/><c:axId val="${ax[0]}"/><c:axId val="${ax[1]}"/></c:lineChart>`
          : `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${body}<c:axId val="${ax[0]}"/><c:axId val="${ax[1]}"/></c:scatterChart>`);
      }
    }
    // scatter (markers)
    if (table.scatter) {
      const body = table.scatter.map((s, k) => { const c0 = table.scatterStart + k * 2; return `<c:ser><c:idx val="${idx}"/><c:order val="${idx++}"/><c:tx><c:strRef><c:f>${cellRef(sheet, c0 + 1, 0)}</c:f></c:strRef></c:tx><c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="${Math.max(2, Math.min(20, Math.round((s.markerSize || 5) * 0.75)))}"/><c:spPr><a:solidFill><a:srgbClr val="${hex6(s.color)}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker><c:xVal><c:numRef><c:f>${ref(sheet, c0, 1, s.points.length)}</c:f></c:numRef></c:xVal><c:yVal><c:numRef><c:f>${ref(sheet, c0 + 1, 1, s.points.length)}</c:f></c:numRef></c:yVal><c:smooth val="0"/></c:ser>`; }).join('');
      groups.push(`<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${body}<c:axId val="${axIds.cat}"/><c:axId val="${axIds.val}"/></c:scatterChart>`);
    }
    plotXml = groups.join('');
    const XT = m.xTicks;
    const anyCatGroup = /c:(lineChart|areaChart)/.test(plotXml);
    if (anyCatGroup && isDate) {
      const step = XT && XT.step ? XT.step : 1;
      const unit = step >= 1 - 1e-6 ? ['years', Math.round(step)] : step >= 1 / 12 - 1e-6 ? ['months', Math.max(1, Math.round(step * 12))] : ['days', Math.max(1, Math.round(step * 365.25))];
      const mn = XT ? dateToExcel(yearToDate(XT.min)) : null, mx = XT ? dateToExcel(yearToDate(XT.max)) : null;
      axesXml += `<c:dateAx><c:axId val="${axIds.cat}"/><c:scaling><c:orientation val="minMax"/>${mx ? `<c:max val="${Math.round(mx)}"/><c:min val="${Math.round(mn)}"/>` : ''}</c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="${esc(dateFmtFor(m))}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/><c:spPr>${xLine}</c:spPr>${xFont}<c:crossAx val="${axIds.val}"/><c:crosses val="autoZero"/><c:auto val="0"/><c:lblOffset val="100"/><c:baseTimeUnit val="days"/><c:majorUnit val="${unit[1]}"/><c:majorTimeUnit val="${unit[0]}"/></c:dateAx>`;
    } else {
      const XT2 = XT && XT.min != null ? XT : null;
      axesXml += `<c:valAx><c:axId val="${axIds.cat}"/><c:scaling><c:orientation val="minMax"/>${XT2 ? `<c:max val="${XT2.max}"/><c:min val="${XT2.min}"/>` : ''}</c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/><c:spPr>${xLine}</c:spPr>${xFont}<c:crossAx val="${axIds.val}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/>${XT2 && XT2.step ? `<c:majorUnit val="${XT2.step}"/>` : ''}</c:valAx>`;
    }
    axesXml += valAx(axIds.val, axIds.cat, YL || YR, YL ? 'l' : 'r', false);
    if (/c:axId val="1004"/.test(plotXml)) {
      axesXml += anyCatGroup && isDate ? `<c:dateAx><c:axId val="${axIds.cat2}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="none"/><c:crossAx val="${axIds.val2}"/><c:crosses val="autoZero"/><c:auto val="0"/><c:lblOffset val="100"/><c:baseTimeUnit val="days"/></c:dateAx>`
        : `<c:valAx><c:axId val="${axIds.cat2}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="none"/><c:crossAx val="${axIds.val2}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;
      axesXml += valAx(axIds.val2, axIds.cat2, YR, 'r', false);
    }
  }
  const pl = layoutXml(P.x0 / W, P.y0 / H, (P.x1 - P.x0 + 1) / W, (P.y1 - P.y0 + 1) / H, true);
  const plotArea = `<c:plotArea>${pl}${plotXml}${axesXml}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>`;
  return wrapChart(titleXml, plotArea, legendXml(m, W, H, hideIdx), m);
}

function legendXml(m, W, H, hideIdx = []) {
  const L = m.legend || [];
  if (!L.length || !(m.series || []).some((s) => s.named) && !m.pie) return '';
  const x0 = Math.min(...L.map((e) => e.swatchBox.x0)), x1 = Math.max(...L.map((e) => e.box.x1));
  const y0 = Math.min(...L.map((e) => Math.min(e.box.y0, e.swatchBox.y0))), y1 = Math.max(...L.map((e) => Math.max(e.box.y1, e.swatchBox.y1)));
  const h = median(L.map((e) => (e.phrase ? e.phrase.h : 10)));
  const color = L[0].textColor || '#333333';
  // hide helper entries (band bases)
  return `<c:legend><c:legendPos val="b"/>${hideIdx.map((i) => `<c:legendEntry><c:idx val="${i}"/><c:delete val="1"/></c:legendEntry>`).join('')}${layoutXml(x0 / W, y0 / H, (x1 - x0 + 1) / W, (y1 - y0 + 1) / H, false)}<c:overlay val="1"/>${txPr(fontPx(h), color)}</c:legend>`;
}

function wrapChart(titleXml, plotArea, legend, m) {
  const bg = m.bg.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:date1904 val="0"/><c:roundedCorners val="0"/>
<c:chart>${titleXml}${plotArea}${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>
<c:spPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>
<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:latin typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>
</c:chartSpace>`;
}

function drawingXml(items) {
  // items: [{kind:'chart'|'pic', col, row, cx, cy, rid, name}]
  const body = items.map((it, i) => {
    const from = `<xdr:from><xdr:col>${it.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${it.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`;
    const ext = `<xdr:ext cx="${Math.round(it.cx)}" cy="${Math.round(it.cy)}"/>`;
    if (it.kind === 'chart') return `<xdr:oneCellAnchor>${from}${ext}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="${esc(it.name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${it.rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`;
    return `<xdr:oneCellAnchor>${from}${ext}<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="${esc(it.name)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${it.rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(it.cx)}" cy="${Math.round(it.cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${body}</xdr:wsDr>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="mmm\\-yy"/><numFmt numFmtId="165" formatCode="yyyy"/><numFmt numFmtId="166" formatCode="dd\\-mmm\\-yy"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="16"/><name val="Calibri"/><family val="2"/></font><font><sz val="10"/><color rgb="FF6E6E73"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF5F5F7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD2D2D7"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function safeSheetName(name, used) {
  let s = String(name || 'Chart').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || 'Chart';
  let k = s, i = 2; while (used.has(k.toLowerCase())) k = s.slice(0, 26) + ' ' + i++;
  used.add(k.toLowerCase()); return k;
}

// items: [{ model, png: Uint8Array|Blob (source image), name, page, score }]
export async function buildWorkbook(items, { title = 'Retrace' } = {}) {
  const zip = new JSZip(); const used = new Set();
  const sheets = []; let chartN = 0, drawN = 0, imgN = 0;
  const contentOverrides = [];
  const multi = items.length > 1;
  if (multi) sheets.push({ name: safeSheetName('Contents', used), contents: true });
  for (const it of items) {
    const m = it.model;
    const name = safeSheetName(it.name || (m.title && m.title.text) || 'Chart ' + (sheets.length + 1), used);
    const table = tableFor(m);
    // band helpers: upper - lower, in a column after the table
    if (table.nat) {
      table.bandHelper = {}; let ci = 1;
      for (const s of table.nat.series) {
        if (s.type === 'band') {
          const hc = table.rows[0].length; table.rows[0][hc] = s.name + ' (thickness)';
          for (let r = 1; r < table.rows.length; r++) { const lo = table.rows[r][ci], up = table.rows[r][ci + 1]; table.rows[r][hc] = lo != null && up != null ? +(up - lo).toFixed(8) : null; }
          table.bandHelper[s.name] = hc; ci += 2;
        } else ci++;
      }
    }
    sheets.push({ name, table, m, it });
  }
  const wbSheets = [], wbRels = [];
  sheets.forEach((sh, i) => {
    const sid = i + 1; wbSheets.push(`<sheet name="${esc(sh.name)}" sheetId="${sid}" r:id="rId${sid}"/>`);
    wbRels.push(`<Relationship Id="rId${sid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sid}.xml"/>`);
    contentOverrides.push(`<Override PartName="/xl/worksheets/sheet${sid}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    if (sh.contents) {
      const rows = [['Chart', 'Type', 'Series', 'Points', 'Match', 'Page', 'Title in source']];
      sheets.filter((x) => !x.contents).forEach((x) => rows.push([x.name, x.m.chartType, (x.m.series || []).length || (x.m.pie ? x.m.pie.slices.length : 0), x.table.n, x.it.score != null ? +x.it.score.toFixed(1) : null, x.it.page || null, x.m.title ? x.m.title.text : null]));
      const xml = sheetXml({ rows, kind: 'text' }, null);
      zip.file(`xl/worksheets/sheet${sid}.xml`, xml.replace(/<sheetData>/, '<sheetData>'));
      return;
    }
    const m = sh.m; const t = sh.table;
    // chart + source image to the right of the table
    chartN++; drawN++; imgN++;
    const dataCols = Math.max(...t.rows.map((r) => r.length)) || 1;
    const anchorCol = dataCols + 1;
    const scale = Math.min(1, 900 / m.W) || 1;
    const cx = m.W * EMU * Math.max(scale, 0.6), cy = m.H * EMU * Math.max(scale, 0.6);
    const chartRows = Math.ceil((m.H * Math.max(scale, 0.6)) / 20) + 2;
    const extra = [[chartRows + 1, anchorCol, 'Original image', STY.header]];
    zip.file(`xl/worksheets/sheet${sid}.xml`, sheetXml(t, 'rId1', []));
    zip.file(`xl/worksheets/_rels/sheet${sid}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawN}.xml"/></Relationships>`);
    zip.file(`xl/drawings/drawing${drawN}.xml`, drawingXml([
      { kind: 'chart', col: anchorCol, row: 1, cx, cy, rid: 'rId1', name: 'Rebuilt chart' },
      { kind: 'pic', col: anchorCol, row: chartRows + 1, cx, cy, rid: 'rId2', name: 'Original image' },
    ]));
    zip.file(`xl/drawings/_rels/drawing${drawN}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartN}.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${imgN}.png"/></Relationships>`);
    zip.file(`xl/charts/chart${chartN}.xml`, chartXml(m, t, sh.name));
    zip.file(`xl/media/image${imgN}.png`, sh.it.png);
    contentOverrides.push(`<Override PartName="/xl/drawings/drawing${drawN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
    contentOverrides.push(`<Override PartName="/xl/charts/chart${chartN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
  });
  // notes sheet (single chart) with calibration and scores
  if (!multi) {
    const sh = sheets[0]; const m = sh.m; const sid = sheets.length + 1;
    const rows = [['About this extraction', ''], ['Source title', m.title ? m.title.text : ''], ['Chart type', m.chartType]];
    if (sh.table.nat) rows.push(['Data detail in this file', sh.table.nat.grid.name]);
    if (sh.it.score != null) rows.push(['Trace match (%)', +sh.it.score.toFixed(1)]);
    if (sh.it.axisScore != null) rows.push(['Axis fit (%)', +sh.it.axisScore.toFixed(2)]);
    (m.notes || []).forEach((n) => rows.push(['Note in source', n]));
    rows.push(['Made with', 'Retrace — runs in your browser; nothing was uploaded']);
    zip.file(`xl/worksheets/sheet${sid}.xml`, sheetXml({ rows, kind: 'text' }, null));
    wbSheets.push(`<sheet name="About" sheetId="${sid}" r:id="rId${sid}"/>`);
    wbRels.push(`<Relationship Id="rId${sid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sid}.xml"/>`);
    contentOverrides.push(`<Override PartName="/xl/worksheets/sheet${sid}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }
  const nRel = wbRels.length;
  wbRels.push(`<Relationship Id="rId${nRel + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${wbSheets.join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels.join('')}</Relationships>`);
  zip.file('xl/styles.xml', STYLES);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Retrace</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Retrace</Application></Properties>`);
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${contentOverrides.join('')}</Types>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
}
