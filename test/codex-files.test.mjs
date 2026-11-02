import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeClaudeHome } from './fixture.mjs';

const fx = makeClaudeHome();
const { parsePatch, patchSucceeded } = await import('../src/sources/patch.mjs');
const { _test } = await import('../src/sources/codex.mjs');
const { mergeFiles } = await import('../src/sources/files.mjs');
const { render } = await import('../src/ui.mjs');

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/a.mjs',
  '@@ function foo',
  ' keep',
  '-old',
  '+new',
  '+more',
  '*** Update File: src/old-name.mjs',
  '*** Move to: src/new-name.mjs',
  '@@',
  '-x',
  '+y',
  '*** Add File: /abs/new.txt',
  '+hello',
  '+world',
  '*** Delete File: src/gone.mjs',
  '*** End Patch',
].join('\n');

test('apply_patch 본문을 파일별 변경으로 바꾼다 (상대 경로는 cwd 기준)', () => {
  const r = parsePatch(PATCH, '/w');
  assert.deepEqual(r.map((c) => [c.type ?? 'update', c.filePath]), [['update', '/w/src/a.mjs'], ['update', '/w/src/new-name.mjs'], ['create', '/abs/new.txt'], ['delete', '/w/src/gone.mjs']]);
  assert.deepEqual(r[0].structuredPatch[0], { unnumbered: true, context: 'function foo', oldStart: 0, oldLines: 2, newStart: 0, newLines: 3, lines: [' keep', '-old', '+new', '+more'] });
  assert.equal(r[2].content, 'hello\nworld');
  assert.deepEqual(parsePatch('그냥 글', '/w'), []);
});

test('본문에 *** End Patch 글자가 있어도 뒤 파일까지 읽는다', () => {
  const p = ['*** Begin Patch', '*** Add File: a.mjs', '+const s = "*** End Patch";', '*** Update File: b.mjs', '@@', '-1', '+2', '*** End Patch'].join('\n');
  assert.deepEqual(parsePatch(p, '/w').map((c) => c.filePath), ['/w/a.mjs', '/w/b.mjs']);
});

test('CRLF 패치와 앞 공백 없는 빈 문맥 줄', () => {
  const p = ['*** Begin Patch', '*** Update File: c.mjs', '@@ x', ' a', '', '-b', '+c', '*** End Patch'].join('\r\n');
  const h = parsePatch(p, '/w')[0].structuredPatch[0];
  assert.deepEqual(h.lines, [' a', ' ', '-b', '+c']);
  assert.deepEqual([h.oldLines, h.newLines], [3, 3]);
});

test('apply_patch 결과가 실패면 false', () => {
  assert.equal(patchSucceeded(JSON.stringify({ output: 'Success.', metadata: { exit_code: 0 } })), true);
  assert.equal(patchSucceeded(JSON.stringify({ output: 'Error', metadata: { exit_code: 2 } })), false);
  assert.equal(patchSucceeded('apply_patch verification failed: Failed to find context'), false);
  assert.equal(patchSucceeded('Success. Updated the following files:'), true);
});

function session(lines) {
  const path = join(fx.home, `rollout-${Math.random()}.jsonl`);
  writeFileSync(path, '');
  const st = _test.newState(path);
  for (const x of lines) _test.applyLine(st, x);
  return st;
}
const ts = (s) => new Date(Date.parse('2026-11-01T00:00:00Z') + s * 1000).toISOString();
const meta = { type: 'session_meta', timestamp: ts(0), payload: { id: 'c1', cwd: '/w' } };
const prompt = (s, text) => ({ type: 'event_msg', timestamp: ts(s), payload: { type: 'user_message', message: text } });
const call = (s, id, input) => ({ type: 'response_item', timestamp: ts(s), payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: id, input } });
const result = (s, id, code) => ({ type: 'response_item', timestamp: ts(s), payload: { type: 'custom_tool_call_output', call_id: id, output: JSON.stringify({ output: '', metadata: { exit_code: code } }) } });

