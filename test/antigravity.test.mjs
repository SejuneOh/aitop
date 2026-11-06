import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadSqlite } from '../src/sqlite.mjs';
import { canListProcesses } from '../src/procs.mjs';

// macOS 의 임시 폴더는 /private/var 로 가는 심볼릭 링크라, 실제 경로로 바뀌는 AGY_ROOT 와 맞추려고 처음부터 실제 경로를 쓴다.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'aitop-agy-')));
process.env.AITOP_AGY_HOME = root;
process.env.XDG_CACHE_HOME = join(root, 'cache');
mkdirSync(join(root, 'conversations'));
mkdirSync(join(root, 'presence'));

const { pbFields, readGeneration, readConversation, readStep, describeAgyTool, phaseOf, waitingFor, STEP, idFromPath, matchLive, agyRoot, parseTime, cwdOf, collectAgy } = await import('../src/sources/antigravity.mjs');
const { createBudget } = await import('../src/tail.mjs');

const sqlite = loadSqlite();
const noSqlite = !sqlite && 'agy 기록을 immutable 로 열 수 없는 Node (22.15 미만)';

// ---- protobuf 만들기 ----
const varint = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
const num = (f, v) => Buffer.concat([varint(f * 8), varint(v)]);
const bytes = (f, v) => {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
  return Buffer.concat([varint(f * 8 + 2), varint(b.length), b]);
};
// 실제 기록과 같은 모양: 1 → { 3 모델 번호, 17 → 2 → 사용량, 19 모델 이름 }, 앞뒤에 상관없는 필드.
function generation({ model = 'gemini-4-argon', input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  const usage = Buffer.concat([num(1, 1417), num(2, input), num(3, output), ...(cacheWrite ? [num(4, cacheWrite)] : []), num(5, cacheRead), num(6, 3), bytes(7, 'bot-x'), num(9, 1), num(10, Math.max(0, output - 1))]);
  const gen = Buffer.concat([num(3, 1319), bytes(4, 'x'.repeat(30)), bytes(17, bytes(2, usage)), bytes(19, model), bytes(20, 'tool')]);
  return Buffer.concat([bytes(2, '4'), bytes(4, 'uuid'), bytes(8, bytes(214280, 'cfg')), bytes(1, gen)]);
}

function makeConversation(id, gens) {
  const db = new sqlite.DatabaseSync(join(root, 'conversations', `${id}.db`));
  db.exec('create table if not exists gen_metadata (idx integer primary key, data blob, size integer not null default 0)');
  const ins = db.prepare('insert into gen_metadata (idx, data) values (?, ?)');
  const start = db.prepare('select coalesce(max(idx), -1) + 1 n from gen_metadata').get().n;
  gens.forEach((g, i) => ins.run(start + i, generation(g)));
  db.close();
}

// steps 한 줄. 실제 기록과 같은 모양: 1 종류, 4 상태, 5 메타 {1 만든 시각, 4 도구 호출}, 19 사용자 입력, 20 답변, 140 도구 결과.
const T0 = Date.UTC(2026, 10, 6, 2, 0, 0);
const stamp = (ms) => Buffer.concat([num(1, Math.floor(ms / 1000)), num(2, (ms % 1000) * 1e6 + 123)]);
const call = (name, args) => Buffer.concat([bytes(1, 'call_1'), bytes(2, name), bytes(3, JSON.stringify(args)), bytes(7, Buffer.from([1, 0xc8, 0x3d, 0x6b]))]);
const meta = (at, tool) => Buffer.concat([bytes(1, stamp(at)), num(3, 2), ...(tool ? [bytes(4, call(...tool))] : []), num(11, 1319), bytes(12, 'uuid'), bytes(35, 'hash')]);
function step({ type, status = 3, at = T0, text, tool }) {
  const parts = [num(1, type), num(4, status), bytes(5, meta(at, type === STEP.TOOL ? tool : null))];
  if (type === STEP.PROMPT) parts.push(bytes(19, Buffer.concat([bytes(2, text), bytes(3, `\n${text}`), bytes(4, '')])));
  if (type === STEP.REPLY) parts.push(bytes(20, Buffer.concat([...(text ? [bytes(1, text)] : []), bytes(3, '**Thinking**'), bytes(6, 'bot-x'), ...(tool ? [bytes(7, call(...tool))] : []), num(12, 2)])));
  if (type === STEP.TOOL) parts.push(bytes(140, bytes(1, Buffer.concat([bytes(1, 'Path'), bytes(2, '/x')]))));
  return Buffer.concat(parts);
}
const prompt = (text, at) => ({ type: STEP.PROMPT, text, at });
const reply = (text, tool, at) => ({ type: STEP.REPLY, text, tool, at });
const toolStep = (tool, status = 3, at) => ({ type: STEP.TOOL, tool, status, at });

function makeSteps(id, steps) {
  const db = new sqlite.DatabaseSync(join(root, 'conversations', `${id}.db`));
  db.exec(`create table if not exists steps (idx integer, step_type integer not null default 0, status integer not null default 0, has_subtrajectory numeric not null default false,
    metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer not null default 0, primary key (idx))`);
  const ins = db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)');
  const start = db.prepare('select coalesce(max(idx), -1) + 1 n from steps').get().n;
  steps.forEach((s, i) => ins.run(start + i, s.type, s.status ?? 3, Buffer.isBuffer(s.raw) ? s.raw : step(s)));
  db.close();
}

