// Finds text on the chart and reads it, one box at a time.
import { components, cropCanvas, binarizeForOcr, median } from './image.js';

let workers = null;
const VENDOR = (window.RETRACE_VENDOR || './vendor');

export async function getOcr(onProgress) {
  if (workers) return workers;
  const opts = { workerPath: VENDOR + '/tesseract/worker.min.js', corePath: VENDOR + '/tesseract/core', langPath: VENDOR + '/tesseract/lang' };
  const make = async (params) => { const w = await Tesseract.createWorker('eng', 1, opts); await w.setParameters(params); return w; };
  const [text, digits] = await Promise.all([
    make({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' }),
    make({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.,-%()' }),
  ]);
  workers = { text, digits };
  return workers;
}

// Distance-from-background ink mask
export function inkMask(img, bg, thr = 70) {
  const n = img.width * img.height; const m = new Uint8Array(n); const d = img.data;
  for (let i = 0; i < n; i++) {
    const dr = d[i * 4] - bg[0], dg = d[i * 4 + 1] - bg[1], db = d[i * 4 + 2] - bg[2];
    if (dr * dr + dg * dg + db * db > thr * thr) m[i] = 1;
  }
  return m;
}

class UF { constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); } f(a) { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; } u(a, b) { a = this.f(a); b = this.f(b); if (a !== b) this.p[b] = a; } }

function bboxOf(list) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const c of list) { b.x0 = Math.min(b.x0, c.x0); b.y0 = Math.min(b.y0, c.y0); b.x1 = Math.max(b.x1, c.x1); b.y1 = Math.max(b.y1, c.y1); }
  return b;
}

// Background per 32px tile (handles coloured panels behind text). null where no colour dominates.
export function tileBackgrounds(img, size = 32) {
  const W = img.width, H = img.height, d = img.data; const tw = Math.ceil(W / size), th = Math.ceil(H / size);
  const modes = new Array(tw * th).fill(null);
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    const counts = new Map(); let total = 0;
    for (let y = ty * size; y < Math.min(H, (ty + 1) * size); y++) for (let x = tx * size; x < Math.min(W, (tx + 1) * size); x++) {
      const i = (y * W + x) * 4; const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      let c = counts.get(k); if (!c) { c = [0, 0, 0, 0]; counts.set(k, c); } c[0]++; c[1] += d[i]; c[2] += d[i + 1]; c[3] += d[i + 2]; total++;
    }
    let best = null; for (const c of counts.values()) if (!best || c[0] > best[0]) best = c;
    if (best && best[0] >= total * 0.4) modes[ty * tw + tx] = [best[1] / best[0], best[2] / best[0], best[3] / best[0]];
  }
  return { size, tw, th, modes };
}

// Ink relative to local background: a pixel is ink if it differs from its own and neighbouring tile backgrounds
export function localInkMask(img, bg, thr = 60) {
  const W = img.width, H = img.height, d = img.data; const T = tileBackgrounds(img); const m = new Uint8Array(W * H);
  const t2 = thr * thr;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4; const r = d[i], g = d[i + 1], b = d[i + 2];
    const dg = (r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2; if (dg <= t2) continue;
    const tx = Math.floor(x / T.size), ty = Math.floor(y / T.size); let isBg = false;
    for (let dy = -1; dy <= 1 && !isBg; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = tx + dx, Y = ty + dy; if (X < 0 || Y < 0 || X >= T.tw || Y >= T.th) continue; const mo = T.modes[Y * T.tw + X]; if (!mo) continue;
      if ((r - mo[0]) ** 2 + (g - mo[1]) ** 2 + (b - mo[2]) ** 2 <= t2 * 0.45) { isBg = true; break; }
    }
    if (!isBg) m[y * W + x] = 1;
  }
  return m;
}

// The colour just around a box
export function ringBackground(img, b) {
  const W = img.width, H = img.height, d = img.data; const px = [];
  for (let x = b.x0 - 2; x <= b.x1 + 2; x++) for (const y of [b.y0 - 2, b.y1 + 2]) if (x >= 0 && y >= 0 && x < W && y < H) px.push(y * W + x);
  for (let y = b.y0 - 2; y <= b.y1 + 2; y++) for (const x of [b.x0 - 2, b.x1 + 2]) if (x >= 0 && y >= 0 && x < W && y < H) px.push(y * W + x);
  const ch = [0, 1, 2].map((k) => median(px.map((p) => d[p * 4 + k])));
  return ch;
}

