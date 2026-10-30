#!/usr/bin/env node
import { collect } from '../src/collect.mjs';
import { render, filterSessions } from '../src/ui.mjs';
import { flushCache } from '../src/cache.mjs';
import { toJson } from '../src/json.mjs';
import { createAttention, updateAttention, markSeen, nextAttention } from '../src/attention.mjs';
import { onKey, fixFocus } from '../src/keys.mjs';

const args = new Set(process.argv.slice(2));
if (args.has('-h') || args.has('--help')) {
  console.log(`aitop - 터미널에서 Claude Code · Codex · Gemini 세션을 실시간으로 본다

  aitop            실시간 화면
  aitop --once     현재 상태를 한 번 출력하고 끝낸다
  aitop --all      종료된 세션(24시간 이내)도 함께 본다
  aitop --json     세션 목록과 사용량 합계를 JSON 으로 한 번 출력한다 (--all 과 함께 쓸 수 있다)

  키: / 검색 · ↑↓/jk 선택 · n 다음 볼 세션 · f 변경 파일 · d 상세 · e 종료 세션 토글 · Esc 뒤로 · ? 도움말 · q 나가기`);
  process.exit(0);
}

const view = { data: null, selectedId: null, showDetail: true, showEnded: args.has('--all'), frame: 0, filter: '', searching: false, help: false, focus: null, filePath: null, diffScroll: 0, tab: 'now' };
const once = args.has('--once') || args.has('--json') || !process.stdout.isTTY;
// 실시간 화면에서 한 번 갱신할 때 읽는 기록 양. 큰 기록은 여러 번에 나눠 읽어서 키 입력이 막히지 않게 한다.
const TICK_BUDGET = 24 * 1024 * 1024;

const attention = createAttention();

function refresh() {
  const data = collect({ showEnded: view.showEnded, selectedId: view.selectedId, budgetBytes: once ? Infinity : TICK_BUDGET });
  if (!data.sessions.some((s) => s.id === view.selectedId)) {
    view.selectedId = data.sessions[0]?.id ?? null;
    view.focus = null;
  }
  updateAttention(attention, data.sessions, view.selectedId);
  data.sessions = data.sessions.map((s) => (attention.unseen.has(s.id) ? { ...s, unseen: true, phase: { kind: 'unseen', text: '완료 · 확인 전' }, plain: s } : s));
  view.data = data;
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
  if (args.has('--json')) {
    process.stdout.write(JSON.stringify(toJson(view.data), null, 2) + '\n');
    process.exit(0);
  }
  const W = process.stdout.columns || 140;
  const H = process.stdout.rows || 40;
  process.stdout.write(render(view, W, H).join('\n') + '\n');
  process.exit(0);
}

const out = process.stdout;
const stdin = process.stdin;
let last = '';

function draw() {
  const frame = render(view, out.columns, out.rows).join('\r\n');
  if (frame === last) return;
  last = frame;
  out.write('\x1b[?2026h\x1b[H' + frame + '\x1b[?2026l');
}

function enterScreen() {
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  stdin.setRawMode(true);
  stdin.resume();
  last = '';
}

function leaveScreen() {
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
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