function setStep(id, idx, s) {
  const db = new sqlite.DatabaseSync(join(root, 'conversations', `${id}.db`));
  db.prepare('update steps set status = ?, step_payload = ? where idx = ?').run(s.status ?? 3, step(s), idx);
  db.close();
}

const kinds = (g) => g.events.map((e) => `${e.kind}:${e.text}`);

function makeSummaries(rows) {
  const db = new sqlite.DatabaseSync(join(root, 'conversation_summaries.db'));
  db.exec(`drop table if exists conversation_summaries;
    create table conversation_summaries (conversation_id text primary key, title text not null default '', step_count integer not null default 0,
      last_modified_time datetime not null, workspace_uris text not null, status text not null default '', agent_name text not null default '',
      parent_conversation_id text not null default '', nesting_depth integer not null default 0, not_fully_idle numeric not null default false,
      killed numeric not null default false)`);
  const ins = db.prepare('insert into conversation_summaries values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.title ?? '', r.steps ?? 1, r.modified, JSON.stringify(r.ws ?? []), r.status ?? 'CASCADE_RUN_STATUS_IDLE', r.agent ?? '', r.parent ?? '', r.parent ? 1 : 0, r.busy ? 1 : 0, 0);
  db.close();
}

const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00:00');

test('protobuf 맨 위 필드를 번호와 값으로 나눈다', () => {
  const f = pbFields(Buffer.concat([num(1, 300), bytes(2, 'hi'), Buffer.from([0x1d, 1, 2, 3, 4]), num(4, 7)]));
  assert.deepEqual(f.map(([n, v]) => [n, Buffer.isBuffer(v) ? v.toString() : v]), [[1, 300], [2, 'hi'], [4, 7]]);
  assert.throws(() => pbFields(Buffer.from([0x0a, 5, 1])), /truncated/);
});

test('gen_metadata 한 줄에서 모델과 토큰을 꺼낸다', () => {
  assert.deepEqual(readGeneration(generation({ model: 'gemini-3.8-flash', input: 3350, output: 83, cacheRead: 4945, cacheWrite: 2 })), {
    model: 'gemini-3.8-flash',
    usage: { input: 3350, output: 83, cacheWrite: 2, cacheRead: 4945 },
  });
  assert.equal(readGeneration(Buffer.from([0xff])), null, '깨진 기록은 건너뛴다');
  assert.deepEqual(readGeneration(bytes(1, bytes(19, 'm'))), { model: 'm', usage: null });
});

test('시각과 작업 폴더를 읽는다', () => {
  assert.equal(parseTime('2026-11-06 02:19:18.516555503+00:00'), Date.UTC(2026, 10, 6, 2, 19, 18, 516));
  assert.equal(parseTime('0001-01-01 00:00:00+00:00'), null);
  assert.equal(cwdOf('["file:///home/me/my%20work"]'), '/home/me/my work');
  assert.equal(cwdOf(''), null);
});

test('열린 파일 경로에서 대화 id 를 꺼낸다', () => {
  assert.equal(idFromPath(`${root}/presence/abc-1.lock`), 'abc-1');
  assert.equal(idFromPath(`${root}/conversations/abc-1.db-wal`), 'abc-1');
  assert.equal(idFromPath(`${root}/log/cli.log`), null);
  assert.equal(idFromPath(`/elsewhere/presence/abc-1.lock`), null);
});

test('agy 프로세스와 대화를 짝짓는다: 열린 파일, 서브에이전트는 부모로, /proc 이 없으면 작업 폴더', () => {
  const rows = [
    { id: 'top', parent: '', cwd: '/w' },
    { id: 'kid', parent: 'top', cwd: '/w' },
    { id: 'other', parent: '', cwd: '/x' },
  ];
  const files = { 1: [`${root}/presence/kid.lock`], 2: null, 3: [`${root}/log/a.log`] };
  const { live, loose } = matchLive([{ pid: 1, cwd: '/w' }, { pid: 2, cwd: '/x' }, { pid: 3, cwd: '/y' }], rows, (pid) => files[pid]);
  assert.deepEqual([...live], [['top', 1], ['other', 2]]);
  assert.deepEqual(loose.map((p) => p.pid), [3], '대화를 아직 열지 않은 프로세스');
});

test('기록 폴더를 /proc 링크와 같은 실제 절대 경로로 바꿔 짝짓는다: 끝의 /, 상대 경로, 심볼릭 링크', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'aitop-agy-root-')));
  const real = join(base, 'real');
  mkdirSync(join(real, 'presence'), { recursive: true });
  symlinkSync(base, join(base, 'gemini-link'));
  const opened = [`${real}/presence/top.lock`];
  const rows = [{ id: 'top', parent: '', cwd: '/w' }];
  for (const dir of [`${real}/`, relative(process.cwd(), real), join(base, 'gemini-link', 'real'), `${join(base, 'gemini-link', 'real')}/`]) {
    const r = agyRoot(dir);
    assert.equal(r, real, dir);
    assert.equal(idFromPath(opened[0], r), 'top', dir);
    const { live, loose } = matchLive([{ pid: 1, cwd: '/elsewhere' }], rows, () => opened, r);
    assert.deepEqual([...live], [['top', 1]], dir);
    assert.deepEqual(loose, [], dir);
  }
  assert.equal(agyRoot(`${base}/missing/`), join(base, 'missing'), '없는 폴더는 절대 경로까지만 바꾼다');
});

