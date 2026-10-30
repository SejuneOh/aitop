import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { ClaudeTracker } = await import('../src/sources/claude-tracker.mjs');
const { addChange, FILE_LIMITS, isSecretFile } = await import('../src/sources/files.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { flushCache } = await import('../src/cache.mjs');
const { toJson } = await import('../src/json.mjs');

const ts = (ms) => new Date(ms).toISOString();
// Claude 기록의 도구 결과 줄: user 메시지 + toolUseResult
const result = (r, at = Date.now()) => ({ ...user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), timestamp: ts(at), toolUseResult: r });
const edit = (filePath, lines, oldStart = 10) => ({ filePath, oldString: 'a', newString: 'b', originalFile: 'x'.repeat(5000), structuredPatch: [{ oldStart, oldLines: 2, newStart: oldStart, newLines: 2, lines }], userModified: false, replaceAll: false });
const create = (filePath, content) => ({ type: 'create', filePath, content, structuredPatch: [], originalFile: null });

test('Edit 와 Write(새 파일·덮어쓰기)를 파일별로 모으고 원본 파일 전체는 저장하지 않는다', () => {
  const now = Date.now();
  const p = fx.transcript('ffffffff-1', [
    user('고쳐줘'),
    result(edit('/work/demo/src/a.mjs', [' ctx', '-old', '+new', '+more']), now - 3000),
    result(edit('/work/demo/src/a.mjs', ['-x', '+y'], 40), now - 2000),
    result(create('/work/demo/test/b.test.mjs', 'one\ntwo\nthree\n'), now - 1000),
    result({ type: 'update', filePath: '/work/demo/README.md', content: 'z', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }, now),
  ]);
  const t = new ClaudeTracker(p);
  t.update();
  const byPath = Object.fromEntries(t.files.map((f) => [f.path, f]));
  const a = byPath['/work/demo/src/a.mjs'];
  assert.deepEqual([a.edits, a.add, a.del, a.created, a.hunks.length], [2, 3, 2, false, 2]);
  const b = byPath['/work/demo/test/b.test.mjs'];
  assert.deepEqual([b.created, b.add, b.del], [true, 3, 0]);
  assert.deepEqual(b.hunks[0].lines, ['+one', '+two', '+three']);
  assert.equal(byPath['/work/demo/README.md'].add, 1);
  assert.equal(t.files[0].path, '/work/demo/README.md', '최근에 고친 파일이 앞');
  assert.doesNotMatch(JSON.stringify(t.snapshot()), /xxxxxxxxxx/);
});

test('형식이 다르거나 실패한 결과는 건너뛰고 멈추지 않는다', () => {
  const files = [];
  for (const r of ['Error: String to replace not found', null, 42, {}, { filePath: 3 }, { filePath: '/a', structuredPatch: 'oops' }, { filePath: '/a', structuredPatch: [null, { lines: 'x' }] }, { type: 'create', filePath: '/c' }]) addChange(files, r);
  assert.deepEqual(files.map((f) => [f.path, f.add, f.del]), [['/a', 0, 0]]);
});

test('상한을 넘으면 오래된 변경부터 버리고 줄 수 통계는 남긴다', () => {
  const files = [];
  const t0 = Date.parse('2026-10-30T00:00:00Z');
  for (let i = 0; i < FILE_LIMITS.hunksPerFile + 3; i++) addChange(files, edit('/one.mjs', ['+a', '-b']), ts(t0 + i * 1000));
  assert.equal(files[0].hunks.length, FILE_LIMITS.hunksPerFile);
  assert.equal(files[0].dropped, 3);
  assert.equal(files[0].add, FILE_LIMITS.hunksPerFile + 3);

  const many = [];
  for (let i = 0; i < FILE_LIMITS.files + 5; i++) addChange(many, edit(`/f${i}.mjs`, ['+a']), ts(t0 + i * 1000));
  assert.equal(many.length, FILE_LIMITS.files);
  assert.ok(!many.some((f) => f.path === '/f0.mjs'), '가장 오래된 파일이 빠진다');

  const big = [];
  const long = Array.from({ length: 280 }, () => '+' + 'y'.repeat(500));
  for (let i = 0; i < 8; i++) addChange(big, edit(`/big${i}.mjs`, long), ts(t0 + i * 1000));
  const total = big.reduce((a, f) => a + f.hunks.reduce((b, h) => b + h.lines.length, 0), 0);
  assert.ok(total <= FILE_LIMITS.lines, `저장 줄 ${total}`);
  assert.ok(big.every((f) => f.hunks.every((h) => h.lines.every((l) => l.length <= FILE_LIMITS.lineChars))));
  assert.equal(big.find((f) => f.path === '/big0.mjs').add, 280, '조각을 버려도 통계는 남는다');
});

