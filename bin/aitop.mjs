#!/usr/bin/env node
import { collect } from '../src/collect.mjs';
import { render } from '../src/ui.mjs';

const args = new Set(process.argv.slice(2));
if (args.has('-h') || args.has('--help')) {
  console.log(`aitop - 터미널에서 Claude Code · Codex · Gemini 세션을 실시간으로 본다

  aitop            실시간 화면
  aitop --once     현재 상태를 한 번 출력하고 끝낸다
  aitop --all      종료된 세션(24시간 이내)도 함께 본다

  키: ↑↓/jk 선택 · Enter 상세 열기/닫기 · e 종료 세션 토글 · q 나가기`);
  process.exit(0);
}

const view = { data: null, selectedId: null, showDetail: true, showEnded: args.has('--all'), frame: 0 };

function refresh() {
  view.data = collect({ showEnded: view.showEnded });
  if (!view.data.sessions.some((s) => s.id === view.selectedId)) view.selectedId = view.data.sessions[0]?.id ?? null;
}

if (args.has('--once') || !process.stdout.isTTY) {
  refresh();
  const W = process.stdout.columns || 140;
  const H = process.stdout.rows || 40;
  process.stdout.write(render(view, W, H).join('\n') + '\n');
  process.exit(0);
}

const out = process.stdout;
let last = '';
function draw() {
  const frame = render(view, out.columns, out.rows).join('\r\n');
  if (frame === last) return;
  last = frame;
  out.write('\x1b[?2026h\x1b[H' + frame + '\x1b[?2026l');
}

function quit() {
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  process.exit(0);
}

out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
draw();
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('uncaughtException', (err) => {
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
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
  view.selectedId = list[Math.min(list.length - 1, Math.max(0, i + delta))].id;
}

process.stdin.on('data', (key) => {
  if (key === 'q' || key === '\x03' || key === '\x1b') return quit();
  if (key === '\x1b[A' || key === 'k') move(-1);
  else if (key === '\x1b[B' || key === 'j') move(1);
  else if (key === '\r') view.showDetail = !view.showDetail;
  else if (key === 'e') {
    view.showEnded = !view.showEnded;
    refresh();
  }
  draw();
});

setTimeout(() => {
  refresh();
  draw();
  setInterval(refresh, 1000);
  setInterval(() => {
    view.frame++;
    draw();
  }, 120);
}, 30);