test('토큰은 호출마다 더하고, 새 줄만 이어 읽는다', { skip: noSqlite }, () => {
  makeConversation('u1', [{ input: 100, output: 10, cacheRead: 50 }, { input: 20, output: 5, cacheRead: 400, model: 'gemini-3.8-flash' }]);
  const g = readConversation('u1', createBudget());
  assert.deepEqual(g.tokens, { input: 120, output: 15, cacheRead: 450, cacheWrite: 0, total: 585 });
  assert.equal(g.model, 'gemini-3.8-flash');
  assert.equal(g.prompt, 420, '컨텍스트는 마지막 호출의 입력 + 캐시');
  makeConversation('u1', [{ input: 1, output: 1, cacheRead: 1 }]);
  assert.equal(readConversation('u1', createBudget()).tokens.total, 588);
});

test('기록을 읽어도 agy 폴더에 -wal·-shm 같은 파일을 만들지 않는다', { skip: noSqlite }, () => {
  const p = join(root, 'conversations', 'wal-1.db');
  const w = new sqlite.DatabaseSync(p);
  w.exec('pragma journal_mode=wal; create table gen_metadata (idx integer primary key, data blob, size integer not null default 0)');
  w.prepare('insert into gen_metadata (idx, data) values (0, ?)').run(generation({ input: 7, output: 3 }));
  w.close();
  const before = readdirSync(join(root, 'conversations')).filter((f) => f.startsWith('wal-1')).sort();
  assert.deepEqual(before, ['wal-1.db'], 'agy 가 닫히면 -wal·-shm 은 지워진다');
  assert.equal(readConversation('wal-1', createBudget()).tokens.total, 10);
  assert.deepEqual(readdirSync(join(root, 'conversations')).filter((f) => f.startsWith('wal-1')).sort(), before);

  // 새 호출을 본 파일에 합쳐 두고, agy 가 남긴 것처럼 빈 -wal 만 둔다. 이때도 -shm 을 만들거나 고치지 않는다.
  const w2 = new sqlite.DatabaseSync(p);
  w2.prepare('insert into gen_metadata (idx, data) values (1, ?)').run(generation({ input: 1, output: 1 }));
  w2.close();
  writeFileSync(`${p}-wal`, '');
  const files = () => readdirSync(join(root, 'conversations')).filter((f) => f.startsWith('wal-1')).sort().map((f) => [f, statSync(join(root, 'conversations', f)).mtimeMs]);
  const ready = files();
  assert.deepEqual(ready.map(([f]) => f), ['wal-1.db', 'wal-1.db-wal']);
  assert.equal(readConversation('wal-1', createBudget()).tokens.total, 12, '본 파일에 합쳐진 새 호출을 읽는다');
  assert.deepEqual(files(), ready, '파일 목록과 수정 시각이 그대로');
});

