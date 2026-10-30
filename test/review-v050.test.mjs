import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { visibleFiles } = await import('../src/turns.mjs');
const { onKey, fixFocus, KEY } = await import('../src/keys.mjs');

const t0 = Date.parse('2026-10-30T05:00:00Z');
const ts = (min) => new Date(t0 + min * 60_000).toISOString();
const prompt = (text, min) => ({ ...user(text), timestamp: ts(min) });
const result = (r, min) => ({ ...user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), timestamp: ts(min), toolUseResult: r });
const edit = (filePath, lines, min) => result({ filePath, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }] }, min);
const create = (filePath, content, min) => result({ type: 'create', filePath, content, structuredPatch: [] }, min);
const act = { quit() {}, refresh() {}, move() {}, next() {}, keepVisible() {} };

function collect(id) {
  return collectClaude({ showEnded: false, budget: createBudget() }).find((s) => s.id === id);
}

test('탭의 줄 수·새 파일 표시·생략 수는 그 지시의 편집만 센다', () => {
  fx.session({ sessionId: 'rrrrrrrr-1' });
  fx.transcript('rrrrrrrr-1', [
    prompt('만들어줘', 0),
    create('/work/demo/a.mjs', Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), 1),
    prompt('한 줄 고쳐줘', 10),
    edit('/work/demo/a.mjs', ['-line 1', '+line one'], 11),
  ]);
  const s = collect('rrrrrrrr-1');
  const [now] = visibleFiles(s, 'now');
  assert.deepEqual([now.edits, now.add, now.del, now.created, now.dropped], [1, 1, 1, false, 0]);
  const [all] = visibleFiles(s, 'all');
  assert.deepEqual([all.edits, all.add, all.del, all.created], [2, 31, 1, true]);
  const [first] = visibleFiles(s, 1);
  assert.deepEqual([first.edits, first.add, first.created], [1, 30, true]);
});

test('백그라운드 서브에이전트가 다음 지시 뒤에 고친 파일도 자기를 부른 지시에 들어간다', () => {
  fx.session({ sessionId: 'rrrrrrrr-2' });
  fx.transcript('rrrrrrrr-2', [
    prompt('백그라운드로 정리해줘', 0),
    assistant('m1', [{ type: 'tool_use', id: 'tb', name: 'Agent', input: {} }], usage(1, 1)),
    prompt('그동안 다른 질문', 10),
  ]);
  fx.subagent('rrrrrrrr-2', 'bg', { agentType: 'general-purpose', toolUseId: 'tb' }, [prompt('정리 작업', 1), edit('/work/demo/footer.mjs', ['+x'], 15)]);
  const s = collect('rrrrrrrr-2');
  assert.deepEqual(visibleFiles(s, 'now'), []);
  assert.deepEqual(visibleFiles(s, 1).map((f) => f.path), ['/work/demo/footer.mjs']);
});

test('diff 를 보는 중에 새 지시가 들어와도 diff 를 닫지 않고 전체 탭으로 옮긴다', () => {
  const file = { path: '/a', edits: 1, add: 1, del: 0, at: t0 + 60_000, hunks: [], log: [{ at: t0 + 60_000, add: 1, del: 0 }] };
  const s = { id: 's', files: [file], turns: [{ n: 1, at: t0, text: 'x' }] };
  const view = { data: { sessions: [s] }, selectedId: 's', showDetail: true, focus: null, tab: 'now', filePath: null };
  onKey(view, 'f', act);
  onKey(view, KEY.enter, act);
  assert.deepEqual([view.focus, view.filePath], ['diff', '/a']);
  view.data.sessions = [{ ...s, turns: [...s.turns, { n: 2, at: t0 + 120_000, text: 'y' }] }];
  fixFocus(view);
  assert.deepEqual([view.focus, view.filePath, view.tab], ['diff', '/a', 'all']);
});

test('탭을 바꿔도 고른 파일이 새 탭에 있으면 그대로 둔다', () => {
  const mk = (path, min) => ({ path, edits: 1, add: 1, del: 0, at: t0 + min * 60_000, hunks: [], log: [{ at: t0 + min * 60_000, add: 1, del: 0 }] });
  // /ui 는 두 지시에서 모두 고쳤다.
  const ui = { ...mk('/ui', 11), edits: 2, log: [{ at: t0 + 60_000, add: 1, del: 0 }, { at: t0 + 11 * 60_000, add: 1, del: 0 }] };
  const s = { id: 's', files: [mk('/new', 12), ui, mk('/old', 2)], turns: [{ n: 1, at: t0, text: 'a' }, { n: 2, at: t0 + 10 * 60_000, text: 'b' }] };
  const view = { data: { sessions: [s] }, selectedId: 's', showDetail: true, focus: null, tab: 'now', filePath: null };
  onKey(view, 'f', act);
  onKey(view, KEY.down, act);
  assert.equal(view.filePath, '/ui');
  onKey(view, KEY.right, act);
  assert.deepEqual([view.tab, view.filePath], [1, '/ui']);
  onKey(view, KEY.right, act);
  assert.deepEqual([view.tab, view.filePath], ['all', '/ui']);
});
