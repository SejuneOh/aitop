#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { BRAND, userVarsSeq } from '../src/brand.mjs';
import { notifyOptions } from '../src/notify.mjs';

const HELP = `${BRAND.logo} aitop - 터미널에서 Claude Code · Codex · Antigravity · Gemini 세션을 실시간으로 본다

  aitop            실시간 화면
  aitop --once     현재 상태를 한 번 출력하고 끝낸다
  aitop --all      종료된 세션(24시간 이내)도 함께 본다
  aitop --json     세션 목록과 사용량 합계를 JSON 으로 한 번 출력한다 (--all 과 함께 쓸 수 있다)
  aitop --doctor   Claude · Codex · Antigravity · Gemini 기록과 실행 중인 프로세스를 찾는지 점검한다 (--json 과 함께 쓸 수 있다)
  aitop --bell     응답 대기 세션이 새로 생기면 터미널 벨을 울린다
  aitop --notify   응답 대기 세션이 새로 생기면 데스크톱 알림을 띄운다 (notify-send · osascript, 없으면 건너뜀)
  aitop --on-waiting <명령>  응답 대기 세션이 새로 생기면 /bin/sh -c 로 명령을 실행한다 (내 권한으로 실행, 10초 제한)
                   세션 정보는 환경변수로만: AITOP_TOOL AITOP_PROJECT AITOP_SESSION_ID AITOP_CWD AITOP_WAITING_FOR
  aitop --show-requests  응답 대기 요청 전체를 상세 패널·--json 에 보인다 (AITOP_SHOW_REQUESTS=1). 비밀값 가림은 최선일 뿐이라 명령 속 비밀값이 보일 수 있다
  aitop --theme light|dark  밝은 배경 / 어두운 배경 색 (없으면 COLORFGBG 로 고른다)
  aitop --version  설치된 버전을 보인다

  AITOP_ICONS=plain  창 제목의 Nerd Font 아이콘과 WezTerm 탭 값을 끈다 (ascii 면 로고도 ASCII)

  키: / 검색 · ↑↓/jk 선택 · n 다음 볼 세션 · s 정렬 · g 묶기 · f 변경 파일 · d 상세 · e 종료 세션 토글 · Esc 뒤로 · ? 도움말 · q 나가기`;
const KNOWN = new Set(['-h', '--help', '-v', '--version', '--once', '--all', '--json', '--doctor', '--bell', '--show-requests']);
const THEMES = ['light', 'dark'];
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// --notify, --on-waiting 은 notifyOptions 한 곳에서 해석한다.
const alerts = notifyOptions(process.argv.slice(2));
if (alerts.error) {
  process.stderr.write(`aitop: ${alerts.error}\n`);
  process.exit(2);
}
// --theme light, --theme=light 처럼 값을 받는 옵션은 따로 꺼낸다.
const argv = alerts.rest;
let theme = null;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const m = /^--theme(?:=(.*))?$/.exec(argv[i]);
  if (!m) rest.push(argv[i]);
  else theme = m[1] ?? (argv[i + 1]?.startsWith('-') ? '' : (argv[++i] ?? ''));
}
if (theme === '') {
  process.stderr.write(`aitop: --theme 값이 없습니다 (light 또는 dark)\n`);
  process.exit(2);
}
const args = new Set(rest);
const unknown = [...args].filter((a) => !KNOWN.has(a));
if (theme != null && !THEMES.includes(theme)) unknown.push(`--theme ${theme}`);
if (unknown.length) {
  process.stderr.write(`aitop: 모르는 옵션 ${unknown.join(' ')}\n\n${HELP}\n`);
  process.exit(2);
}
// 화면 모듈이 불러올 때 테마를 고르므로 그 전에 넘긴다.
if (theme) process.env.AITOP_THEME = theme;
if (args.has('-h') || args.has('--help')) {
  console.log(HELP);
  process.exit(0);
}
if (args.has('-v') || args.has('--version')) {
  console.log(VERSION);
  process.exit(0);
}

// 파이프나 파일로 받을 때는 색 코드를 넣지 않는다. 화면 모듈이 불러올 때 NO_COLOR 를 읽으므로 그 전에 정한다.
const forced = process.env.FORCE_COLOR != null && !['', '0', 'false'].includes(process.env.FORCE_COLOR);
if (!process.stdout.isTTY && !forced && !process.env.NO_COLOR) process.env.NO_COLOR = '1';