test('마지막 줄을 해석하지 못하면 건너뛰지 않고 다음 갱신에 다시 읽는다', { skip: noSqlite }, () => {
  makeConversation('torn-1', [{ input: 5, output: 5 }]);
  const db = new sqlite.DatabaseSync(join(root, 'conversations', 'torn-1.db'));
  db.prepare('insert into gen_metadata (idx, data) values (1, ?)').run(Buffer.from([0x0a, 0x7f, 1]));
  db.close();
  assert.equal(readConversation('torn-1', createBudget()).tokens.total, 10, '쓰는 중인 줄은 아직 세지 않는다');
  const db2 = new sqlite.DatabaseSync(join(root, 'conversations', 'torn-1.db'));
  db2.prepare('update gen_metadata set data = ? where idx = 1').run(generation({ input: 1, output: 2 }));
  db2.close();
  assert.equal(readConversation('torn-1', createBudget()).tokens.total, 13, '다 쓰인 뒤에는 그 줄도 센다');
});

test('읽기 한도에 닿으면 멈췄다가 다음 갱신에 이어 읽는다', { skip: noSqlite }, () => {
  makeConversation('u2', Array.from({ length: 70 }, () => ({ input: 1, output: 1 })));
  const b = createBudget(1, Infinity);
  const g = readConversation('u2', b);
  assert.ok(b.exhausted);
  assert.ok(g.tokens.total > 0 && g.tokens.total < 140);
  assert.equal(readConversation('u2', createBudget()).tokens.total, 140);
});

test('steps 한 줄에서 종류, 시각, 사용자 입력, 답변, 도구 호출을 꺼낸다', () => {
  assert.deepEqual(readStep(step(prompt('폴더 옮기는 법', T0 + 5))), { type: STEP.PROMPT, at: T0 + 5, text: '폴더 옮기는 법', tool: null });
  const r = readStep(step(reply(null, ['read_file', { Path: '/a/b/SKILL.md' }])));
  assert.equal(r.text, null, '도구만 부른 답변에는 글이 없다');
  assert.deepEqual(r.tool, { name: 'read_file', what: 'read_file SKILL.md' });
  assert.equal(readStep(step(reply('**완료**했습니다'))).text, '**완료**했습니다');
  assert.deepEqual(readStep(step(toolStep(['call_mcp_tool', { Arguments: {}, ServerName: 'cms', ToolName: 'whoami' }]))).tool, { name: 'call_mcp_tool', what: 'mcp cms/whoami' });
  assert.equal(readStep(Buffer.from([0x08, 0x0e, 0x2a, 0x7f, 1])), null, '잘린 줄');
  assert.equal(readStep(null), null);
});

