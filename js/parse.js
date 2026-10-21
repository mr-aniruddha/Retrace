// Turning label text into values: numbers, percents, years, months, quarters, fiscal years.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function cleanNumeric(t) {
  let s = (t || '').trim();
  s = s.replace(/[−–—‒]/g, '-').replace(/\s+/g, '');
  // common OCR confusions inside numbers
  if (/^[-+(]?[\dOoIl|SB.,%$€£]+[)%]?$/.test(s) && /\d/.test(s)) {
    s = s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  }
  return s;
}

export function parseNumber(t) {
  let s = cleanNumeric(t);
  if (!s) return null;
  let neg = false, pct = false, mult = 1;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/^[$€£₹]/, '');
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1); }
  const suf = s.match(/^(.*?)([kKmMbB]|bn|tn)$/);
  if (suf && /\d/.test(suf[1])) { s = suf[1]; mult = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9, bn: 1e9, tn: 1e12 }[suf[2]]; }
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.'); // decimal comma
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  let v = parseFloat(s) * mult; if (neg) v = -v;
  const dec = s.includes('.') ? s.split('.')[1].length : 0;
  return { value: v, pct, decimals: dec, raw: t, twoDigit: /^\d{2}$/.test(s) };
}

const twoOrFour = (y) => { y = +y; if (y < 100) y += y >= 50 ? 1900 : 2000; return y; };

// Returns {t: decimal year, kind: 'year'|'month'|'quarter'|'fiscal', label}
export function parseDate(t) {
  let s = (t || '').trim().replace(/[−–—]/g, '-').replace(/[’‘]/g, "'");
  let m;
  if ((m = s.match(/^(19|20)\d{2}$/))) return { t: +s, kind: 'year' };
  if ((m = s.match(/^FY\s?'?(\d{2}|\d{4})$/i))) return { t: twoOrFour(m[1]), kind: 'fiscal' };
  if ((m = s.match(/^((?:19|20)\d{2})\s?[-/]\s?(\d{2})$/)) && (+m[2] === (+m[1] + 1) % 100)) return { t: +m[1], kind: 'fiscal' };
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s?[-'/ ]?\s?'?(\d{2}|\d{4})$/))) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return { t: twoOrFour(m[2]) + mi / 12, kind: 'month' };
  }
  if ((m = s.match(/^((?:19|20)\d{2})\s?[-/]\s?(\d{1,2})$/)) && +m[2] >= 1 && +m[2] <= 12) return { t: +m[1] + (+m[2] - 1) / 12, kind: 'month' };
  if ((m = s.match(/^Q([1-4])\s?[-' ]?\s?'?(\d{2}|\d{4})$/i))) return { t: twoOrFour(m[2]) + (+m[1] - 1) / 4, kind: 'quarter' };
  if ((m = s.match(/^(\d{2}|\d{4})\s?[-' ]?\s?Q([1-4])$/i))) return { t: twoOrFour(m[1]) + (+m[2] - 1) / 4, kind: 'quarter' };
  if ((m = s.match(/^([1-4])Q\s?'?(\d{2}|\d{4})$/i))) return { t: twoOrFour(m[2]) + (+m[1] - 1) / 4, kind: 'quarter' };
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    const a = +m[1], b = +m[2]; const y = twoOrFour(m[3]);
    const [d, mo] = a > 12 ? [a, b] : [b, a] /* ambiguous: assume mm/dd if first <=12 */;
    if (mo >= 1 && mo <= 12) return { t: y + (mo - 1) / 12 + (d - 1) / 365, kind: 'day' };
  }
  return null;
}

// Decimal year <-> Excel serial and pretty labels
export function yearToDate(t) {
  const y = Math.floor(t); const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
  return new Date(start + (t - y) * (end - start));
}
export function dateToExcel(d) { return d.getTime() / 86400000 + 25569; }
export function fmtDate(t, kind) {
  const d = yearToDate(t + 1e-6);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  if (kind === 'year' || kind === 'fiscal') return String(Math.round(t));
  if (kind === 'quarter') return 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear();
  if (kind === 'day') return d.getUTCDate() + ' ' + mon + ' ' + d.getUTCFullYear();
  return mon + ' ' + d.getUTCFullYear();
}

// Clean numeric display with sensible precision
export function niceRound(v, range) {
  if (!isFinite(v)) return v;
  const digits = Math.max(0, Math.min(6, Math.ceil(-Math.log10(Math.max(range, 1e-9) / 2000))));
  return +v.toFixed(digits);
}
