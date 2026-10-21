// Finding series by colour and turning their pixels into values.
import { rgb2lab, dE, chroma, hex, components, median, mean } from './image.js';

// Straight achromatic rules (axes, gridlines, frames): rows/columns that stand out from their neighbours
// along most of the plot, even when faint or noisy (JPEG).
export function findRules(img, lab, bg, plot, tickYs = null, tickXs = null) {
  const W = img.width, H = img.height; const bgLab = rgb2lab(...bg);
  const d = (x, y) => { const i = (y * W + x) * 3; return dE([lab[i], lab[i + 1], lab[i + 2]], bgLab); };
  const grey = (x, y) => { const i = (y * W + x) * 3; return Math.hypot(lab[i + 1], lab[i + 2]) < 22 || (lab[i] < 42 && Math.hypot(lab[i + 1], lab[i + 2]) < 40); };
  const pw = plot.x1 - plot.x0 + 1, ph = plot.y1 - plot.y0 + 1;
  const rows = [], cols = [];
  for (let y = Math.max(3, plot.y0 - 3); y <= Math.min(H - 4, plot.y1 + 3); y++) {
    let hit = 0;
    for (let x = plot.x0; x <= plot.x1; x++) { const v = d(x, y); if (v > 4 && grey(x, y) && v - Math.max(d(x, y - 3), d(x, y + 3)) > 2.5) hit++; }
    const nearTick = tickYs && tickYs.some((t) => Math.abs(t - y) <= 2.5);
    if (hit >= 0.88 * pw || (hit >= 0.5 * pw && (nearTick || !tickYs))) rows.push(y);
  }
  for (let x = Math.max(3, plot.x0 - 3); x <= Math.min(W - 4, plot.x1 + 3); x++) {
    let hit = 0;
    for (let y = plot.y0; y <= plot.y1; y++) { const v = d(x, y); if (v > 4 && grey(x, y) && v - Math.max(d(x - 3, y), d(x + 3, y)) > 2.5) hit++; }
    const nearTickX = tickXs && tickXs.some((t) => Math.abs(t - x) <= 2.5);
    if (hit >= 0.88 * ph || (hit >= 0.6 * ph && (nearTickX || !tickXs))) cols.push(x);
  }
  // keep thin bundles only
  const thin = (arr) => { const out = []; let g = []; for (const k of arr) { if (g.length && k - g[g.length - 1] > 1) { if (g.length <= 3) out.push(...g); g = []; } g.push(k); } if (g.length && g.length <= 3) out.push(...g); return out; };
  return { rows: thin(rows), cols: thin(cols) };
}

// RGB segment distance: anti-aliasing and transparency blend linearly in RGB
function segRGB(P, A, B) {
  const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]; const ap = [P[0] - A[0], P[1] - A[1], P[2] - A[2]];
  const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1; let t = (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / L2; t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]), t };
}

// Colour clusters among plot pixels (anti-aliased fringes are folded into their parent colour).
export function colourClusters(img, lab, bg, plot, excluded, extraBgs = [], bgThr = 9) {
  const W = img.width; const bgLab = rgb2lab(...bg); const d = img.data;
  const bgs = [bg, ...extraBgs]; const bgLabs = bgs.map((b) => rgb2lab(...b));
  const bins = new Map();
  for (let y = plot.y0; y <= plot.y1; y++) for (let x = plot.x0; x <= plot.x1; x++) {
    const p = y * W + x; if (excluded[p]) continue;
    const L = lab[p * 3], A = lab[p * 3 + 1], B = lab[p * 3 + 2];
    if (bgLabs.some((bl) => dE([L, A, B], bl) < bgThr)) continue;
    const k = `${Math.round(L / 4)},${Math.round(A / 4)},${Math.round(B / 4)}`;
    let b = bins.get(k); if (!b) { b = { n: 0, L: 0, A: 0, B: 0, r: 0, g: 0, bb: 0 }; bins.set(k, b); }
    b.n++; b.L += L; b.A += A; b.B += B; b.r += d[p * 4]; b.g += d[p * 4 + 1]; b.bb += d[p * 4 + 2];
  }
  const list = [...bins.values()].map((b) => ({ n: b.n, lab: [b.L / b.n, b.A / b.n, b.B / b.n], rgb: [b.r / b.n, b.g / b.n, b.bb / b.n] })).sort((a, b) => b.n - a.n);
  const total = list.reduce((s, b) => s + b.n, 0);
  const clusters = [];
  for (const b of list) {
    let best = null, bd = 1e9;
    for (const c of clusters) { const dd = dE(b.lab, c.lab); if (dd < bd) { bd = dd; best = c; } }
    if (best && bd < 12) { best.n += b.n; best.core += b.n; continue; }
    // fringe of an existing colour towards the background?
    let fr = null, fd = 1e9;
    for (const c of clusters) for (const bgx of bgs) { const s2 = segRGB(b.rgb, c.rgb, bgx); if (s2.d < fd && s2.t > 0.04 && s2.t < 0.97) { fd = s2.d; fr = c; } }
    if (fr && fd < 16) { fr.n += b.n; continue; }
    // blend of two colours (crossings, lines over fills)
    let blend = false;
    for (let i = 0; i < clusters.length && !blend; i++) for (let j = i + 1; j < clusters.length; j++) { const s2 = segRGB(b.rgb, clusters[i].rgb, clusters[j].rgb); if (s2.d < 12 && s2.t > 0.1 && s2.t < 0.9) { blend = true; break; } }
    if (blend) continue;
    clusters.push({ lab: b.lab, rgb: b.rgb, n: b.n, core: b.n, id: clusters.length });
  }
  const minN = Math.max(20, total * 0.004);
  return clusters.filter((c) => c.core >= minN).map((c, i) => ({ ...c, id: i }));
}

