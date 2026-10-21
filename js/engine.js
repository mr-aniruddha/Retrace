// Retrace engine: image in, chart model out.
import { labImage, backgroundColor, rgb2lab, dE, chroma, hex, components, median, mean } from './image.js';
import { findTextBoxes, readBoxes, phrases, boxColor, inkMask, readRotatedStrip, ringBackground } from './text.js';
import { findValueAxes, findCategoryAxis, findLeftCategories } from './axes.js';
import { parseNumber, fmtDate } from './parse.js';
import { findRules, colourClusters, assignPixels, foldHalos, findPanels, backgroundNoise, shapeOf, rectangles, classify, traceLine, isStep, areaEdges, scatterPoints, labToRgbApprox, dashStyle } from './series.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export async function analyze(canvas, onStage = () => {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const W = img.width, H = img.height;
  const bg = backgroundColor(img); const bgLab = rgb2lab(...bg);
  const lab = labImage(img);
  await onStage('look', { W, H });

  // 1. text
  const words = findTextBoxes(img, bg);
  words.forEach((w) => { w.bg = ringBackground(img, w); });
  await onStage('boxes', { words });
  await readBoxes(canvas, words, bg, (f) => onStage('ocr', { f }));
  words.forEach((w) => { w.color = boxColor(img, w, w.bg || bg); });
  const meaningful = (w) => w.text && w.conf >= 45 && /[A-Za-z0-9]/.test(w.text);

  // 2. ink that is not readable text
  const ink = inkMask(img, bg, 30);
  const clearText = () => { for (const w of words) if (meaningful(w)) for (let y = Math.max(0, w.y0 - 1); y <= Math.min(H - 1, w.y1 + 1); y++) for (let x = Math.max(0, w.x0 - 1); x <= Math.min(W - 1, w.x1 + 1); x++) ink[y * W + x] = 0; };
  clearText();
  const gcomps = components(ink, W, H).comps.filter((c) => Math.max(c.w, c.h) >= Math.min(30, Math.max(W, H) * 0.06));
  const gfx = gcomps.length ? gcomps.reduce((b, c) => ({ x0: Math.min(b.x0, c.x0), y0: Math.min(b.y0, c.y0), x1: Math.max(b.x1, c.x1), y1: Math.max(b.y1, c.y1) }), { x0: W, y0: H, x1: 0, y1: 0 }) : { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
  const inkIn = (x0, y0, x1, y1) => { x0 = Math.round(x0); x1 = Math.round(x1); y0 = Math.round(y0); y1 = Math.round(y1); let n = 0; for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) n += ink[y * W + x]; return n; };

  // 3. value axes: numeric columns with graphics beside them
  const span = (c) => { const ys = c.fit.inliers.map((P) => P.box.cy); return [Math.min(...ys), Math.max(...ys)]; };
  const vaxAll = findValueAxes(words.filter(meaningful), W, H).map((c) => {
    let [ya, yb] = span(c); ya = Math.round(ya); yb = Math.round(yb); const reach = Math.round(W * 0.45);
    c.inkRight = inkIn(Math.round(c.x1 + 3), ya, Math.round(c.x1 + reach), yb) / ((yb - ya + 1) * reach);
    c.inkLeft = inkIn(Math.round(c.x0 - reach), ya, Math.round(c.x0 - 3), yb) / ((yb - ya + 1) * reach);
    c.ya = ya; c.yb = yb; return c;
  });
  let left = vaxAll.filter((c) => c.inkRight > 0.004).sort((a, b) => b.n - a.n || a.cx - b.cx)[0] || null;
  let right = vaxAll.filter((c) => c !== left && c.inkLeft > 0.004 && (!left || (c.x0 > left.x1 + W * 0.3 && Math.min(c.yb, left.yb) - Math.max(c.ya, left.ya) > 0.4 * (left.yb - left.ya)))).sort((a, b) => b.n - a.n || b.cx - a.cx)[0] || null;
  if (left && right && left.cx > right.cx) [left, right] = [right, left];
  const dbgVax = vaxAll.map((c) => ({ n: c.n, labels: c.fit.inliers.map((P) => P.box.text), inkR: +c.inkRight.toFixed(4), inkL: +c.inkLeft.toFixed(4), x0: c.x0, x1: c.x1 }));
  if (!left && right && right.cx < W / 2) { left = right; right = null; }
  const axisBoxes = new Set();
  [left, right].forEach((a) => a && a.fit.inliers.forEach((P) => axisBoxes.add(P.box)));
  const main = left || right;
  const stepPx = main ? Math.abs(main.fit.stepV / main.fit.b) : 0;
  const findX = () => findCategoryAxis(words.filter((w) => meaningful(w) && !axisBoxes.has(w)), main ? { yMid: (main.ya + main.yb) / 2, bottom: main.yb + stepPx * 0.6 } : { yMid: (gfx.y0 + gfx.y1) / 2, bottom: gfx.y1 });
  let xAxis = findX()[0] || null;
  // rotated date labels under the plot: read the whole strip turned upright
  const rotated = words.filter((w) => w.rotated && (!main || w.y0 > main.yb - 4));
  const catWeak = (a) => { const labs = a.cats.map((c) => c.label); return new Set(labs).size < labs.length * 0.7 || mean(labs.map((l) => l.length)) < 2.5 || mean(a.boxes.map((b) => b.conf || 0)) < 70; };
  const weakX = !xAxis || xAxis.used < 4 || (xAxis.kind === 'category' && catWeak(xAxis));
  if (weakX && (rotated.length >= 2 || main)) {
    const reg = rotated.length >= 2
      ? { x0: Math.max(0, Math.min(...rotated.map((w) => w.x0)) - 4), x1: Math.min(W - 1, Math.max(...rotated.map((w) => w.x1)) + 4), y0: Math.max(0, Math.min(...rotated.map((w) => w.y0)) - 3), y1: Math.min(H - 1, Math.max(...rotated.map((w) => w.y1)) + 3) }
      : (() => {
        // below the bottom axis line if there is one
        let y0 = Math.round(main.yb + stepPx * 0.3); const full = inkMask(img, bg, 60);
        for (let y = Math.round(main.yb); y < Math.min(H - 1, main.yb + stepPx * 2.5); y++) { let run = 0, best = 0; for (let x = 0; x < W; x++) { if (full[y * W + x]) { run++; if (run > best) best = run; } else run = 0; } if (best >= W * 0.45) y0 = y + 2; }
        return { x0: 0, x1: W - 1, y0: Math.min(H - 2, y0), y1: Math.min(H - 1, y0 + 2) };
      })();
    // extend down to the end of the labels (the digits often were not grouped as rotated text)
    { const full = inkMask(img, bg, 50); const rowInk = (y) => { let n = 0; for (let x = reg.x0; x <= reg.x1; x++) n += full[y * W + x]; return n; };
      let y = reg.y1, gap = 0, seen = false; while (y < H - 1 && gap < (seen ? 4 : 12)) { y++; if (rowInk(y) >= 2) { gap = 0; reg.y1 = y; if (y - reg.y0 > 6) seen = true; } else gap++; }
      // labels read bottom-to-top keep their digits near the axis: extend up too
      const need = Math.max(3, rotated.length * 0.5); y = reg.y0; gap = 0;
      while (y > 0 && gap < 2) { y--; const n = rowInk(y); if (n >= need && n < (reg.x1 - reg.x0) * 0.6) { gap = 0; reg.y0 = y; } else gap++; } }
    await onStage('strip', { reg });
    const strip = reg.y1 - reg.y0 >= 18 ? await readRotatedStrip(canvas, reg, bg) : [];
    if (strip.filter((w) => /\d/.test(w.text)).length >= 3) {
      for (const w of words) if (!w.fromStrip && w.cx >= reg.x0 && w.cx <= reg.x1 && w.cy >= reg.y0 && w.cy <= reg.y1) w.text = '';
      strip.forEach((w, i) => { w.id = 10000 + i; words.push(w); });
      const again = findX()[0] || null;
      const rank = (a) => (a ? a.used * (a.kind === 'category' ? 0.5 : 1) : 0);
      if (again && rank(again) >= rank(xAxis)) xAxis = again;
    }
  }
  let orientation = 'v';
  if (!left && !right && xAxis && xAxis.kind === 'number') {
    const plotTmp = { x0: gfx.x0, x1: gfx.x1, y0: gfx.y0, y1: xAxis.y0 - 2 };
    const cats = findLeftCategories(words.filter(meaningful), plotTmp);
    if (cats) orientation = 'h';
  }
  if (xAxis) xAxis.boxes.forEach((b) => axisBoxes.add(b));

  // 4. plot rectangle, grown from the axes into the graphics
  const colHas = (x, y0, y1) => inkIn(x, y0, x, y1) > 0;
  const rowHas = (y, x0, x1) => inkIn(x0, y, x1, y) > 0;
  const plot = { ...gfx };
  if (main || xAxis) {
    const xl = xAxis ? xAxis.boxes : [];
    const xsp = xAxis && xl.length > 1 ? (Math.max(...xl.map((b) => b.cx)) - Math.min(...xl.map((b) => b.cx))) / (xl.length - 1) : 20;
    plot.y1 = xAxis ? xAxis.y0 - 2 : (main ? Math.round(main.yb + stepPx * 0.3) : gfx.y1);
    const yTopLabel = main ? main.ya : gfx.y0;
    const bandTop = main ? Math.round(main.ya) : gfx.y0;
    plot.x0 = left ? left.x1 + 3 : (xAxis ? Math.max(0, Math.round(Math.min(...xl.map((b) => b.x0)) - xsp * 0.5)) : gfx.x0);
    plot.x1 = right ? right.x0 - 3 : (xAxis ? Math.min(W - 1, Math.round(Math.max(...xl.map((b) => b.x1)) + xsp * 0.5)) : gfx.x1);
    // grow right/left through graphics
    if (!right) { let x = plot.x1, gap = 0; while (x < W - 1 && gap < 14) { x++; if (colHas(x, bandTop, plot.y1)) { gap = 0; plot.x1 = x; } else gap++; } }
    if (!left) { let x = plot.x0, gap = 0; while (x > 0 && gap < 14) { x--; if (colHas(x, bandTop, plot.y1)) { gap = 0; plot.x0 = x; } else gap++; } }
    // grow upwards from the top label
    plot.y0 = Math.round(yTopLabel);
    const limit = main ? Math.max(0, Math.round(yTopLabel - stepPx * 3)) : 0;
    let y = plot.y0, gap = 0; while (y > limit && gap < 7) { y--; if (rowHas(y, plot.x0 + 2, plot.x1 - 2)) { gap = 0; plot.y0 = y; } else gap++; }
    plot.y0 = Math.max(0, Math.min(plot.y0, Math.round(yTopLabel - 2)));
  }
  if (plot.x1 - plot.x0 < 20 || plot.y1 - plot.y0 < 20) Object.assign(plot, gfx);
  await onStage('axes', { plot, left, right, xAxis });

  const noAxes = !left && !right && (!xAxis || xAxis.kind === 'category' && xAxis.used < 2);

  // 5. legend
  const isDash = (t) => /^[—–\-~_=©®■●▬•«»oO0]+$/.test(t || '');
  const legendish = (w) => (meaningful(w) || (w.text && w.conf >= 15 && /[A-Za-z]{4,}/.test(w.text))) && !w.dashLike && !isDash(w.text) && !axisBoxes.has(w) && !w.rotated;
  const phr = phrases(words.filter(legendish), 1.3);
  const legend = findLegend(img, lab, bg, phr, axisBoxes, words);

  // 6. exclusion mask: readable text, legend, rules
  const excl = new Uint8Array(W * H);
  const mark = (b, pad = 1) => { for (let y = Math.max(0, b.y0 - pad); y <= Math.min(H - 1, b.y1 + pad); y++) for (let x = Math.max(0, b.x0 - pad); x <= Math.min(W - 1, b.x1 + pad); x++) excl[y * W + x] = 1; };
  const inPlot = (b) => b.x0 >= plot.x0 && b.x1 <= plot.x1 && b.y0 >= plot.y0 && b.y1 <= plot.y1;
  for (const w of words) {
    if (w.dashLike) { if (!inPlot(w)) mark(w, 1); continue; }
    if (!w.text && !w.fromStrip && !(w.charLike && !inPlot(w))) continue;
    if (inPlot(w)) { const readable = w.conf >= 40 && /[A-Za-z]{2,}|\d/.test(w.text || ''); const darkText = w.charLike && chroma(rgb2lab(...(w.color || [0, 0, 0]))) < 15 && w.comps && w.comps.length >= 2; if (!readable && !darkText) continue; }
    mark(w, 1);
  }
  for (const e of legend) { mark(e.swatchBox, 2); mark(e.box, 1); }
  // gridlines sit on tick positions; long dark runs elsewhere may be data (a step line)
  const tickYs = [];
  for (const a of [left, right].filter(Boolean)) { const ins = a.fit.inliers.map((P) => P.p).sort((x, y) => x - y); const st = ins.length > 1 ? median(ins.slice(1).map((v, i) => v - ins[i])) : 0; for (const p of ins) tickYs.push(p); if (st > 4) for (let p = ins[0] - st * 3; p <= ins[ins.length - 1] + st * 3; p += st) tickYs.push(p); }
  const tickXs = xAxis && xAxis.kind !== 'category' ? xAxis.boxes.map((b) => b.cx) : null;
  tickYs.push(plot.y0, plot.y1);
  const rules = findRules(img, lab, bg, plot, tickYs.length > 2 ? tickYs : null, tickXs && tickXs.length > 2 ? [...tickXs, plot.x0, plot.x1] : null);
  // annotation boxes: several lines of prose stacked inside the plot
  { const prose = phrases(words.filter((w) => meaningful(w) && inPlot(w) && !w.rotated), 1.3).filter((q) => /[A-Za-z]{3,}/.test(q.text) && q.text.length >= 6);
    const legendBoxes = legend.map((e) => e.box);
    const blocks = [];
    for (const q of prose) { if (legendBoxes.some((b) => !(q.x1 < b.x0 || q.x0 > b.x1 || q.y1 < b.y0 || q.y0 > b.y1))) continue;
      const blk = blocks.find((B) => q.y0 - B.y1 <= q.h * 2.2 && q.x0 <= B.x1 + q.h * 3 && q.x1 >= B.x0 - q.h * 3);
      if (blk) { blk.x0 = Math.min(blk.x0, q.x0); blk.x1 = Math.max(blk.x1, q.x1); blk.y0 = Math.min(blk.y0, q.y0); blk.y1 = Math.max(blk.y1, q.y1); blk.n++; blk.h = Math.max(blk.h, q.h); }
      else blocks.push({ x0: q.x0, x1: q.x1, y0: q.y0, y1: q.y1, n: 1, h: q.h }); }
    for (const B of blocks.filter((B) => B.n >= 3)) { const pad = Math.round(B.h * 2); mark({ x0: B.x0 - pad, x1: B.x1 + pad, y0: B.y0 - pad, y1: B.y1 + pad }, 0); }
  }
  const greyish = (p) => Math.hypot(lab[p * 3 + 1], lab[p * 3 + 2]) < 22 || (lab[p * 3] < 42 && Math.hypot(lab[p * 3 + 1], lab[p * 3 + 2]) < 40);
  // rules and their anti-aliased neighbour rows (darker than the background around them)
  const bgL = rgb2lab(...bg)[0];
  const softer = (p) => greyish(p) || lab[p * 3] < bgL - 25;
  for (const y0 of rules.rows) for (let y = y0 - 1; y <= y0 + 1; y++) if (y >= 0 && y < H) for (let x = plot.x0; x <= plot.x1; x++) { const p = y * W + x; if (y === y0 ? greyish(p) : softer(p) && greyish(p)) excl[p] = 1; }
  for (const x0 of rules.cols) for (let x = x0 - 1; x <= x0 + 1; x++) if (x >= 0 && x < W) for (let y = plot.y0; y <= plot.y1; y++) { const p = y * W + x; if (x === x0 ? greyish(p) : softer(p) && greyish(p)) excl[p] = 1; }
  // tick marks hang off the outer axes: grey stubs right next to the first/last rule
  const phh = plot.y1 - plot.y0, pww = plot.x1 - plot.x0;
  const lowR = rules.rows.length ? Math.max(...rules.rows) : null, highR = rules.rows.length ? Math.min(...rules.rows) : null;
  const leftC = rules.cols.length ? Math.min(...rules.cols) : null, rightC = rules.cols.length ? Math.max(...rules.cols) : null;
  const edgeRows = [...new Set([lowR, highR].filter((y) => y != null && (y >= plot.y1 - phh * 0.15 || y <= plot.y0 + phh * 0.15)))];
  const edgeCols = [...new Set([leftC, rightC].filter((x) => x != null && (x <= plot.x0 + pww * 0.1 || x >= plot.x1 - pww * 0.1)))];
  // an axis line is the true edge of the plot: pull the box in to it
  if (lowR != null && lowR >= plot.y1 - phh * 0.15 && lowR < plot.y1) plot.y1 = lowR - 2;
  if (leftC != null && leftC <= plot.x0 + pww * 0.1 && leftC > plot.x0) plot.x0 = leftC + 2;
  for (const y0 of edgeRows) for (let y = y0 - 8; y <= y0 + 8; y++) if (y >= 0 && y < H) for (let x = plot.x0; x <= plot.x1; x++) { const p = y * W + x; if (greyish(p) && lab[p * 3] < 75) excl[p] = 1; }
  for (const x0 of edgeCols) for (let x = x0 - 8; x <= x0 + 8; x++) if (x >= 0 && x < W) for (let y = plot.y0; y <= plot.y1; y++) { const p = y * W + x; if (greyish(p) && lab[p * 3] < 75) excl[p] = 1; }

  if (typeof window !== 'undefined' && window.__dbgExcl) { const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const g2 = c2.getContext('2d'); const id = g2.createImageData(W, H); for (let i = 0; i < W * H; i++) { const ex = excl[i]; id.data[i * 4] = ex ? 255 : img.data[i * 4]; id.data[i * 4 + 1] = ex ? 0 : img.data[i * 4 + 1]; id.data[i * 4 + 2] = ex ? 255 : img.data[i * 4 + 2]; id.data[i * 4 + 3] = 255; } g2.putImageData(id, 0, 0); g2.strokeStyle = 'lime'; g2.strokeRect(plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0); const bb = await new Promise((r) => c2.toBlob(r)); await fetch('/__save/excl_' + window.__dbgExcl + '.png', { method: 'POST', body: bb }); }
  if (noAxes) {
    const pie = analyzePie(img, lab, bg, excl, legend, words, gfx);
    if (pie) return finishModel({ W, H, bg, words, legend, plot: gfx, pie, chartType: pie.donut ? 'doughnut' : 'pie' }, canvas);
  }

  // 7. colours
  const bgThr = backgroundNoise(lab, W, plot, bg);
  let clusters = colourClusters(img, lab, bg, plot, excl, [], bgThr);
  let { asg, core } = assignPixels(img, lab, bg, plot, excl, clusters, [], bgThr);
  // shaded panels behind the data act as extra backgrounds
  const panelCols = findPanels(asg, W, plot, clusters);
  if (typeof window !== 'undefined' && window.__dbgExcl) console.log('PANELS', panelCols.length, JSON.stringify(clusters.map((c) => [hex(c.rgb), c.n, +c.lab[0].toFixed(0)])));
  if (panelCols.length) {
    const extra = panelCols.map((c) => c.rgb);
    clusters = colourClusters(img, lab, bg, plot, excl, extra, bgThr);
    ({ asg, core } = assignPixels(img, lab, bg, plot, excl, clusters, extra, bgThr));
  }
  clusters = foldHalos(asg, core, W, H, plot, clusters, bg);
  await onStage('colours', { clusters, plot });

  // 8. shape + type per colour
  const pw = plot.x1 - plot.x0 + 1, ph = plot.y1 - plot.y0 + 1;
  let shapes = clusters.map((c) => {
    const shape = shapeOf(asg, core, W, plot, c.id);
    const rects = rectangles(asg, W, H, plot, c.id, core);
    const type = classify(shape, rects, plot);
    const rgb = labToRgbApprox(img, asg, core, plot, c.id);
    return { c, shape, rects, type, rgb, achromatic: chroma(c.lab) < 10 };
  });
  if (typeof window !== 'undefined' && window.__dbgShapes) window.__dbgShapes.push(shapes.map((s) => ({ rgb: hex(s.rgb), type: s.type, n: s.shape.n, cov: +s.shape.coverage.toFixed(2), th: s.shape.thickness, colFill: s.shape.colFill, dens: +s.shape.density.toFixed(2), rects: s.rects.length, rectish: s.rects.filter((r) => r.n > 30).map((r) => [r.x0, r.y0, r.w, r.h, +r.fill.toFixed(2), r.n]) })));
  // decorative panels: tall rectangles filling the plot height
  const panels = shapes.filter((s) => (s.type === 'area' || s.type === 'bar') && s.shape.y1 - s.shape.y0 >= ph * 0.88 && s.rects.some((r) => r.fill > 0.85 && r.h >= ph * 0.85) && (s.shape.y0 <= plot.y0 + 3));
  shapes = shapes.filter((s) => !panels.includes(s));
  // junk: tiny marks, arrows, tick stubs
  shapes = shapes.filter((s) => {
    const span = (s.shape.x1 - s.shape.x0 + 1) / pw;
    const inLegend = legend.some((e) => e.cluster === undefined && dE(e.lab, s.c.lab) < 22);
    if (s.type === 'bar' || s.type === 'barh') return s.rects.some((r) => r.fill >= 0.8 && r.w >= 3);
    if (s.type === 'scatter') return s.rects.length >= 4;
    if (span < 0.04 && !inLegend) return false;
    if (s.achromatic && !inLegend && span < 0.15) return false;
    return true;
  });

  // 9. legend <-> colour
  const used = new Set();
  for (const e of legend) {
    let best = null, bd = 1e9;
    for (const s of shapes) { if (used.has(s)) continue; const kindPen = e.kind === 'line' && !(s.type === 'line') ? 12 : e.kind === 'box' && s.type === 'line' ? 12 : 0; let d = dE(e.lab, s.c.lab) + kindPen;
      // same hue, different shade (JPEG, thin swatches): still a match
      const h1 = Math.atan2(e.lab[2], e.lab[1]), h2 = Math.atan2(s.c.lab[2], s.c.lab[1]); const dh = Math.abs(Math.atan2(Math.sin(h1 - h2), Math.cos(h1 - h2)));
      if (chroma(e.lab) > 20 && chroma(s.c.lab) > 20 && dh < 0.35) d = Math.min(d, 20 + kindPen + dh * 20);
      if (d < bd) { bd = d; best = s; } }
    if (best && bd < 30 && !used.has(best)) { best.name = e.name; best.legendKind = e.kind; best.legendEntry = e; used.add(best); e.matched = true; }
  }

  // 10. chain line segments that are one series in different colours
  const lines = shapes.filter((s) => s.type === 'line');
  const chains = [];
  for (const s of lines.sort((a, b) => a.shape.x0 - b.shape.x0)) {
    if (s.name) { chains.push([s]); continue; }
    const tr = traceLine(s.shape, plot); s.trace = tr;
    const ch = chains.find((C) => { const L = C[C.length - 1]; if (L.name) return false; const lt = L.trace || (L.trace = traceLine(L.shape, plot));
      return lt.last >= 0 && tr.first >= 0 && tr.first >= lt.last - 3 && tr.first - lt.last <= 6 && Math.abs(lt.pts[lt.last].py - tr.pts[tr.first].py) <= 8; });
    if (ch) ch.push(s); else chains.push([s]);
  }

  // 11. build series
  const series = []; let letter = 0;
  const yAxisFor = (s) => {
    if (!right) return 0; if (!left) return 1;
    const nm = (s.name || '').toLowerCase();
    if (/\b(rhs|right)\b/.test(nm)) return 1; if (/\b(lhs|left)\b/.test(nm)) return 0;
    const lc = mean(left.fit.inliers.map((P) => chroma(rgb2lab(...P.box.color))));
    const rc = rgb2lab(...median3(right.fit.inliers.map((P) => P.box.color)));
    if (chroma(rc) > 15 && dE(rc, s.c.lab) < 25) return 1;
    return 0;
  };
  const axes = [left, right];
  const toY = (axisIdx, py) => { const a = axes[axisIdx] || left || right; if (!a) return null; const v = a.fit.a + a.fit.b * py; return a.isLog ? Math.pow(10, v) : v; };
  const xKind = xAxis ? xAxis.kind : 'index';
  const toX = (px) => { if (!xAxis || xAxis.kind === 'category') return px; return xAxis.fit.a + xAxis.fit.b * px; };
  const zeroPy = (axisIdx) => { const a = axes[axisIdx] || left || right; if (!a || a.isLog) return plot.y1; const py = -a.fit.a / a.fit.b; return py >= plot.y0 - 2 && py <= plot.y1 + 4 ? py : plot.y1; };

  for (const chain of chains) {
    const s0 = chain[0];
    const name = s0.name || (chain.length > 1 ? null : null);
    const pts = new Array(pw).fill(null); const segs = [];
    for (const s of chain) {
      const tr = s.trace || traceLine(s.shape, plot);
      for (let i = Math.max(0, tr.first); i <= tr.last && tr.first >= 0; i++) if (tr.pts[i] && (!pts[i] || pts[i].interp)) pts[i] = { ...tr.pts[i] };
      if (tr.first >= 0) segs.push({ from: plot.x0 + tr.first, to: plot.x0 + tr.last, color: hex(s.rgb), dash: dashStyle(s.shape, tr.first, tr.last), width: Math.max(1, Math.min(6, +(s.shape.lineWidth || s.shape.colFill || s.shape.thickness).toFixed(1))) });
    }
    const first = pts.findIndex((p) => p); if (first < 0) continue; const last = pts.length - 1 - [...pts].reverse().findIndex((p) => p);
    for (let i = first; i <= last; i++) if (!pts[i]) { let j = i; while (!pts[j]) j++; const a = pts[i - 1], b = pts[j]; for (let k = i; k < j; k++) pts[k] = { py: a.py + (b.py - a.py) * (k - i + 1) / (j - i + 1), conf: 0.5, interp: true }; i = j; }
    const axisIdx = yAxisFor(s0);
    const data = [];
    for (let i = first; i <= last; i++) { const p = pts[i]; data.push({ px: plot.x0 + i, py: p.py, x: toX(plot.x0 + i), y: toY(axisIdx, p.py), conf: p.conf, interp: !!p.interp }); }
    const step = isStep(pts, first, last);
    if (s0.legendEntry && s0.legendEntry.kind === 'line' && !s0.legendEntry.dashed) segs.forEach((g) => (g.dash = 'solid'));
    series.push({ name: name || LETTERS[letter++], type: step ? 'step' : 'line', color: segs[0].color, width: segs[0].width, dash: segs[0].dash, segments: segs.length > 1 ? segs : null, axis: axisIdx, points: data, named: !!name, clusterIds: chain.map((c) => c.c.id), legend: s0.legendEntry || null });
  }

  // areas and bands
  for (const s of shapes.filter((x) => x.type === 'area')) {
    const { top, bot } = areaEdges(s.shape, plot); const axisIdx = yAxisFor(s);
    const base = zeroPy(axisIdx);
    const reachesBase = bot.filter((b, i) => b !== null && Math.abs(b - base) <= 4).length >= 0.7 * bot.filter((b) => b !== null).length;
    const nm = s.name || LETTERS[letter++];
    const upper = [], lower = [];
    top.forEach((t, i) => { if (t === null) return; upper.push({ px: plot.x0 + i, py: t, x: toX(plot.x0 + i), y: toY(axisIdx, t), conf: 1 }); lower.push({ px: plot.x0 + i, py: bot[i], x: toX(plot.x0 + i), y: toY(axisIdx, bot[i]), conf: 1 }); });
    if (reachesBase) series.push({ name: nm, type: 'area', color: hex(s.rgb), axis: axisIdx, points: upper, named: !!s.name, clusterIds: [s.c.id] });
    else series.push({ name: nm, type: 'band', color: hex(s.rgb), axis: axisIdx, points: upper, lower, named: !!s.name, clusterIds: [s.c.id] });
  }

  // bars
  const barShapes = shapes.filter((x) => x.type === 'bar' || x.type === 'barh');
  if (barShapes.length) {
    const horiz = barShapes.filter((b) => b.type === 'barh').length > barShapes.length / 2 || orientation === 'h';
    const allRects = [];
    for (const s of barShapes) for (const r of s.rects.filter((r) => r.fill >= 0.75 && r.w >= 2 && r.h >= 2)) allRects.push({ ...r, x0: r.tx0, x1: r.tx1, y0: r.ty0, y1: r.ty1, w: r.tw, h: r.th, cx: (r.tx0 + r.tx1) / 2, cy: (r.ty0 + r.ty1) / 2, s });
    const C = (r) => (horiz ? r.cy : r.cx), S = (r) => (horiz ? r.h : r.w);
    // groups: bars that sit next to each other form one category
    const sorted = [...allRects].sort((a, b) => (horiz ? a.y0 - b.y0 : a.x0 - b.x0));
    const groups = []; let cur = null;
    for (const r of sorted) {
      const lo = horiz ? r.y0 : r.x0, hi = horiz ? r.y1 : r.x1;
      const unit = median(allRects.map(S));
      if (!cur || lo - cur.hi > unit * 0.45) { cur = { lo, hi, rects: [] }; groups.push(cur); }
      cur.rects.push(r); cur.hi = Math.max(cur.hi, hi);
    }
    let cats = horiz ? findLeftCategories(words.filter(meaningful), plot) : (xAxis && xAxis.kind === 'category' ? xAxis.cats : null);
    groups.forEach((g, i) => {
      g.px = (g.lo + g.hi) / 2;
      let label = null;
      if (cats) { const c = cats.filter((c) => Math.abs(c.px - g.px) <= (g.hi - g.lo) / 2 + 6).sort((a, b) => Math.abs(a.px - g.px) - Math.abs(b.px - g.px))[0]; if (c) label = c.label; }
      if (!label && xAxis && xAxis.kind !== 'category' && !horiz) { const v = xAxis.fit.a + xAxis.fit.b * g.px; label = xAxis.kind === 'date' ? fmtDate(v, xAxis.dateKind) : String(+v.toFixed(2)); }
      g.label = label || ('Group ' + (i + 1));
    });
    const valueAt = (pix, axisIdx) => {
      if (horiz) { if (!xAxis || xAxis.kind === 'category') return null; return xAxis.fit.a + xAxis.fit.b * pix; }
      return toY(axisIdx, pix);
    };
    // the baseline bars grow from: the most common bar foot
    const feet = allRects.map((r) => (horiz ? r.x0 : r.y1)); const heads = allRects.map((r) => (horiz ? r.x1 : r.y0));
    const mode = (arr) => { const m = new Map(); arr.forEach((v) => m.set(Math.round(v), (m.get(Math.round(v)) || 0) + 1)); return +[...m.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
    let baselinePy = horiz ? null : mode(feet), baselinePx = horiz ? mode(feet) : null;
    if (!horiz) { const z = zeroPy(0); const negFeet = allRects.filter((r) => Math.abs(r.y0 - z) <= 3).length; if (negFeet > allRects.length / 2) baselinePy = z; }
    // printed values on or above bars
    const nums = words.filter((w) => meaningful(w) && !axisBoxes.has(w)).map((w) => ({ w, n: parseNumber(w.text) })).filter((x) => x.n);
    for (const s of barShapes) {
      const axisIdx = yAxisFor(s); const nm = s.name || null;
      const pts = groups.map((g) => {
        const mine = g.rects.filter((r) => r.s === s);
        if (!mine.length) return { cat: g.label, y: null, conf: 1 };
        const r = mine.reduce((a, b) => (a.n > b.n ? a : b));
        let v, mode = 'diff';
        if (horiz) { const lft = valueAt(r.x0 - 0.5), rgt = valueAt(r.x1 + 0.5); const base = baselinePx; if (Math.abs(r.x0 - base) <= 3) { v = rgt; mode = 'right'; } else if (Math.abs(r.x1 - base) <= 3) { v = lft; mode = 'left'; } else v = rgt - lft; }
        else {
          const top = valueAt(r.y0 - 0.5, axisIdx), bottom = valueAt(r.y1 + 0.5, axisIdx);
          const base = baselinePy;
          if (Math.abs(r.y1 - base) <= 3) { v = top; mode = 'top'; }               // standing on the baseline
          else if (Math.abs(r.y0 - base) <= 3) { v = bottom; mode = 'bottom'; }   // hanging below it (negative)
          else { v = top - bottom; mode = 'diff'; }                               // a stacked segment
        }
        // a printed label right at the bar end
        let printed = null;
        const lab = nums.filter(({ w }) => horiz
          ? Math.abs(w.cy - r.cy) <= r.h / 2 + 2 && w.x0 >= r.x1 - w.w && w.x0 <= r.x1 + w.h * 3
          : w.cx >= r.x0 - 3 && w.cx <= r.x1 + 3 && w.y1 >= r.y0 - w.h * 2.5 && w.y1 <= r.y0 + w.h * 1.5);
        if (lab.length) printed = lab.sort((a, b) => (horiz ? Math.abs(a.w.cy - r.cy) - Math.abs(b.w.cy - r.cy) : Math.abs(a.w.cx - r.cx) - Math.abs(b.w.cx - r.cx)))[0].n.value;
        return { cat: g.label, y: v, measured: v, printed, mode, rect: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }, px: r.cx, py: horiz ? r.cy : r.y0, conf: 1 };
      });
      series.push({ name: nm, type: horiz ? 'barh' : 'bar', color: hex(s.rgb), axis: axisIdx, points: pts, named: !!s.name, clusterIds: [s.c.id] });
    }
    // trust printed values when they agree with the bar geometry better than the axis does
    const barSeries = series.filter((s) => s.type === 'bar' || s.type === 'barh');
    const pairs = barSeries.flatMap((s) => s.points.filter((p) => p.printed != null && p.measured != null && p.rect));
    if (pairs.length >= 3) {
      const len = (p) => (horiz ? p.rect.x1 - p.rect.x0 + 1 : p.rect.y1 - p.rect.y0 + 1);
      // fit printed = a + k * length (the axis may not start at zero)
      { const xs = pairs.map(len), ys = pairs.map((p) => p.printed); const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; }); var kk = sxx ? sxy / sxx : 0, aa = my - kk * mx; }
      // printed value should be proportional to bar length (bars start at zero)
      const pred = (p) => aa + kk * len(p);
      const tolOf = (p) => Math.max(0.06 * Math.abs(p.printed), Math.abs(kk) * 2.5);
      const good = pairs.filter((p) => Math.abs(p.printed - pred(p)) <= tolOf(p));
      if (good.length >= Math.max(3, pairs.length * 0.6) && kk > 0) {
        for (const s of barSeries) for (const p of s.points) {
          if (!p.rect) continue;
          const fromPrinted = pred(p);
          p.scaleFromLabels = fromPrinted;
          if (p.printed != null && Math.abs(p.printed - pred(p)) <= tolOf(p)) { p.y = p.printed; p.source = 'printed'; }
          else if (Math.abs((p.measured ?? 0) - fromPrinted) > 0.03 * Math.max(...pairs.map((q) => Math.abs(q.printed)))) { p.y = +fromPrinted.toFixed(4); p.source = 'scaled'; }
        }
        series.barLabelScale = kk;
      }
    }
    const stacked = groups.some((g) => { const rs = g.rects; for (let i = 0; i < rs.length; i++) for (let j = 0; j < rs.length; j++) if (i !== j && rs[i].s !== rs[j].s && (horiz ? Math.abs(rs[i].x1 + 1 - rs[j].x0) <= 2 : Math.abs(rs[i].y0 - 1 - rs[j].y1) <= 2) && (horiz ? Math.abs(rs[i].cy - rs[j].cy) < 3 : Math.abs(rs[i].cx - rs[j].cx) < 3)) return true; return false; });
    barSeries.forEach((s) => (s.stacked = stacked));
    series.categories = groups.map((g) => g.label);
  }

  // scatter
  for (const s of shapes.filter((x) => x.type === 'scatter')) {
    const axisIdx = yAxisFor(s); const nm = s.name || LETTERS[letter++];
    const pts = scatterPoints(s.rects).map((p) => ({ ...p, x: toX(p.px), y: toY(axisIdx, p.py) }));
    const size = median(s.rects.map((r) => Math.max(r.w, r.h)));
    series.push({ name: nm, type: 'scatter', color: hex(s.rgb), axis: axisIdx, points: pts, markerSize: size, named: !!s.name, clusterIds: [s.c.id] });
  }

  // axis lines and frames that slipped through: flat, hugging the plot edge
  for (let i = series.length - 1; i >= 0; i--) {
    const s = series[i]; if (!(s.type === 'line' || s.type === 'step')) continue;
    const ys = s.points.filter((p) => !p.interp).map((p) => p.py); if (!ys.length) { series.splice(i, 1); continue; }
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const edge = Math.abs(median(ys) - plot.y1) <= 5 || Math.abs(median(ys) - plot.y0) <= 4;
    const flatShare = ys.filter((y) => Math.abs(y - median(ys)) <= 1.5).length / ys.length;
    const nearEdge = s.points.filter((p) => !p.interp && (Math.abs(p.py - plot.y0) <= 5 || Math.abs(p.py - plot.y1) <= 5)).length / Math.max(1, s.points.length);
    const grey = chroma(rgb2lab(...hexRgb(s.color))) < 20;
    const interpShare = s.points.filter((p) => p.interp).length / Math.max(1, s.points.length);
    if (!s.named && interpShare > 0.6 && grey) { series.splice(i, 1); continue; }
    if (!s.named && interpShare > 0.75 && series.length > 1) { series.splice(i, 1); continue; }   // mostly guesswork between scraps   // mostly guessed: outlines and edges, not a series
    if (edge && flatShare > 0.85 && !s.named) series.splice(i, 1);
    else if (grey && !s.named && nearEdge > 0.5) series.splice(i, 1);   // the plot frame
    else if (s.points.length < (plot.x1 - plot.x0) * 0.04 && !s.named) series.splice(i, 1);
  }
  // drop shadows: a duplicate trace at a small constant offset, greyer than its partner
  for (let i = series.length - 1; i >= 0; i--) {
    const s = series[i]; if (!(s.type === 'line' || s.type === 'step') || s.named) continue;
    const sl = rgb2lab(...hexRgb(s.color));
    for (const o of series) {
      if (o === s || !(o.type === 'line' || o.type === 'step')) continue;
      const m = new Map(o.points.map((p) => [p.px, p.py])); const diffs = [];
      for (const p of s.points) if (m.has(p.px) && !p.interp) diffs.push(p.py - m.get(p.px));
      if (diffs.length < s.points.length * 0.7) continue;
      const md = median(diffs); const spread = median(diffs.map((d) => Math.abs(d - md)));
      if (Math.abs(md) <= 7 && spread <= 1.2 && chroma(sl) < chroma(rgb2lab(...hexRgb(o.color)))) { series.splice(i, 1); break; }
    }
  }
  // dark edges along bar tops read as a line
  { const rects = series.filter((x) => x.type === 'bar').flatMap((x) => x.points.map((p) => p.rect).filter(Boolean));
    if (rects.length) for (let i = series.length - 1; i >= 0; i--) { const s = series[i]; if (s.type !== 'line' || s.named) continue;
      const real = s.points.filter((p) => !p.interp); const onTop = real.filter((p) => rects.some((r) => p.px >= r.x0 - 2 && p.px <= r.x1 + 2 && (Math.abs(p.py - r.y0) <= 5 || Math.abs(p.py - r.y1) <= 5))).length;
      if (real.length && onTop / real.length > 0.4) series.splice(i, 1); } }
  // legend names OCR'd all in lower case
  series.forEach((s) => { if (s.named && /^[a-z][a-z ]+$/.test(s.name)) s.name = s.name[0].toUpperCase() + s.name.slice(1); });
  // axis tick marks read as markers: points lined up on the plot edge
  for (let i = series.length - 1; i >= 0; i--) {
    const s = series[i]; if (s.type !== 'scatter' || s.named) continue;
    const edge = s.points.filter((p) => Math.abs(p.py - plot.y1) <= 5 || Math.abs(p.py - plot.y0) <= 5 || Math.abs(p.px - plot.x0) <= 5).length;
    if (edge >= s.points.length * 0.5 || s.points.length < 4) series.splice(i, 1);
  }
  series.forEach((s, i) => { if (!s.named) s.name = LETTERS[series.filter((x, j) => j < i && !x.named).length]; });

  // 12. printed values inside the plot (anchors)
  const anchors = [];
  for (const w of words) {
    if (axisBoxes.has(w) || !meaningful(w)) continue;
    const n = parseNumber(w.text); if (!n) continue;
    if (w.cx < plot.x0 - 4 || w.cx > plot.x1 + 4 || w.cy < plot.y0 - 14 || w.cy > plot.y1 + 4) continue;
    anchors.push({ value: n.value, box: w });
  }

  const categories = series.categories || (xAxis && xAxis.kind === 'category' ? xAxis.cats.map((c) => c.label) : null);
  // decorative rules outside the plot (title underlines, frames)
  const deco = [];
  { const full = inkMask(img, bg, 40); let prev = -5;
    for (let y = 0; y < H; y++) { if (y >= plot.y0 - 3 && y <= plot.y1 + 3) continue; let run = 0, best = 0, bx = 0, sx = 0; for (let x = 0; x < W; x++) { if (full[y * W + x]) { if (!run) sx = x; run++; if (run > best) { best = run; bx = sx; } } else run = 0; }
      if (best >= W * 0.45 && y - prev > 1) { const thick = [y]; while (y + 1 < H && (() => { let r = 0, b = 0; for (let x = bx; x < bx + best; x++) { if (full[(y + 1) * W + x]) { r++; b = Math.max(b, r); } else r = 0; } return b >= best * 0.9; })()) { y++; thick.push(y); }
        if (thick.length <= 4) deco.push({ y: (thick[0] + thick[thick.length - 1]) / 2, x0: bx, x1: bx + best - 1, w: thick.length, color: hex(median3(sampleRow(img, thick[0], bx, bx + best - 1))) }); prev = y; } } }
  const ruleInfo = {
    deco,
    rows: rules.rows.map((y) => ({ y, color: hex(median3(sampleRow(img, y, plot.x0, plot.x1))) })),
    cols: rules.cols.map((x) => ({ x, color: hex(median3(sampleCol(img, x, plot.y0, plot.y1))) })),
  };
  const panelRects = panelCols.map((c) => { let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1; for (let y = plot.y0; y <= plot.y1; y++) for (let x = plot.x0; x <= plot.x1; x++) { const p = y * W + x; if (excl[p]) continue; const P = [lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]]; if (dE(P, c.lab) < 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } return { x0, x1, y0, y1, color: hex(c.rgb) }; }).filter((r) => r.x1 > r.x0);
  return finishModel({ dbgVax, asg, core, rulesInfo: ruleInfo, panels: panelRects, axisBoxes, W, H, bg, words, legend, plot, left, right, xAxis, xKind, series, anchors, categories, rules, orientation, chartType: dominantType(series) }, canvas);
}

