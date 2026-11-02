// 색: 팔레트, 색 코드, 테두리 글자. NO_COLOR 이면 색 코드를 넣지 않는다.
// 팔레트는 불러올 때 한 번 고른다: AITOP_THEME(bin 의 --theme) → COLORFGBG 의 배경색 → 어두운 테마.

export const NO_COLOR = Boolean(process.env.NO_COLOR);

// COLORFGBG 는 "글자;배경" 색 번호다. 배경이 7(밝은 회색) 이나 9~15(밝은 색) 면 밝은 배경으로 본다.
export function pickTheme(env = process.env) {
  if (env.AITOP_THEME === 'light' || env.AITOP_THEME === 'dark') return env.AITOP_THEME;
  const bg = Number(String(env.COLORFGBG ?? '').split(';').pop());
  return Number.isInteger(bg) && (bg === 7 || (bg >= 9 && bg <= 15)) ? 'light' : 'dark';
}

const DARK = {
  text: '#e6e8ee',
  muted: '#8a90a2',
  faint: '#4b5060',
  line: '#2b2f3a',
  rowSel: '#1d2433',
  // 변경 파일 목록의 배경 띠(bar) 위에서도 보이는 선택 행 배경
  rowFocus: '#2a3550',
  rowWaiting: '#2e2610',
  bar: '#141821',
  brand: '#7dd3fc',
  busy: '#4ade80',
  waiting: '#fbbf24',
  tool: '#38bdf8',
  team: '#f0abfc',
  idle: '#8a90a2',
  ended: '#4b5060',
  alert: '#f87171',
  money: '#fcd34d',
  addBg: '#10261a',
  delBg: '#2c1517',
  tools: { claude: '#e8865f', codex: '#5eead4', gemini: '#8ab4f8' },
  // 색 칩(키 안내, 로고) 위 글자
  chipText: '#0b0e14',
};

// 흰 배경용. 글자는 짙게, 배경 띠는 옅게 둔다.
const LIGHT = {
  text: '#1f2328',
  muted: '#57606a',
  faint: '#8c959f',
  line: '#d0d7de',
  rowSel: '#eaeef2',
  rowFocus: '#dbe7f7',
  rowWaiting: '#fff3cd',
  bar: '#f3f5f7',
  brand: '#0969da',
  busy: '#1a7f37',
  waiting: '#9a6700',
  tool: '#0550ae',
  team: '#8250df',
  idle: '#57606a',
  ended: '#8c959f',
  alert: '#cf222e',
  money: '#9a6700',
  addBg: '#dafbe1',
  delBg: '#ffebe9',
  tools: { claude: '#bc4c00', codex: '#0a7d6e', gemini: '#1f5fbf' },
  chipText: '#ffffff',
};

export const THEME = pickTheme();
export const PALETTES = { dark: DARK, light: LIGHT };
export const PALETTE = THEME === 'light' ? LIGHT : DARK;

export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(';');

export function style({ fg, bg, bold, dim, italic } = {}) {
  if (NO_COLOR) return '';
  let s = '\x1b[0m';
  if (bold) s += '\x1b[1m';
  if (dim) s += '\x1b[2m';
  if (italic) s += '\x1b[3m';
  if (fg) s += `\x1b[38;2;${hex(fg)}m`;
  if (bg) s += `\x1b[48;2;${hex(bg)}m`;
  return s;
}

export const RESET = NO_COLOR ? '' : '\x1b[0m';

export const PHASE_COLOR = { tool: PALETTE.tool, team: PALETTE.team, think: PALETTE.busy, write: PALETTE.busy, waiting: PALETTE.waiting, idle: PALETTE.idle, ended: PALETTE.ended, done: PALETTE.faint, unseen: PALETTE.busy };

// 상자 테두리. 포커스가 있으면 강조색으로, 색이 없으면 굵은 선으로 구분한다.
export const EDGE = {
  normal: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
};