// Pixel -> cluster assignment. Returns cluster index per pixel (-1 none) and a core flag.
export function assignPixels(img, lab, bg, plot, excluded, clusters, extraBgs = [], bgThr = 9) {
  const W = img.width, H = img.height; const asg = new Int16Array(W * H).fill(-1); const core = new Uint8Array(W * H);
  const bgLab = rgb2lab(...bg); const d = img.data; const bgs = [bg, ...extraBgs]; const bgLabs = bgs.map((b) => rgb2lab(...b));
  for (let y = plot.y0; y <= plot.y1; y++) for (let x = plot.x0; x <= plot.x1; x++) {
    const p = y * W + x; if (excluded[p]) continue;
    const P = [lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]];
    if (bgLabs.some((bl) => dE(P, bl) < bgThr)) continue;
    let bi = -1, bd = 1e9;
    for (const c of clusters) { const dd = dE(P, c.lab); if (dd < bd) { bd = dd; bi = c.id; } }
    if (bd < 15) { asg[p] = bi; core[p] = 1; continue; }
    const rgb = [d[p * 4], d[p * 4 + 1], d[p * 4 + 2]];
    let fi = -1, fd = 1e9;
    for (const c of clusters) for (const bgx of bgs) { const s2 = segRGB(rgb, c.rgb, bgx); if (s2.t < 0.8 && s2.d < fd) { fd = s2.d; fi = c.id; } }
    if (fi >= 0 && fd < 18) asg[p] = fi;
  }
  return { asg, core };
}