// Character-sized components grouped into words. Returns word boxes {x0,y0,x1,y1, comps, rotated}
export function findTextBoxes(img, bg) {
  const W = img.width, H = img.height;
  const mask = localInkMask(img, bg, 60);
  const { comps } = components(mask, W, H);
  const maxH = Math.max(14, Math.min(48, H * 0.09));
  const chars = comps.filter((c) => {
    if (c.n < 2 && !(c.w === 1 && c.h === 1)) return false;
    const fill = c.n / (c.w * c.h);
    const small = c.h <= 3 || c.w <= 3;
    if (c.h > maxH || c.w > maxH * 1.6) return false;
    if (!small && fill > 0.92 && c.w > 5 && c.h > 5) return false; // solid blocks: bars, swatches
    if (c.h <= 2 && c.w > maxH * 0.9) return false; // long thin rules
    return true;
  });
  // horizontal grouping
  const uf = new UF(chars.length);
  const byX = chars.map((c, i) => i).sort((a, b) => chars[a].x0 - chars[b].x0);
  for (let ii = 0; ii < byX.length; ii++) {
    const a = chars[byX[ii]];
    for (let jj = ii + 1; jj < byX.length; jj++) {
      const b = chars[byX[jj]];
      const hh = Math.max(a.h, b.h, 6);
      if (b.x0 - a.x1 > 0.55 * hh) break;
      const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      const tiny = Math.min(a.h, b.h) <= 4;
      const dashy = (c, o) => c.h <= 5 && c.w >= Math.max(10, o.h * 0.9) && c.w >= c.h * 2.5;
      if (dashy(a, b) !== dashy(b, a)) continue;
      let ok;
      if (tiny) { const [t, g] = a.h <= b.h ? [a, b] : [b, a]; ok = g.h <= 4 ? Math.abs(a.cy - b.cy) <= 2 : t.cy >= g.y0 - 3 && t.cy <= g.y1 + 2; }
      else ok = ov >= 0.45 * Math.min(a.h, b.h) && Math.max(a.h, b.h) <= 2.6 * Math.min(a.h, b.h);
      if (ok) uf.u(byX[ii], byX[jj]);
    }
  }
  let groups = new Map();
  chars.forEach((c, i) => { const r = uf.f(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
  let words = [...groups.values()].map((g) => ({ ...bboxOf(g), comps: g, rotated: false }));
  // vertical grouping for leftovers that look like stacked single characters (rotated labels)
  const singles = words.filter((w) => w.comps.length === 1 && w.comps[0].h >= 4 && w.comps[0].w >= 3);
  if (singles.length >= 6) {
    const uf2 = new UF(singles.length);
    const byY = singles.map((s, i) => i).sort((a, b) => singles[a].y0 - singles[b].y0);
    for (let ii = 0; ii < byY.length; ii++) {
      const a = singles[byY[ii]];
      for (let jj = ii + 1; jj < byY.length; jj++) {
        const b = singles[byY[jj]];
        const ww = Math.max(a.x1 - a.x0, b.x1 - b.x0, 6);
        if (b.y0 - a.y1 > 0.6 * ww) continue;
        const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        if (ov >= 0.35 * Math.min(a.x1 - a.x0 + 1, b.x1 - b.x0 + 1) && b.y0 - a.y1 <= 0.6 * ww && b.y0 - a.y1 >= -2) uf2.u(byY[ii], byY[jj]);
      }
    }
    const g2 = new Map();
    singles.forEach((s, i) => { const r = uf2.f(i); if (!g2.has(r)) g2.set(r, []); g2.get(r).push(s); });
    const vert = [...g2.values()].filter((g) => { if (g.length < 3) return false; const bb = bboxOf(g); return (bb.y1 - bb.y0 + 1) >= 2.2 * (bb.x1 - bb.x0 + 1); });
    if (vert.length >= 3) {
      const used = new Set(vert.flat());
      words = words.filter((w) => !used.has(w));
      for (const g of vert) words.push({ ...bboxOf(g), comps: g.flatMap((x) => x.comps), rotated: true });
    }
  }
  // drop specks
  words = words.filter((w) => (w.x1 - w.x0 + 1) * (w.y1 - w.y0 + 1) >= 6 && !(w.comps.length === 1 && w.comps[0].n < 4 && !(w.comps[0].h <= 3 && w.comps[0].w >= 3)));
  words.forEach((w, i) => { w.id = i; w.h = w.y1 - w.y0 + 1; w.w = w.x1 - w.x0 + 1; w.cx = (w.x0 + w.x1) / 2; w.cy = (w.y0 + w.y1) / 2;
    // a lone short horizontal stroke is a legend swatch or a dash, not text
    w.dashLike = !w.rotated && w.comps.every((c) => c.h <= 5 && c.w >= 3 && c.w >= 1.5 * c.h) && w.h <= 6 && w.w >= Math.max(10, 2 * w.h);
    w.charLike = w.comps.filter((c) => c.h >= 5).length >= 1;
    // nothing taller than a stroke: dashes of a dashed line, not text
    if (!w.rotated && !w.charLike && w.w >= 6) w.dashLike = true;
    // runs of dash-shaped strokes (a dashed line), not letters
    const dashy = w.comps.filter((c) => c.h <= 6 && c.w >= 1.8 * c.h && c.w >= 5).length;
    if (!w.rotated && w.comps.length >= 2 && dashy >= 0.7 * w.comps.length) w.dashLike = true;
  });
  return words;
}

// Text colour of a box: mean of its darkest/most distinct pixels
export function boxColor(img, box, bg) {
  const d = img.data; let best = []; const W = img.width;
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
    const i = (y * W + x) * 4; const dist = Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
    best.push([dist, d[i], d[i + 1], d[i + 2]]);
  }
  best.sort((a, b) => b[0] - a[0]); best = best.slice(0, Math.max(3, Math.round(best.length * 0.15)));
  const s = [0, 0, 0]; best.forEach((p) => { s[0] += p[1]; s[1] += p[2]; s[2] += p[3]; });
  return s.map((v) => v / best.length);
}

const looksAlpha = (t) => /[A-Za-z]{3,}/.test(t);
const numberish = (t) => /[0-9%oOlISB]/.test(t) && t.replace(/\s/g, '').length <= 9;

async function recognizeBox(canvas, box, bg, worker, rotate = 0) {
  const h = rotate ? box.x1 - box.x0 + 1 : box.y1 - box.y0 + 1;
  const scale = Math.max(2, Math.min(7, 42 / Math.max(6, h)));
  const c = cropCanvas(canvas, box, scale, 3, rotate);
  binarizeForOcr(c, bg);
  // white margin helps tesseract
  const m = document.createElement('canvas'); m.width = c.width + 40; m.height = c.height + 30;
  const g = m.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, m.width, m.height); g.drawImage(c, 20, 15);
  const r = await worker.recognize(m);
  return { text: (r.data.text || '').trim().replace(/\s+/g, ' '), conf: r.data.confidence || 0 };
}

// Read every word box. Mutates boxes with .text and .conf
export async function readBoxes(canvas, boxes, bg, onProgress) {
  const { text, digits } = await getOcr();
  let done = 0;
  for (const b of boxes) {
    let r; const bgl = b.bg || bg;
    if (b.dashLike) { b.text = '—'; b.conf = 0; done++; continue; }
    if (b.rotated) {
      const a = await recognizeBox(canvas, b, bgl, text, -90);
      const c = await recognizeBox(canvas, b, bgl, text, 90);
      r = a.conf >= c.conf ? { ...a, rot: -90 } : { ...c, rot: 90 };
    } else {
      r = await recognizeBox(canvas, b, bgl, text);
      if (!looksAlpha(r.text) && numberish(r.text || '0')) {
        const d = await recognizeBox(canvas, b, bgl, digits);
        if (/\d/.test(d.text) && (d.conf >= r.conf - 15 || !/\d/.test(r.text))) r = { ...d, digitsPass: true };
      }
    }
    b.text = fixDecimal(r.text, b); b.conf = r.conf; b.rot = r.rot || 0;
    done++; if (onProgress) onProgress(done / boxes.length);
  }
  return boxes;
}

// Merge words on one baseline into phrases (titles, legend names, annotations)
export function phrases(words, maxGapFactor = 1.1) {
  const ws = words.filter((w) => !w.rotated && w.text);
  const uf = new UF(ws.length);
  for (let i = 0; i < ws.length; i++) for (let j = 0; j < ws.length; j++) {
    if (i === j) continue; const a = ws[i], b = ws[j];
    if (b.x0 < a.x1) continue;
    const hh = Math.max(a.h, b.h);
    const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (b.x0 - a.x1 <= maxGapFactor * hh && ov >= 0.5 * Math.min(a.h, b.h) && Math.max(a.h, b.h) <= 1.6 * Math.min(a.h, b.h)) uf.u(i, j);
  }
  const g = new Map(); ws.forEach((w, i) => { const r = uf.f(i); if (!g.has(r)) g.set(r, []); g.get(r).push(w); });
  return [...g.values()].map((list) => { list.sort((a, b) => a.x0 - b.x0); const bb = bboxOf(list); return { ...bb, words: list, text: list.map((w) => w.text).join(' '), h: median(list.map((w) => w.h)), cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2 }; });
}

// Rotated labels (dates turned 90 degrees): read the strip upright, both ways, keep the better.
export async function readRotatedStrip(canvas, reg, bg) {
  const { text } = await getOcr();
  const sw = reg.x1 - reg.x0 + 1, sh = reg.y1 - reg.y0 + 1;
  const scale = Math.max(2, Math.min(5, 40 / Math.max(6, median([sw, sh].map(() => 12)))));
  let best = [];
  for (const rot of [-90, 90]) {
    const c = cropCanvas(canvas, reg, scale, 0, rot); binarizeForOcr(c, bg);
    const pad = 20; const m = document.createElement('canvas'); m.width = c.width + pad * 2; m.height = c.height + pad * 2;
    const g = m.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, m.width, m.height); g.drawImage(c, pad, pad);
    await text.setParameters({ tessedit_pageseg_mode: '11' });
    const r = await text.recognize(m);
    await text.setParameters({ tessedit_pageseg_mode: '7' });
    if (window.__dbgStrip) { const blob = await new Promise((res) => m.toBlob(res)); await fetch('/__save/strip_' + window.__dbgStrip + '_' + rot + '.png', { method: 'POST', body: blob }); console.log('STRIP', rot, JSON.stringify((r.data.words || []).map((w) => [w.text, Math.round(w.confidence)]))); }
    const ws = [];
    for (const w of r.data.words || []) {
      const t = (w.text || '').trim(); if (!t || w.confidence < 30) continue;
      // back to strip coordinates (scaled), then to image
      const u0 = (w.bbox.x0 - pad) / scale, u1 = (w.bbox.x1 - pad) / scale, v0 = (w.bbox.y0 - pad) / scale, v1 = (w.bbox.y1 - pad) / scale;
      let x0, x1, y0, y1;
      if (rot === -90) { x0 = sw - v1; x1 = sw - v0; y0 = u0; y1 = u1; } else { x0 = v0; x1 = v1; y0 = sh - u1; y1 = sh - u0; }
      const b = { x0: Math.round(reg.x0 + x0), x1: Math.round(reg.x0 + x1), y0: Math.round(reg.y0 + y0), y1: Math.round(reg.y0 + y1), text: t, conf: w.confidence, rotated: true, fromStrip: true, rot };
      b.w = b.x1 - b.x0 + 1; b.h = b.y1 - b.y0 + 1; b.cx = (b.x0 + b.x1) / 2; b.cy = (b.y0 + b.y1) / 2; b.color = [0, 0, 0];
      ws.push(b);
    }
    const good = ws.filter((w) => /\d/.test(w.text)).length;
    if (good > best.filter((w) => /\d/.test(w.text)).length) best = ws;
  }
  return best;
}

// OCR often drops tiny decimal points. If the box has a dot-sized blob near the baseline between digits, put it back.
function fixDecimal(t, b) {
  if (!t || /[.,]/.test(t) || !/^[-−]?\d{2,}%?$/.test(t.trim()) || !b.comps) return t;
  const cs = [...b.comps].sort((a, c) => a.x0 - c.x0); const hMax = Math.max(...cs.map((c) => c.h));
  const idx = cs.findIndex((c, i) => i > 0 && i < cs.length - 1 && c.w <= Math.max(3, hMax * 0.3) && c.h <= Math.max(3, hMax * 0.3) && c.cy > b.y0 + (b.y1 - b.y0) * 0.55);
  if (idx < 0) return t;
  const digitsBefore = cs.slice(0, idx).filter((c) => c.h >= hMax * 0.6).length;
  const neg = /^[-−]/.test(t.trim()); const body = t.trim().replace(/^[-−]/, '');
  if (digitsBefore <= 0 || digitsBefore >= body.replace('%', '').length) return t;
  return (neg ? '-' : '') + body.slice(0, digitsBefore) + '.' + body.slice(digitsBefore);
}
