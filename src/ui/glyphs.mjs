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
  // 상태 기호. 색이 없거나(NO_COLOR) 색약 팔레트여도 모양만으로 갈리도록 서로 겹치지 않게 둔다 (test/glyphs.test.mjs).
  waiting: '◆',
  waitingBlink: '◇',
  unseen: '●',
  // 상태를 모르는 실행 중 세션(Gemini 프로세스만 보임). 확인 전 ● 와 겹치지 않게 반쯤 찬 원.
  live: '◐',
  idle: '○',
  ended: '·',
  // 오류로 멈춤: 돌지 않는 ! 로 작업 중(스피너)과 구분한다.
  stopped: '!',
  done: '✓',
  select: '▌',
  tool: '▍',
  hot: '▲',
  member: '├─ ',
  memberLast: '└─ ',
  // 호출 트리(--report trace)의 이어지는 가지, 묶음 수, 완료·실패 표시.
  memberPipe: '│  ',
  times: '×',
  traceDone: '✓',
  traceFail: '✗',
  traceRun: '●',
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
  // 상태 기호는 서로, 그리고 선택 > · 접힘 + - 와도 겹치지 않게 둔다.
  // 응답 대기는 묻는 ? 로, 멈춤은 기본 세트와 같은 ! 로 둔다. 색약 팔레트에서 둘 다 노랑 계열이라 기호로만 갈린다.
  // 응답 대기는 깜빡이지 않는다: 빈 모양으로 바뀌면 그 순간 다른 상태(. 종료)와 헷갈린다.
  waiting: '?',
  waitingBlink: '?',
  unseen: '*',
  live: '@',
  idle: 'o',
  ended: '.',
  stopped: '!',
  // 폭이 모호하지 않아(N) 그대로 둔다.
  done: '✓',
  select: '>',
  tool: '|',
  hot: '^',
  member: '|- ',
  memberLast: '`- ',
  memberPipe: '|  ',
  times: 'x',
  traceDone: '+',
  traceFail: 'x',
  traceRun: '*',
  event: '*',
  cursor: '|',
  // 확인 전 * 와 겹치지 않게.
  pin: '#',
};

export const glyphs = () => (ambiguousWide() ? SAFE : NORMAL);

// 도움말 범례처럼 기본 기호로 적어 둔 글을 지금 기호로 바꾼다.
const SWAP = { '◆': 'waiting', '●': 'unseen', '◐': 'live', '○': 'idle', '!': 'stopped', '✓': 'done', '·': 'ended', '★': 'pin' };

// 표의 상태 칸과 그 앞뒤에 서는 기호. 세트마다 서로 달라야 한다 (응답 대기 깜빡임은 응답 대기와 같아도 된다).
export const STATUS_KEYS = ['waiting', 'unseen', 'live', 'idle', 'stopped', 'done', 'ended', 'select', 'pin'];
export const glyphSets = () => ({ NORMAL, SAFE });
export const legendMark = (t) => (SWAP[t] ? glyphs()[SWAP[t]] : t);
