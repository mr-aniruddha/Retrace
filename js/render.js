// Rebuild the chart from the extracted numbers, at the source's size and in its styling.

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const fs = (h) => Math.max(7, h * 1.32); // glyph box height -> font size

export function dashArray(dash, w) {
  const u = Math.max(1, w);
  if (dash === 'dot') return `${u},${u * 1.6}`;
  if (dash === 'dash') return `${u * 4},${u * 2.5}`;
  if (dash === 'longDash') return `${u * 8},${u * 3}`;
  return null;
}

// Pixel geometry of every series, recomputed from values (not copied from the image)
export function seriesGeometry(m) {
  const out = [];
  for (const s of m.series || []) {
    const g = { s, type: s.type };
    if (s.type === 'line' || s.type === 'step') {
      g.pts = s.points.map((p) => (p.y != null && isFinite(p.y) ? [m.xToPx(p.x), m.yToPx(s.axis, p.y), p.px] : null));
    } else if (s.type === 'area' || s.type === 'band') {
      g.upper = s.points.map((p) => [m.xToPx(p.x), m.yToPx(s.axis, p.y)]);
      if (s.type === 'band') g.lower = s.lower.map((p) => [m.xToPx(p.x), m.yToPx(s.axis, p.y)]);
      else { const base = baseline(m, s.axis); g.lower = g.upper.map(([x]) => [x, base]); }
    } else if (s.type === 'bar' || s.type === 'barh') {
      g.rects = s.points.filter((p) => p.rect && p.y != null).map((p) => {
        const r = p.rect;
        if (s.type === 'bar') {
          const v = m.yToPx(s.axis, p.y); const b = barBase(m, s, p);
          return { x: r.x0, y: Math.min(v, b), w: r.x1 - r.x0 + 1, h: Math.abs(b - v) };
        }
        const v = m.xToPx(p.y); const b = r.x0 - 0.5;
        return { x: Math.min(v, b), y: r.y0, w: Math.abs(v - b), h: r.y1 - r.y0 + 1 };
      });
    } else if (s.type === 'scatter') {
      g.dots = s.points.filter((p) => p.y != null).map((p) => [m.xToPx(p.x), m.yToPx(s.axis, p.y)]);
    }
    out.push(g);
  }
  return out;
}

function baseline(m, axis) {
  const z = m.yToPx(axis, 0);
  if (z != null && z >= m.plot.y0 - 2 && z <= m.plot.y1 + 4) return z;
  return m.plot.y1;
}
function barBase(m, s, p) {
  const r = p.rect;
  if (p.source === 'printed' || p.source === 'scaled' || p.measured != null) {
    // bars keep the foot they stand on in the source
    if (p.y >= 0) return r.y1 + 0.5;
    return r.y0 - 0.5;
  }
  return baseline(m, s.axis);
}

function poly(pts) { return pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(''); }

export function buildSVG(m, opts = {}) {
  const { text = true, background = true } = opts;
  const W = m.W, H = m.H; const parts = [];
  const bg = `rgb(${m.bg.map((v) => Math.round(v)).join(',')})`;
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">`);
  if (background) parts.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);
  for (const p of m.panels || []) parts.push(`<rect x="${p.x0}" y="${p.y0}" width="${p.x1 - p.x0 + 1}" height="${p.y1 - p.y0 + 1}" fill="${p.color}"/>`);
  if (m.pie) return pieSVG(m, parts, text);
  // gridlines and axes
  for (const r of (m.rulesInfo && m.rulesInfo.rows) || []) parts.push(`<line x1="${m.plot.x0}" x2="${m.plot.x1}" y1="${r.y + 0.5}" y2="${r.y + 0.5}" stroke="${r.color}" stroke-width="1"/>`);
  for (const r of (m.rulesInfo && m.rulesInfo.deco) || []) parts.push(`<line x1="${r.x0}" x2="${r.x1 + 1}" y1="${r.y + 0.5}" y2="${r.y + 0.5}" stroke="${r.color}" stroke-width="${r.w}"/>`);
  for (const r of (m.rulesInfo && m.rulesInfo.cols) || []) parts.push(`<line y1="${m.plot.y0}" y2="${m.plot.y1}" x1="${r.x + 0.5}" x2="${r.x + 0.5}" stroke="${r.color}" stroke-width="1"/>`);
  const geo = seriesGeometry(m);
  const order = { band: 0, area: 1, bar: 2, barh: 2, line: 3, step: 3, scatter: 4 };
  for (const g of [...geo].sort((a, b) => order[a.type] - order[b.type])) parts.push(seriesSVG(g));
  if (text) parts.push(textSVG(m));
  parts.push('</svg>');
  return parts.join('');
}

