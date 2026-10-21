// How close is the rebuild? Pixel agreement per series, axis fit, printed values, and a confidence ribbon.
import { seriesGeometry, dashArray } from './render.js';
import { median, mean } from './image.js';

function dilate(mask, W, H, r) {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let last = -1e9; for (let x = 0; x < W; x++) { if (mask[y * W + x]) last = x; if (x - last <= r) tmp[y * W + x] = 1; } last = 1e9; for (let x = W - 1; x >= 0; x--) { if (mask[y * W + x]) last = x; if (last - x <= r) tmp[y * W + x] = 1; } }
  for (let x = 0; x < W; x++) { let last = -1e9; for (let y = 0; y < H; y++) { if (tmp[y * W + x]) last = y; if (y - last <= r) out[y * W + x] = 1; } last = 1e9; for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) last = y; if (last - y <= r) out[y * W + x] = 1; } }
  return out;
}

// Rasterise one series' rebuilt geometry into a mask
function drawMask(g, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
  ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const s = g.s;
  if (g.pts) {
    ctx.lineWidth = Math.max(1, s.width || 1.5); ctx.beginPath(); let started = false;
    for (const p of g.pts) { if (!p) { started = false; continue; } if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]); }
    ctx.stroke();
  } else if (g.upper) {
    ctx.beginPath(); g.upper.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); [...g.lower].reverse().forEach((p) => ctx.lineTo(p[0], p[1])); ctx.closePath(); ctx.fill();
  } else if (g.rects) g.rects.forEach((r) => ctx.fillRect(r.x, r.y, r.w, r.h));
  else if (g.dots) { const r = Math.max(1.5, (s.markerSize || 5) / 2); g.dots.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }); }
  const d = ctx.getImageData(0, 0, W, H).data; const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (d[i * 4 + 3] > 100) m[i] = 1;
  return m;
}

export function scoreModel(m) {
  const W = m.W, H = m.H; const res = { series: [], ribbon: [], diff: null };
  const plot = m.plot; const pw = plot.x1 - plot.x0 + 1;
  if (m.pie) {
    // pies: compare angles of slices with printed percentages, if any
    const errs = (m.pie.anchors || []).filter((a) => a.pct).map((a) => Math.abs(a.value - a.slice.share * 100));
    res.trace = 100; res.anchors = errs.length ? { n: errs.length, meanErr: mean(errs) } : null; res.axis = null;
    return res;
  }
  const geo = seriesGeometry(m);
  const colGood = new Float32Array(pw), colAll = new Float32Array(pw);
  const missAll = new Uint8Array(W * H), extraAll = new Uint8Array(W * H);
  let tp = 0, tr = 0, sumO = 0, sumR = 0;
  for (const g of geo) {
    const ids = new Set(g.s.clusterIds || []);
    const orig = new Uint8Array(W * H);
    for (let y = plot.y0; y <= plot.y1; y++) for (let x = plot.x0; x <= plot.x1; x++) { const p = y * W + x; if (ids.has(m.asg[p]) && m.core[p]) orig[p] = 1; }
    const reb = drawMask(g, W, H);
    const tol = g.type === 'bar' || g.type === 'barh' || g.type === 'area' || g.type === 'band' ? 1 : 2;
    const dO = dilate(orig, W, H, tol), dR = dilate(reb, W, H, tol);
    let nO = 0, nR = 0, hitO = 0, hitR = 0;
    for (let y = plot.y0; y <= plot.y1; y++) for (let x = plot.x0; x <= plot.x1; x++) {
      const p = y * W + x;
      if (orig[p]) { nO++; colAll[x - plot.x0]++; if (dR[p]) { hitO++; colGood[x - plot.x0]++; } else missAll[p] = 1; }
      if (reb[p]) { nR++; if (dO[p]) hitR++; else extraAll[p] = 1; }
    }
    const recall = nO ? hitO / nO : 1, precision = nR ? hitR / nR : 1;
    const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
    res.series.push({ name: g.s.name, recall, precision, f1, n: nO });
    tp += hitO; tr += hitR; sumO += nO; sumR += nR;
  }
  const R = sumO ? tp / sumO : 1, P = sumR ? tr / sumR : 1;
  res.trace = 100 * (R + P ? (2 * R * P) / (R + P) : 0);
  // average vertical gap for lines, in value units
  const gaps = [];
  for (const s of m.series || []) if (s.type === 'line' || s.type === 'step') {
    const a = [m.left, m.right][s.axis] || m.left || m.right; if (!a) continue;
    for (const p of s.points) if (!p.interp && p.py != null && p.y != null) { const py = m.yToPx(s.axis, p.y); gaps.push(Math.abs(py - p.py) * Math.abs(a.fit.b)); }
  }
  res.meanGap = gaps.length ? mean(gaps) : null;
  // axis fit: worst label residual as share of the axis range
  const axes = [m.left, m.right].filter(Boolean);
  if (axes.length) {
    const scores = axes.map((a) => { const range = a.fit.range || 1; return Math.max(0, 100 * (1 - a.fit.maxResid / range)); });
    const xs = m.xAxis && m.xAxis.fit ? [Math.max(0, 100 * (1 - m.xAxis.fit.maxResid / (m.xAxis.fit.range || 1)))] : [];
    res.axis = Math.min(...scores, ...xs);
    res.axisLabels = axes.reduce((n, a) => n + a.fit.inliers.length, 0) + (m.xAxis ? (m.xAxis.used || 0) : 0);
  } else res.axis = null;
  // printed values
  const printed = (m.series || []).flatMap((s) => s.points.filter((p) => p.printed != null));
  res.anchors = printed.length ? { n: printed.length, matched: printed.filter((p) => p.source === 'printed').length } : null;
  // confidence ribbon (40 buckets)
  const B = 40; for (let b = 0; b < B; b++) {
    let g = 0, a = 0, interp = 0, tot = 0;
    for (let i = Math.floor((b * pw) / B); i < Math.floor(((b + 1) * pw) / B); i++) { g += colGood[i]; a += colAll[i]; }
    for (const s of m.series || []) for (const p of s.points) { if (p.px == null) continue; const i = p.px - plot.x0; if (i >= Math.floor((b * pw) / B) && i < Math.floor(((b + 1) * pw) / B)) { tot++; if (p.interp) interp++; } }
    const agree = a ? g / a : 1; const covered = tot ? 1 - interp / tot : 1;
    res.ribbon.push(Math.min(agree, 0.4 + 0.6 * covered));
  }
  res.diff = { miss: missAll, extra: extraAll };
  return res;
}

// A picture of the disagreements over a faded original
export function diffCanvas(m, srcCanvas, diff) {
  const W = m.W, H = m.H; const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 0.22; ctx.drawImage(srcCanvas, 0, 0); ctx.globalAlpha = 1;
  const im = ctx.getImageData(0, 0, W, H); const d = im.data;
  for (let i = 0; i < W * H; i++) {
    if (diff.miss[i]) { d[i * 4] = 255; d[i * 4 + 1] = 59; d[i * 4 + 2] = 48; d[i * 4 + 3] = 255; }
    else if (diff.extra[i]) { d[i * 4] = 0; d[i * 4 + 1] = 113; d[i * 4 + 2] = 227; d[i * 4 + 3] = 255; }
  }
  ctx.putImageData(im, 0, 0);
  return c;
}