test('Codex 세션은 성공한 패치만 변경 파일에 넣고 지시 목록을 만든다', () => {
  const st = session([meta, prompt(1, '고쳐줘'), call(2, 'p1', PATCH), result(3, 'p1', 0), prompt(4, '하나 더'), call(5, 'p2', '*** Begin Patch\n*** Update File: src/z.mjs\n@@\n-a\n+b\n*** End Patch'), result(6, 'p2', 1)]);
  assert.deepEqual(st.files.map((f) => f.path).sort(), ['/abs/new.txt', '/w/src/a.mjs', '/w/src/gone.mjs', '/w/src/new-name.mjs']);
  const a = st.files.find((f) => f.path === '/w/src/a.mjs');
  assert.deepEqual([a.edits, a.add, a.del], [1, 2, 1]);
  assert.equal(st.files.find((f) => f.path === '/abs/new.txt').created, true);
  assert.equal(st.files.find((f) => f.path === '/w/src/gone.mjs').deleted, true);
  assert.deepEqual(st.turns.map((t) => [t.n, t.text]), [[1, '고쳐줘'], [2, '하나 더']]);
  assert.deepEqual(st.patches, {});
});

test('빈 지시는 건너뛰고, 패치 본문은 캐시 스냅샷에 남기지 않는다', () => {
  const st = session([meta, prompt(1, '   '), prompt(2, '진짜 지시'), call(3, 'p9', PATCH)]);
  assert.deepEqual(st.turns.map((t) => [t.n, t.text]), [[1, '진짜 지시']]);
  assert.ok(st.patches.p9, '결과를 기다리는 중');
  assert.ok(!('patches' in _test.snapshot(st)), '캐시에는 저장하지 않는다');
  _test.applyLine(st, { type: 'event_msg', timestamp: ts(4), payload: { type: 'turn_aborted' } });
  assert.deepEqual(st.patches, {});
});

test('apply_patch 가 아닌 shell 명령의 글은 패치로 보지 않는다', () => {
  const args = JSON.stringify({ command: ['bash', '-lc', "rg '*** Begin Patch'\n*** Begin Patch\n*** Update File: x\n@@\n-a\n+b\n*** End Patch"] });
  const st = session([meta, { type: 'response_item', timestamp: ts(1), payload: { type: 'function_call', name: 'shell', call_id: 'r1', arguments: args } }, { type: 'response_item', timestamp: ts(2), payload: { type: 'function_call_output', call_id: 'r1', output: '{"output":"","metadata":{"exit_code":0}}' } }]);
  assert.deepEqual(st.files, []);
});

test('예전 shell 형식의 apply_patch 도 해석한다', () => {
  const args = JSON.stringify({ command: ['apply_patch', '*** Begin Patch\n*** Update File: b.mjs\n@@\n-1\n+2\n*** End Patch'] });
  const st = session([meta, { type: 'response_item', timestamp: ts(1), payload: { type: 'function_call', name: 'shell', call_id: 's1', arguments: args } }, { type: 'response_item', timestamp: ts(2), payload: { type: 'function_call_output', call_id: 's1', output: JSON.stringify({ output: 'Success.', metadata: { exit_code: 0 } }) } }]);
  assert.deepEqual(st.files.map((f) => [f.path, f.add, f.del]), [['/w/b.mjs', 1, 1]]);
});

test('줄 번호 없는 diff 는 @@ 문맥만 보이고 번호 칸을 비운다. 삭제한 파일은 그렇다고 보인다', () => {
  const st = session([meta, prompt(1, '고쳐줘'), call(2, 'p1', PATCH), result(3, 'p1', 0)]);
  const files = mergeFiles([{ agent: '메인', files: st.files }]);
  const s = { tool: 'codex', id: 'c1', name: 'w', cwd: '/w', status: 'idle', live: true, phase: { kind: 'idle', text: '대기' }, updatedAt: Date.now(), tokens: { total: 10 }, context: {}, members: [], events: [], files, turns: st.turns };
  const draw = (filePath) => render({ data: { sessions: [s], usage: null, errors: [], at: Date.now() }, selectedId: 'c1', showDetail: true, frame: 0, focus: 'diff', filePath, tab: 'all' }, 140, 30).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  const a = draw('/w/src/a.mjs');
  assert.match(a, /메인 · @@ function foo/);
  assert.doesNotMatch(a, /@@ -0/);
  assert.match(a, /│ +keep/);
  assert.match(draw('/w/src/gone.mjs'), /이 파일을 삭제했습니다/);
});
