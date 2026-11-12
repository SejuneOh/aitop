// 프로세스 목록을 못 얻는 OS(Windows)에서는 최근에 바뀐 rollout 을 실행 중으로 본다 (#194).
// canList 를 바꿔 끼워 Linux 에서도 그 경로를 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeClaudeHome } from './fixture.mjs';

makeClaudeHome();
const root = mkdtempSync(join(tmpdir(), 'aitop-codex-noproc-'));
process.env.CODEX_HOME = join(root, 'codex');
const { collectCodex, NO_PROC_LIVE_MS } = await import('../src/sources/codex.mjs');

function rollout(name, cwd, ageMs, busy = false) {
  const d = new Date(Date.now() - ageMs);
  const dir = join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  const rows = [
    { type: 'session_meta', payload: { id: name, timestamp: d.toISOString(), cwd } },
    { timestamp: d.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50, total_tokens: 1050 }, last_token_usage: { total_tokens: 900 }, model_context_window: 258400 } } },
  ];
  if (busy) rows.push({ timestamp: d.toISOString(), type: 'event_msg', payload: { type: 'task_started' } });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

rollout('fresh', process.platform === 'win32' ? 'C:\\Users\\u\\dev\\fresh' : '/work/fresh', 60_000);
rollout('edge', '/work/edge', NO_PROC_LIVE_MS - 30_000);
rollout('old', '/work/old', NO_PROC_LIVE_MS + 60_000);

const blind = () => false;

test('프로세스를 못 세면 최근 기록을 pid 없는 실행 중 세션으로 보인다', () => {
  const rows = collectCodex({ showEnded: false, canList: blind });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['edge', 'fresh']);
  for (const r of rows) {
    assert.equal(r.live, true);
    assert.equal(r.pid, null);
    assert.ok(r.status === 'idle' || r.status === 'busy');
    assert.equal(r.tokens.total, 1050);
  }
  // 작업 폴더 이름이 잡힌다 (win32 는 \\ 경로)
  assert.equal(byId.fresh.project, 'fresh');
});

test('ended 를 보이면 오래된 기록은 종료로 남는다', () => {
  const rows = collectCodex({ showEnded: true, canList: blind });
  const st = Object.fromEntries(rows.map((r) => [r.id, r.status]));
  assert.equal(st.old, 'ended');
  assert.notEqual(st.fresh, 'ended');
  assert.notEqual(st.edge, 'ended');
});

test('프로세스를 셀 수 있으면 예전처럼 프로세스가 없을 때 아무것도 보이지 않는다', () => {
  // 이 테스트 PC 에서 codex 가 돌아도 이 임시 CODEX_HOME 의 기록과는 짝이 맞지 않는다.
  const rows = collectCodex({ showEnded: false, canList: () => true, filesOf: () => null, startOf: () => Date.now() + 3_600_000 });
  assert.equal(rows.filter((r) => ['fresh', 'edge', 'old'].includes(r.id)).length, 0);
});
