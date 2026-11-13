// --line 용 요약 파일: 새 요약/오래된 요약/없음/깨짐, 쓰기 간격 조절, 작업 중·대기 수 고르기.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, writeSummary, readSummary, createSummaryWriter, STALE_MS, MIN_WRITE_MS, HEARTBEAT_MS } from '../src/summary.mjs';
import { pickCounts, formatLine } from '../src/line.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'aitop-summary-'));
const NOW = 1_800_000_000_000;
const sessions = [
  { tool: 'claude', live: true, status: 'busy' },
  { tool: 'codex', live: true, status: 'shell' },
  { tool: 'claude', live: true, status: 'waiting' },
  { tool: 'antigravity', live: true, status: 'waiting', name: 'gemini-gen', updatedAt: NOW - 120_000 },
  { tool: 'claude', live: true, status: 'idle' },
  { tool: 'claude', live: false, status: 'ended' },
  { tool: 'codex', live: false, status: 'busy' },
];

test('summarize 는 화면 헤더와 같은 기준으로 센다 (살아 있는 busy·shell 이 작업 중)', () => {
  assert.deepEqual(summarize(sessions, NOW), { v: 1, at: NOW, running: 2, waiting: 2, waitingOther: 1, waitTop: [{ tool: 'antigravity', name: 'gemini-gen', since: NOW - 120_000 }] });
  assert.deepEqual(summarize([], NOW), { v: 1, at: NOW, running: 0, waiting: 0, waitingOther: 0, waitTop: [] });
});

test('waitTop: Claude 를 뺀 대기 세션 중 오래 기다린 순서로 둘까지', () => {
  const agy = (name, ago) => ({ tool: 'antigravity', live: true, status: 'waiting', name, updatedAt: NOW - ago });
  const s = summarize([agy('b', 10_000), agy('a', 90_000), agy('c', 50_000), { tool: 'claude', live: true, status: 'waiting', name: 'cl', updatedAt: NOW - 999_000 }, { ...agy('gone', 999_000), live: false }], NOW);
  assert.deepEqual(s.waitTop.map((w) => w.name), ['a', 'c']);
  assert.equal(s.waitingOther, 3);
});

test('waitTop: 대기 시작 시각을 모르면(waitSince null) since 를 null 로 두고 맨 뒤로, 쓰기도 매번 하지 않는다', () => {
  const agy = (name, extra) => ({ tool: 'gemini', live: true, status: 'waiting', name, updatedAt: NOW, ...extra });
  const s = summarize([agy('unknown', { waitSince: null }), agy('known', { waitSince: NOW - 60_000 })], NOW);
  assert.deepEqual(s.waitTop.map((w) => [w.name, w.since]), [['known', NOW - 60_000], ['unknown', null]]);
  const file = join(dir(), 'summary.json');
  writeSummary(s, file);
  assert.deepEqual(readSummary({ file, now: NOW }).waitTop, s.waitTop, 'since null 도 읽는다');
  // 시각을 모르면 대기 시간을 뺀다.
  assert.equal(formatLine({ waiting: 1, longest: { name: 'unknown', since: null } }, { now: NOW }), 'wait unknown');
  // 화면이 매 갱신 지금 시각(updatedAt)을 새로 넣어도 waitSince 가 null 이면 바뀐 것으로 보지 않는다.
  const w = createSummaryWriter({ write: () => true });
  w([agy('u', { waitSince: null, updatedAt: NOW })], NOW);
  assert.equal(w([agy('u', { waitSince: null, updatedAt: NOW + MIN_WRITE_MS })], NOW + MIN_WRITE_MS), false);
});

test('waitTop 이 없는 예전 요약도 읽고(빈 목록), 형식이 틀린 항목만 버린다', () => {
  const file = join(dir(), 'summary.json');
  const old = { v: 1, at: NOW, running: 1, waiting: 1, waitingOther: 1 };
  writeFileSync(file, JSON.stringify(old));
  assert.deepEqual(readSummary({ file, now: NOW }), { ...old, waitTop: [] });
  writeFileSync(file, JSON.stringify({ ...old, waitTop: [{ name: 'ok', since: NOW }, { name: 3, since: NOW }, { name: 'x' }, null, { name: 'ok2', since: NOW }, { name: 'ok3', since: NOW }] }));
  assert.deepEqual(readSummary({ file, now: NOW }).waitTop.map((w) => w.name), ['ok', 'ok2']);
  writeFileSync(file, JSON.stringify({ ...old, waitTop: 'bad' }));
  assert.deepEqual(readSummary({ file, now: NOW }).waitTop, []);
});

test('새 요약은 읽고, 임시 파일을 남기지 않는다', () => {
  const d = dir();
  const file = join(d, 'sub', 'summary.json');
  assert.equal(writeSummary(summarize(sessions, NOW), file), true);
  assert.deepEqual(readSummary({ file, now: NOW + 1000 }), summarize(sessions, NOW));
  assert.deepEqual(readdirSync(join(d, 'sub')), ['summary.json']);
});

test('오래된 요약은 버린다 (경계는 STALE_MS)', () => {
  const file = join(dir(), 'summary.json');
  writeSummary(summarize(sessions, NOW), file);
  assert.ok(readSummary({ file, now: NOW + STALE_MS }));
  assert.equal(readSummary({ file, now: NOW + STALE_MS + 1 }), null);
  // 미래 시각(시계가 크게 어긋남)도 믿지 않는다.
  assert.equal(readSummary({ file, now: NOW - 60_000 }), null);
});