// 받는 쪽(| head 등)이 먼저 닫으면 조용히 끝낸다.
process.stdout.on('error', (err) => process.exit(err.code === 'EPIPE' ? 0 : 1));
// 다 쓴 뒤에 끝낸다 (파이프로 넘길 때 64KB 넘는 출력이 잘리지 않게).
const printAndExit = async (text) => {
  await new Promise((resolve) => process.stdout.write(text + '\n', resolve));
  process.exit(0);
};

// 알림은 실시간 화면에서만 동작한다.
if ((alerts.notify || alerts.onWaiting) && (args.has('--once') || args.has('--json') || args.has('--doctor') || !process.stdout.isTTY)) {
  process.stderr.write('aitop: --notify, --on-waiting 은 실시간 화면에서만 동작한다 (--once·--json·--doctor·파이프 출력에서는 무시)\n');
}

const { checkTools, doctorText, toolsJson } = await import('../src/doctor.mjs');
if (args.has('--doctor')) {
  const result = checkTools();
  await printAndExit(args.has('--json') ? JSON.stringify({ version: VERSION, ...result, tools: toolsJson(result.tools) }, null, 2) : doctorText(result, VERSION));
}

const { collect } = await import('../src/collect.mjs');
const { render, filterSessions, animating } = await import('../src/ui.mjs');
const { arrange } = await import('../src/order.mjs');
const { frameTimer } = await import('../src/frames.mjs');
const { flushCache } = await import('../src/cache.mjs');
const { toJson } = await import('../src/json.mjs');
const { createAttention, updateAttention, markSeen, nextAttention, windowTitle, createWaitWatch, takeNewlyWaiting, attentionCounts } = await import('../src/attention.mjs');
const { createNotifier } = await import('../src/notify.mjs');
const { onKey, fixFocus } = await import('../src/keys.mjs');

// 요청 전체 보기는 기본으로 꺼 둔다. 켜지 않으면 상세 패널에도 --json 에도 나가지 않는다.
const showRequests = args.has('--show-requests') || process.env.AITOP_SHOW_REQUESTS === '1';
const view = { showRequests, data: null, selectedId: null, showDetail: 'auto', showEnded: args.has('--all'), frame: 0, filter: '', searching: false, help: false, focus: null, filePath: null, diffScroll: 0, tab: 'now', costMode: 'api', sort: 'default', group: 'none' };
const once = args.has('--once') || args.has('--json') || !process.stdout.isTTY;
// 실시간 화면에서 한 번 갱신할 때 읽는 기록 양과 시간. 큰 기록은 여러 번에 나눠 읽어서 키 입력이 막히지 않게 한다.
const TICK_BUDGET = 24 * 1024 * 1024;
const TICK_MS = 60;
// 덜 읽은 기록이 있으면 1초를 기다리지 않고 이만큼 쉰 뒤 이어 읽는다 (그 사이 키 입력과 그리기가 돈다).
const CATCH_UP_MS = 15;
// 처음 읽는 동안은 캐시를 자주 저장해, 도중에 끝내도 읽은 만큼은 남게 한다.
const LOADING_FLUSH_MS = 3000;

const attention = createAttention();
let tools = null;
// --bell · --notify · --on-waiting: 실시간 화면에서만, 첫 갱신에서 이미 응답 대기인 세션은 알리지 않는다.
const bell = args.has('--bell');
const waitWatch = createWaitWatch();
const notifier = !once && (alerts.notify || alerts.onWaiting) ? createNotifier(alerts) : null;

function refresh() {
  const data = collect({ showEnded: view.showEnded, selectedId: view.selectedId, budgetBytes: once ? Infinity : TICK_BUDGET, budgetMs: once ? Infinity : TICK_MS });
  if (!data.sessions.some((s) => s.id === view.selectedId)) {
    view.selectedId = arrange(data.sessions, view).sessions[0]?.id ?? null;
    view.focus = null;
    view.tab = 'now';
  }
  updateAttention(attention, data.sessions, view.selectedId);
  data.sessions = data.sessions.map((s) => (attention.unseen.has(s.id) ? { ...s, unseen: true, phase: { kind: 'unseen', text: '완료 · 확인 전' }, plain: s } : s));
  // 도구별 점검은 기록 폴더를 훑으므로 30초에 한 번만 한다.
  if (!tools || Date.now() - tools.at > 30_000) tools = { at: Date.now(), result: checkTools() };
  data.tools = tools.result;
  view.data = data;
  if (!once && (bell || notifier)) {
    const fresh = takeNewlyWaiting(waitWatch, data.sessions);
    if (fresh.length && bell) process.stdout.write('\x07');
    notifier?.fire(fresh);
  }
  if (view.filter) keepSelectionVisible();
  fixFocus(view);
}