test('비밀 파일은 변경 내용을 저장하지 않고, 줄 안의 비밀값과 제어문자는 지운다', () => {
  assert.ok(['.env', '.env.local', 'server.pem', 'id_rsa', 'aws-credentials.json', 'api_key.txt', '.npmrc'].every(isSecretFile));
  assert.ok(!['keys.mjs', 'monkey.js', 'env.ts', 'README.md'].some(isSecretFile));
  const files = [];
  addChange(files, edit('/work/.env', ['+TOKEN=abcdef123456']));
  assert.equal(files[0].hidden, true);
  assert.equal(files[0].hunks.length, 0);
  addChange(files, edit('/work/a.mjs', ['+const k = "sk-ant-abcdefghijklmnopqrstu";', '+\x1b]52;c;cGF3bmVk\x07evil\x1b[2J', '+\tindent']));
  const lines = files.find((f) => f.path === '/work/a.mjs').hunks[0].lines;
  assert.doesNotMatch(lines[0], /sk-ant-abc/);
  assert.doesNotMatch(lines[1], /[\x00-\x1f]/);
  assert.equal(lines[2], '+  indent');
});

test('서브에이전트가 고친 파일도 합치고, 누가 고쳤는지 붙인다', () => {
  fx.session({ sessionId: 'ffffffff-2', pid: process.pid });
  const now = Date.now();
  fx.transcript('ffffffff-2', [user('같이 고치자'), assistant('m1', [{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }], usage(1, 1)), result(edit('/work/demo/src/a.mjs', ['+main']), now - 2000)]);
  fx.subagent('ffffffff-2', 'q', { agentType: 'general-purpose', description: '테스트', toolUseId: 'ta' }, [result(edit('/work/demo/src/a.mjs', ['+sub']), now - 1000), result(create('/work/demo/new.mjs', 'x'), now)]);
  const s = collectClaude({ showEnded: false, budget: createBudget() }).find((x) => x.id === 'ffffffff-2');
  const a = s.files.find((f) => f.path === '/work/demo/src/a.mjs');
  assert.equal(a.edits, 2);
  assert.deepEqual(a.hunks.map((h) => h.agent), ['general-purpose', '메인'], '최신 변경이 먼저');
  assert.deepEqual(a.agents.sort(), ['general-purpose', '메인']);
  assert.equal(s.files[0].path, '/work/demo/new.mjs');

  const j = toJson({ sessions: [s], usage: null, at: now }).sessions[0].files;
  assert.deepEqual(Object.keys(j[0]).sort(), ['agents', 'created', 'deletedLines', 'edits', 'path', 'updatedAt', 'writtenLines']);
});

test('캐시에 저장했다 다시 읽어도 같다', () => {
  const p = fx.transcript('ffffffff-3', [result(edit('/w/a.mjs', ['+1', '-2'])), result(create('/w/b.mjs', 'b'))]);
  const t = new ClaudeTracker(p);
  t.update();
  flushCache();
  const again = new ClaudeTracker(p);
  assert.deepEqual(again.files, t.files);
  again.update();
  assert.deepEqual(again.files, t.files, '이미 읽은 줄을 다시 더하지 않는다');
});
