// Find the charts on each PDF page and hand them over as images.
import { components } from './image.js';

const VENDOR = window.RETRACE_VENDOR || './vendor';

export async function openPdf(file) {
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = VENDOR + '/pdfjs/pdf.worker.min.js';
  const data = new Uint8Array(await file.arrayBuffer());
  return lib.getDocument({ data }).promise;
}

// Render a page and return chart crops: [{canvas, box, page}]
export async function chartsOnPage(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(1.5, Math.min(3, 1700 / base.width));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas'); canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const W = canvas.width, H = canvas.height;
  // text boxes from the PDF itself
  const tc = await page.getTextContent();
  const textBoxes = tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
    const t = window.pdfjsLib.Util.transform(vp.transform, it.transform);
    const h = Math.hypot(t[2], t[3]); const w = it.width * scale;
    return { x0: t[4], y0: t[5] - h, x1: t[4] + w, y1: t[5] + h * 0.25, h, str: it.str };
  });
  // graphics = ink that is not text
  const img = ctx.getImageData(0, 0, W, H); const d = img.data;
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]; if (r + g + b < 735) ink[i] = 1; }
  for (const t of textBoxes) for (let y = Math.max(0, Math.floor(t.y0) - 1); y <= Math.min(H - 1, Math.ceil(t.y1) + 1); y++) for (let x = Math.max(0, Math.floor(t.x0) - 1); x <= Math.min(W - 1, Math.ceil(t.x1) + 1); x++) ink[y * W + x] = 0;
  // join nearby graphics: downsample by 6 and dilate
  const S = 6, w = Math.ceil(W / S), h = Math.ceil(H / S); const small = new Uint8Array(w * h);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink[y * W + x]) small[Math.floor(y / S) * w + Math.floor(x / S)] = 1;
  const dil = new Uint8Array(w * h); const R = 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (small[y * w + x]) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) dil[Y * w + X] = 1; }
  const { comps } = components(dil, w, h);
  const minW = W * 0.18, minH = H * 0.08;
  let boxes = comps.map((c) => ({ x0: c.x0 * S, y0: c.y0 * S, x1: Math.min(W - 1, (c.x1 + 1) * S), y1: Math.min(H - 1, (c.y1 + 1) * S), n: c.n }))
    .filter((b) => b.x1 - b.x0 >= minW && b.y1 - b.y0 >= minH && (b.x1 - b.x0) < W * 0.98);
  // grow each box to take in its labels, legend and title (text close to the graphics)
  boxes = boxes.map((b) => {
    const g = { ...b }; const lh = 14 * scale;
    for (let pass = 0; pass < 3; pass++) for (const t of textBoxes) {
      const near = t.x1 >= g.x0 - lh * 4 && t.x0 <= g.x1 + lh * 4 && t.y1 >= g.y0 - lh * 2.2 && t.y0 <= g.y1 + lh * 2.2;
      if (near && t.x1 - t.x0 < W * 0.9) { g.x0 = Math.min(g.x0, t.x0); g.x1 = Math.max(g.x1, t.x1); g.y0 = Math.min(g.y0, t.y0); g.y1 = Math.max(g.y1, t.y1); }
    }
    const pad = 6 * scale;
    return { x0: Math.max(0, Math.floor(g.x0 - pad)), y0: Math.max(0, Math.floor(g.y0 - pad)), x1: Math.min(W - 1, Math.ceil(g.x1 + pad)), y1: Math.min(H - 1, Math.ceil(g.y1 + pad)) };
  });
  // drop boxes inside others
  boxes = boxes.filter((b, i) => !boxes.some((o, j) => j !== i && o.x0 <= b.x0 && o.y0 <= b.y0 && o.x1 >= b.x1 && o.y1 >= b.y1 && (o.x1 - o.x0) * (o.y1 - o.y0) > (b.x1 - b.x0) * (b.y1 - b.y0)));
  boxes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  // crops at a sensible size for the engine
  const out = [];
  for (const b of boxes) {
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1; const k = Math.min(1, 1100 / bw);
    const c = document.createElement('canvas'); c.width = Math.round(bw * k); c.height = Math.round(bh * k);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, b.x0, b.y0, bw, bh, 0, 0, c.width, c.height);
    out.push({ canvas: c, box: b, page: pageNo });
  }
  page.cleanup();
  return out;
}
