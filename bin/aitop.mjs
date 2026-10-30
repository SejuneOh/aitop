#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { collect } from '../src/collect.mjs';
import { render } from '../src/ui.mjs';
import { flushCache } from '../src/cache.mjs';

const args = new Set(process.argv.slice(2));
if (args.has('-h') || args.has('--help')) {
  console.log(`aitop - 터미널에서 Claude Code · Codex · Gemini 세션을 실시간으로 본다

  aitop            실시간 화면
  aitop --once     현재 상태를 한 번 출력하고 끝낸다
  aitop --all      종료된 세션(24시간 이내)도 함께 본다

  키: ↑↓/jk 선택 · Enter 세션 열기 · d 상세 · e 종료 세션 토글 · q 나가기`);
  process.exit(0);
}

const view = { data: null, selectedId: null, showDetail: true, showEnded: args.has('--all'), frame: 0, toast: null };
const once = args.has('--once') || !process.stdout.isTTY;
// 실시간 화면에서 한 번 갱신할 때 읽는 기록 양. 큰 기록은 여러 번에 나눠 읽어서 키 입력이 막히지 않게 한다.
const TICK_BUDGET = 24 * 1024 * 1024;

function refresh() {
  view.data = collect({ showEnded: view.showEnded, selectedId: view.selectedId, budgetBytes: once ? Infinity : TICK_BUDGET });
  if (!view.data.sessions.some((s) => s.id === view.selectedId)) view.selectedId = view.data.sessions[0]?.id ?? null;
}

if (once) {
  refresh();
  flushCache();
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

function toast(text, error = false) {
  view.toast = { text, error, until: Date.now() + 3000 };
}

// 백그라운드 세션을 이 터미널에서 연다. claude attach 가 끝나면(← 또는 Ctrl+Z) 다시 aitop 화면으로 돌아온다.
function openSession() {
  const s = view.data?.sessions.find((x) => x.id === view.selectedId);
  if (!s) return;
  if (!s.attachId) {
    toast(s.tool !== 'claude' ? `${s.tool} 세션은 아직 열기를 지원하지 않습니다` : '다른 터미널에서 실행 중인 세션이라 여기서 열 수 없습니다', true);
    return;
  }
  leaveScreen();
  stdin.pause();
  out.write(`\n  aitop → "${s.name}" 세션을 엽니다. 세션은 계속 돌고, 나오면 aitop 으로 돌아옵니다.\n\n`);
  const r = spawnSync('claude', ['attach', s.attachId], { stdio: 'inherit' });
  enterScreen();
  if (r.error) toast(`열기 실패: ${r.error.message}`, true);
  else if (r.status) toast(`열기 실패: claude attach 가 종료 코드 ${r.status} 로 끝났습니다`, true);
  else if (r.signal) toast(`열기 중단: ${r.signal}`, true);
  refresh();
  draw();
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

function move(delta) {
  const list = view.data?.sessions ?? [];
  if (!list.length) return;
  const i = Math.max(0, list.findIndex((s) => s.id === view.selectedId));
  const next = list[Math.min(list.length - 1, Math.max(0, i + delta))];
  view.selectedId = next.id;
  // 아직 본문을 읽지 않은 종료 세션을 고르면 다음 갱신을 기다리지 않고 바로 읽는다.
  if (next.lazy) refresh();
}

stdin.setEncoding('utf8');
stdin.on('data', (key) => {
  if (key === 'q' || key === '\x03' || key === '\x1b') return quit();
  if (key === '\x1b[A' || key === 'k') move(-1);
  else if (key === '\x1b[B' || key === 'j') move(1);
  else if (key === '\r') return openSession();
  else if (key === 'd') view.showDetail = !view.showDetail;
  else if (key === 'e') {
    view.showEnded = !view.showEnded;
    refresh();
  }
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