test('없거나 깨졌거나 형식이 다르면 조용히 null', () => {
  const d = dir();
  assert.equal(readSummary({ file: join(d, 'none.json'), now: NOW }), null);
  const bad = join(d, 'bad.json');
  for (const body of ['', '{', 'null', '[]', JSON.stringify({ v: 2, at: NOW, running: 1, waiting: 0, waitingOther: 0 }), JSON.stringify({ v: 1, at: NOW, running: -1, waiting: 0, waitingOther: 0 }), JSON.stringify({ v: 1, at: 'x', running: 1, waiting: 0, waitingOther: 0 }), JSON.stringify({ v: 1, at: NOW, running: 1.5, waiting: 0, waitingOther: 0 })]) {
    writeFileSync(bad, body);
    assert.equal(readSummary({ file: bad, now: NOW }), null, body);
  }
});

test('쓰기 실패(폴더 자리에 파일)는 false 를 돌려주고 던지지 않는다', () => {
  const d = dir();
  writeFileSync(join(d, 'f'), 'x');
  assert.equal(writeSummary(summarize([], NOW), join(d, 'f', 'summary.json')), false);
});

test('쓰기 간격: 처음엔 바로, 수가 바뀌면 MIN_WRITE_MS 뒤에, 그대로면 HEARTBEAT_MS 마다', () => {
  const writes = [];
  const w = createSummaryWriter({ write: (s) => (writes.push(s), true) });
  const busy = [{ tool: 'claude', live: true, status: 'busy' }];
  assert.equal(w(busy, NOW), true);
  assert.equal(w(busy, NOW + 1000), false);
  assert.equal(w([], NOW + 1000), false, '바뀌었어도 너무 이르면 미룬다');
  assert.equal(w([], NOW + MIN_WRITE_MS), true, '간격이 지나면 바뀐 수를 쓴다');
  assert.equal(w([], NOW + MIN_WRITE_MS + HEARTBEAT_MS - 1), false);
  assert.equal(w([], NOW + MIN_WRITE_MS + HEARTBEAT_MS), true, '그대로여도 시각을 새로 적는다');
  assert.deepEqual(writes.map((s) => s.running), [1, 0, 0]);
  // 기다리는 세션이 바뀌면(수는 같아도) 바뀐 것으로 본다.
  const agy = (name) => [{ tool: 'antigravity', live: true, status: 'waiting', name, updatedAt: NOW }];
  const w2 = createSummaryWriter({ write: () => true });
  w2(agy('a'), NOW);
  assert.equal(w2(agy('b'), NOW + MIN_WRITE_MS), true);
  assert.ok(HEARTBEAT_MS * 2 < STALE_MS, '한 번 놓쳐도 오래된 요약이 되지 않는다');
});

test('쓰기에 실패하면 다음 갱신에서 다시 쓴다', () => {
  let ok = false;
  let n = 0;
  const w = createSummaryWriter({ write: () => (n++, ok) });
  assert.equal(w([], NOW), false);
  ok = true;
  assert.equal(w([], NOW + 1), true);
  assert.equal(n, 2);
});

test('실제 파일로: 여러 번 써도 파일은 하나이고 마지막 값이 남는다', () => {
  const d = dir();
  const file = join(d, 'summary.json');
  const w = createSummaryWriter({ file, minMs: 0 });
  w(sessions, NOW);
  w([], NOW + 1);
  assert.deepEqual(readdirSync(d), ['summary.json']);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).running, 0);
});

test('pickCounts: 요약이 없으면 작업 중은 빼고 Claude 대기만, 있으면 다른 도구 대기를 더한다', () => {
  const cl = [{ tool: 'claude', name: 'fix-login', since: NOW - 30_000 }, { tool: 'claude', name: 'old', since: NOW - 300_000 }];
  assert.deepEqual(pickCounts(null, cl), { waiting: 2, longest: { name: 'old', since: NOW - 300_000 }, running: null });
  assert.deepEqual(pickCounts(null, []), { waiting: 0, longest: null, running: null });
  const s = summarize(sessions, NOW);
  // Claude 대기는 요약(1)이 아니라 지금 찾은 값(없음)을 쓰고, 이름은 요약의 다른 도구 몫에서.
  assert.deepEqual(pickCounts(s, []), { waiting: 1, longest: { name: 'gemini-gen', since: NOW - 120_000 }, running: 2 });
  // 둘을 합쳐 대기 시작이 가장 이른 세션을 고른다.
  assert.equal(pickCounts(s, cl).longest.name, 'old');
  assert.equal(pickCounts(s, cl.slice(0, 1)).longest.name, 'gemini-gen');
  // 시각을 모르는 세션은 맨 뒤.
  assert.equal(pickCounts(null, [{ name: 'x', since: null }, { name: 'y', since: NOW }]).longest.name, 'y');
});

test('formatLine: run 은 wait 뒤, 시간당 지출 앞. 0 이나 null 이면 뺀다', () => {
  const v = { today: 54.13, waiting: 2, perHour: 3.14 };
  assert.equal(formatLine({ ...v, running: 3 }), '$54.13 wait 2 run 3 $3.1/h');
  assert.equal(formatLine({ ...v, running: 0 }), '$54.13 wait 2 $3.1/h');
  assert.equal(formatLine({ ...v, running: null }), '$54.13 wait 2 $3.1/h');
  assert.equal(formatLine({ ...v, running: 3 }, { width: 19 }), '$54.13 wait 2 run 3');
  assert.match(formatLine({ ...v, running: 3 }, { mode: 'tmux' }), /#\[fg=colour\d+\]run 3#\[default\]/);
});
