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

// 기록에서 읽은 문자열이 터미널 제어 순서(ESC 등)나 방향 바꾸기 문자를 담고 있으면 화면이 깨지거나 터미널 동작이 바뀐다.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]/g;

export function stripControl(s) {
  return String(s ?? '').replace(CONTROL, '');
}

// diff 한 줄: 탭은 두 칸으로 펼치고 줄바꿈과 제어문자는 지운다.
export function cleanLine(s) {
  return stripControl(String(s ?? '').replace(/\t/g, '  ').replace(/[\r\n]/g, ''));
}

// 마크다운 답변을 활동 한 줄용 평문으로 바꾼다. 구분선·표 구분 줄·코드 펜스와
// `**질문:**` 처럼 굵은 이름표만 있는 줄은 건너뛰고, 굵게·인용·머리·백틱 기호를 지운다.
// 밑줄 하나(a_b)나 별표 하나(*.mjs)처럼 이름에 흔한 글자는 건드리지 않는다.
export function plainText(s) {
  const out = [];
  for (const raw of String(s ?? '').split('\n')) {
    // 인용 표시는 '> ' 처럼 뒤에 공백이 올 때만 지운다 ('>= 3' 은 그대로).
    let l = raw.trim().replace(/^(>(\s|$))+/, '').replace(/^#{1,6}\s+/, '');
    if (!l || /^```/.test(l) || /^([-*_]\s*){3,}$/.test(l)) continue;
    // 표 구분 줄: | : - 와 공백만 있는 줄.
    if (/^[|:\-\s]+$/.test(l) && l.includes('|') && l.includes('--')) continue;
    if (/^(\*\*|__)[^*_]+(\*\*|__):?$/.test(l) && /:(\*\*|__)?$/.test(l)) continue;
    // 코드 조각은 떼어 두었다가 기호 정리가 끝난 뒤 백틱만 빼고 되돌린다.
    // __dirname, __main__ 처럼 밑줄 두 개로 시작하는 이름도 같은 방법으로 지킨다.
    const code = [];
    l = l.replace(/`([^`]*)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`).replace(/(?<![\w/])__\w+(?:__)?(?![\w/])/g, (c) => `\u0000${code.push(c) - 1}\u0000`);
    if (l.startsWith('|')) l = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
    // 강조 기호는 앞뒤가 글자·/·* 에 붙지 않았을 때만 지운다 (__init__, src/**/x, 2**10 은 그대로).
    // 밑줄 두 개로 감싼 한 단어(__main__, __dirname)는 이름으로 보고 그대로 둔다.
    l = l
      .replace(/(^|[^\w/*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\w/*])/g, '$1$2')
      .replace(/(^|[^\w/])__(?=\S)(.+?)(?<=\S)__(?![\w/])/g, (m, pre, inner) => (/^\w+$/.test(inner) ? m : pre + inner));
    l = l.replace(/\u0000(\d+)\u0000/g, (_, i) => code[i]).trim();
    if (l) out.push(l);
  }
  return out.join(' ');
}

export function oneLine(s) {
  return stripControl(String(s ?? '').replace(/\s+/g, ' ')).trim();
}

// 앞을 잘라 끝(파일 이름)을 남긴다.
export function truncateLeft(s, max) {
  if (max <= 0) return '';
  if (width(s) <= max) return s;
  const chars = [...s];
  let out = '';
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i].codePointAt(0));
    if (w + cw > max - 1) break;
    out = chars[i] + out;
    w += cw;
  }
  return '…' + out;
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