test('agy 도구 호출을 한 줄로 줄인다', () => {
  assert.equal(describeAgyTool('run_command', { CommandLine: 'npm test' }), '$ npm test');
  assert.equal(describeAgyTool('read_file', { Path: '/home/me/x.md', EndLine: 50 }), 'read_file x.md');
  assert.equal(describeAgyTool('search_web', { query: 'agy' }), 'search_web agy');
  assert.equal(describeAgyTool('manage_task', {}), 'manage_task');
});

test('진행 기록: 지시, 답변, 도구 호출을 이어 읽고 지시마다 턴을 만든다', { skip: noSqlite }, () => {
  makeConversation('s1', [{ input: 10, output: 1 }]);
  makeSteps('s1', [prompt('mcp 연결 확인', T0), reply(null, ['read_file', { Path: '/m/whoami.json' }], T0 + 1000), toolStep(['read_file', { Path: '/m/whoami.json' }], 3, T0 + 2000), reply('연결 **정상**', null, T0 + 3000)]);
  const g = readConversation('s1', createBudget());
  assert.equal(g.tokens.total, 11, '토큰도 같은 열기에서 읽는다');
  assert.deepEqual(kinds(g), ['prompt:mcp 연결 확인', 'tool:read_file whoami.json', 'reply:연결 정상']);
  assert.equal(g.events[0].at, T0);
  assert.deepEqual(g.turns, [{ n: 1, at: T0, text: 'mcp 연결 확인' }]);
  assert.equal(g.lastTool, 'read_file whoami.json');

  makeSteps('s1', [prompt('글 올려 줘', T0 + 9000), toolStep(['run_command', { CommandLine: 'ls' }], 3, T0 + 9500)]);
  readConversation('s1', createBudget());
  assert.deepEqual(kinds(g).slice(3), ['prompt:글 올려 줘', 'tool:$ ls'], '새 줄만 더한다');
  assert.equal(g.events.length, 5);
  assert.deepEqual(g.turns.map((t) => [t.n, t.text]), [[1, 'mcp 연결 확인'], [2, '글 올려 줘']]);
});

test('진행 기록: 마지막 단계를 해석하지 못하면 다음 갱신에 다시 읽는다', { skip: noSqlite }, () => {
  makeSteps('s2', [prompt('하나'), { type: STEP.REPLY, raw: Buffer.from([0x08, 0x0f, 0x22, 0x7f, 1]) }]);
  const g = readConversation('s2', createBudget());
  assert.deepEqual(kinds(g), ['prompt:하나'], '쓰는 중인 줄은 아직 넣지 않는다');
  setStep('s2', 1, reply('둘'));
  assert.deepEqual(kinds(readConversation('s2', createBudget())), ['prompt:하나', 'reply:둘'], '다 쓰인 뒤에 한 번만 넣는다');
});

