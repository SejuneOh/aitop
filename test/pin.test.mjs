import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, GROUPS, PINNED_GROUP, SORTS, WAITING_GROUP, togglePin } from '../src/order.mjs';
import { onKey } from '../src/keys.mjs';
import { render } from '../src/ui.mjs';
import { VIEWS, keysText } from '../src/help.mjs';
import { width } from '../src/text.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.now();
const sess = (id, project, status, cost, extra = {}) => ({ tool: 'claude', id, name: id, project, cwd: `/w/${project}`, status, live: true, phase: { kind: status === 'waiting' ? 'waiting' : 'idle', text: status === 'waiting' ? '응답 대기 · Bash' : '대기' }, updatedAt: at, tokens: { total: 1000 }, cost, context: { used: 1000, window: 200_000 }, members: [], events: [], ...extra });
const list = () => [sess('a', 'web', 'idle', 5), sess('b', 'aitop', 'idle', 40), sess('w', 'web', 'waiting', 1), sess('c', 'aitop', 'idle', 12), sess('d', 'web', 'idle', 0.5)];
const ids = (o) => arrange(list(), o).sessions.map((s) => s.id);
const act = { quit() {}, refresh() {}, move() {}, next() {}, keepVisible() {} };

test('togglePin: 없으면 끝에 붙이고, 있으면 뺀다', () => {
  assert.deepEqual(togglePin([], 'a'), ['a']);
  assert.deepEqual(togglePin(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(togglePin(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(togglePin(undefined, 'a'), ['a']);
});

test('고정한 세션은 응답 대기 바로 아래에 고정한 순서로, 정렬이 바꾸지 않는다', () => {
  assert.deepEqual(ids({ pins: ['d', 'a'] }), ['w', 'd', 'a', 'b', 'c']);
  assert.deepEqual(ids({ sort: 'cost', pins: ['d', 'a'] }), ['w', 'd', 'a', 'b', 'c'], '비용순이어도 고정 순서는 그대로');
  assert.deepEqual(ids({ sort: 'cost', pins: [] }), ['w', 'b', 'c', 'a', 'd']);
  assert.deepEqual(ids({ pins: ['없는 세션', 'c'] }), ['w', 'c', 'a', 'b', 'd'], '화면에 없는 id 는 건너뛴다');
  // 고정한 세션이 응답 대기가 되면 대기 쪽에 선다.
  assert.deepEqual(ids({ pins: ['w', 'b'] }), ['w', 'b', 'a', 'c', 'd']);
});

test('모든 정렬·묶기에서 응답 대기가 맨 위, 그다음 고정', () => {
  for (const sort of SORTS)
    for (const group of GROUPS) {
      const got = ids({ sort, group, pins: ['c', 'a'] });
      assert.deepEqual(got.slice(0, 3), ['w', 'c', 'a'], `${sort}/${group}`);
    }
});

test('묶기: 고정한 세션은 응답 대기 다음의 고정 묶음 하나로 모인다', () => {
  const { groups } = arrange(list(), { group: 'project', sort: 'cost', pins: ['d', 'b'] });
  assert.deepEqual(groups.map((g) => [g.name, g.sessions.map((s) => s.id), g.pinned]), [
    [WAITING_GROUP, ['w'], false],
    [PINNED_GROUP, ['d', 'b'], true],
    ['aitop', ['c'], false],
    ['web', ['a'], false],
  ]);
  assert.ok(arrange(list(), { group: 'tool' }).groups.every((g) => g.name !== PINNED_GROUP), '고정이 없으면 묶음도 없다');
});

test('p 는 고른 세션을 고정·해제하고 선택은 그대로 둔다', () => {
  const v = { data: { sessions: list() }, selectedId: 'c', pins: [] };
  onKey(v, 'p', act);
  assert.deepEqual(v.pins, ['c']);
  v.selectedId = 'a';
  onKey(v, 'p', act);
  assert.deepEqual(v.pins, ['c', 'a']);
  assert.equal(v.selectedId, 'a');
  v.selectedId = 'c';
  onKey(v, 'p', act);
  assert.deepEqual(v.pins, ['a']);
  const none = { data: { sessions: [] }, selectedId: null, pins: [] };
  onKey(none, 'p', act);
  assert.deepEqual(none.pins, [], '고른 세션이 없으면 아무 일도 없다');
  const searching = { data: { sessions: list() }, selectedId: 'a', pins: [], searching: true, filter: '' };
  onKey(searching, 'p', act);
  assert.deepEqual(searching.pins, [], '검색어 입력 중에는 글자로 들어간다');
  assert.equal(searching.filter, 'p');
});

const view = (extra = {}) => ({ data: { sessions: list(), usage: null, errors: [], at }, selectedId: 'a', showDetail: false, frame: 0, costMode: 'api', sort: 'default', group: 'none', pins: [], ...extra });
const draw = (v, W = 140, H = 24) => render(v, W, H).map(strip);
const rowOf = (lines, id) => lines.findIndex((l) => l.includes(' claude ') && new RegExp(`  (★ )?${id} `).test(l));

test('표: 고정한 행은 SESSION 칸 앞에 ★ (색 없이도), 맨 위로 오고 열이 밀리지 않는다', () => {
  const v = view({ pins: ['d'] });
  const lines = draw(v);
  const d = lines[rowOf(lines, 'd')];
  assert.match(d, /claude +- +★ d +/);
  assert.ok(rowOf(lines, 'w') < rowOf(lines, 'd') && rowOf(lines, 'd') < rowOf(lines, 'a'), '대기 → 고정 → 나머지');
  assert.doesNotMatch(lines[rowOf(lines, 'a')], /★/);
  // 고정 표시가 붙어도 다른 열 자리는 같다.
  const col = (l) => l.indexOf('대기');
  assert.equal(col(d), col(lines[rowOf(lines, 'a')]));
  for (const W of [60, 80, 100, 140]) for (const l of draw(v, W)) assert.ok(width(l) <= W, `W=${W}`);
  // 아주 좁아 이름 칸이 몇 칸 안 남아도 고정 표시는 남는다.
  for (const W of [30, 36, 40, 44]) {
    const narrow = draw(v, W);
    assert.ok(narrow.some((l) => l.includes('★')), `W=${W}`);
    for (const l of narrow) assert.ok(width(l) <= W, `W=${W}`);
  }
});

test('고정한 종료 세션은 종료 세션을 함께 볼 때 실행 중인 세션보다 위에 남는다', () => {
  const s = [sess('a', 'web', 'idle', 5), sess('e', 'web', 'ended', 3, { live: false, phase: { kind: 'ended', text: '종료' } })];
  assert.deepEqual(arrange(s, { sort: 'cost', pins: ['e'] }).sessions.map((x) => x.id), ['e', 'a']);
});

test('파일 목록·diff 에 들어가 있으면 p 는 고정하지 않는다', () => {
  for (const focus of ['files', 'diff']) {
    const v = { data: { sessions: list() }, selectedId: 'a', pins: [], focus, showDetail: true };
    onKey(v, 'p', act);
    assert.deepEqual(v.pins, [], focus);
  }
});

test('검색: 고정한 세션도 검색어에 맞지 않으면 숨고, 맞으면 맨 위에 남는다', () => {
  const lines = draw(view({ pins: ['d', 'b'], filter: 'web' }));
  assert.equal(rowOf(lines, 'b'), -1);
  assert.ok(rowOf(lines, 'd') < rowOf(lines, 'a'));
  assert.match(lines[rowOf(lines, 'd')], /★ d/);
});

test('묶기 화면에 고정 묶음 머리가 보인다', () => {
  const lines = draw(view({ group: 'project', pins: ['d'] }));
  const head = lines.findIndex((l) => /▾ 고정 +1개/.test(l));
  assert.ok(head > 0);
  assert.equal(rowOf(lines, 'd'), head + 1);
});

test('키 안내 줄과 도움말에 p 가 있다', () => {
  const v = view({ selectedId: 'a' });
  assert.match(draw(v, 160).at(-1), /p +고정 /);
  v.pins = ['a'];
  assert.match(draw(v, 160).at(-1), /p +고정 해제/);
  // 좁으면 먼저 빠지고 ? · q 는 남는다.
  const narrow = draw(v, 70).at(-1);
  assert.doesNotMatch(narrow, /고정/);
  assert.match(narrow, /\? +도움/);
  assert.ok(VIEWS.table.keys.some(([k, t]) => k === 'p' && /고정/.test(t)));
  assert.match(keysText(), /p 고정/);
  assert.match(draw({ ...view(), help: true }, 140, 60).join('\n'), /p +고른 세션을 맨 위/);
});