function sampleRow(img, y, x0, x1) { const out = []; for (let x = x0; x <= x1; x += 2) { const i = (y * img.width + x) * 4; out.push([img.data[i], img.data[i + 1], img.data[i + 2]]); } return out; }
function sampleCol(img, x, y0, y1) { const out = []; for (let y = y0; y <= y1; y += 2) { const i = (y * img.width + x) * 4; out.push([img.data[i], img.data[i + 1], img.data[i + 2]]); } return out; }
function hexRgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function median3(cols) { return [0, 1, 2].map((k) => median(cols.map((c) => c[k]))); }

function dominantType(series) {
  if (!series.length) return 'unknown';
  const t = {}; series.forEach((s) => (t[s.type] = (t[s.type] || 0) + 1));
  const kinds = Object.keys(t);
  if (kinds.length === 1) return kinds[0];
  if (kinds.includes('band')) return 'mixed';
  return 'mixed';
}

// Legend: a phrase with a coloured mark just to its left
function findLegend(img, lab, bg, phr, axisBoxes, allWords) {
  const W = img.width, H = img.height; const bgLab = rgb2lab(...bg); const out = [];
  const isDash = (t) => /^[—–\-~_=©®■●▬•«»oO0]+$/.test(t || '');
  const blockers = allWords.filter((w) => !w.dashLike && ((w.text && w.conf >= 50 && !isDash(w.text) && /[A-Za-z0-9]/.test(w.text)) || (w.charLike && (w.comps || []).length >= 2)));
  for (const p of phr) {
    const words = p.words;
    let toks = words.flatMap((w) => w.text.split(/\s+/));
    while (toks.length > 1 && toks[toks.length - 1].replace(/[^A-Za-z0-9]/g, '').length <= 2 && !/^\d+$/.test(toks[toks.length - 1])) toks.pop();
    let name = toks.join(' ').replace(/^[—–\-~_=©®■●▬•«»‘’'"`\s]+/, '').replace(/[|‘’'"`]+$/, '').trim();
    if (!/[A-Za-z0-9]/.test(name) || name.length > 60) continue;
    const first = words[0]; const h = Math.max(6, p.h);
    let region = { x0: Math.max(0, Math.round(first.x0 - 3.4 * h)), x1: first.x0 - 1, y0: Math.max(0, Math.round(first.cy - 0.7 * h)), y1: Math.min(H - 1, Math.round(first.cy + 0.7 * h)) };
    // a dash glued to the first word ("——Repo"): wide, short components at its left end
    const lead = (first.comps || []).slice().sort((a, b) => a.x0 - b.x0);
    let gl = []; for (const c of lead) { if (c.h <= Math.max(5, h * 0.35) && c.w >= 4 && c.w >= c.h * 2.5) gl.push(c); else break; }
    let glued = false;
    if (gl.length) { region = { x0: Math.min(...gl.map((c) => c.x0)), x1: Math.max(...gl.map((c) => c.x1)), y0: Math.min(...gl.map((c) => c.y0)) - 1, y1: Math.max(...gl.map((c) => c.y1)) + 1 }; glued = true; }
    const px = []; let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
    for (let y = region.y0; y <= region.y1; y++) for (let x = region.x0; x <= region.x1; x++) {
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const q = y * W + x; const P = [lab[q * 3], lab[q * 3 + 1], lab[q * 3 + 2]];
      if (dE(P, bgLab) < 20) continue;
      if (!glued && blockers.some((w) => x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1)) continue;
      px.push(P); bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
    }
    if (px.length < 4 || bx1 - bx0 < 3) continue;
    // keep only the mark nearest the text (ignore stray marks further left)
    const chromaPx = px.filter((P) => chroma(P) > 15);
    let core;
    if (chromaPx.length >= Math.max(3, px.length * 0.25)) { chromaPx.sort((a, b) => chroma(b) - chroma(a)); core = chromaPx.slice(0, Math.max(3, Math.round(chromaPx.length * 0.6))); }
    else { px.sort((a, b) => dE(b, bgLab) - dE(a, bgLab)); core = px.slice(0, Math.max(3, Math.round(px.length * 0.5))); }
    const L = [0, 1, 2].map((k) => median(core.map((c) => c[k])));
    const sw = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    if (!glued && [bx0 <= region.x0, bx1 >= region.x1, by0 <= region.y0, by1 >= region.y1].filter(Boolean).length >= 3) continue;
    const kind = by1 - by0 <= 5 ? 'line' : (bx1 - bx0 >= 5 && by1 - by0 >= 5 ? 'box' : 'marker');
    let gaps = 0; { const yy = Math.round((by0 + by1) / 2); let on = false; for (let x = bx0; x <= bx1; x++) { const q = yy * W + x; const ink = dE([lab[q * 3], lab[q * 3 + 1], lab[q * 3 + 2]], bgLab) > 20; if (on && !ink) gaps++; on = ink; } }
    const chromatic = chroma(L) >= 12;
    const lettersOk = /[A-Za-z]{2,}/.test(name) && (words.every((w) => w.conf >= 50) || (mean(words.map((w) => w.conf)) >= 35 && name.replace(/[^A-Za-z]/g, '').length >= 6));
    const numericOk = /^\d{2,4}$/.test(name) && chromatic;
    if (!lettersOk && !numericOk) continue;
    // the "words" sit on the line itself (a dashed line read as text): not a legend
    { let same = 0, tot = 0; for (let y = p.y0; y <= p.y1; y++) for (let x = p.x0; x <= p.x1; x++) { const q = y * W + x; tot++; if (dE([lab[q * 3], lab[q * 3 + 1], lab[q * 3 + 2]], L) < 18) same++; } if (tot && same / tot > 0.18 && chroma(L) > 12 && (by1 - by0) <= 5) continue; }
    if (!chromatic && !(kind === 'line' && bx1 - bx0 >= 1.2 * h)) continue;
    out.push({ name, lab: L, color: hex(labToRgb(L)), box: { x0: first.x0, y0: p.y0, x1: p.x1, y1: p.y1 }, swatchBox: sw, kind, dashed: gaps >= 2, phrase: p, textColor: hex(first.color || [34, 34, 34]) });
  }
  // names that wrap onto a second line: a phrase right below an entry, left-aligned with it, with no swatch of its own
  const usedP = new Set(out.map((e) => e.phrase));
  for (const e of out) {
    const nx = phr.filter((q) => !usedP.has(q) && Math.abs(q.x0 - e.phrase.x0) <= 4 && q.y0 > e.phrase.y1 && q.y0 - e.phrase.y1 <= e.phrase.h * 1.2)[0];
    if (nx) { e.name = (e.name + ' ' + nx.text).replace(/\s+/g, ' ').trim(); usedP.add(nx); e.box = { ...e.box, y1: nx.y1, x1: Math.max(e.box.x1, nx.x1) }; }
  }
  // a legend has 2+ entries, or one entry with a crisp line swatch
  return out.length >= 2 ? out : out.filter((e) => e.kind === 'line');
}

export function labToRgb([L, a, b]) {
  let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = f(x) * 0.95047; y = f(y); z = f(z) * 1.08883;
  let r = x * 3.2406 + y * -1.5372 + z * -0.4986, g = x * -0.9689 + y * 1.8758 + z * 0.0415, bb = x * 0.0557 + y * -0.204 + z * 1.057;
  const c = (v) => 255 * (v > 0.0031308 ? 1.055 * Math.pow(v, 1 / 2.4) - 0.055 : 12.92 * v);
  return [c(r), c(g), c(bb)].map((v) => Math.max(0, Math.min(255, v)));
}

// Pie and doughnut charts: sweep angles around the centre.
function analyzePie(img, lab, bg, excl, legend, words, gfx) {
  const W = img.width, H = img.height; const bgLab = rgb2lab(...bg);
  const m = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) { if (excl[p]) continue; if (dE([lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]], bgLab) > 12) m[p] = 1; }
  const { comps } = components(m, W, H);
  // slices may be separated by white borders: merge components whose union is roughly round
  const big = comps.filter((c) => c.n > W * H * 0.004).sort((a, b) => b.n - a.n);
  if (!big.length) return null;
  const bb = big.reduce((b, c) => ({ x0: Math.min(b.x0, c.x0), y0: Math.min(b.y0, c.y0), x1: Math.max(b.x1, c.x1), y1: Math.max(b.y1, c.y1), n: b.n + c.n }), { x0: W, y0: H, x1: 0, y1: 0, n: 0 });
  const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1;
  if (Math.abs(bw - bh) > 0.12 * Math.max(bw, bh)) return null;
  const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2, r = (bw + bh) / 4;
  const fill = bb.n / (Math.PI * r * r);
  if (fill < 0.45) return null;
  // hole?
  const centreInk = m[Math.round(cy) * W + Math.round(cx)];
  let inner = 0;
  if (!centreInk) { for (let rr = 1; rr < r; rr++) if (m[Math.round(cy) * W + Math.round(cx + rr)]) { inner = rr; break; } }
  const rs = inner ? (inner + r) / 2 : r * 0.7;
  const samples = [];
  for (let a = 0; a < 3600; a++) {
    const th = (a / 3600) * 2 * Math.PI - Math.PI / 2; // start at 12 o'clock, clockwise
    const x = Math.round(cx + rs * Math.cos(th)), y = Math.round(cy + rs * Math.sin(th));
    const q = y * W + x; samples.push(m[q] ? [lab[q * 3], lab[q * 3 + 1], lab[q * 3 + 2]] : null);
  }
  // cluster colours along the sweep
  const cl = [];
  const idx = samples.map((P) => { if (!P) return -1; let bi = -1, bd = 1e9; cl.forEach((c, i) => { const d = dE(P, c.lab); if (d < bd) { bd = d; bi = i; } }); if (bd < 14) { cl[bi].n++; return bi; } cl.push({ lab: P, n: 1 }); return cl.length - 1; });
  // runs
  const runs = []; let cur = null;
  idx.forEach((k, i) => { if (k < 0) return; if (cur && cur.k === k && i - cur.end <= 12) { cur.end = i; cur.n++; } else { cur = { k, start: i, end: i, n: 1 }; runs.push(cur); } });
  if (runs.length > 1 && runs[0].k === runs[runs.length - 1].k) { runs[0].n += runs[runs.length - 1].n; runs[0].start = runs[runs.length - 1].start - 3600; runs.pop(); }
  const real = runs.filter((rn) => rn.n >= 12);
  if (real.length < 2) return null;
  const total = real.reduce((s, rn) => s + rn.n, 0);
  const slices = real.map((rn, i) => {
    const L = cl[rn.k].lab; const mid = ((rn.start + rn.end) / 2) / 3600 * 2 * Math.PI - Math.PI / 2;
    let name = null; const lg = legend.filter((e) => dE(e.lab, L) < 22).sort((a, b) => dE(a.lab, L) - dE(b.lab, L))[0];
    if (lg) name = lg.name;
    return { name: name || LETTERS[i], color: hex(labToRgb(L)), share: rn.n / total, angle: mid, lab: L };
  });
  // printed percentages near slices
  const anchors = [];
  for (const w of words) { const n = parseNumber(w.text || ''); if (!n || !(w.conf > 50)) continue; const ang = Math.atan2(w.cy - cy, w.cx - cx); const dist = Math.hypot(w.cx - cx, w.cy - cy); if (dist > r * 1.6) continue;
    let best = null, bd = 1e9; slices.forEach((s) => { let d = Math.abs(Math.atan2(Math.sin(ang - s.angle), Math.cos(ang - s.angle))); if (d < bd) { bd = d; best = s; } }); if (best && bd < 0.6) anchors.push({ value: n.value, pct: n.pct, slice: best, box: w }); }
  return { cx, cy, r, inner, slices, anchors, donut: inner > r * 0.2 };
}