test('진행 기록: 아직 바뀌는 중인 단계는 상태가 끝날 때 넣고, 그 뒤 단계를 두 번 넣지 않는다', { skip: noSqlite }, () => {
  const mcp = ['call_mcp_tool', { ServerName: 'cms', ToolName: 'create' }];
  makeSteps('s3', [prompt('올려'), toolStep(mcp, 9), reply('기다리는 중 다른 답')]);
  const g = readConversation('s3', createBudget());
  assert.deepEqual(kinds(g), ['prompt:올려', 'reply:기다리는 중 다른 답']);
  assert.equal(g.open.status, 9);
  assert.equal(waitingFor(g), 'mcp cms/create', '허락을 기다리는 도구 호출');
  setStep('s3', 1, toolStep(mcp, 2));
  readConversation('s3', createBudget());
  assert.equal(waitingFor(g), null, '허락한 뒤에는 실행 중');
  assert.deepEqual(phaseOf(true, { running: true, steps: 3 }, g), { kind: 'write', text: '답변 작성 중' }, '더 뒤의 끝난 답변이 지금 하는 일');
  setStep('s3', 1, toolStep(mcp, 3));
  readConversation('s3', createBudget());
  assert.deepEqual(kinds(g), ['prompt:올려', 'reply:기다리는 중 다른 답', 'tool:mcp cms/create']);
  assert.equal(g.open, null);
  makeSteps('s3', [reply('끝')]);
  assert.deepEqual(kinds(readConversation('s3', createBudget())).slice(3), ['reply:끝']);
});

test('진행 기록: 앞의 명령이 도는 동안 뒤 단계가 허락을 기다리면 응답 대기다', { skip: noSqlite }, () => {
  const mcp = ['call_mcp_tool', { ServerName: 's', ToolName: 'del' }];
  makeSteps('s5', [toolStep(['run_command', { CommandLine: 'npm run dev' }], 2, T0), reply('x', null, T0 + 1000), toolStep(mcp, 9, T0 + 2000)]);
  const g = readConversation('s5', createBudget());
  assert.equal(waitingFor(g), 'mcp s/del');
  assert.equal(phaseOf(true, { running: true, steps: 3 }, g).text, '응답 대기 · mcp s/del');
  setStep('s5', 2, toolStep(mcp, 2, T0 + 2000));
  readConversation('s5', createBudget());
  assert.equal(waitingFor(g), null);
  assert.equal(phaseOf(true, { running: true, steps: 3 }, g).text, '도구 실행 · mcp s/del', '가장 뒤의 바뀌는 중인 단계');
});

test('진행 기록: 내용이 아직 빈 채로 바뀌는 중인 단계도 다 쓰인 뒤에 넣고, 시각 순서로 둔다', { skip: noSqlite }, () => {
  makeSteps('s6', [{ type: STEP.TOOL, status: 1, raw: Buffer.alloc(0) }, reply('나중 답', null, T0 + 5000)]);
  const g = readConversation('s6', createBudget());
  assert.deepEqual(kinds(g), ['reply:나중 답']);
  setStep('s6', 0, toolStep(['run_command', { CommandLine: 'echo hi' }], 3, T0));
  readConversation('s6', createBudget());
  assert.deepEqual(kinds(g), ['tool:$ echo hi', 'reply:나중 답']);
});

test('허락 대기를 본 뒤 -wal 이 바뀌면 agy 가 다시 쓰는 것이라 대기로 치지 않는다', { skip: noSqlite }, () => {
  const p = join(root, 'conversations', 's7.db');
  makeSteps('s7', [prompt('지워'), toolStep(['run_command', { CommandLine: 'rm x' }], 9)]);
  const g = readConversation('s7', createBudget());
  assert.equal(waitingFor(g), '$ rm x');
  writeFileSync(`${p}-wal`, '');
  readConversation('s7', createBudget());
  assert.equal(waitingFor(g), null, '-wal 이 생겼다');
  rmSync(`${p}-wal`);

  // 본 파일이 바뀌었는데 여전히 9 면 그때의 -wal 을 다시 기준으로 삼는다.
  makeSteps('s7', [reply('뒤 답')]);
  readConversation('s7', createBudget());
  assert.equal(waitingFor(g), '$ rm x', '본 파일이 아직 대기를 보인다');
  readConversation('s7', createBudget());
  assert.equal(waitingFor(g), '$ rm x', '-wal 이 그대로면 계속 대기');
  writeFileSync(`${p}-wal`, 'x'.repeat(100));
  readConversation('s7', createBudget());
  assert.equal(waitingFor(g), null, '-wal 이 커졌다');
  assert.equal(phaseOf(true, { running: true, steps: 3 }, g).kind, 'write', '바쁜 것으로 보인다');
  rmSync(`${p}-wal`);
});

