// Codex 압축 rollout(rollout-*.jsonl.zst) 도 기록으로 읽는다 (#330): 장부·세션 목록·세션 리포트·프로젝트·--doctor,
// 같은 이름의 .jsonl 과 함께 있으면 .jsonl 하나만, 한도 있는 갱신에서는 한 번에 하나씩, 한 번 다 읽으면 다시 풀지 않음,
// zstd 없는 Node 에서는 건너뛰고 --doctor 에 안내, 압축 해제 크기 상한.
// zstd 로 압축할 수 없는 Node(22.15 미만)에서는 건너뛴다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeClaudeHome } from './fixture.mjs';

const skip = typeof zlib.zstdCompressSync !== 'function' ? 'zstd 없는 Node' : false;

makeClaudeHome();
const root = mkdtempSync(join(tmpdir(), 'aitop-codex-zst-'));
process.env.CODEX_HOME = join(root, 'codex');
const SESSIONS = join(process.env.CODEX_HOME, 'sessions');
const { collectCodexLedger, _test: ledgerTest } = await import('../src/sources/codex-ledger.mjs');
const { collectDaily } = await import('../src/sources/claude-ledger.mjs');
const { collectCodex } = await import('../src/sources/codex.mjs');
const { attachProjects } = await import('../src/sources/projects.mjs');
const { collectSessions } = await import('../src/sessions-report.mjs');
const { findTrace } = await import('../src/trace.mjs');
const { codexId } = await import('../src/resume.mjs');
const { checkTools, describe } = await import('../src/doctor.mjs');
const { createBudget, JsonlTail } = await import('../src/tail.mjs');
const { flushCache } = await import('../src/cache.mjs');
const zstd = await import('../src/zstd.mjs');

const DAY = 86400_000;
const id = (n) => `5e5e5e5e-0000-4000-8000-${String(n).padStart(12, '0')}`;

const count = (at, output) => ({
  timestamp: new Date(at).toISOString(),
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: output, total_tokens: output }, last_token_usage: { total_tokens: 1 } } },
});

// 날짜 폴더에 rollout 을 만든다. zst: true 면 .jsonl.zst 로 압축해 둔다. 수정 시각은 지금에서 ageMs 전.
function rollout(n, { zst = false, ageMs = 2 * DAY, output = 1000, cwd = '/work/zst', name = null, pad = 0 } = {}) {
  const at = Date.now() - ageMs - 60_000;
  const d = new Date(at);
  const dir = join(SESSIONS, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'session_meta', payload: { id: id(n), cwd: '/meta', timestamp: new Date(at).toISOString() } },
    { type: 'turn_context', payload: { model: 'gpt-5.1-codex', cwd } },
    ...(name ? [{ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'thread_name_updated', thread_name: name } }] : []),
    { timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'x'.repeat(pad) || '안녕' } },
    count(at, output),
  ];
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const plain = join(dir, `rollout-2026-01-01T00-00-00-${id(n)}.jsonl`);
  const path = zst ? plain + '.zst' : plain;
  writeFileSync(path, zst ? zlib.zstdCompressSync(Buffer.from(text)) : text);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

// 해제 함수를 감싸 몇 번 불렸는지 센다.
let calls = 0;
const spy = () => {
  calls = 0;
  zstd._test.setDecompress((buf, o) => {
    calls++;
    return zlib.zstdDecompressSync(buf, o);
  });
};

beforeEach(() => {
  rmSync(SESSIONS, { recursive: true, force: true });
  ledgerTest.reset();
  zstd._test.reset();
});