function select(id) {
  if (id !== view.selectedId) {
    view.focus = null;
    view.tab = 'now';
  }
  view.selectedId = id;
  markSeen(attention, id);
}

if (once) {
  refresh();
  flushCache();
  const size = (v) => (Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const W = process.stdout.columns || size(process.env.COLUMNS) || 140;
  const H = process.stdout.rows || size(process.env.LINES) || 40;
  await printAndExit(args.has('--json') ? JSON.stringify(toJson(view.data, VERSION, { showRequests }), null, 2) : render(view, W, H).join('\n'));
}

const out = process.stdout;
const stdin = process.stdin;
let last = '';
let lastTitle = '';
// 스피너처럼 움직이는 표시가 있을 때만 120ms 마다 다시 그린다. 없으면 데이터 갱신·키 입력·창 크기 변경 때만 그린다.
const frames = frameTimer({
  ms: 120,
  animating: () => animating(view),
  onFrame: () => {
    view.frame++;
    draw();
  },
});

function draw() {
  frames.sync();
  view.rows = out.rows;
  const frame = render(view, out.columns, out.rows).join('\r\n');
  const title = windowTitle(view.data?.sessions ?? [], BRAND.tab);
  if (title !== lastTitle) {
    lastTitle = title;
    out.write(`\x1b]0;${title}\x07`);
    // WezTerm 탭 제목에서 읽을 수 있게 같은 수를 user var 로도 내보낸다.
    if (BRAND.userVars) out.write(userVarsSeq(attentionCounts(view.data?.sessions ?? [])));
  }
  if (frame === last) return;
  last = frame;
  out.write('\x1b[?2026h\x1b[H' + frame + '\x1b[?2026l');
}

function enterScreen() {
  // 창 제목을 저장해 두었다가 끝낼 때 되돌린다 (지원하지 않는 터미널은 무시한다).
  out.write('\x1b[22;0t\x1b[?1049h\x1b[?25l\x1b[2J');
  lastTitle = '';
  stdin.setRawMode(true);
  stdin.resume();
  last = '';
}

function leaveScreen() {
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l\x1b[23;0t' + (BRAND.userVars ? userVarsSeq(null) : ''));
  if (stdin.isTTY) stdin.setRawMode(false);
}

function quit() {
  notifier?.killAll();
  leaveScreen();
  flushCache();
  process.exit(0);
}

enterScreen();
draw();
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('SIGHUP', quit);
process.on('SIGQUIT', quit);
process.on('SIGCONT', () => {
  enterScreen();
  draw();
});
process.on('uncaughtException', (err) => {
  notifier?.killAll();
  leaveScreen();
  try {
    flushCache();
  } catch {}
  console.error(err);
  process.exit(1);
});
out.on('resize', () => {
  last = '';
  out.write('\x1b[2J');
  draw();
});

// 화면에 그린 순서 그대로 (정렬·묶기 반영). ↑↓ 와 n 이 이 순서를 따른다.
const visible = () => arrange(filterSessions(view.data?.sessions ?? [], view.filter), view).sessions;

function move(delta) {
  const list = visible();
  if (!list.length) return;
  const i = Math.max(0, list.findIndex((s) => s.id === view.selectedId));
  goTo(list[Math.min(list.length - 1, Math.max(0, i + delta))]);
}

function goTo(next) {
  if (!next) return;
  select(next.id);
  // 아직 본문을 읽지 않은 종료 세션을 고르면 다음 갱신을 기다리지 않고 바로 읽는다. 그 밖에는 전체 갱신 없이 화면만 바꾼다.
  if (next.lazy) return refresh();
  if (next.unseen) view.data.sessions = view.data.sessions.map((s) => (s.id === next.id ? s.plain : s));
}

function keepSelectionVisible() {
  const list = visible();
  if (list.length && !list.some((s) => s.id === view.selectedId)) select(list[0].id);
}

stdin.setEncoding('utf8');
const act = {
  quit,
  refresh,
  move,
  next: () => goTo(nextAttention(attention, visible(), view.selectedId)),
  keepVisible: keepSelectionVisible,
};

stdin.on('data', (key) => {
  onKey(view, key, act);
  draw();
});

let lastFlush = 0;
function tick() {
  refresh();
  const more = view.data?.more;
  if (more ? Date.now() - lastFlush > LOADING_FLUSH_MS : Date.now() - lastFlush > 15_000) {
    flushCache();
    lastFlush = Date.now();
  }
  draw();
  setTimeout(tick, more ? CATCH_UP_MS : 1000);
}

setTimeout(tick, 30);