test('토큰 마지막 줄이 쓰는 중이고 진행 기록이 읽기 한도에 닿아도 한도에 닿았다고 알린다', { skip: noSqlite }, () => {
  makeConversation('s8', [{ input: 1, output: 1 }]);
  const db = new sqlite.DatabaseSync(join(root, 'conversations', 's8.db'));
  db.prepare('insert into gen_metadata (idx, data) values (1, ?)').run(Buffer.from([0x0a, 0x7f, 1]));
  db.close();
  makeSteps('s8', Array.from({ length: 70 }, () => prompt('p')));
  const b = createBudget(1, Infinity);
  readConversation('s8', b);
  assert.ok(b.exhausted);
});

test('진행 기록: 읽기 한도에 닿으면 멈췄다가 빠짐없이 이어 읽는다', { skip: noSqlite }, () => {
  makeSteps('s4', Array.from({ length: 70 }, (_, i) => toolStep(['run_command', { CommandLine: `echo ${i}` }])));
  const b = createBudget(1, Infinity);
  const g = readConversation('s4', b);
  assert.ok(b.exhausted);
  assert.ok(g.events.length < 40);
  readConversation('s4', createBudget());
  assert.deepEqual(g.events.map((e) => e.text), Array.from({ length: 40 }, (_, i) => `$ echo ${i + 30}`), '최근 40개만 남긴다');
});

test('실행 중 단계: 마지막 단계로 지금 할 일을 보인다', () => {
  const r = { running: true, steps: 7 };
  const ph = (g) => phaseOf(true, r, { open: null, last: null, ...g }).text;
  assert.equal(ph({}), '작업 중 · 7단계', '단계를 읽지 못했으면 단계 수');
  assert.equal(ph({ last: { type: STEP.PROMPT } }), '생각 중');
  assert.equal(ph({ last: { type: STEP.TOOL, tool: { what: 'read_file a' } } }), '생각 중', '끝난 도구 호출 뒤에는 결과를 읽는다');
  assert.equal(ph({ last: { type: STEP.REPLY, tool: { what: '$ ls' } } }), '도구 실행 · $ ls', '답변이 낸 도구를 실행할 차례');
  assert.equal(ph({ last: { type: STEP.REPLY, tool: null } }), '답변 작성 중');
  assert.equal(ph({ open: { type: STEP.REPLY, status: 8 } }), '답변 작성 중');
  assert.equal(phaseOf(true, r, { open: null, last: { type: STEP.PROMPT } }, 2).text, '생각 중 · 에이전트 2개 실행 중');
  assert.deepEqual(phaseOf(true, { running: false }, { open: null, last: null }), { kind: 'idle', text: '다음 지시 대기' });
  assert.deepEqual(phaseOf(true, r, { open: { type: STEP.TOOL, status: 9 }, wait: { what: '$ rm x' } }), { kind: 'waiting', text: '응답 대기 · $ rm x' });
  assert.equal(phaseOf(false, r, { open: { type: STEP.TOOL, status: 9 }, wait: { what: '$ rm x' } }).text, '종료');
  assert.equal(ph({ open: { type: STEP.TOOL, idx: 1, tool: { what: 'npm run dev' } }, last: { type: STEP.REPLY, idx: 2, tool: { what: '$ ls' } } }), '도구 실행 · $ ls', '더 뒤의 단계가 지금 하는 일');
});

