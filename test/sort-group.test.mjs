import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, GROUPS, SORTS, WAITING_GROUP } from '../src/order.mjs';
import { onKey } from '../src/keys.mjs';
import { createAttention, nextAttention } from '../src/attention.mjs';
import { bySession } from '../src/collect.mjs';
import { render } from '../src/ui.mjs';
import { width } from '../src/text.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-11-09T05:00:00Z');
// cost, ctx(%), ago(초 전 활동)
const sess = (id, project, tool, status, cost, ctx, ago, extra = {}) => ({ tool, id, name: id, project, cwd: `/w/${project}`, status, live: true, phase: { kind: status === 'waiting' ? 'waiting' : 'idle', text: status === 'waiting' ? '응답 대기 · Bash' : '대기' }, startedAt: at - 10_000 + ago, updatedAt: at - ago * 1000, tokens: { total: 1000 }, cost, context: { used: ctx * 2000, window: 200_000 }, members: [], events: [], ...extra });
const list = () => [
  sess('w1', 'aitop', 'claude', 'waiting', 1, 10, 30),
  sess('a', 'aitop', 'claude', 'idle', 5, 80, 300),
  sess('b', 'web', 'codex', 'busy', 40, 20, 5),
  sess('c', 'web', 'claude', 'idle', 12, 95, 60),
  sess('w2', 'web', 'codex', 'waiting', 30, 50, 10),
  sess('d', 'aitop', 'codex', 'idle', 0.5, 40, 1),
].sort(bySession);
const ids = (o) => arrange(list(), o).sessions.map((s) => s.id);

test('정렬 네 가지: 기본·비용·컨텍스트·최근, 응답 대기는 맨 위', () => {
  assert.deepEqual(ids({ sort: 'default' }), list().map((s) => s.id));
  assert.deepEqual(ids({ sort: 'cost' }), ['w2', 'w1', 'b', 'c', 'a', 'd']);
  assert.deepEqual(ids({ sort: 'context' }), ['w2', 'w1', 'c', 'a', 'd', 'b']);
  assert.deepEqual(ids({ sort: 'recent' }), ['w2', 'w1', 'd', 'b', 'c', 'a']);
});

test('캐시 제외 기준이면 그 비용으로 줄 세운다', () => {
  const s = [sess('x', 'p', 'claude', 'idle', 10, 0, 0, { costNoCache: 1 }), sess('y', 'p', 'claude', 'idle', 5, 0, 0, { costNoCache: 2 })];
  assert.deepEqual(arrange(s, { sort: 'cost', costMode: 'net' }).sessions.map((x) => x.id), ['y', 'x']);
});

test('모든 정렬·묶기에서 응답 대기 세션이 맨 위다', () => {
  for (const sort of SORTS)
    for (const group of GROUPS) {
      const got = ids({ sort, group });
      assert.deepEqual(new Set(got.slice(0, 2)), new Set(['w1', 'w2']), `${sort}/${group}`);
      const { groups } = arrange(list(), { sort, group });
      if (groups) assert.equal(groups[0].name, WAITING_GROUP);
    }
});

test('묶음: 이름·세션 수·비용, 묶음 안은 지금 정렬 순서', () => {
  const { groups } = arrange(list(), { sort: 'cost', group: 'project' });
  assert.deepEqual(groups.map((g) => [g.name, g.count, g.cost, g.sessions.map((s) => s.id)]), [
    [WAITING_GROUP, 2, 31, ['w2', 'w1']],
    ['web', 2, 52, ['b', 'c']],
    ['aitop', 2, 5.5, ['a', 'd']],
  ]);
  const tools = arrange(list(), { sort: 'recent', group: 'tool' }).groups;
  assert.deepEqual(tools.map((g) => [g.name, g.count, g.sessions.map((s) => s.id)]), [[WAITING_GROUP, 2, ['w2', 'w1']], ['codex', 2, ['d', 'b']], ['claude', 2, ['c', 'a']]]);
});

test('응답 대기가 없으면 대기 묶음도 없다', () => {
  const { groups } = arrange(list().filter((s) => s.status !== 'waiting'), { group: 'tool' });
  assert.ok(groups.every((g) => g.name !== WAITING_GROUP));
});

test('s·g 는 차례로 돌고 선택한 세션 id 는 그대로다', () => {
  const view = { data: { sessions: list() }, selectedId: 'c', filter: '', focus: null };
  const act = {};
  const seen = [];
  for (let i = 0; i < 4; i++) {
    onKey(view, 's', act);
    seen.push(view.sort);
  }
  assert.deepEqual(seen, ['cost', 'context', 'recent', 'default']);
  const groups = [];
  for (let i = 0; i < 3; i++) {
    onKey(view, 'g', act);
    groups.push(view.group);
  }
  assert.deepEqual(groups, ['project', 'tool', 'none']);
  assert.equal(view.selectedId, 'c');
});

