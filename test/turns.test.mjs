import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { turnTabs, visibleFiles } = await import('../src/turns.mjs');
const { onKey, KEY } = await import('../src/keys.mjs');
const { render } = await import('../src/ui.mjs');

const t0 = Date.parse('2026-10-30T05:00:00Z');
const ts = (min) => new Date(t0 + min * 60_000).toISOString();
const prompt = (text, min) => ({ ...user(text), timestamp: ts(min) });
const edit = (filePath, min) => ({ ...user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), timestamp: ts(min), toolUseResult: { filePath, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } });
const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');

function session() {
  fx.session({ sessionId: 'tttttttt-1' });
  fx.transcript('tttttttt-1', [
    prompt('로그인 고쳐줘', 0),
    edit('/work/demo/src/login.mjs', 1),
    edit('/work/demo/src/login.mjs', 2),
    prompt('질문만 할게', 5),
    prompt('footer 정리해줘', 10),
    assistant('m1', [{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }], usage(1, 1)),
    edit('/work/demo/src/ui.mjs', 11),
    edit('/work/demo/package-lock.json', 12),
  ]);
  fx.subagent('tttttttt-1', 'q', { agentType: 'general-purpose', toolUseId: 'ta' }, [prompt('서브에이전트 지시', 11), edit('/work/demo/src/footer.mjs', 13)]);
  return collectClaude({ showEnded: false, budget: createBudget() }).find((s) => s.id === 'tttttttt-1');
}

test('지시마다 시각을 남기고, 이번 지시 탭에는 마지막 지시 뒤에 고친 파일만 보인다', () => {
  const s = session();
  assert.deepEqual(s.turns.map((t) => [t.n, t.text]), [[1, '로그인 고쳐줘'], [2, '질문만 할게'], [3, 'footer 정리해줘']]);
  const tabs = turnTabs(s);
  assert.deepEqual(tabs.map((t) => t.label), ['이번 지시', 'T1', '전체'], '편집이 없는 지시(T2)는 탭이 없다');
  const now = visibleFiles(s, 'now').map((f) => [f.path.split('/').pop(), f.edits]);
  assert.deepEqual(now, [['footer.mjs', 1], ['ui.mjs', 1], ['package-lock.json', 1]], '서브에이전트 편집도 들어가고 lock 파일은 끝');
  assert.deepEqual(visibleFiles(s, 1).map((f) => [f.path.split('/').pop(), f.edits]), [['login.mjs', 2]]);
  assert.equal(visibleFiles(s, 'all').length, 4);
});

test('목록에서 ←/→ 로 탭을 바꾸고, 바꾼 탭의 첫 파일을 고른다', () => {
  const s = session();
  const view = { data: { sessions: [s] }, selectedId: s.id, showDetail: true, focus: null, tab: 'now', filePath: null };
  const act = { quit() {}, refresh() {}, move() {}, next() {}, keepVisible() {} };
  const press = (...keys) => keys.forEach((k) => onKey(view, k, act));
  press('f');
  assert.equal(view.filePath, '/work/demo/src/footer.mjs');
  press(KEY.right);
  assert.deepEqual([view.tab, view.filePath, view.focus], [1, '/work/demo/src/login.mjs', 'files']);
  press(KEY.right, KEY.right);
  assert.equal(view.tab, 'all', '끝에서 멈춘다');
  press(KEY.left, KEY.left, KEY.left);
  assert.equal(view.tab, 'now');
  press(KEY.enter, KEY.left);
  assert.equal(view.focus, 'files', 'diff 에서 ← 는 목록으로');
});

test('이번 지시에 고친 파일이 없으면 안내를 보이고, 목록에 들어가 다른 지시로 갈 수 있다', () => {
  const s = session();
  s.turns = [...s.turns, { n: 4, at: t0 + 20 * 60_000, text: '테스트 돌려줘' }];
  const view = { data: { sessions: [s], usage: null, errors: [], at: Date.now() }, selectedId: s.id, showDetail: true, frame: 0, focus: null, tab: 'now', filePath: null };
  const out = render(view, 120, 30).map(strip).join('\n');
  assert.match(out, /"테스트 돌려줘"\s+파일 0 · 편집 0회/);
  assert.match(out, /이 지시에서 고친 파일이 없습니다/);
  const act = { quit() {}, refresh() {}, move() {}, next() {}, keepVisible() {} };
  onKey(view, 'f', act);
  assert.deepEqual([view.focus, view.filePath], ['files', null]);
  onKey(view, KEY.enter, act);
  assert.equal(view.focus, 'files', '고를 파일이 없으면 diff 를 열지 않는다');
  onKey(view, KEY.right, act);
  assert.equal(view.tab, 3);
  assert.equal(view.filePath, '/work/demo/src/footer.mjs');
});