export function seriesSVG(g) {
  const s = g.s;
  if (g.pts) {
    const segs = s.segments && s.segments.length > 1 ? s.segments : [{ color: s.color, dash: s.dash, width: s.width, from: -Infinity, to: Infinity }];
    const out = [];
    for (const seg of segs) {
      const pts = g.pts.filter((p) => p && (seg.from === -Infinity || (p[2] >= seg.from - 0.5 && p[2] <= seg.to + 0.5)));
      if (pts.length < 2) continue;
      const da = dashArray(seg.dash, seg.width || s.width);
      out.push(`<path d="${poly(pts)}" fill="none" stroke="${seg.color}" stroke-width="${Math.max(1, seg.width || s.width || 1.5)}" stroke-linejoin="round" stroke-linecap="round"${da ? ` stroke-dasharray="${da}"` : ''}/>`);
    }
    return out.join('');
  }
  if (g.upper) {
    const d = poly(g.upper) + poly([...g.lower].reverse()).replace(/^M/, 'L') + 'Z';
    return `<path d="${d}" fill="${s.color}" stroke="none"/>`;
  }
  if (g.rects) return g.rects.map((r) => `<rect x="${r.x.toFixed(2)}" y="${r.y.toFixed(2)}" width="${r.w.toFixed(2)}" height="${r.h.toFixed(2)}" fill="${s.color}"/>`).join('');
  if (g.dots) { const r = Math.max(1.5, (s.markerSize || 5) / 2); return g.dots.map(([x, y]) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r}" fill="${s.color}"/>`).join(''); }
  return '';
}

function textSVG(m) {
  const out = [];
  const t = (x, y, str, h, color, anchor = 'start', extra = '', width = null) =>
    out.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${fs(h).toFixed(1)}" fill="${color}" text-anchor="${anchor}" dominant-baseline="central"${width ? ` textLength="${width.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : ''}${extra}>${esc(str)}</text>`);
  const [L, R] = m.yTicks || [];
  if (L) for (const k of L.ticks) t(L.x1, k.py, k.text, L.h, L.color, 'end');
  if (R) for (const k of R.ticks) t(R.x0, k.py, k.text, R.h, R.color, 'start');
  if (m.xTicks) {
    const X = m.xTicks;
    for (const k of X.ticks) {
      if (X.rotated) { const y = X.y0; out.push(`<text x="${k.px.toFixed(1)}" y="${y.toFixed(1)}" font-size="${fs(X.h).toFixed(1)}" fill="${X.color}" text-anchor="end" dominant-baseline="central" transform="rotate(-90 ${k.px.toFixed(1)} ${y.toFixed(1)})">${esc(k.text)}</text>`); }
      else t(k.px, X.y0 + X.h / 2, k.text, X.h, X.color, 'middle');
    }
  }
  for (const e of m.legend || []) {
    const sw = e.swatchBox; const cy = (e.box.y0 + Math.min(e.box.y1, e.box.y0 + (e.phrase ? e.phrase.h : 10))) / 2;
    if (e.kind === 'box') out.push(`<rect x="${sw.x0}" y="${sw.y0}" width="${sw.x1 - sw.x0 + 1}" height="${sw.y1 - sw.y0 + 1}" fill="${e.color}"/>`);
    else out.push(`<line x1="${sw.x0}" x2="${sw.x1 + 1}" y1="${(sw.y0 + sw.y1 + 1) / 2}" y2="${(sw.y0 + sw.y1 + 1) / 2}" stroke="${e.color}" stroke-width="${Math.max(1, sw.y1 - sw.y0 + 1)}"/>`);
    const h = e.phrase ? e.phrase.h : 10;
    const tw = e.phrase ? e.phrase.x1 - e.box.x0 + 1 : null;
    t(e.box.x0, cy, e.name, h, e.textColor || '#222222', 'start', '', e.name.length > 1 && tw ? tw : null);
  }
  // stretch text to its original width only when the guess is close; otherwise it looks squashed
  const fit = (str, h, w) => { const est = str.length * fs(h) * 0.52; return est / w > 0.78 && est / w < 1.3 ? w : null; };
  for (const it of m.textItems || []) t(it.x0, (it.y0 + it.y1) / 2, it.text, it.h, it.color, 'start', '', fit(it.text, it.h, it.x1 - it.x0 + 1));
  return out.join('');
}

function pieSVG(m, parts, text) {
  const { cx, cy, r, inner, slices } = m.pie; let a = -Math.PI / 2;
  for (const s of slices) {
    const b = a + s.share * 2 * Math.PI; const large = b - a > Math.PI ? 1 : 0;
    const p = (ang, rad) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)].map((v) => v.toFixed(2)).join(',');
    const d = inner > r * 0.2
      ? `M${p(a, r)}A${r},${r} 0 ${large} 1 ${p(b, r)}L${p(b, inner)}A${inner},${inner} 0 ${large} 0 ${p(a, inner)}Z`
      : `M${cx},${cy}L${p(a, r)}A${r},${r} 0 ${large} 1 ${p(b, r)}Z`;
    parts.push(`<path d="${d}" fill="${s.color}" stroke="rgb(${m.bg.map(Math.round).join(',')})" stroke-width="1"/>`);
    a = b;
  }
  if (text) parts.push(textSVG(m));
  parts.push('</svg>');
  return parts.join('');
}

// Rasterise the SVG (for the wipe view and for scoring)
export async function svgToCanvas(svg, W, H) {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(img, 0, 0);
  return c;
}
