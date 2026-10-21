// Axis labels -> calibrated scales.
import { parseNumber, parseDate } from './parse.js';
import { median, mean } from './image.js';

// Robust line fit v = a + b*p. pts: [{p, v, box}]
export function ransacFit(pts, opts = {}) {
  const n = pts.length; if (n < 2) return null;
  const sorted = [...pts].sort((x, y) => x.p - y.p);
  const dv = []; for (let i = 1; i < sorted.length; i++) { const d = Math.abs(sorted[i].v - sorted[i - 1].v); if (d > 0) dv.push(d); }
  const stepV = median(dv) || 1;
  const tol = opts.tol ?? stepV * 0.18;
  let best = null;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const A = pts[i], B = pts[j]; if (Math.abs(A.p - B.p) < 3 || A.v === B.v) continue;
    const b = (B.v - A.v) / (B.p - A.p); const a = A.v - b * A.p;
    if (opts.sign && Math.sign(b) !== opts.sign) continue;
    let inl = [], err = 0;
    for (const P of pts) { const e = Math.abs(a + b * P.p - P.v); if (e <= tol) { inl.push(P); err += e; } }
    if (!best || inl.length > best.inl.length || (inl.length === best.inl.length && err < best.err)) best = { a, b, inl, err };
  }
  if (!best || best.inl.length < 2) return null;
  // least squares on inliers
  const I = best.inl; const mp = mean(I.map((x) => x.p)), mv = mean(I.map((x) => x.v));
  let sxy = 0, sxx = 0, syy = 0; for (const P of I) { sxy += (P.p - mp) * (P.v - mv); sxx += (P.p - mp) ** 2; syy += (P.v - mv) ** 2; }
  const b = sxx ? sxy / sxx : best.b; const a = mv - b * mp;
  const r2 = syy ? (sxy * sxy) / (sxx * syy) : 1;
  const resid = I.map((P) => Math.abs(a + b * P.p - P.v));
  return { a, b, inliers: I, outliers: pts.filter((P) => !I.includes(P)), r2, stepV, maxResid: Math.max(...resid), range: Math.abs(Math.max(...I.map((x) => x.v)) - Math.min(...I.map((x) => x.v))) };
}

function groupBy(boxes, key, tol) {
  const s = [...boxes].sort((a, b) => key(a) - key(b)); const groups = [];
  for (const b of s) { const g = groups.find((G) => Math.abs(key(G[0]) - key(b)) <= tol && Math.abs(median(G.map(key)) - key(b)) <= tol); if (g) g.push(b); else groups.push([b]); }
  return groups;
}

// Find a vertical numeric scale (left or right). Returns best candidate list.
export function findValueAxes(words, W, H) {
  const nums = words.filter((w) => !w.rotated && w.text).map((w) => ({ w, n: parseNumber(w.text) })).filter((x) => x.n);
  const cands = [];
  for (const [keyName, key] of [['right', (x) => x.w.x1], ['left', (x) => x.w.x0], ['center', (x) => x.w.cx]]) {
    for (const g of groupBy(nums, key, 5)) {
      if (g.length < 3) continue;
      const ys = new Set(g.map((x) => Math.round(x.w.cy / 3))); if (ys.size < 3) continue;
      const pts = g.map((x) => ({ p: x.w.cy, v: x.n.value, box: x.w, pct: x.n.pct, dec: x.n.decimals }));
      const lin = ransacFit(pts, { sign: -1 });
      let log = null;
      if (pts.every((P) => P.v > 0)) {
        const lp = ransacFit(pts.map((P) => ({ ...P, v: Math.log10(P.v), orig: P.v })), { sign: -1, tol: 0.06 });
        if (lp && lp.inliers.length >= 3) log = lp;
      }
      let fit = lin, isLog = false;
      if (log && (!lin || log.inliers.length > lin.inliers.length + 0 && log.r2 > lin.r2 + 0.002) && ratioSpaced(pts)) { fit = log; isLog = true; }
      if (!fit || fit.inliers.length < 3) continue;
      // labels in a value axis are evenly spaced in pixels too (except log)
      const xs = fit.inliers.map((P) => P.box.cx);
      cands.push({ key: keyName, fit, isLog, n: fit.inliers.length, x0: Math.min(...fit.inliers.map((P) => P.box.x0)), x1: Math.max(...fit.inliers.map((P) => P.box.x1)), cx: mean(xs), pts, pct: pts.some((P) => P.pct) });
    }
  }
  // dedupe: the same labels via different keys
  cands.sort((a, b) => b.n - a.n || b.fit.r2 - a.fit.r2);
  const out = [];
  for (const c of cands) {
    if (out.some((o) => o.fit.inliers.some((P) => c.fit.inliers.some((Q) => Q.box === P.box)))) continue;
    out.push(c);
  }
  return out;
}
function ratioSpaced(pts) {
  const v = pts.map((P) => P.v).sort((a, b) => a - b); const r = [];
  for (let i = 1; i < v.length; i++) r.push(v[i] / v[i - 1]);
  return r.length >= 2 && Math.max(...r) / Math.min(...r) < 1.6 && median(r) >= 1.9;
}