test('장부: 압축 기록의 사용량을 세고, 작업 폴더를 기억해 리포트 프로젝트에 쓴다', { skip }, () => {
  const p = rollout(1, { zst: true, output: 5000 });
  const r = collectCodexLedger({ budget: createBudget(), days: 30 });
  assert.deepEqual(r.paths, [p]);
  assert.equal(Object.values(r.days[0]).reduce((a, d) => a + d.tokens, 0), 5000);
  assert.equal(r.pending, 0);
  // 첫 turn_context.cwd (projects.mjs codexProject 와 같은 규칙)
  assert.deepEqual(r.cwds, ['/work/zst']);
  const books = collectDaily({ budget: createBudget(), days: 30 }).books.filter((b) => b.tool === 'codex');
  assert.equal(books.length, 1);
  assert.equal(attachProjects(books)[0].project, '/work/zst');
});

test('같은 이름의 .jsonl 과 .jsonl.zst 가 함께 있으면 .jsonl 하나만 센다', { skip }, () => {
  const z = rollout(2, { zst: true, output: 7000 });
  const p = rollout(2, { output: 3000 });
  assert.equal(z, p + '.zst');
  const r = collectCodexLedger({ budget: createBudget(), days: 30 });
  assert.deepEqual(r.paths, [p]);
  assert.equal(Object.values(r.days[0]).reduce((a, d) => a + d.tokens, 0), 3000);
  assert.equal(checkTools().tools.codex.records, 1);
});

test('세션 목록: 압축 기록은 끝난 세션으로만 보이고 실행 중으로 짝짓지 않는다', { skip }, () => {
  // 수정 시각이 방금이어도(프로세스 목록이 없을 때의 10분 규칙) 실행 중으로 보지 않는다.
  const p = rollout(3, { zst: true, ageMs: 60_000 });
  const blind = { canList: () => false, procsOf: () => [] };
  assert.deepEqual(collectCodex({ showEnded: false, budget: createBudget(), ...blind }), []);
  const all = collectCodex({ showEnded: true, budget: createBudget(), ...blind });
  assert.equal(all.length, 1);
  assert.equal(all[0].live, false);
  assert.equal(all[0].id, id(3));
  assert.equal(all[0].tokens.total, 1000);
  assert.equal(codexId(p), id(3));
  // 같은 폴더에서 도는 프로세스에도 붙이지 않는다.
  const procs = collectCodex({ showEnded: true, budget: createBudget(), canList: () => true, procsOf: () => [{ pid: 999999, cwd: '/work/zst' }], filesOf: () => [], startOf: () => null });
  assert.equal(procs.find((s) => s.id === id(3)).live, false);
});

test('한도 있는 budget 에서는 압축 기록을 한 번에 하나만 풀고, 한도 Infinity 면 다 푼다', { skip }, () => {
  const a = new JsonlTail(rollout(4, { zst: true }));
  const b = new JsonlTail(rollout(5, { zst: true }));
  const lines = [];
  const on = (x) => lines.push(x);
  const budget = createBudget(Infinity, 60_000);
  assert.ok(a.read(on, budget) > 0);
  assert.equal(b.read(on, budget), 0);
  assert.equal(budget.exhausted, true);
  assert.equal(b.done, false);
  assert.ok(b.read(on, createBudget(Infinity, 60_000)) > 0);
  assert.equal(lines.length, 8);
  const c = new JsonlTail(rollout(6, { zst: true }));
  const d = new JsonlTail(rollout(7, { zst: true }));
  const all = createBudget();
  assert.ok(c.read(on, all) > 0 && d.read(on, all) > 0);
  assert.equal(all.exhausted, false);
});

test('한 번 다 읽은 압축 기록은 바뀔 때까지 다시 풀지 않는다 (캐시에서 이어도)', { skip }, () => {
  spy();
  const p = rollout(8, { zst: true, output: 1000 });
  collectCodexLedger({ budget: createBudget(), days: 30 });
  collectCodexLedger({ budget: createBudget(), days: 30 });
  assert.equal(calls, 1);
  flushCache();
  ledgerTest.reset();
  const r = collectCodexLedger({ budget: createBudget(), days: 30 });
  assert.equal(calls, 1);
  assert.equal(Object.values(r.days[0]).reduce((a, d) => a + d.tokens, 0), 1000);
  // 다시 압축되어 바뀌면(크기·수정 시각) 처음부터 다시 읽고 두 번 더하지 않는다. 캐시에서 이어 읽던 장부도 알아챈다.
  flushCache();
  ledgerTest.reset();
  rollout(8, { zst: true, output: 4000 });
  const again = collectCodexLedger({ budget: createBudget(), days: 30 });
  assert.equal(calls, 2);
  assert.deepEqual(again.paths, [p]);
  assert.equal(Object.values(again.days[0]).reduce((a, d) => a + d.tokens, 0), 4000);
});