function finishModel(m, canvas) {
  const meaningful = (w) => w.text && w.conf >= 45 && /[A-Za-z0-9]/.test(w.text);
  // title: largest text above the plot
  const above = phrases(m.words.filter((w) => meaningful(w) && w.y1 < m.plot.y0 - 2 && !w.rotated), 1.2).filter((p) => /[A-Za-z]{2,}/.test(p.text) && !/^\(.*\)$/.test(p.text.trim()));
  // the title is usually the nearest prominent line above the plot; a much bigger line close above it wins
  above.sort((a, b) => b.y1 - a.y1);
  if (above.length) { const near = above[0]; const big = above.find((p) => p !== near && near.y0 - p.y1 < near.h * 2 && p.h > near.h * 1.25); if (big) above.unshift(big); }
  // titles that wrap: join a same-size line right above
  if (above[0]) { const t = above[0]; const up = above.find((p) => p !== t && t.y0 - p.y1 >= -2 && t.y0 - p.y1 < t.h * 1.2 && Math.abs(p.h - t.h) < t.h * 0.3); if (up) above[0] = { ...t, text: up.text + ' ' + t.text, x0: Math.min(up.x0, t.x0), y0: up.y0, x1: Math.max(up.x1, t.x1), words: [...up.words, ...t.words] }; }
  m.title = above[0] ? { text: above[0].text, box: { x0: above[0].x0, y0: above[0].y0, x1: above[0].x1, y1: above[0].y1 }, color: hex(above[0].words[0].color || [0, 0, 0]), size: above[0].h } : null;
  const below = phrases(m.words.filter((w) => meaningful(w) && w.y0 > m.plot.y1 + 4 && !w.rotated), 1.2).filter((p) => /^(source|note|sources)/i.test(p.text));
  m.notes = below.map((p) => p.text);
  // all other prose for the rebuild (titles, subtitles, notes, annotations)
  const used = new Set([...(m.axisBoxes || [])]);
  (m.legend || []).forEach((e) => (e.phrase ? e.phrase.words : []).forEach((w) => used.add(w)));
  const legendBoxes = (m.legend || []).map((e) => e.box);
  const yCols = [m.left, m.right].filter(Boolean).map((a) => ({ x0: a.x0, x1: a.x1, y0: m.plot.y0 - 20, y1: m.plot.y1 + 20 }));
  const xStrip = m.xAxis ? { y0: m.xAxis.y0 - 2, y1: Math.max(...m.xAxis.boxes.map((b) => b.y1)) + 2 } : null;
  const prose = phrases(m.words.filter((w) => meaningful(w) && !used.has(w) && !w.rotated && !w.dashLike
      && !legendBoxes.some((b) => w.cx >= b.x0 - 2 && w.cx <= b.x1 + 2 && w.cy >= b.y0 - 2 && w.cy <= b.y1 + 2)
      && !(xStrip && w.cy >= xStrip.y0 && w.cy <= xStrip.y1 && w.x1 > m.plot.x0 - 10)
      && !yCols.some((c) => w.x1 >= c.x0 - 4 && w.x0 <= c.x1 + 4 && w.cy >= c.y0 && w.cy <= c.y1 && parseNumber(w.text))), 1.2)
    .filter((p) => p.text.replace(/[^A-Za-z0-9]/g, '').length >= 2 && mean(p.words.map((w) => w.conf)) >= 55);
  const typicalH = median(m.words.filter((w) => meaningful(w) && !w.rotated).map((w) => w.h)) || 10;
  m.textItems = prose.map((p) => ({ text: p.text, x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, h: Math.min(p.h, typicalH * 2.4), color: hex(p.words[0].color || [0, 0, 0]), inPlot: p.cx > m.plot.x0 && p.cx < m.plot.x1 && p.cy > m.plot.y0 && p.cy < m.plot.y1 }));
  refreshDerived(m);
  m.canvas = canvas;
  return m;
}

