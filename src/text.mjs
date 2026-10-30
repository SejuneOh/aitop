// 터미널 표시 폭 계산과 자르기. 한글·CJK·이모지는 2칸을 차지한다.

const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
  return 1;
}

export function width(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

export function truncate(s, max) {
  if (max <= 0) return '';
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function pad(s, n, align = 'left') {
  const t = truncate(s, n);
  const gap = ' '.repeat(Math.max(0, n - width(t)));
  return align === 'right' ? gap + t : t + gap;
}

export function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// 화면 공유 때 새지 않도록 비밀값처럼 보이는 문자열을 가린다.
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
];
const KEY_VALUE = /((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*"?)[^\s"']{6,}/gi;

export function mask(s) {
  let out = String(s ?? '').replace(KEY_VALUE, '$1••••');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '••••');
  return out;
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(n);
}

export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
