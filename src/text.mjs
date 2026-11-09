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
  // 공백만 있는 조각은 … 없이 그냥 자른다 (조각 사이 간격이 … 로 바뀌지 않게).
  if (!s.trim()) return ' '.repeat(max);
  // 원래 글이 … 로 끝나는 곳에서 잘리면 … 가 두 번 붙지 않게 한다.
  return out.replace(/[…\s]+$/u, '') + '…';
}

export function pad(s, n, align = 'left') {
  const t = truncate(s, n);
  const gap = ' '.repeat(Math.max(0, n - width(t)));
  return align === 'right' ? gap + t : t + gap;
}

// 기록에서 읽은 문자열이 터미널 제어 순서(ESC 등)나 방향 바꾸기 문자를 담고 있으면 화면이 깨지거나 터미널 동작이 바뀐다.
// 폭이 0인 글자(U+200B~200D, U+2060, U+FEFF)도 지운다. 명령 사이에 숨으면 보이는 글자와 실제 명령이 달라진다.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f​-‏‪-‮⁠⁦-⁩﻿]/g;

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

// ── 엄격한 가림: 허락을 기다리는 요청 전체(상세 패널 요청 구획, --json waitDetail)에만 쓴다 ──
// 명령을 그대로 사용자에게 보이는 자리라, 애매하면 가린다. 평범한 낱말 하나가 가려지는 편이 비밀값이 새는 것보다 낫다.
// 모든 반복에는 상한을 두어 긴 입력에서도 처리 시간이 길이에 비례하게 한다.
const M = '••••';
const STRICT_WORD = '(?:token|secret|passw(?:or)?d|pass(?![a-z])|pwd|(?<![a-z])pin(?![a-z])|key|passphrase|credentials?|creds?(?![a-z])|authorization|auth(?!or)|cookie|session[_-]?id|signature|(?<![a-z])sig(?![a-z]))';
const NAME = `[A-Za-z0-9_.-]{0,64}${STRICT_WORD}[A-Za-z0-9_.-]{0,64}`;
// 이 이름이면 값 전체가 비밀이다. key 하나뿐인 이름도 비밀로 친다.
export const STRICT_NAME = new RegExp(`^(?:${NAME}|key)$`, 'i');
// 값: "따옴표 안 전체", '따옴표 안 전체', `백틱 안 전체`, 아니면 공백·구분자 앞까지.
const VALUE = `(?:\$\{[^}\n]{0,256}\}|"[^"\\n]{0,4096}"|'[^'\\n]{0,4096}'|\`[^\`\\n]{0,4096}\`|[^\\s"'\`,;&}]{1,4096})`;
const PRIVATE_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY( BLOCK)?-----/;
const STRICT_RULES = [
  // Authorization: Bearer xxx → 방식 이름을 남기고 값만. Cookie / Set-Cookie 는 줄 끝(또는 따옴표)까지 전부.
  [/\b((?:proxy-)?authorization["']?\s{0,16}[:=]\s{0,16}["'`]?)(?:(bearer|basic|token|digest|negotiate)\s{1,16})?[^\s"'`,]{1,4096}/gi, (_, h, k) => `${h}${k ? k + ' ' : ''}${M}`],
  [/\b((?:set-)?cookie["']?\s{0,16}[:=]\s{0,16})[^"'`\n]{1,4096}/gi, `$1${M}`],
  [/\b(bearer)\s{1,16}(?!••••)[A-Za-z0-9._~+/=-]{8,4096}/gi, `$1 ${M}`],
  [/\b(basic)\s{1,16}(?=[A-Za-z0-9+/]{0,4096}[0-9=])[A-Za-z0-9+/]{8,4096}={0,2}/gi, `$1 ${M}`],
  // scheme://user:pass@host — 비밀번호에 띄어쓰기가 있어도 @ 까지 가린다.
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{1,256}:)[^@/\n"']{1,256}@/gi, `$1${M}@`],
  // URL 질의의 key=, token=, sig= 등.
  [new RegExp(`([?&;](?:${NAME}|key|code)=)[^&#\\s"'\`]{1,4096}`, 'gi'), `$1${M}`],
  // curl -u user:pass, --user user:pass
  [/((?:^|\s)(?:-u|-U|--user|--proxy-user)(?:\s{1,16}|=)["']?)([^\s:"']{1,256}):[^\s"']{1,4096}/g, `$1$2:${M}`],
  // --password hunter2, --token=abc, --api-key "a b"
  [new RegExp(`((?:^|\\s)--?${NAME})(=|\\s{1,16})(?![<>|&;-])(?!["'\`]?••••)${VALUE}`, 'gi'), `$1$2${M}`],
  // 명령마다 정해진 짧은 비밀번호 옵션: mysql -pX, sshpass -p X, redis-cli -a X
  [/\b((?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mariadb|mariadb-dump|mariadb-admin)\b[^\n|;&]{0,200}?\s-p)(?!••••)[^\s-]\S{0,4096}/g, `$1${M}`],
  [/\b(sshpass\b[^\n|;&]{0,200}?\s-p)(\s{0,16})(?!••••)\S{1,4096}/g, `$1$2${M}`],
  [/\b(redis-cli\b[^\n|;&]{0,200}?\s(?:-a|--pass))(\s{1,16})(?!••••)\S{1,4096}/g, `$1$2${M}`],
  [/\b(aws\s{1,16}configure\s{1,16}set\s{1,16}\S{0,64}(?:secret|key|token)\S{0,64}\s{1,16})\S{1,4096}/gi, `$1${M}`],
  // 이름=값, 이름: 값, "이름": "값", 이름 = "a b c". 따옴표 값은 통째로 가린다.
  // 셸 따옴표 안의 JSON(\"password\":\"x\")처럼 따옴표 앞에 \ 가 붙어도 같게 본다.
  [new RegExp(`(?<![A-Za-z0-9_.-])(${NAME}(?:\\\\?["'])?\\s{0,16}[=:]\\s{0,16}\\\\?)(?!["'\`]?(?:(?:bearer|basic|token|digest|negotiate)\\s{1,16})?••••)${VALUE}`, 'gi'), `$1${M}`],
  [/\bAIza[0-9A-Za-z_-]{20,4096}/g, M],
];

// -----BEGIN … PRIVATE KEY----- 부터 -----END … PRIVATE KEY----- 까지(여러 줄)를 •••• 하나로. 끝 표시가 없으면 끝까지 가린다.
function maskPrivateKeys(s) {
  let out = '';
  let rest = s;
  for (let m = PRIVATE_BEGIN.exec(rest); m; m = PRIVATE_BEGIN.exec(rest)) {
    out += rest.slice(0, m.index) + M;
    const end = rest.indexOf('-----END ', m.index + m[0].length);
    const close = end < 0 ? -1 : rest.indexOf('-----', end + 9);
    rest = close < 0 ? '' : rest.slice(close + 5);
  }
  return out + rest;
}

export function maskStrict(s) {
  let out = maskPrivateKeys(String(s ?? ''));
  for (const [re, to] of STRICT_RULES) out = out.replace(re, to);
  for (const re of SECRET_PATTERNS) out = out.replace(re, M);
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