// Horizontal axis below the plot: numbers, dates, or categories.
export function findCategoryAxis(words, plotGuess) {
  const pool = words.filter((w) => w.text && w.cy > plotGuess.yMid);
  // group rows: horizontal labels by cy, rotated labels by top edge
  const rows = [];
  for (const g of groupBy(pool.filter((w) => !w.rotated), (w) => w.cy, 4)) if (g.length >= 2) rows.push({ boxes: g, rotated: false });
  for (const g of groupBy(pool.filter((w) => w.rotated), (w) => w.y0, 6)) if (g.length >= 3) rows.push({ boxes: g, rotated: true });
  const results = [];
  for (const row of rows) {
    const boxes = row.boxes.sort((a, b) => a.cx - b.cx);
    const r = interpretRow(boxes);
    if (r) results.push({ ...r, rotated: row.rotated, y0: Math.min(...boxes.map((b) => b.y0)), y1: Math.max(...boxes.map((b) => b.y1)), boxes });
  }
  // prefer rows close below the plot with many usable labels
  results.forEach((r) => { r.score = r.used * (r.kind === 'category' ? 0.8 : 1) - Math.max(0, r.y0 - plotGuess.bottom) / 40; });
  results.sort((a, b) => b.score - a.score);
  return results;
}

function interpretRow(boxes) {
  const pts = boxes.map((b) => ({ p: b.cx, box: b, text: b.text }));
  // 1) dates
  const dates = pts.map((P) => ({ ...P, d: parseDate(P.text) })).filter((P) => P.d);
  let best = null;
  if (dates.length >= Math.max(2, pts.length * 0.5)) {
    const kinds = {}; dates.forEach((P) => (kinds[P.d.kind] = (kinds[P.d.kind] || 0) + 1));
    const kind = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0];
    const fit = ransacFit(dates.map((P) => ({ p: P.p, v: P.d.t, box: P.box })), { sign: 1 });
    if (fit && fit.inliers.length >= 2) best = { kind: 'date', dateKind: kind, fit, used: fit.inliers.length };
  }
  // 2) numbers, with two-digit-year handling
  const nums = pts.map((P) => ({ ...P, n: parseNumber(P.text) })).filter((P) => P.n);
  if (nums.length >= Math.max(2, pts.length * 0.5)) {
    let fit = ransacFit(nums.map((P) => ({ p: P.p, v: P.n.value, box: P.box })), { sign: 1 });
    let kind = 'number', dateKind = null;
    const ints2 = nums.filter((P) => P.n.twoDigit);
    if (ints2.length >= nums.length * 0.7 && ints2.length >= 3) {
      // try century splits
      let bestY = null;
      const sorted = [...ints2].sort((a, b) => a.p - b.p);
      for (let k = 0; k <= sorted.length; k++) {
        const ys = sorted.map((P, i) => ({ p: P.p, v: P.n.value + (i < k ? 1900 : 2000), box: P.box }));
        const f = ransacFit(ys, { sign: 1 });
        if (f && (!bestY || f.inliers.length > bestY.inliers.length)) bestY = f;
      }
      const wraps = sorted.some((P, i) => i && P.n.value < sorted[i - 1].n.value - 50);
      if (bestY && (wraps || (fit && bestY.inliers.length > fit.inliers.length))) { fit = bestY; kind = 'date'; dateKind = 'year'; }
      else if (fit && fit.inliers.length >= 3 && Math.abs(fit.stepV) <= 5) {
        // ascending two-digit labels with year-like steps: treat as years when in plausible range
        const vals = fit.inliers.map((P) => P.v);
        if (Math.min(...vals) >= 0 && Math.max(...vals) <= 99 && Number.isInteger(fit.stepV)) { /* ambiguous: keep numeric */ }
      }
    } else if (fit && fit.inliers.every((P) => Number.isInteger(P.v) && P.v >= 1900 && P.v <= 2100)) { kind = 'date'; dateKind = 'year'; }
    if (fit && fit.inliers.length >= 2 && (!best || fit.inliers.length > best.used)) best = { kind, dateKind, fit, used: fit.inliers.length };
  }
  // 3) categories: mostly words
  if (!best || best.used < 3) {
    const words = pts.filter((P) => /[A-Za-z]/.test(P.text) || parseNumber(P.text));
    if (words.length >= 2 && (!best || words.length > best.used + 1)) best = { kind: 'category', cats: words.map((P) => ({ label: P.text, px: P.p, box: P.box })), used: words.length };
  }
  return best;
}

// Left-hand categories for horizontal bars
export function findLeftCategories(words, plot) {
  const pool = words.filter((w) => !w.rotated && w.text && w.x1 < plot.x0 + 4 && /[A-Za-z]/.test(w.text));
  const g = groupBy(pool, (w) => w.x1, 6).sort((a, b) => b.length - a.length)[0];
  if (!g || g.length < 2) return null;
  return g.sort((a, b) => a.cy - b.cy).map((w) => ({ label: w.text, px: w.cy, box: w }));
}

// Even tick step and nice axis bounds from the fit
export function axisInfo(fit, isLog, pLo, pHi) {
  const vals = fit.inliers.map((P) => (isLog ? Math.pow(10, P.v) : P.v)).sort((a, b) => a - b);
  const steps = []; for (let i = 1; i < vals.length; i++) steps.push(vals[i] - vals[i - 1]);
  const major = isLog ? null : median(steps);
  let min = vals[0], max = vals[vals.length - 1];
  return { min, max, major, ticks: vals };
}
