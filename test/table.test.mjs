import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, PALETTE } from '../src/ui.mjs';
import { width } from '../src/text.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-10-30T05:00:00Z');
const mk = (id, cost) => ({ tool: 'claude', id, name: `세션-${id}`, cwd: '/w', status: 'idle', live: true, phase: { kind: 'idle', text: '다음 지시 대기' }, updatedAt: at, tokens: { total: 1000 }, cost, context: {}, members: [], events: [] });
const sessions = [mk('a', 12.5), mk('b', 2103), mk('c', 99.77), mk('d', 865)];
const view = { data: { sessions, usage: null, errors: [], at }, selectedId: 'a', showDetail: true, frame: 0 };

test('높이 30줄 이상이면 세션 표를 상자로 감싸고, 그보다 작으면 감싸지 않는다', () => {
  for (const [W, H] of [[140, 30], [100, 40], [80, 30]]) {
    const lines = render(view, W, H).map(strip);
    assert.match(lines[2], /^╭─ 세션 4 ─+╮$/, `${W}x${H}`);
    assert.ok(lines.every((l) => width(l) <= W), `${W}x${H} 폭`);
    assert.ok(lines.some((l) => /^│ .*세션-b.*│$/.test(l)), '행은 상자 안에 있다');
  }
  const small = render(view, 140, 24).map(strip);
  assert.ok(!small.slice(0, 4).some((l) => l.startsWith('╭')));
  assert.ok(small.every((l) => width(l) <= 140));
});

test('비용 색은 화면에서 가장 큰 금액 두 개에만 칠한다', () => {
  const raw = render(view, 140, 24);
  const money = `38;2;${[1, 3, 5].map((i) => parseInt(PALETTE.money.slice(i, i + 2), 16)).join(';')}m`;
  const colored = raw.filter((l) => l.includes(money) && /세션-/.test(strip(l))).map((l) => strip(l).match(/세션-(\w)/)[1]).sort();
  assert.deepEqual(colored, ['b', 'd']);
});

test('낮은 화면에서도 보이는 세션 행과 … +N 을 더하면 전체 세션 수가 되고, 고른 세션은 보인다', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => mk(id, 1));
  for (const selectedId of ['a', 'e']) {
    for (let H = 10; H <= 24; H++) {
      const lines = render({ ...view, data: { ...view.data, sessions: five }, selectedId }, 100, H).map(strip);
      const rows = lines.filter((l) => / claude  세션-/.test(l));
      const more = lines.map((l) => l.match(/… \+(\d+) 세션/)).find(Boolean);
      assert.equal(rows.length + (more ? Number(more[1]) : 0), five.length, `H=${H} ${selectedId}`);
      assert.ok(rows.some((l) => l.startsWith('▌') && l.includes(`세션-${selectedId}`)), `H=${H} 고른 세션`);
      assert.ok(lines.length <= H, `H=${H} 높이`);
    }
  }
});