// Shape statistics for one colour's mask
export function shapeOf(asg, core, W, plot, id) {
  const pw = plot.x1 - plot.x0 + 1;
  let n = 0, cols = 0; const thick = [], colSum = [], colDensity = [], flatCore = [], singleCore = []; let prevC = null, thinCols = 0; let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  const colRuns = [];
  for (let x = plot.x0; x <= plot.x1; x++) {
    const runs = []; let s = -1; let coreCol = 0;
    for (let y = plot.y0; y <= plot.y1 + 1; y++) {
      const on = y <= plot.y1 && asg[y * W + x] === id;
      if (on && core[y * W + x]) coreCol++;
      if (on) { n++; if (s < 0) s = y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      else if (s >= 0) { runs.push([s, y - 1]); s = -1; }
    }
    colRuns.push(runs);
    if (runs.length === 1 && coreCol > 0) { const c = (runs[0][0] + runs[0][1]) / 2; if (prevC !== null && Math.abs(c - prevC) <= 0.6) flatCore.push(coreCol); singleCore.push(coreCol); prevC = c; } else prevC = null;
    if (runs.length) { cols++; runs.forEach((r) => thick.push(r[1] - r[0] + 1)); const sum = runs.reduce((a, r) => a + r[1] - r[0] + 1, 0); const span = runs[runs.length - 1][1] - runs[0][0] + 1; colSum.push(coreCol); colDensity.push(sum / span); if (coreCol <= 4) thinCols++; }
  }
  // thickness measured across the stroke, not straight down (steep lines look thick vertically)
  const perp = [];
  for (let i = 1; i < colRuns.length - 1; i++) {
    const a = colRuns[i - 1], b = colRuns[i], c = colRuns[i + 1];
    if (a.length !== 1 || b.length !== 1 || c.length !== 1) continue;
    const slope = ((c[0][0] + c[0][1]) - (a[0][0] + a[0][1])) / 4;
    perp.push((b[0][1] - b[0][0] + 1) / Math.sqrt(1 + slope * slope));
  }
  return { n, perpThick: perp.length >= 8 ? median(perp) : null, thinShare: cols ? thinCols / cols : 1, coverage: cols / pw, thickness: median(thick) || 0, lineWidth: flatCore.length >= 5 ? median(flatCore) : singleCore.length >= 5 ? Math.max(1, singleCore.sort((a, b) => a - b)[Math.floor(singleCore.length * 0.25)] * 0.75) : null, colFill: median(colSum) || 0, density: median(colDensity) || 0, x0, x1, y0, y1, colRuns };
}

// Rectangles (bars) within a colour mask
export function rectangles(asg, W, H, plot, id, core) {
  const m = new Uint8Array(W * H);
  for (let y = plot.y0; y <= plot.y1; y++) for (let x = plot.x0; x <= plot.x1; x++) { const p = y * W + x; if (asg[p] === id) m[p] = 1; }
  const { comps } = components(m, W, H);
  return comps.filter((c) => c.n >= 6).map((c) => {
    // fill measured inside a slightly shrunken box, so soft edges and halos don't count against it
    const s = c.w >= 6 && c.h >= 6 ? 1 : 0; let k = 0, area = 0;
    for (let y = c.y0 + s; y <= c.y1 - s; y++) for (let x = c.x0 + s; x <= c.x1 - s; x++) { area++; if (m[y * W + x]) k++; }
    // tight box: rows/cols at least half filled
    let tx0 = c.x0, tx1 = c.x1, ty0 = c.y0, ty1 = c.y1;
    const colFill = (x) => { let n = 0; for (let y = c.y0; y <= c.y1; y++) n += m[y * W + x]; return n / c.h; };
    const rowFill = (y) => { let n = 0; for (let x = c.x0; x <= c.x1; x++) n += m[y * W + x]; return n / c.w; };
    while (tx0 < tx1 && colFill(tx0) < 0.5) tx0++; while (tx1 > tx0 && colFill(tx1) < 0.5) tx1--;
    while (ty0 < ty1 && rowFill(ty0) < 0.5) ty0++; while (ty1 > ty0 && rowFill(ty1) < 0.5) ty1--;
    return { ...c, fill: area ? k / area : 1, tx0, tx1, ty0, ty1, tw: tx1 - tx0 + 1, th: ty1 - ty0 + 1 };
  });
}

export function classify(shape, rects, plot) {
  const pw = plot.x1 - plot.x0 + 1, ph = plot.y1 - plot.y0 + 1;
  const total = rects.reduce((s, r) => s + r.n, 0) || 1;
  rects = rects.filter((r) => r.n >= Math.max(12, total * 0.015));   // ignore specks and stray glyphs
  const big = rects.filter((r) => r.tw >= 3 && r.th >= 4);
  const rectish = big.filter((r) => r.fill >= 0.82);
  const rectPix = rectish.reduce((s, r) => s + r.n, 0); const allPix = rects.reduce((s, r) => s + r.n, 0) || 1;
  if (rectish.length >= 1 && rectPix >= 0.75 * allPix && rectish.every((r) => r.tw < pw * 0.6 || r.th < ph * 0.6)) {
    const bottoms = rectish.map((r) => r.ty1), lefts = rectish.map((r) => r.tx0);
    const widths = rectish.map((r) => r.tw), heights = rectish.map((r) => r.th);
    const vSpread = Math.max(...bottoms) - Math.min(...bottoms);
    const hSpread = Math.max(...lefts) - Math.min(...lefts);
    const wSim = Math.max(...widths) - Math.min(...widths) <= Math.max(3, median(widths) * 0.3);
    const hSim = Math.max(...heights) - Math.min(...heights) <= Math.max(3, median(heights) * 0.3);
    if (wSim && (vSpread <= 3 || !hSim || rectish.length === 1) && !(hSim && median(heights) <= 8 && rectish.length > 6)) return 'bar';
    if (hSim && hSpread <= 3) return 'barh';
  }
  if (shape.colFill >= 8 && shape.density >= 0.55 && shape.coverage >= 0.2 && shape.thinShare < 0.25 && !(shape.perpThick != null && shape.perpThick < 6)) return 'area';
  const small = rects.filter((r) => r.w <= 16 && r.h <= 16);
  if (rects.length >= 8 && small.length >= rects.length * 0.8 && shape.coverage < 0.7) {
    // dotted/dashed lines also give many small pieces: they line up and are evenly spaced
    const xs = small.map((r) => r.cx).sort((a, b) => a - b); const gaps = []; for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
    const g = median(gaps); const regular = gaps.filter((v) => Math.abs(v - g) <= Math.max(2, g * 0.3)).length >= gaps.length * 0.7;
    const sizes = small.map((r) => r.w); const thin = median(small.map((r) => r.h)) <= 4;
    if (!(regular && (thin || g < 14))) return 'scatter';
  }
  return 'line';
}

// Follow a line column by column, outwards from a clean seed in the middle.
export function traceLine(shape, plot) {
  const pw = plot.x1 - plot.x0 + 1; const pts = new Array(pw).fill(null);
  const lw = Math.max(1, shape.thickness);
  const cols = shape.colRuns.map((r, i) => (r.length ? i : -1)).filter((i) => i >= 0);
  if (!cols.length) return { pts, first: -1, last: -1 };
  const mid = cols[Math.floor(cols.length / 2)];
  let seed = -1;
  for (let d = 0; d < pw && seed < 0; d++) for (const i of [mid + d, mid - d]) { const r = shape.colRuns[i]; if (r && r.length === 1 && r[0][1] - r[0][0] + 1 <= Math.max(3, lw * 2)) { seed = i; break; } }
  if (seed < 0) seed = mid;
  const step = (i, prev) => {
    const runs = shape.colRuns[i]; if (!runs || !runs.length) return null;
    let r;
    if (prev === null) r = runs.reduce((a, b) => ((a[1] - a[0]) <= (b[1] - b[0]) ? a : b));
    else r = runs.reduce((a, b) => (Math.abs((a[0] + a[1]) / 2 - prev) <= Math.abs((b[0] + b[1]) / 2 - prev) ? a : b));
    const len = r[1] - r[0] + 1; let y;
    if (prev !== null && len > 2.5 * lw + 1) y = Math.abs(r[0] - prev) > Math.abs(r[1] - prev) ? r[0] + lw / 2 - 0.5 : r[1] - lw / 2 + 0.5;
    else y = (r[0] + r[1]) / 2;
    if (prev !== null && Math.abs(y - prev) > (plot.y1 - plot.y0) * 0.45 && runs.length > 1) return null;
    return { py: y, conf: runs.length > 1 ? 0.75 : 1 };
  };
  let prev = null;
  for (let i = seed; i < pw; i++) { const p = step(i, prev); if (p) { pts[i] = p; prev = p.py; } }
  prev = pts[seed] ? pts[seed].py : null;
  for (let i = seed - 1; i >= 0; i--) { const p = step(i, prev); if (p) { pts[i] = p; prev = p.py; } }
  // vertical stubs at the very ends (axis remnants, ticks) are not data
  const tall = (i) => { const r = shape.colRuns[i]; return r && r.length && Math.max(...r.map((q) => q[1] - q[0] + 1)) > Math.max(6, lw * 4); };
  for (let k = 0; k < 10; k++) { const f = pts.findIndex((p) => p); if (f >= 0 && tall(f)) pts[f] = null; else break; }
  for (let k = 0; k < 10; k++) { const l = pts.length - 1 - [...pts].reverse().findIndex((p) => p); if (l < pts.length && pts[l] && tall(l)) pts[l] = null; else break; }
  // fill gaps inside the drawn range by straight interpolation (crossings, dashes, dots)
  const first = pts.findIndex((p) => p), last = pts.length - 1 - [...pts].reverse().findIndex((p) => p);
  if (first < 0) return { pts, first: -1, last: -1 };
  for (let i = first; i <= last; i++) {
    if (pts[i]) continue;
    let j = i; while (j <= last && !pts[j]) j++;
    const a = pts[i - 1], b = pts[j]; const gap = j - i;
    for (let k = i; k < j; k++) { const t = (k - i + 1) / (gap + 1); pts[k] = { py: a.py + (b.py - a.py) * t, conf: gap <= 3 ? 0.8 : gap <= 10 ? 0.55 : 0.3, interp: true }; }
    i = j;
  }
  return { pts, first, last };
}

export function isStep(pts, first, last) {
  let flat = 0, jumps = 0, n = 0;
  for (let i = first + 1; i <= last; i++) { if (!pts[i] || !pts[i - 1] || pts[i].interp) continue; n++; const d = Math.abs(pts[i].py - pts[i - 1].py); if (d < 0.6) flat++; else if (d > 4) jumps++; }
  return n > 20 && flat / n > 0.85 && jumps >= 2;
}

// Area/band edges per column
export function areaEdges(shape, plot) {
  const pw = plot.x1 - plot.x0 + 1; const top = new Array(pw).fill(null), bot = new Array(pw).fill(null);
  for (let i = 0; i < pw; i++) {
    const runs = shape.colRuns[i]; if (!runs.length) continue;
    // merge runs separated by small gaps (lines drawn over the fill)
    top[i] = runs[0][0]; bot[i] = runs[runs.length - 1][1];
  }
  return { top, bot };
}

// Scatter points = blob centres
export function scatterPoints(rects) {
  const sizes = rects.map((r) => r.n); const unit = median(sizes) || 1;
  const pts = [];
  for (const r of rects) {
    const k = Math.max(1, Math.round(r.n / unit));
    if (k === 1) pts.push({ px: r.cx, py: r.cy, conf: 1 });
    else for (let i = 0; i < k; i++) pts.push({ px: r.x0 + (r.w * (i + 0.5)) / k, py: r.cy, conf: 0.4 });
  }
  return pts.sort((a, b) => a.px - b.px);
}

export function labToRgbApprox(img, asg, core, plot, id) {
  // mean colour of core pixels
  const W = img.width; const d = img.data; let r = 0, g = 0, b = 0, n = 0;
  for (let y = plot.y0; y <= plot.y1; y++) for (let x = plot.x0; x <= plot.x1; x++) { const p = y * W + x; if (asg[p] === id && core[p]) { r += d[p * 4]; g += d[p * 4 + 1]; b += d[p * 4 + 2]; n++; } }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

// Dash pattern of a line from its run lengths along x
export function dashStyle(shape, first, last) {
  const on = []; const off = []; let cur = null, len = 0;
  for (let i = first; i <= last; i++) { const has = shape.colRuns[i] && shape.colRuns[i].length > 0; if (cur === null) { cur = has; len = 1; continue; } if (has === cur) len++; else { (cur ? on : off).push(len); cur = has; len = 1; } }
  if (off.length < 6) return 'solid';
  const mon = median(on), moff = median(off);
  const cv = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))) / (m || 1); };
  const covered = on.reduce((a, b) => a + b, 0) / (on.reduce((a, b) => a + b, 0) + off.reduce((a, b) => a + b, 0));
  if (cv(off) > 0.6 || covered > 0.92) return 'solid';
  if (mon <= 3) return 'dot';
  if (mon >= 10) return 'longDash';
  return 'dash';
}

