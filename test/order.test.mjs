import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bySession } from '../src/collect.mjs';
import { render } from '../src/ui.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-11-06T05:00:00Z');
const sess = (id, status, startedAt, updatedAt, extra = {}) => ({ tool: 'claude', id, name: id, cwd: '/w', status, live: true, phase: { kind: 'idle' }, startedAt, updatedAt, tokens: { total: 1000 }, cost: 1, context: {}, members: [], events: [], ...extra });

// 갱신 두 번: 같은 세션인데 두 번째에는 updatedAt 순서가 뒤집힌다.
const first = () => [sess('old', 'idle', at - 3000, at - 10), sess('new', 'idle', at - 1000, at - 500), sess('w', 'waiting', at - 2000, at - 900), sess('b1', 'busy', at - 5000, at - 1), sess('b2', 'busy', at - 4000, at - 2000)];
const second = () => [sess('old', 'idle', at - 3000, at - 5000), sess('new', 'idle', at - 1000, at), sess('w', 'waiting', at - 2000, at), sess('b1', 'busy', at - 5000, at - 3000), sess('b2', 'busy', at - 4000, at)];
const ids = (list) => list.sort(bySession).map((s) => s.id);

test('같은 상태 안의 순서는 updatedAt 이 바뀌어도 그대로다', () => {
  assert.deepEqual(ids(first()), ['w', 'b2', 'b1', 'new', 'old'], '상태 순서가 먼저, 같은 상태는 늦게 시작한 세션이 위');
  assert.deepEqual(ids(second()), ids(first()));
});

test('시작 시각이 없으면 아래로 가고, 같으면 도구·id 순이다', () => {
  const list = [sess('z', 'live', null, at, { tool: 'gemini' }), sess('a', 'live', null, at - 1, { tool: 'gemini' }), sess('c', 'live', at, at, { tool: 'codex' }), sess('x', 'live', at, at, { tool: 'claude' })];
  assert.deepEqual(ids(list), ['x', 'c', 'a', 'z']);
});

test('순서가 그대로라 선택한 세션 행도 같은 자리에 남는다', () => {
  const row = (list) => {
    const lines = render({ data: { sessions: list.sort(bySession), usage: null, errors: [], at }, selectedId: 'old', showDetail: false, frame: 0 }, 120, 20).map(strip);
    return lines.findIndex((l) => / old /.test(l));
  };
  const before = row(first());
  assert.ok(before > 0);
  assert.equal(row(second()), before);
});
