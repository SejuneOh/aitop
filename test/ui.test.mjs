import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';

process.env.NO_COLOR = '1';
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const session = (i, status = 'idle') => ({
  tool: 'claude',
  id: `s${i}`,
  name: `session-${i}`,
  project: 'demo',
  model: 'claude-opus-5-5',
  live: true,
  status,
  phase: { kind: status === 'waiting' ? 'waiting' : 'idle', text: status === 'waiting' ? '응답 대기' : '다음 지시 대기' },
  updatedAt: Date.now(),
  tokens: { total: 1000 },
  cost: 1,
  context: { used: 0, window: 200_000 },
  events: [],
  members: [],
});

const view = (sessions, extra = {}) => ({ data: { sessions, errors: [], at: Date.now() }, selectedId: sessions[0]?.id, showDetail: true, showEnded: false, frame: 0, ...extra });

test('표가 다 들어가지 않으면 가려진 세션 수를 정확히 알린다', () => {
  const sessions = Array.from({ length: 12 }, (_, i) => session(i));
  const lines = render(view(sessions), 120, 24).map(strip);
  const shown = lines.filter((l) => /session-\d+/.test(l) && !l.startsWith('╭')).length;
  const note = lines.find((l) => l.includes('… +'));
  assert.ok(note, '가려진 세션 안내 줄이 있어야 한다');
  assert.equal(Number(note.match(/\+(\d+) 세션/)[1]), 12 - shown);
});

test('다 들어가면 안내 줄이 없다', () => {
  const lines = render(view([session(0), session(1)]), 120, 40).map(strip);
  assert.ok(!lines.some((l) => l.includes('… +')));
});

test('헤더의 응답 대기 수와 응답 대기 행 수가 같고, 가려진 대기 세션도 알린다', () => {
  const sessions = [session(0, 'waiting'), session(1, 'waiting'), ...Array.from({ length: 10 }, (_, i) => session(i + 2))];
  const lines = render(view(sessions, { selectedId: 's11' }), 120, 24).map(strip);
  assert.match(lines[0], /2 응답 대기/);
  const visibleWaiting = lines.filter((l) => /session-\d+ .*응답 대기/.test(l)).length;
  const note = lines.find((l) => l.includes('… +'));
  const hiddenWaiting = Number(note?.match(/응답 대기 (\d+)/)?.[1] ?? 0);
  assert.equal(visibleWaiting + hiddenWaiting, 2);
});

test('IDLE 열: 작업 중이면 now, 쉬고 있으면 경과 시간', () => {
  const busy = { ...session(0, 'busy'), phase: { kind: 'think' } };
  const idle = { ...session(1), updatedAt: Date.now() - 5 * 60_000 };
  const lines = render(view([busy, idle], { showDetail: false }), 140, 12).map(strip);
  assert.match(lines[3], /IDLE\s*$/);
  assert.match(lines.find((l) => l.includes('session-0')), /now\s*$/);
  assert.match(lines.find((l) => l.includes('session-1')), /5m\s*$/);
});