test('zstd 없는 Node: 압축 기록은 건너뛰고 --doctor 에 읽지 못한 수와 필요한 Node 버전을 안내한다', { skip }, () => {
  zstd._test.setDecompress(null);
  rollout(9, { zst: true });
  rollout(10, { zst: true });
  rollout(11);
  const r = collectCodexLedger({ budget: createBudget(), days: 30 });
  assert.equal(r.paths.length, 3);
  assert.equal(r.pending, 0);
  const tokens = r.days.flatMap((d) => Object.values(d)).reduce((a, d) => a + d.tokens, 0);
  assert.equal(tokens, 1000);
  const t = checkTools().tools.codex;
  assert.equal(t.records, 3);
  assert.equal(t.zstUnread, 2);
  assert.match(describe(t, Date.now(), 'ko').hint, /^압축 기록 2개 읽지 못함 \(Node .+ 에 zstd 없음, Node 22\.15 이상 필요\)$/);
  assert.match(describe(t, Date.now(), 'en').hint, /^2 compressed logs not read \(Node .+ has no zstd, needs Node 22\.15 or later\)$/);
  zstd._test.reset();
  const ok = checkTools().tools.codex;
  assert.equal(ok.zstUnread, undefined);
  assert.equal(ok.hint, null);
});

test('압축 해제 크기 상한을 넘는 기록은 건너뛴다', { skip }, () => {
  const p = rollout(12, { zst: true, pad: 64 * 1024 });
  assert.equal(zstd.inflateZst(p, 1024).skip, 'toolarge');
  assert.ok(zstd.inflateZst(p).data.length > 64 * 1024);
  // 해제 함수가 상한 옵션을 받는지 (실제 기록도 같은 길로 읽는다).
  let max = null;
  zstd._test.setDecompress((buf, o) => {
    max = o.maxOutputLength;
    return zlib.zstdDecompressSync(buf, o);
  });
  new JsonlTail(p).read(() => {});
  assert.equal(max, zstd.ZST_MAX_BYTES);
  zstd._test.setDecompress(() => {
    throw Object.assign(new RangeError('too large'), { code: 'ERR_BUFFER_TOO_LARGE' });
  });
  const t = new JsonlTail(p);
  assert.equal(t.read(() => assert.fail('읽으면 안 된다')), 0);
  assert.equal(t.skipped, 'toolarge');
  assert.equal(t.done, true);
});

test('세션 리포트와 trace 찾기: 압축 기록의 이름·id 를 잡는다', { skip }, async () => {
  const p = rollout(13, { zst: true, name: '압축 세션' });
  const got = await collectSessions({ since: Date.now() - 10 * DAY });
  const book = got.books.find((b) => b.tool === 'codex');
  assert.equal(book.path, p);
  assert.equal(book.project, '/work/zst');
  assert.equal(got.extra.get(p).custom, '압축 세션');
  const f = await findTrace(id(13), { claudeRoots: [], codexRoots: [SESSIONS], agyRoot: join(root, 'agy-none') });
  assert.equal(f.tool, 'codex');
  assert.equal(f.id, id(13));
  assert.equal((await findTrace(p, { claudeRoots: [], codexRoots: [SESSIONS], agyRoot: join(root, 'agy-none') })).id, `rollout-2026-01-01T00-00-00-${id(13)}`);
  assert.ok(existsSync(p));
});
