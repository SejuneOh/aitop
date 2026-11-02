// 색: 팔레트, 색 코드, 테두리 글자. NO_COLOR 이면 색 코드를 넣지 않는다.


export const NO_COLOR = Boolean(process.env.NO_COLOR);

export const PALETTE = {
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
};

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
