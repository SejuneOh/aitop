// 색: 팔레트, 색 코드, 테두리 글자. NO_COLOR 이면 색 코드를 넣지 않는다.
// 팔레트는 불러올 때 한 번 고른다: AITOP_THEME(bin 의 --theme) → COLORFGBG 의 배경색 → 어두운 테마.

export const NO_COLOR = Boolean(process.env.NO_COLOR);

// COLORFGBG 는 "글자;배경" 색 번호다. 배경이 7(밝은 회색) 이나 9~15(밝은 색) 면 밝은 배경으로 본다.
export function pickTheme(env = process.env) {
  if (env.AITOP_THEME === 'light' || env.AITOP_THEME === 'dark') return env.AITOP_THEME;
  const bg = Number(String(env.COLORFGBG ?? '').split(';').pop());
  return Number.isInteger(bg) && (bg === 7 || (bg >= 9 && bg <= 15)) ? 'light' : 'dark';
}

// 정보를 담은 글자색(text, muted, info, 상태색)은 터미널 배경, 선택 행, 대기 행, 배경 띠 어디에서도 4.5:1 이상이다.
// faint 는 구분점이나 게이지 빈 칸 같은 장식에만 쓴다.
const DARK = {
  text: '#e6e8ee',
  muted: '#babec8',
  // 글자 위계는 text > muted > info. info 는 가장 낮은 단계 (시각, 토큰 내역, 힌트, 종료 행)로 선택 행에서 4.5:1 바로 위에 둔다.
  info: '#999eae',
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
  idle: '#babec8',
  ended: '#999eae',
  alert: '#f87878',
  // 돈은 대기(호박색)와 다른 연두 계열이다. 대기 색은 사람이 응답해야 할 때만 쓴다.
  money: '#a3e635',
  addBg: '#10261a',
  delBg: '#2c1517',
  tools: { claude: '#e8865f', codex: '#5eead4', gemini: '#8ab4f8' },
  // 색 칩(키 안내, 로고) 위 글자
  chipText: '#0b0e14',
};

// 흰 배경용. 글자는 짙게, 배경 띠는 옅게 둔다.
const LIGHT = {
  text: '#1f2328',
  muted: '#495059',
  info: '#5f6771',
  faint: '#6e7781',
  line: '#d0d7de',
  rowSel: '#eaeef2',
  rowFocus: '#dbe7f7',
  rowWaiting: '#fff3cd',
  bar: '#f3f5f7',
  brand: '#0862cb',
  busy: '#187533',
  waiting: '#895c00',
  tool: '#0550ae',
  team: '#7649cb',
  idle: '#495059',
  ended: '#5f6771',
  alert: '#c5202c',
  money: '#3f6212',
  addBg: '#dafbe1',
  delBg: '#ffebe9',
  tools: { claude: '#ab4500', codex: '#097264', gemini: '#1f5fbf' },
  chipText: '#ffffff',
};

// 색약(적록 색약: 1형·2형) 팔레트. Okabe-Ito 색 계열을 터미널 배경에 맞게 밝기만 조정했다.
// 적록 색약은 빨강·초록·노랑을 노랑 계열 한 가지로, 파랑·보라를 파랑 계열로 본다. 그래서 꼭 갈라야 하는 쌍을 노랑 계열과 파랑 계열로 나눈다.
// 응답 대기(노랑) ↔ 돈(파랑), 작업 중·diff 더한 줄(청록) ↔ 경고·diff 지운 줄(주홍), 예산 주의(자주) ↔ 경고(주홍).
// 대기와 경고는 둘 다 노랑 계열로 보이지만 ◆ 와 ! 기호로 갈린다.
// 어두운 배경의 돈은 도구 실행(하늘색)과 같은 행에 서므로 같은 파랑 계열 안에서 훨씬 밝게 둔다.
// 글자·배경·도구 색은 기본 팔레트와 같고, 상태색과 diff 배경만 바꾼다. 대비 규칙은 기본 팔레트와 같다.
const DARK_CB = {
  ...DARK,
  rowWaiting: '#2b2808',
  busy: '#3cc8a0',
  waiting: '#f0e442',
  tool: '#56b4e9',
  team: '#e8a0c8',
  alert: '#ff8060',
  money: '#d4dcff',
  addBg: '#0d2333',
  delBg: '#331b0a',
};

const LIGHT_CB = {
  ...LIGHT,
  rowWaiting: '#fbf3c0',
  busy: '#00735a',
  waiting: '#6e5f00',
  tool: '#0060a0',
  team: '#9a3d76',
  alert: '#c03010',
  money: '#3a4fc0',
  addBg: '#dcefff',
  delBg: '#ffe8d6',
};

// AITOP_COLOR_BLIND=1 (bin 의 --color-blind, 설정 파일 colorBlind) 이면 배경에 맞는 색약 팔레트를 쓴다.
// 밝기(light/dark)와 색약 여부는 따로 고른다. 그래야 COLORFGBG 자동 판별을 색약 팔레트에서도 그대로 쓴다.
export const pickColorBlind = (env = process.env) => env.AITOP_COLOR_BLIND === '1';
export const paletteName = (theme, colorBlind) => (colorBlind ? `${theme}-cb` : theme);

export const THEME = pickTheme();
export const COLOR_BLIND = pickColorBlind();
export const PALETTES = { dark: DARK, light: LIGHT, 'dark-cb': DARK_CB, 'light-cb': LIGHT_CB };
export const PALETTE = PALETTES[paletteName(THEME, COLOR_BLIND)];

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

// 하루 예산 경고. 주의(예상이 예산의 80% 이상)는 대기 색과 헷갈리지 않게 팀원 색을, 초과 예상은 경고 색을 쓴다.
export const BUDGET_TOKEN = { caution: 'team', warn: 'alert' };
export const BUDGET_COLOR = { caution: PALETTE[BUDGET_TOKEN.caution], warn: PALETTE[BUDGET_TOKEN.warn] };

export const PHASE_COLOR = { tool: PALETTE.tool, team: PALETTE.team, think: PALETTE.busy, write: PALETTE.busy, waiting: PALETTE.waiting, idle: PALETTE.idle, ended: PALETTE.ended, done: PALETTE.info, unseen: PALETTE.busy };

// 상자 테두리. 포커스가 있으면 강조색으로, 색이 없으면 굵은 선으로 구분한다.
export const EDGE = {
  normal: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
};
