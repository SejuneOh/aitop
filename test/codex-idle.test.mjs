// 하루 넘게 입력이 없던 codex 세션도 기록 파일과 짝지어 토큰을 보인다 (#94).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeClaudeHome } from './fixture.mjs';
import { canListProcesses, processStart } from '../src/procs.mjs';
import { phaseText } from '../src/i18n.mjs';

makeClaudeHome();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'aitop-codex-idle-')));
process.env.CODEX_HOME = join(root, 'codex');
const { collectCodex } = await import('../src/sources/codex.mjs');

const DAY = 86400_000;

// 세션 파일은 시작한 날짜 폴더(YYYY/MM/DD)에 있고, 마지막으로 쓴 지 ageMs 가 지났다.
function rollout(name, cwd, ageMs) {
  const d = new Date(Date.now() - ageMs);
  const dir = join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  const rows = [
    { type: 'session_meta', payload: { id: name, timestamp: d.toISOString(), cwd } },
    { timestamp: d.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50, total_tokens: 1050 }, last_token_usage: { total_tokens: 900 }, model_context_window: 258400 } } },
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

function project(name) {
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
}

// 이름이 codex 인 프로세스를 cwd 에서 띄운다. open 이 있으면 진짜 codex 처럼 그 파일을 열어 둔다.
function fakeCodex(cwd, open) {
  const script = `${open ? `require('fs').openSync(${JSON.stringify(open)}, 'a');` : ''} setInterval(() => {}, 1000);`;
  return spawn(process.execPath, ['-e', script], { argv0: 'codex', cwd, stdio: 'ignore' });
}

async function rowOf(pid, opts = {}) {
  let rows = [];
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    rows = collectCodex({ showEnded: false, budget: undefined, ...opts }).filter((r) => r.pid === pid);
    if (rows.length && rows[0].tokens.total > 0) break;
  }
  return rows;
}

const skip = !canListProcesses() && '이 OS 는 프로세스 목록을 지원하지 않음';
const linuxOnly = (!canListProcesses() || process.platform !== 'linux') && 'Linux /proc 에서만 열린 파일을 안다';

test('25시간 쉰 codex 세션은 프로세스가 열어 둔 기록 파일로 짝짓는다', { skip: linuxOnly }, async () => {
  const cwd = project('idle-day');
  const path = rollout('idle-day', cwd, 25 * 3600_000);
  const child = fakeCodex(cwd, path);
  try {
    const rows = await rowOf(child.pid);
    assert.equal(rows.length, 1, '빈 행과 세션 행이 겹치지 않는다');
    assert.equal(rows[0].id, 'idle-day');
    assert.notEqual(phaseText(rows[0]?.phase), '첫 입력 대기');
    assert.equal(rows[0].tokens.total, 1050);
    assert.equal(rows[0].context.used, 900);
  } finally {
    child.kill();
  }
});

test('열린 파일을 모르는 OS 에서는 일주일보다 오래된 날짜 폴더에서 같은 작업 폴더의 기록을 찾는다', { skip }, async () => {
  const cwd = project('idle-week');
  rollout('idle-week-older', cwd, 12 * DAY);
  rollout('idle-week', cwd, 10 * DAY);
  rollout('elsewhere', join(root, 'other'), 9 * DAY);
  const child = fakeCodex(cwd);
  try {
    const rows = await rowOf(child.pid, { filesOf: () => null, startOf: () => Date.now() - 30 * DAY });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'idle-week', '같은 작업 폴더에서 가장 최근에 바뀐 파일');
    assert.equal(rows[0].tokens.total, 1050);
  } finally {
    child.kill();
  }
});

test('열린 파일에 기록이 없어도, 프로세스가 시작한 뒤 쓰인 같은 작업 폴더의 오래 쉰 기록을 찾는다', { skip }, async () => {
  const cwd = project('idle-closed');
  rollout('idle-closed', cwd, 25 * 3600_000);
  const child = fakeCodex(cwd);
  try {
    const rows = await rowOf(child.pid, { startOf: () => Date.now() - 2 * DAY });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'idle-closed');
    assert.equal(rows[0].tokens.total, 1050);
  } finally {
    child.kill();
  }
});