// Halo clusters: colours that only ever appear hugging another colour (anti-aliasing, JPEG ringing,
// blends where two lines cross). Fold them into their host, or drop them if they sit between two hosts.
export function foldHalos(asg, core, W, H, plot, clusters, bg) {
  const ids = clusters.map((c) => c.id); const near = new Map(); const tot = new Map();
  for (const id of ids) { near.set(id, new Map()); tot.set(id, 0); }
  for (let y = plot.y0; y <= plot.y1; y++) for (let x = plot.x0; x <= plot.x1; x++) {
    const p = y * W + x; const id = asg[p]; if (id < 0) continue;
    tot.set(id, tot.get(id) + 1);
    const seen = new Set();
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { if (!dx && !dy) continue; const X = x + dx, Y = y + dy; if (X < plot.x0 || Y < plot.y0 || X > plot.x1 || Y > plot.y1) continue; const o = asg[Y * W + X]; if (o >= 0 && o !== id) seen.add(o); }
    const m = near.get(id); for (const o of seen) m.set(o, (m.get(o) || 0) + 1);
  }
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const mapping = new Map();
  if (typeof window !== 'undefined' && window.__dbgHalo) window.__dbgHalo.push(clusters.map((c) => ({ id: c.id, rgb: hex(c.rgb), n: tot.get(c.id), near: [...near.get(c.id).entries()].map(([o, k]) => [o, k, +segRGB(c.rgb, byId.get(o).rgb, bg).d.toFixed(1)]) })));
  const sorted = [...clusters].sort((a, b) => tot.get(a.id) - tot.get(b.id));
  for (const c of sorted) {
    const n = tot.get(c.id); if (!n) continue;
    const hosts = [...near.get(c.id).entries()].filter(([o, k]) => tot.get(o) >= n && !(mapping.get(o) === c.id)).sort((a, b) => b[1] - a[1]);
    if (!hosts.length) continue;
    const anyNear = [...near.get(c.id).values()].reduce((a, b) => Math.max(a, b), 0);
    const [h1, k1] = hosts[0];
    const H1 = byId.get(h1); const fringe = segRGB(c.rgb, H1.rgb, bg);
    if (k1 >= 0.45 * n && fringe.d < 26 && fringe.t > 0.05) { mapping.set(c.id, h1); continue; }
    const bgL = rgb2lab(...bg);
    if (k1 >= 0.72 * n && c.lab[0] > H1.lab[0] - 5 && dE(c.lab, bgL) < dE(H1.lab, bgL)) { mapping.set(c.id, h1); continue; }
    { const hu = (l) => Math.atan2(l[2], l[1]); const dh = Math.abs(Math.atan2(Math.sin(hu(c.lab) - hu(H1.lab)), Math.cos(hu(c.lab) - hu(H1.lab))));
      if (k1 >= 0.8 * n && chroma(c.lab) > 15 && chroma(H1.lab) > 15 && dh < 0.4) { mapping.set(c.id, h1); continue; } }   // same colour, darker/lighter edge
    if (k1 >= 0.7 * n) {
      const similar = dE(c.lab, H1.lab) < 35;
      if (fringe.d < 30 || similar) { mapping.set(c.id, h1); continue; }
      if (hosts[1] && hosts[1][1] >= 0.3 * n) { const s2 = segRGB(c.rgb, H1.rgb, byId.get(hosts[1][0]).rgb); if (s2.d < 30) { mapping.set(c.id, -1); continue; } }
    }
    // squeezed between two other colours (where lines overlap): not a series of its own
    if (hosts.length >= 2 && hosts[0][1] >= 0.4 * n && hosts[1][1] >= 0.4 * n && n < 0.6 * Math.min(tot.get(hosts[0][0]), tot.get(hosts[1][0]))) { mapping.set(c.id, -1); continue; }
  }
  if (!mapping.size) return clusters;
  const resolve = (id) => { let k = id, guard = 0; while (mapping.has(k) && k >= 0 && guard++ < 20) k = mapping.get(k); return k; };
  for (let y = plot.y0; y <= plot.y1; y++) for (let x = plot.x0; x <= plot.x1; x++) { const p = y * W + x; const id = asg[p]; if (id >= 0 && mapping.has(id)) { asg[p] = resolve(id); core[p] = 0; } }
  return clusters.filter((c) => !mapping.has(c.id));
}

