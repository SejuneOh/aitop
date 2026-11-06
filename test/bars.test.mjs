import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';
import { width } from '../src/text.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-10-30T05:00:00Z');
const s = { tool: 'claude', id: 's', name: 'demo', cwd: '/w', status: 'busy', live: true, phase: { kind: 'tool', text: '도구' }, updatedAt: at, tokens: { total: 1_200_000 }, context: {}, members: [], events: [], files: [{ path: '/w/a.mjs', edits: 1, add: 1, del: 0, at, hunks: [], log: [{ at, add: 1, del: 0 }] }], turns: [] };
const usage = { today: { cost: 51.96, tokens: 132_000_000 }, week: { cost: 644.1, tokens: 1_200_000_000 }, loading: null };
const screen = (W, extra = {}) => render({ data: { sessions: [s], usage, errors: [], at }, selectedId: 's', showDetail: true, frame: 0, ...extra }, W, 30).map(strip);

test('헤더는 상태 이름을 먼저 줄이고, 그래도 모자라면 토큰 수, 7일, 오늘 순으로 줄이며 넘치지 않는다', () => {
  const head = (W) => screen(W)[0];
  assert.match(head(160), /1 작업 중 .*오늘 \$51\.96 132M · 7일 \$644 1\.20B · \d\d:\d\d:\d\d/);
  assert.match(head(70), /1 작업 .*오늘 \$51\.96 132M · 7일 \$644 1\.20B/, '이름을 줄여 숫자를 지킨다');
  assert.match(head(68), /오늘 \$51\.96 · 7일 \$644 · \d\d:\d\d:\d\d/);
  assert.doesNotMatch(head(68), /132M/);
  assert.match(head(58), /오늘 \$51\.96 · \d\d:\d\d:\d\d/);
  assert.doesNotMatch(head(58), /7일/);
  for (const W of [40, 50, 60, 68, 70, 80, 84, 90, 94, 100, 115, 140, 160]) assert.ok(width(head(W)) <= W, `${W}`);
});

test('세션이 없는 도구는 이름만 보인다', () => {
  const strip2 = screen(140)[1];
  assert.match(strip2, /▍claude 1 · 1\.2M +codex +gemini/);
  assert.doesNotMatch(strip2, /0 세션/);
});

test('종료 세션을 볼 때는 실행 중인 세션이 없는 도구도 누적 토큰을 흐리게 보인다', () => {
  const ended = { ...s, id: 'x', tool: 'codex', live: false, status: 'ended', tokens: { total: 4_200_000 } };
  const lines = render({ data: { sessions: [s, ended], usage, errors: [], at }, selectedId: 's', showDetail: false, showEnded: true, frame: 0 }, 140, 30).map(strip);
  assert.match(lines[1], /codex · 4\.2M/);
});

test('비용이 없는 세션은 비용 대신 컨텍스트 구획 제목을 쓴다', () => {
  const g = { ...s, tool: 'gemini', cost: null, context: { used: 10, window: 100 } };
  const lines = render({ data: { sessions: [g], usage, errors: [], at }, selectedId: 's', showDetail: true, frame: 0 }, 140, 40).map(strip);
  assert.ok(lines.some((l) => l.includes('── 컨텍스트 ─')));
  assert.ok(!lines.some((l) => l.includes('── 비용 ─')));
});

test('키 안내는 폭이 모자라면 오른쪽부터 빼고 ? 와 q 는 남긴다', () => {
  for (const W of [60, 80, 120, 140]) {
    const foot = screen(W).at(-1);
    assert.ok(width(foot) <= W, `${W} 폭`);
    assert.match(foot, /\?\s+도움\s+q\s+나가기/, `${W}`);
  }
  assert.match(screen(140).at(-1), /f\s+파일.*⊘ 읽기전용/);
  assert.doesNotMatch(screen(60).at(-1), /종료 포함/);
});

test('파일 목록·diff 에서도 Esc 와 ? q 는 남는다', () => {
  for (const focus of ['files', 'diff']) {
    const foot = screen(60, { focus, filePath: '/w/a.mjs', tab: 'all' }).at(-1);
    assert.match(foot, /Esc.*\?\s+도움\s+q\s+나가기/, focus);
  }
});