test('새 codex 프로세스는 시작 전에 쓰인 같은 작업 폴더의 기록을 붙이지 않고 첫 입력 대기로 보인다', { skip }, async () => {
  const cwd = project('fresh');
  rollout('fresh-old', cwd, 3 * DAY);
  const child = fakeCodex(cwd);
  try {
    let rows = [];
    for (let i = 0; i < 40 && !rows.length; i++) {
      await sleep(100);
      rows = collectCodex({ showEnded: false, budget: undefined }).filter((r) => r.pid === child.pid);
    }
    const started = processStart(child.pid);
    assert.ok(started !== null && Math.abs(Date.now() - started) < 60_000, '프로세스 시작 시각을 읽는다');
    assert.equal(rows.length, 1);
    assert.equal(phaseText(rows[0]?.phase), '첫 입력 대기');
    assert.equal(rows[0].tokens.total, 0);
  } finally {
    child.kill();
  }
});

test('처음엔 기록이 없던 codex 도 나중에 생긴 기록이 하루 넘게 쉬면 그 기록으로 짝짓는다', { skip }, async () => {
  const cwd = project('later');
  const child = fakeCodex(cwd);
  const opts = { startOf: () => Date.now() - 3 * DAY };
  try {
    let rows = [];
    for (let i = 0; i < 40 && !rows.length; i++) {
      await sleep(100);
      rows = collectCodex({ showEnded: false, budget: undefined, ...opts }).filter((r) => r.pid === child.pid);
    }
    assert.equal(phaseText(rows[0]?.phase), '첫 입력 대기');
    rollout('later', cwd, 25 * 3600_000);
    rows = await rowOf(child.pid, opts);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'later');
    assert.equal(rows[0].tokens.total, 1050);
  } finally {
    child.kill();
  }
});

test('같은 폴더의 codex 두 개는 각자 열어 둔 기록과 짝짓는다', { skip: linuxOnly }, async () => {
  // 프로세스 목록 순서와 상관없이 확인하도록, 쉬는 쪽을 먼저 띄운 폴더와 나중에 띄운 폴더를 둘 다 둔다.
  const kids = [];
  const want = [];
  for (const idleFirst of [true, false]) {
    const cwd = project(`two-${idleFirst}`);
    const idle = rollout(`idle-${idleFirst}`, cwd, 25 * 3600_000);
    const busy = rollout(`busy-${idleFirst}`, cwd, 60_000);
    for (const [path, id] of idleFirst ? [[idle, `idle-${idleFirst}`], [busy, `busy-${idleFirst}`]] : [[busy, `busy-${idleFirst}`], [idle, `idle-${idleFirst}`]]) {
      const child = fakeCodex(cwd, path);
      kids.push(child);
      want.push([child.pid, id]);
      await sleep(100);
    }
  }
  const pids = new Set(kids.map((k) => k.pid));
  // 세션 파일 목록은 5초 동안 재사용되므로, 방금 만든 파일까지 목록에 들어온 뒤에 확인한다.
  await sleep(5100);
  try {
    let rows = [];
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      rows = collectCodex({ showEnded: false, budget: undefined }).filter((r) => pids.has(r.pid));
      if (rows.length === 4 && rows.every((r) => r.tokens.total > 0)) break;
    }
    const byPid = (x, y) => x[0] - y[0];
    assert.deepEqual(rows.map((r) => [r.pid, r.id]).sort(byPid), want.sort(byPid));
  } finally {
    for (const k of kids) k.kill();
  }
});

test('두 시간 전에 끝난 세션이 있는 폴더에서 새로 띄운 codex 는 첫 입력 대기로 보인다', { skip }, async () => {
  const cwd = project('ended-2h');
  rollout('ended-2h', cwd, 2 * 3600_000);
  const child = fakeCodex(cwd);
  // 세션 파일 목록은 5초 동안 재사용되므로, 방금 만든 파일까지 목록에 들어온 뒤에 확인한다.
  await sleep(5100);
  try {
    let rows = [];
    for (let i = 0; i < 40 && !rows.length; i++) {
      await sleep(100);
      rows = collectCodex({ showEnded: false, budget: undefined }).filter((r) => r.pid === child.pid);
    }
    assert.equal(rows.length, 1);
    assert.equal(phaseText(rows[0]?.phase), '첫 입력 대기');
    assert.equal(rows[0].tokens.total, 0);
  } finally {
    child.kill();
  }
});
