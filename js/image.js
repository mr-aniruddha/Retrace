// Pixel-level helpers. Everything works on plain {width, height, data} objects (ImageData-compatible).

export function luminance(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

// sRGB -> CIE Lab (D65)
export function rgb2lab(r, g, b) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = f(r), G = f(g), B = f(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const g3 = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = g3(x); y = g3(y); z = g3(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function dE(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
export function chroma(lab) { return Math.hypot(lab[1], lab[2]); }
export function hex(rgb) { return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase(); }

// Per-pixel Lab, computed once (Float32Array, 3 per pixel)
export function labImage(img) {
  const n = img.width * img.height; const out = new Float32Array(n * 3); const d = img.data;
  const cache = new Map();
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3];
    let key = a < 128 ? -1 : (r << 16) | (g << 8) | b;
    let v = cache.get(key);
    if (!v) { v = a < 128 ? [100, 0, 0] : rgb2lab(r, g, b); cache.set(key, v); }
    out[i * 3] = v[0]; out[i * 3 + 1] = v[1]; out[i * 3 + 2] = v[2];
  }
  return out;
}

export function pixel(img, x, y) { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; }

// Most common colour, coarse-binned then refined: the chart background.
export function backgroundColor(img) {
  const counts = new Map(); const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = 0, bk = 0;
  for (const [k, c] of counts) if (c > best) { best = c; bk = k; }
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    if (k === bk) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
  }
  return [sr / n, sg / n, sb / n];
}

// Connected components over a Uint8Array mask (8-connected). Returns {labels, comps}
export function components(mask, w, h, minSize = 1) {
  const labels = new Int32Array(w * h).fill(-1); const comps = []; const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s] !== -1) continue;
    const id = comps.length; let sp = 0; stack[sp++] = s; labels[s] = id;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0, sx = 0, sy = 0;
    while (sp) {
      const p = stack[--sp]; const x = p % w, y = (p / w) | 0; n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx; if (mask[q] && labels[q] === -1) { labels[q] = id; stack[sp++] = q; }
      }
    }
    comps.push({ id, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, n, cx: sx / n, cy: sy / n });
  }
  if (minSize > 1) return { labels, comps: comps.filter((c) => c.n >= minSize), all: comps };
  return { labels, comps, all: comps };
}

export function cropCanvas(srcCanvas, box, scale = 1, pad = 0, rotate = 0) {
  const w = Math.max(1, Math.round((box.x1 - box.x0 + 1 + pad * 2) * scale));
  const h = Math.max(1, Math.round((box.y1 - box.y0 + 1 + pad * 2) * scale));
  const c = document.createElement('canvas');
  if (rotate === 90 || rotate === -90) { c.width = h; c.height = w; } else { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  if (rotate === 90) { g.translate(c.width, 0); g.rotate(Math.PI / 2); }
  else if (rotate === -90) { g.translate(0, c.height); g.rotate(-Math.PI / 2); }
  g.drawImage(srcCanvas, box.x0 - pad, box.y0 - pad, box.x1 - box.x0 + 1 + pad * 2, box.y1 - box.y0 + 1 + pad * 2, 0, 0, w, h);
  return c;
}

// Make text crisp for OCR: grey-scale, contrast stretch against background, threshold softly.
export function binarizeForOcr(canvas, bg) {
  const g = canvas.getContext('2d'); const im = g.getImageData(0, 0, canvas.width, canvas.height); const d = im.data;
  const bgL = bg ? luminance(bg[0], bg[1], bg[2]) : 255;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.hypot(d[i] - (bg ? bg[0] : 255), d[i + 1] - (bg ? bg[1] : 255), d[i + 2] - (bg ? bg[2] : 255));
    // distance from background drives darkness, so coloured text on coloured panels still reads
    let v = 255 - Math.min(255, dist * 2.2);
    if (bgL < 100) v = 255 - v; // dark backgrounds: invert sense handled by distance anyway
    v = v < 150 ? Math.max(0, v - 60) : Math.min(255, v + 40);
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return canvas;
}

export function median(arr) { if (!arr.length) return NaN; const a = [...arr].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
export function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN; }
