#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const HELP = `aitop - 터미널에서 Claude Code · Codex · Gemini 세션을 실시간으로 본다

  aitop            실시간 화면
  aitop --once     현재 상태를 한 번 출력하고 끝낸다
  aitop --all      종료된 세션(24시간 이내)도 함께 본다
  aitop --json     세션 목록과 사용량 합계를 JSON 으로 한 번 출력한다 (--all 과 함께 쓸 수 있다)
  aitop --doctor   Claude · Codex · Gemini 기록과 실행 중인 프로세스를 찾는지 점검한다 (--json 과 함께 쓸 수 있다)
  aitop --bell     응답 대기 세션이 새로 생기면 터미널 벨을 울린다
  aitop --version  설치된 버전을 보인다

  키: / 검색 · ↑↓/jk 선택 · n 다음 볼 세션 · f 변경 파일 · d 상세 · e 종료 세션 토글 · Esc 뒤로 · ? 도움말 · q 나가기`;
const KNOWN = new Set(['-h', '--help', '-v', '--version', '--once', '--all', '--json', '--doctor', '--bell']);
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => !KNOWN.has(a));
if (unknown.length) {
  process.stderr.write(`aitop: 모르는 옵션 ${unknown.join(' ')}\n\n${HELP}\n`);
  process.exit(2);
}
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

const { checkTools, doctorText, toolsJson } = await import('../src/doctor.mjs');
if (args.has('--doctor')) {
  const result = checkTools();
  await printAndExit(args.has('--json') ? JSON.stringify({ version: VERSION, ...result, tools: toolsJson(result.tools) }, null, 2) : doctorText(result, VERSION));
}

const { collect } = await import('../src/collect.mjs');
const { render, filterSessions } = await import('../src/ui.mjs');
const { flushCache } = await import('../src/cache.mjs');
const { toJson } = await import('../src/json.mjs');
const { createAttention, updateAttention, markSeen, nextAttention, windowTitle, newlyWaiting } = await import('../src/attention.mjs');
const { onKey, fixFocus } = await import('../src/keys.mjs');

const view = { data: null, selectedId: null, showDetail: true, showEnded: args.has('--all'), frame: 0, filter: '', searching: false, help: false, focus: null, filePath: null, diffScroll: 0, tab: 'now' };
const once = args.has('--once') || args.has('--json') || !process.stdout.isTTY;
// 실시간 화면에서 한 번 갱신할 때 읽는 기록 양. 큰 기록은 여러 번에 나눠 읽어서 키 입력이 막히지 않게 한다.
const TICK_BUDGET = 24 * 1024 * 1024;

const attention = createAttention();
let tools = null;
// --bell: 첫 갱신에서 이미 응답 대기인 세션에는 울리지 않는다.
const waitingSeen = new Set();
let bellReady = false;

function refresh() {
  const data = collect({ showEnded: view.showEnded, selectedId: view.selectedId, budgetBytes: once ? Infinity : TICK_BUDGET });
  if (!data.sessions.some((s) => s.id === view.selectedId)) {
    view.selectedId = data.sessions[0]?.id ?? null;
    view.focus = null;
    view.tab = 'now';
  }
  updateAttention(attention, data.sessions, view.selectedId);
  data.sessions = data.sessions.map((s) => (attention.unseen.has(s.id) ? { ...s, unseen: true, phase: { kind: 'unseen', text: '완료 · 확인 전' }, plain: s } : s));
  // 도구별 점검은 기록 폴더를 훑으므로 30초에 한 번만 한다.
  if (!tools || Date.now() - tools.at > 30_000) tools = { at: Date.now(), result: checkTools() };
  data.tools = tools.result;
  view.data = data;
  if (!once && args.has('--bell')) {
    if (newlyWaiting(waitingSeen, data.sessions) && bellReady) process.stdout.write('\x07');
    bellReady = true;
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
  await printAndExit(args.has('--json') ? JSON.stringify(toJson(view.data, VERSION), null, 2) : render(view, W, H).join('\n'));
}

const out = process.stdout;
const stdin = process.stdin;
let last = '';
let lastTitle = '';

function draw() {
  const frame = render(view, out.columns, out.rows).join('\r\n');
  const title = windowTitle(view.data?.sessions ?? []);
  if (title !== lastTitle) {
    lastTitle = title;
    out.write(`\x1b]0;${title}\x07`);
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
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l\x1b[23;0t');
  if (stdin.isTTY) stdin.setRawMode(false);
}

function quit() {
  leaveScreen();
  flushCache();
  process.exit(0);
}

enterScreen();
draw();
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('SIGCONT', () => {
  enterScreen();
  draw();
});
process.on('uncaughtException', (err) => {
  leaveScreen();
  console.error(err);
  process.exit(1);
});
out.on('resize', () => {
  last = '';
  out.write('\x1b[2J');
  draw();
});

const visible = () => filterSessions(view.data?.sessions ?? [], view.filter);

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

setTimeout(() => {
  refresh();
  flushCache();
  draw();
  setInterval(refresh, 1000);
  setInterval(flushCache, 15_000);
  setInterval(() => {
    view.frame++;
    draw();
  }, 120);
}, 30);
