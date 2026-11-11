// 칸 수가 정해진 자리에 그리는 기호: 상자 테두리, 가로줄, 막대, 상태 기호, 선택 표시.
// 모두 동아시아 폭이 모호한(A) 글자라, 2칸으로 그리는 터미널(AITOP_AMBIGUOUS=wide)에서는 1칸 ASCII 로 바꾼다.
// 그 밖의 글(·, → 등)은 text.mjs 의 width 가 2칸으로 세어 자리를 맞춘다.
// 그릴 때마다 고르므로 setAmbiguous 를 부른 뒤에도 바로 따른다.
import { ambiguousWide } from '../text.mjs';
import { EDGE, NO_COLOR } from './theme.mjs';

const NORMAL = {
  edge: EDGE,
  rule: '─',
  bar: { fill: '▃', empty: NO_COLOR ? '▁' : '▃' },
  week: '▁▂▃▄▅▆▇█',
  // 시작할 때 헤더의 집계 진행 막대. 색이 없으면 채운 칸과 빈칸이 모양으로 갈리도록 ASCII 로 그린다.
  progress: NO_COLOR ? { l: '[', r: ']', fill: '#', empty: '.' } : { l: '▕', r: '▏', fill: '█', empty: '░' },
  waiting: '◆',
  waitingBlink: '◇',
  unseen: '●',
  live: '●',
  idle: '○',
  ended: '·',
  select: '▌',
  tool: '▍',
  hot: '▲',
  member: '├─ ',
  memberLast: '└─ ',
  event: '•',
  cursor: '▏',
  pin: '★',
};

const SAFE = {
  edge: {
    normal: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
    heavy: { tl: '#', tr: '#', bl: '#', br: '#', h: '=', v: '#' },
  },
  rule: '-',
  // 색이 없어도 채운 칸과 빈칸이 모양으로 갈리게 한다.
  bar: { fill: '#', empty: NO_COLOR ? '.' : '#' },
  week: '_.:-=+*#',
  progress: { l: '[', r: ']', fill: '#', empty: '.' },
  waiting: '!',
  waitingBlink: '.',
  unseen: '*',
  live: '*',
  idle: 'o',
  ended: '.',
  select: '>',
  tool: '|',
  hot: '^',
  member: '|- ',
  memberLast: '`- ',
  event: '*',
  cursor: '|',
  pin: '*',
};

export const glyphs = () => (ambiguousWide() ? SAFE : NORMAL);

// 도움말 범례처럼 기본 기호로 적어 둔 글을 지금 기호로 바꾼다.
const SWAP = { '◆': 'waiting', '●': 'unseen', '○': 'idle', '·': 'ended', '★': 'pin' };
export const legendMark = (t) => (SWAP[t] ? glyphs()[SWAP[t]] : t);