test('순서가 바뀌어도 선택 표시는 같은 세션에 붙고, n 은 화면 순서로 다음 대기 세션을 찾는다', () => {
  for (const [sort, group] of [['default', 'none'], ['cost', 'project'], ['context', 'tool'], ['recent', 'none']]) {
    const lines = render({ data: { sessions: list(), usage: null, errors: [], at }, selectedId: 'c', showDetail: false, frame: 0, sort, group }, 120, 30).map(strip);
    const sel = lines.filter((l) => l.includes('▌'));
    assert.equal(sel.length, 1, `${sort}/${group}`);
    assert.match(sel[0], / c /);
  }
  const shown = arrange(list(), { sort: 'cost', group: 'project' }).sessions;
  assert.equal(nextAttention(createAttention(), shown, 'w2').id, 'w1');
  assert.equal(nextAttention(createAttention(), shown, 'c').id, 'w2');
});

test('묶음 머리 줄과 키 줄의 정렬·묶기 표시', () => {
  const lines = render({ data: { sessions: list(), usage: null, errors: [], at }, selectedId: 'a', showDetail: false, frame: 0, sort: 'cost', group: 'project' }, 140, 30).map(strip);
  const heads = lines.filter((l) => l.includes('▾'));
  assert.equal(heads.length, 3);
  assert.match(heads[0], /▾ 응답 대기\s+2개 · \$31/);
  assert.match(heads[1], /▾ web\s+2개 · \$52/);
  assert.match(lines.at(-1), /s:비용 g:프로젝트/);
  const plain = render({ data: { sessions: list(), usage: null, errors: [], at }, selectedId: 'a', showDetail: false, frame: 0 }, 140, 30).map(strip);
  assert.ok(!plain.some((l) => l.includes('▾')), '기본 상태에는 묶음 머리가 없다');
  assert.doesNotMatch(plain.at(-1), /s:|g:/);
});

test('종료 세션은 어떤 정렬·묶기에서도 (묶음 안에서도) 아래에 있다', () => {
  const withEnded = [...list(), sess('e1', 'aitop', 'claude', 'ended', 999, 99, 0, { live: false }), sess('e2', 'web', 'codex', 'ended', 500, 99, 0, { live: false })].sort(bySession);
  for (const sort of SORTS)
    for (const group of GROUPS) {
      const { sessions, groups } = arrange(withEnded, { sort, group });
      const lists = groups ? groups.map((g) => g.sessions) : [sessions];
      for (const l of lists) {
        const firstEnded = l.findIndex((s) => s.status === 'ended');
        if (firstEnded >= 0) assert.ok(l.slice(firstEnded).every((s) => s.status === 'ended'), `${sort}/${group}`);
      }
    }
  assert.deepEqual(arrange(withEnded, { sort: 'cost' }).sessions.map((s) => s.id).slice(-2), ['e1', 'e2']);
});

test('80칸 키 줄에 짧은 정렬·묶기 표시가 남고, 기본 상태에는 없다', () => {
  const foot = (extra) => strip(render({ data: { sessions: list(), usage: null, errors: [], at }, selectedId: 'a', showDetail: false, frame: 0, ...extra }, 80, 20).at(-1));
  assert.match(foot({ sort: 'cost', group: 'project' }), /s:비용 g:프로젝트/);
  assert.match(foot({ sort: 'context' }), /s:컨텍스트/);
  assert.match(foot({ group: 'tool' }), /g:도구/);
  assert.doesNotMatch(foot({}), /s:|g:/);
});

test('좁고 낮은 화면에서도 줄 수와 폭을 지키고, 정렬 표시는 덜 중요한 안내 뒤에 빠진다', () => {
  for (const [W, H] of [[60, 8], [60, 20], [80, 10], [80, 24], [120, 12]])
    for (const group of GROUPS) {
      const lines = render({ data: { sessions: list(), usage: null, errors: [], at }, selectedId: 'd', showDetail: 'auto', frame: 0, sort: 'context', group }, W, H);
      assert.equal(lines.length, H, `${W}x${H} ${group}`);
      assert.ok(lines.every((l) => width(strip(l)) <= W), `${W}x${H} ${group} 폭`);
      assert.ok(lines.map(strip).some((l) => l.includes('▌') && / d /.test(l)), `${W}x${H} ${group} 선택 행`);
    }
  const foot = strip(render({ data: { sessions: list(), usage: null, errors: [], at }, selectedId: 'a', showDetail: false, frame: 0, sort: 'cost', group: 'tool' }, 60, 20).at(-1));
  assert.doesNotMatch(foot, /비용 기준/, '60칸에서는 c 안내가 먼저 빠진다');
  assert.match(foot, /도움/);
});
