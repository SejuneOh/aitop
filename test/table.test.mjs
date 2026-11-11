import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, PALETTE } from '../src/ui.mjs';
import { width } from '../src/text.mjs';
import { readFileSync } from 'node:fs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-10-30T05:00:00Z');
const mk = (id, cost) => ({ tool: 'claude', id, name: `세션-${id}`, cwd: '/w', status: 'idle', live: true, phase: { kind: 'idle' }, updatedAt: at, tokens: { total: 1000 }, cost, context: {}, members: [], events: [] });
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
      const rows = lines.filter((l) => / claude  .*세션-/.test(l));
      const more = lines.map((l) => l.match(/… \+(\d+) 세션/)).find(Boolean);
      assert.equal(rows.length + (more ? Number(more[1]) : 0), five.length, `H=${H} ${selectedId}`);
      assert.ok(rows.some((l) => l.startsWith('▌') && l.includes(`세션-${selectedId}`)), `H=${H} 고른 세션`);
      assert.ok(lines.length <= H, `H=${H} 높이`);
    }
  }
});

const withCtx = (id) => ({ ...mk(id, 12.5), model: 'claude-opus-5-5', project: 'demo', status: 'busy', phase: { kind: 'tool', args: { what: 'Bash' } }, context: { used: 420_000, window: 1_000_000 } });

test('폭 56~150 에서 모든 줄이 화면 폭 안에 들고, 세션 행마다 % 와 IDLE 이 보인다', () => {
  const list = ['a', 'b', 'c'].map(withCtx);
  list[0].members = [{ name: 'Explore', task: '파일 찾기', status: 'busy', phase: { kind: 'waiting', args: { what: 'Grep' } }, tokens: 1000, cost: 0.1 }];
  for (let W = 56; W <= 150; W++) {
    for (const H of [24, 30]) {
      const lines = render({ ...view, data: { ...view.data, sessions: list }, showDetail: 'auto' }, W, H).map(strip);
      for (const l of lines) assert.ok(width(l) <= W, `${W}x${H} 폭 ${width(l)}: ${l}`);
      const rows = lines.filter((l) => / claude  .*세션-/.test(l)).map((l) => l.replace(/\s*│$/, ''));
      assert.equal(rows.length, list.length, `${W}x${H} 행`);
      for (const r of rows) assert.match(r, /\d+%\s+now\s*$/, `${W}x${H}: ${r}`);
    }
  }
});

test('100줄 미만 폭에서도 COST 는 남는다', () => {
  for (const W of [80, 90, 99]) {
    const lines = render({ ...view, data: { ...view.data, sessions: [withCtx('a')] }, showDetail: false }, W, 20).map(strip);
    assert.ok(lines.some((l) => /COST/.test(l)), `${W}`);
  }
});

test('24줄 미만이면 상세 패널을 접어 표에 줄을 주고, d 로 고른 값은 그대로 따른다', () => {
  const many = Array.from({ length: 12 }, (_, i) => mk(String.fromCharCode(97 + i), 1));
  for (const W of [60, 100]) {
    for (const H of [14, 20, 24]) {
      for (const selectedId of ['a', 'f', 'l']) {
        const lines = render({ ...view, data: { ...view.data, sessions: many }, selectedId, showDetail: 'auto' }, W, H).map(strip);
        const tag = `${W}x${H} ${selectedId}`;
        assert.equal(lines.length, H, `${tag} 높이`);
        const rows = lines.filter((l) => / claude  .*세션-/.test(l));
        const more = lines.map((l) => l.match(/… \+(\d+) 세션/)).find(Boolean);
        assert.equal(rows.length + (more ? Number(more[1]) : 0), many.length, `${tag} 행 수`);
        assert.ok(rows.some((l) => l.startsWith('▌') && l.includes(`세션-${selectedId}`)), `${tag} 고른 세션`);
        const panel = lines.some((l) => l.startsWith('╭─ 세션-'));
        assert.equal(panel, H >= 24, `${tag} 상세 패널`);
        if (W >= 100) assert.ok(lines[H - 1].includes(panel ? '상세 닫기' : '상세 열기'), `${tag} 키 안내`);
      }
    }
  }
  const pinned = render({ ...view, data: { ...view.data, sessions: many }, showDetail: true }, 100, 20).map(strip);
  assert.ok(pinned.some((l) => l.startsWith('╭─ 세션-')), 'd 로 연 상세는 낮은 화면에서도 열려 있다');
  const closed = render({ ...view, data: { ...view.data, sessions: many }, showDetail: false }, 100, 30).map(strip);
  assert.ok(!closed.some((l) => l.startsWith('╭─ 세션-')), 'd 로 닫은 상세는 높은 화면에서도 닫혀 있다');
});

// wide-table.snapshot.json: 표 폭 96 이상의 머리글·세션 행·팀원 행. 좁은 화면 대응 전(v0.14.x)의 출력이다.
// 넓은 화면 배치는 바뀌면 안 되므로, 이 테스트가 깨지면 스냅숏을 고치기 전에 의도한 변경인지 먼저 확인한다.
test('표 폭 96 이상의 배치는 좁은 화면 대응 전과 같다', () => {
  const snapshot = JSON.parse(readFileSync(new URL('./wide-table.snapshot.json', import.meta.url), 'utf8'));
  const sess = (id, extra = {}) => ({ tool: 'claude', id, name: `세션-${id}`, project: `proj-${id}`, cwd: '/w', model: 'claude-opus-5-5', status: 'busy', live: true, phase: { kind: 'tool', args: { what: 'Bash' } }, updatedAt: at, tokens: { total: 1_234_567 }, cost: 12.5, context: { used: 420_000, window: 1_000_000 }, members: [], events: [], ...extra });
  // 팀원 STATUS 칸이 'Grep' 한 단어가 되게 응답 대기(요청 Grep)로 둔다. 스냅숏은 색을 뺀 글만 본다.
  const list = [
    sess('a', { members: [{ name: 'Explore', task: '파일 찾기', status: 'busy', model: 'claude-haiku-4-5', phase: { kind: 'waiting', args: { what: 'Grep' } }, tokens: 1000, cost: 0.1 }] }),
    sess('b', { status: 'shell', phase: { kind: 'tool', msg: 'shell' }, cost: 2103, context: { used: 900_000, window: 1_000_000 } }),
    sess('c', { tool: 'codex', model: 'gpt-5.1-codex', cost: 99.77 }),
  ];
  for (let W = 96; W <= 150; W++) {
    const lines = render({ data: { sessions: list, usage: null, errors: [], at }, selectedId: 'a', showDetail: false, frame: 0 }, W, 20).map(strip);
    const got = lines.filter((l) => /TOOL|세션-|└─/.test(l)).slice(0, 3).map((l) => l.trimEnd());
    assert.deepEqual(got, snapshot[W], `W=${W}`);
  }
});
