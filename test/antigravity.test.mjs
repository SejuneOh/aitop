import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadSqlite } from '../src/sqlite.mjs';
import { canListProcesses } from '../src/procs.mjs';

const root = mkdtempSync(join(tmpdir(), 'aitop-agy-'));
process.env.AITOP_AGY_HOME = root;
process.env.XDG_CACHE_HOME = join(root, 'cache');
mkdirSync(join(root, 'conversations'));
mkdirSync(join(root, 'presence'));

const { pbFields, readGeneration, readUsage, idFromPath, matchLive, parseTime, cwdOf, collectAgy } = await import('../src/sources/antigravity.mjs');
const { createBudget } = await import('../src/tail.mjs');

const sqlite = loadSqlite();
const noSqlite = !sqlite && 'node:sqlite 가 없는 Node';

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

test('토큰은 호출마다 더하고, 새 줄만 이어 읽는다', { skip: noSqlite }, () => {
  makeConversation('u1', [{ input: 100, output: 10, cacheRead: 50 }, { input: 20, output: 5, cacheRead: 400, model: 'gemini-3.8-flash' }]);
  const g = readUsage('u1', createBudget());
  assert.deepEqual(g.tokens, { input: 120, output: 15, cacheRead: 450, cacheWrite: 0, total: 585 });
  assert.equal(g.model, 'gemini-3.8-flash');
  assert.equal(g.prompt, 420, '컨텍스트는 마지막 호출의 입력 + 캐시');
  makeConversation('u1', [{ input: 1, output: 1, cacheRead: 1 }]);
  assert.equal(readUsage('u1', createBudget()).tokens.total, 588);
});

test('기록을 읽어도 agy 폴더에 -wal·-shm 같은 파일을 만들지 않는다', { skip: noSqlite }, () => {
  const p = join(root, 'conversations', 'wal-1.db');
  const w = new sqlite.DatabaseSync(p);
  w.exec('pragma journal_mode=wal; create table gen_metadata (idx integer primary key, data blob, size integer not null default 0)');
  w.prepare('insert into gen_metadata (idx, data) values (0, ?)').run(generation({ input: 7, output: 3 }));
  w.close();
  const before = readdirSync(join(root, 'conversations')).filter((f) => f.startsWith('wal-1')).sort();
  assert.deepEqual(before, ['wal-1.db'], 'agy 가 닫히면 -wal·-shm 은 지워진다');
  assert.equal(readUsage('wal-1', createBudget()).tokens.total, 10);
  assert.deepEqual(readdirSync(join(root, 'conversations')).filter((f) => f.startsWith('wal-1')).sort(), before);

  // 새 호출을 본 파일에 합쳐 두고, agy 가 남긴 것처럼 빈 -wal 만 둔다. 이때도 -shm 을 만들거나 고치지 않는다.
  const w2 = new sqlite.DatabaseSync(p);
  w2.prepare('insert into gen_metadata (idx, data) values (1, ?)').run(generation({ input: 1, output: 1 }));
  w2.close();
  writeFileSync(`${p}-wal`, '');
  const files = () => readdirSync(join(root, 'conversations')).filter((f) => f.startsWith('wal-1')).sort().map((f) => [f, statSync(join(root, 'conversations', f)).mtimeMs]);
  const ready = files();
  assert.deepEqual(ready.map(([f]) => f), ['wal-1.db', 'wal-1.db-wal']);
  assert.equal(readUsage('wal-1', createBudget()).tokens.total, 12, '본 파일에 합쳐진 새 호출을 읽는다');
  assert.deepEqual(files(), ready, '파일 목록과 수정 시각이 그대로');
});

test('읽기 한도에 닿으면 멈췄다가 다음 갱신에 이어 읽는다', { skip: noSqlite }, () => {
  makeConversation('u2', Array.from({ length: 70 }, () => ({ input: 1, output: 1 })));
  const b = createBudget(1, Infinity);
  const g = readUsage('u2', b);
  assert.ok(b.exhausted);
  assert.ok(g.tokens.total > 0 && g.tokens.total < 140);
  assert.equal(readUsage('u2', createBudget()).tokens.total, 140);
});

test('실행 중인 agy 를 대화와 짝지어 Gemini 세션으로 보인다', { skip: noSqlite || (!canListProcesses() && '프로세스 목록 미지원') || (process.platform !== 'linux' && '/proc 필요') }, async () => {
  const now = Date.now();
  makeConversation('live-1', [{ input: 500, output: 50, cacheRead: 1000 }]);
  makeConversation('kid-1', [{ input: 10, output: 5 }]);
  makeConversation('old-1', [{ input: 1, output: 1 }]);
  makeSummaries([
    { id: 'live-1', title: 'agy 작업', steps: 12, modified: ts(now - 1000), ws: ['file:///work/demo'], status: 'CASCADE_RUN_STATUS_RUNNING' },
    { id: 'kid-1', title: '하위 작업', modified: ts(now - 500), ws: ['file:///work/demo'], agent: 'article_writer', parent: 'live-1', status: 'CASCADE_RUN_STATUS_RUNNING' },
    { id: 'old-1', title: '지난 대화', modified: ts(now - 3600_000), ws: ['file:///work/old'] },
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

    const all = collectAgy({ showEnded: true, budget: createBudget() });
    assert.equal(all.find((x) => x.id === 'old-1')?.status, 'ended', '--all 이면 24시간 안의 지난 대화도 보인다');
    assert.equal(all.filter((x) => x.id === 'kid-1').length, 0, '서브에이전트는 따로 세지 않는다');
  } finally {
    child.kill();
  }
});