// Ticks and pixel<->value helpers; call again after the axes are corrected by hand
export function refreshDerived(m) {
  const fmt = (v, dec, pct) => (isFinite(v) ? v.toFixed(Math.max(0, dec)) + (pct ? '%' : '') : '');
  m.yTicks = [m.left, m.right].map((a) => {
    if (!a) return null;
    const ins = a.fit.inliers; const dec = Math.max(0, ...ins.map((P) => (parseNumber(P.box.text) || { decimals: 0 }).decimals));
    const vals = ins.map((P) => (a.isLog ? Math.pow(10, P.v) : P.v)).sort((x, y) => x - y);
    // the tick step: the smallest gap that every other gap is a whole multiple of
    const diffs = vals.slice(1).map((v, i) => v - vals[i]).filter((d) => d > 1e-9);
    let step = a.isLog ? null : median(diffs);
    if (!a.isLog && diffs.length) for (const d of [...new Set(diffs.map((x) => +x.toFixed(6)))].sort((x, y) => x - y)) { if (diffs.every((x) => Math.abs(x / d - Math.round(x / d)) < 0.08)) { step = d; break; } }
    const out = [];
    if (a.isLog) { for (const P of ins) out.push({ v: Math.pow(10, P.v), py: P.p }); }
    else {
      let lo = vals[0], hi = vals[vals.length - 1];
      // labels OCR misread (e.g. "11" read as "1") still mark ticks: extend to them
      for (const P of a.pts || []) { if (ins.includes(P)) continue; const v = a.fit.a + a.fit.b * P.p; const k = Math.round((v - lo) / step); if (Math.abs(v - (lo + k * step)) < step * 0.15) { lo = Math.min(lo, lo + k * step); hi = Math.max(hi, lo + k * step); } }
      for (let v = lo; v <= hi + step * 0.01; v += step) out.push({ v: +v.toFixed(10), py: (v - a.fit.a) / a.fit.b });
    }
    const hs = ins.map((P) => P.box.h), cols = ins.map((P) => P.box.color || [0, 0, 0]);
    return { ticks: out.map((t) => ({ ...t, text: fmt(t.v, dec, a.pct) })), x0: a.x0, x1: a.x1, h: median(hs), color: hex(median3(cols)), dec, step, isLog: a.isLog, pct: a.pct, fit: a.fit, min: out.length ? Math.min(...out.map((t) => t.v)) : null, max: out.length ? Math.max(...out.map((t) => t.v)) : null };
  });
  if (m.xAxis && m.xAxis.kind !== 'category') {
    const f = m.xAxis.fit; const ins = f.inliers; const vals = ins.map((P) => P.v).sort((x, y) => x - y);
    const step = median(vals.slice(1).map((v, i) => v - vals[i]));
    const byV = new Map(ins.map((P) => [+P.v.toFixed(6), P.box.text]));
    const out = []; let lo = vals[0], hi = vals[vals.length - 1];
    // labels the fit left out (misread) still mark ticks
    for (const b of m.xAxis.boxes || []) { const v = f.a + f.b * b.cx; const k = Math.round((v - lo) / step); if (Math.abs(v - (lo + k * step)) < step * 0.2) { lo = Math.min(lo, lo + k * step); hi = Math.max(hi, lo + k * step); } }
    // a known label format to copy for the ones OCR missed
    // carry the tick pattern across the whole plot when the last labels were not read
    while ((lo - step - f.a) / f.b >= m.plot.x0 - 2) lo -= step;
    while ((hi + step - f.a) / f.b <= m.plot.x1 + 2) hi += step;
    for (let v = lo; v <= hi + step * 0.01; v += step) { const key = +v.toFixed(6); const known = [...byV.entries()].find(([k]) => Math.abs(k - v) < step * 0.1); out.push({ v, px: (v - f.a) / f.b, text: known ? known[1] : guessLabel(v, ins, m.xAxis) }); }
    const yl = m.yTicks && (m.yTicks[0] || m.yTicks[1]);
    m.xTicks = { ticks: out, h: m.xAxis.rotated && yl ? yl.h : median(m.xAxis.boxes.map((b) => (b.rotated ? b.w : b.h))), color: hex(median3(m.xAxis.boxes.map((b) => b.color || [0, 0, 0]))), rotated: !!m.xAxis.rotated, y0: m.xAxis.y0, step, min: lo, max: hi, kind: m.xAxis.kind, dateKind: m.xAxis.dateKind };
  } else if (m.xAxis && m.xAxis.kind === 'category') {
    m.xTicks = { ticks: m.xAxis.cats.map((c) => ({ px: c.px, text: c.label })), h: median(m.xAxis.boxes.map((b) => b.h)), color: hex(median3(m.xAxis.boxes.map((b) => b.color || [0, 0, 0]))), rotated: !!m.xAxis.rotated, y0: m.xAxis.y0, kind: 'category' };
  }
  // pixel <-> value helpers
  m.yToPx = (axisIdx, v) => { const a = [m.left, m.right][axisIdx] || m.left || m.right; if (!a || v == null) return null; const t = a.isLog ? Math.log10(v) : v; return (t - a.fit.a) / a.fit.b; };
  m.xToPx = (v) => (m.xAxis && m.xAxis.kind !== 'category' ? (v - m.xAxis.fit.a) / m.xAxis.fit.b : v);
}

