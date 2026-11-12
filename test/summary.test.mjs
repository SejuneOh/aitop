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
  { tool: 'antigravity', live: true, status: 'waiting' },
  { tool: 'claude', live: true, status: 'idle' },
  { tool: 'claude', live: false, status: 'ended' },
  { tool: 'codex', live: false, status: 'busy' },
];

test('summarize 는 화면 헤더와 같은 기준으로 센다 (살아 있는 busy·shell 이 작업 중)', () => {
  assert.deepEqual(summarize(sessions, NOW), { v: 1, at: NOW, running: 2, waiting: 2, waitingOther: 1 });
  assert.deepEqual(summarize([], NOW), { v: 1, at: NOW, running: 0, waiting: 0, waitingOther: 0 });
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
  assert.deepEqual(pickCounts(null, 2), { waiting: 2, running: null });
  const s = summarize(sessions, NOW);
  // Claude 대기는 요약(1)이 아니라 지금 센 값(0)을 쓴다.
  assert.deepEqual(pickCounts(s, 0), { waiting: 1, running: 2 });
});

test('formatLine: run 은 wait 뒤, 시간당 지출 앞. 0 이나 null 이면 뺀다', () => {
  const v = { today: 54.13, waiting: 2, perHour: 3.14 };
  assert.equal(formatLine({ ...v, running: 3 }), '$54.13 wait 2 run 3 $3.1/h');
  assert.equal(formatLine({ ...v, running: 0 }), '$54.13 wait 2 $3.1/h');
  assert.equal(formatLine({ ...v, running: null }), '$54.13 wait 2 $3.1/h');
  assert.equal(formatLine({ ...v, running: 3 }, { width: 19 }), '$54.13 wait 2 run 3');
  assert.match(formatLine({ ...v, running: 3 }, { mode: 'tmux' }), /#\[fg=colour\d+\]run 3#\[default\]/);
});