test('실행 중인 agy 를 대화와 짝지어 Gemini 세션으로 보인다', { skip: noSqlite || (!canListProcesses() && '프로세스 목록 미지원') || (process.platform !== 'linux' && '/proc 필요') }, async () => {
  const now = Date.now();
  makeConversation('live-1', [{ input: 500, output: 50, cacheRead: 1000 }]);
  makeConversation('kid-1', [{ input: 10, output: 5 }]);
  makeConversation('old-1', [{ input: 1, output: 1 }]);
  makeSteps('old-1', [prompt('지난 지시'), reply('지난 답')]);
  makeSummaries([
    { id: 'live-1', title: 'agy 작업', steps: 12, modified: ts(now - 1000), ws: ['file:///work/demo'], status: 'CASCADE_RUN_STATUS_RUNNING' },
    { id: 'kid-1', title: '하위 작업', modified: ts(now - 500), ws: ['file:///work/demo'], agent: 'article_writer', parent: 'live-1', status: 'CASCADE_RUN_STATUS_RUNNING' },
    { id: 'old-1', title: '지난 대화', modified: ts(now - 3600_000), ws: ['file:///work/old'] },
    { id: 'orphan-1', title: '부모 없는 하위', modified: ts(now - 7200_000), ws: ['file:///work/old'], agent: 'article_writer', parent: 'gone' },
  ]);
  const lock = join(root, 'presence', 'live-1.lock');
  writeFileSync(lock, '');
  // 이름이 agy 인 프로세스가 presence lock 을 열어 둔다.
  const script = `require('fs').openSync(${JSON.stringify(lock)}, 'r'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script], { argv0: 'agy', stdio: 'ignore' });
  try {
    let s;
    for (let i = 0; i < 40 && !s; i++) {
      await sleep(100);
      s = collectAgy({ showEnded: false, budget: createBudget() }).find((x) => x.id === 'live-1');
    }
    assert.ok(s, 'agy 세션을 찾는다');
    assert.equal(s.tool, 'gemini');
    assert.equal(s.pid, child.pid);
    assert.equal(s.name, 'agy 작업');
    assert.equal(s.cwd, '/work/demo');
    assert.equal(s.status, 'busy');
    assert.equal(s.phase.text, '작업 중 · 12단계 · 에이전트 1개 실행 중');
    assert.equal(s.model, 'gemini-4-argon');
    assert.equal(s.tokens.total, 1550 + 15);
    assert.equal(s.tokens.sub, 15);
    assert.equal(s.cost, null, 'Gemini 가격표가 없어 비용은 비운다');
    assert.ok(s.costUnknown);
    assert.equal(s.context.window, 1_048_576);
    assert.deepEqual(s.members.map((m) => [m.name, m.task, m.status, m.tokens]), [['article_writer', '하위 작업', 'busy', 15]]);

    assert.deepEqual(s.events, [], '진행 기록(steps)이 없는 대화');
    // 허락을 기다리는 도구 호출이 생기면 응답 대기로 보인다.
    makeSteps('live-1', [prompt('글 올려 줘', now - 900), toolStep(['call_mcp_tool', { ServerName: 'cms', ToolName: 'create' }], 9, now - 800)]);
    const w = collectAgy({ showEnded: false, budget: createBudget() }).find((x) => x.id === 'live-1');
    assert.equal(w.status, 'waiting');
    assert.equal(w.waitingFor, 'mcp cms/create');
    assert.equal(w.phase.text, '응답 대기 · mcp cms/create · 에이전트 1개 실행 중');
    assert.deepEqual(kinds(w), ['prompt:글 올려 줘']);
    assert.deepEqual(w.turns.map((t) => t.text), ['글 올려 줘']);

    const all = collectAgy({ showEnded: true, budget: createBudget() });
    const old = all.find((x) => x.id === 'old-1');
    assert.equal(old?.status, 'ended', '--all 이면 24시간 안의 지난 대화도 보인다');
    assert.deepEqual(kinds(old), ['prompt:지난 지시', 'reply:지난 답']);
    assert.equal(old.now, '지난 답');
    assert.equal(all.filter((x) => x.id === 'kid-1').length, 0, '서브에이전트는 따로 세지 않는다');
    assert.equal(all.find((x) => x.id === 'orphan-1')?.status, 'ended', '부모가 목록에 없는 서브에이전트는 혼자 보인다');
  } finally {
    child.kill();
  }
});