// Panels: big light rectangles behind the plot (shaded regions). Returns their colours.
export function findPanels(asg, W, plot, clusters) {
  const ph = plot.y1 - plot.y0 + 1; const out = [];
  for (const c of clusters) {
    if (c.lab[0] <= 70) continue;
    // columns this colour fills top to bottom (lines and text over it allowed)
    let run = 0, best = 0;
    for (let x = plot.x0; x <= plot.x1; x++) {
      let n = 0; for (let y = plot.y0; y <= plot.y1; y++) if (asg[y * W + x] === c.id) n++;
      if (n >= ph * 0.6) { run++; best = Math.max(best, run); } else run = 0;
    }
    if (best >= 12) out.push(c);
  }
  return out;
}

// How noisy is the background? (JPEG artefacts) -> threshold for "not background"
export function backgroundNoise(lab, W, plot, bg) {
  const bgLab = rgb2lab(...bg); const ds = [];
  for (let y = plot.y0; y <= plot.y1; y += 2) for (let x = plot.x0; x <= plot.x1; x += 2) { const p = y * W + x; const d = dE([lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]], bgLab); if (d < 30) ds.push(d); }
  ds.sort((a, b) => a - b);
  const p90 = ds[Math.floor(ds.length * 0.9)] || 0;
  return Math.max(9, Math.min(20, p90 * 2.2));
}