// Re-derive every value from its pixel position (after an axis correction)
export function revalue(m) {
  const toY = (axis, py) => { const a = [m.left, m.right][axis] || m.left || m.right; if (!a || py == null) return null; const v = a.fit.a + a.fit.b * py; return a.isLog ? Math.pow(10, v) : v; };
  const toX = (px) => (m.xAxis && m.xAxis.kind !== 'category' ? m.xAxis.fit.a + m.xAxis.fit.b * px : px);
  for (const s of m.series || []) {
    if (s.type === 'bar' || s.type === 'barh') {
      for (const p of s.points) {
        if (!p.rect || p.source === 'printed') continue; const r = p.rect;
        if (s.type === 'bar') { const top = toY(s.axis, r.y0 - 0.5), bot = toY(s.axis, r.y1 + 0.5); p.y = p.mode === 'top' ? top : p.mode === 'bottom' ? bot : top - bot; }
        else { const l = toX(r.x0 - 0.5), rr = toX(r.x1 + 0.5); p.y = p.mode === 'right' ? rr : p.mode === 'left' ? l : rr - l; }
        p.measured = p.y;
      }
      continue;
    }
    for (const p of s.points) { if (p.px != null) p.x = toX(p.px); if (p.py != null) p.y = toY(s.axis, p.py); }
    if (s.lower) for (const p of s.lower) { p.x = toX(p.px); p.y = toY(s.axis, p.py); }
  }
  refreshDerived(m);
}

function guessLabel(v, ins, ax) {
  // copy the shape of a known label: two-digit years, month-year, FY, plain numbers
  const sample = ins[0] && ins[0].box.text || '';
  if (ax.kind === 'date') {
    const yr = Math.floor(v + 1e-6), mo = Math.round((v - yr) * 12);
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][((mo % 12) + 12) % 12];
    if (/^\d{2}$/.test(sample)) return String(yr % 100).padStart(2, '0');
    if (/^FY/i.test(sample)) return 'FY' + String(yr % 100).padStart(2, '0');
    if (/^[A-Za-z]{3}-\d{2}$/.test(sample)) return mon + '-' + String(yr % 100).padStart(2, '0');
    if (/^[A-Za-z]{3} \d{4}$/.test(sample)) return mon + ' ' + yr;
    return String(yr);
  }
  const dec = Math.max(0, ...ins.map((P) => (P.box.text.split('.')[1] || '').length));
  return v.toFixed(dec);
}
