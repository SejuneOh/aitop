// STATUS 의 도구 이름 옆에 지금 도구가 돌고 있는 시간 (#242).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { ClaudeTracker } = await import('../src/sources/claude-tracker.mjs');
const { _test: codex } = await import('../src/sources/codex.mjs');
const { toolStartOf: agyToolStart, phaseOf: agyPhase, STEP } = await import('../src/sources/antigravity.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { flushCache, CACHE_DIR } = await import('../src/cache.mjs');
const { toJson } = await import('../src/json.mjs');
const { toolElapsed, TOOL_LONG_MS, setNow } = await import('../src/ui/draw.mjs');
const { statusCell, sessionRow, columns } = await import('../src/ui/table.mjs');
const { animating } = await import('../src/ui.mjs');
const { PALETTE } = await import('../src/ui/theme.mjs');
const { width } = await import('../src/text.mjs');

const run = () => collectClaude({ showEnded: false, budget: createBudget() });
const S = 1000;
const M = 60 * S;
const at = (ms) => new Date(ms).toISOString();
const text = (segs) => segs.map((x) => x.t).join('');
const bash = (id, tid, ms, command = 'npm test') => ({ ...assistant(id, [{ type: 'tool_use', id: tid, name: 'Bash', input: { command } }], usage(1, 1)), timestamp: at(ms) });
const result = (tid, ms) => ({ ...user([{ type: 'tool_result', tool_use_id: tid, content: 'ok' }]), timestamp: at(ms) });
const ask = (ms) => ({ ...user('테스트 돌려'), timestamp: at(ms) });

test('Claude: 열린 tool_use 의 시각이 시작 시각이고, 결과가 오면 사라진다', () => {
  const now = Date.now();
  fx.session({ sessionId: 'te-busy', status: 'busy' });
  const p = fx.transcript('te-busy', [ask(now - 5 * M), bash('m1', 'tu1', now - 4 * M)]);
  let s = run().find((x) => x.id === 'te-busy');
  assert.equal(s.phase.kind, 'tool');
  assert.equal(s.toolStartedAt, now - 4 * M);
  assert.equal(toJson({ sessions: [s], usage: null }).sessions[0].toolStartedAt, at(now - 4 * M));
  fx.append(p, [result('tu1', now - S)]);
  s = run().find((x) => x.id === 'te-busy');
  assert.equal(s.toolStartedAt, null, '결과가 오면 생각 중');
  assert.equal(toJson({ sessions: [s], usage: null }).sessions[0].toolStartedAt, null);
});

test('Claude: 허락 대기 중에는 두지 않고, 허락한 뒤에는 대기를 마지막으로 본 때부터 잰다', () => {
  const now = Date.now();
  fx.session({ sessionId: 'te-wait', status: 'busy', waitingFor: 'approve Bash' });
  fx.transcript('te-wait', [ask(now - 9 * M), bash('m1', 'tu1', now - 8 * M)]);
  const waiting = run().find((x) => x.id === 'te-wait');
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.toolStartedAt, null);
  const seen = Date.now();
  fx.session({ sessionId: 'te-wait', status: 'busy' });
  const s = run().find((x) => x.id === 'te-wait');
  assert.ok(s.toolStartedAt >= seen - S && s.toolStartedAt <= Date.now(), '대기 8분은 세지 않는다');
});

test('Claude: 쉘 명령(! 입력)·다음 지시 대기에는 없다', () => {
  const now = Date.now();
  for (const [id, status] of [['te-shell', 'shell'], ['te-idle', 'idle']]) {
    fx.session({ sessionId: id, status });
    fx.transcript(id, [ask(now - 5 * M), bash(`${id}-m`, `${id}-t`, now - 4 * M)]);
    assert.equal(run().find((x) => x.id === id).toolStartedAt, null, id);
  }
});

test('Claude: 시작 시각은 캐시에 저장되고, 이 필드가 없던 캐시는 기록 끝에서 한 번 채운다', () => {
  const T0 = Date.parse('2026-11-16T10:00:00.000Z');
  const p = fx.transcript('te-cache', [ask(T0), bash('c1', 'ct1', T0 + 3 * S)]);
  new ClaudeTracker(p).update();
  flushCache();
  assert.equal(new ClaudeTracker(p).toolStartedAt(), T0 + 3 * S);
  const file = join(CACHE_DIR, createHash('sha1').update(`\0${p}`).digest('hex') + '.json');
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const [, v] of c.pending) delete v.at;
  writeFileSync(file, JSON.stringify(c));
  const old = new ClaudeTracker(p);
  assert.equal(old.toolStartedAt(), T0 + 3 * S);
  flushCache();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pending[0][1].at, T0 + 3 * S, '다시 적어 두어 다음엔 훑지 않는다');
});

test('Codex: 열린 function_call 의 시각, 출력이 오거나 턴이 끝나면 없음. 캐시에 남는다', () => {
  const T0 = Date.parse('2026-11-16T10:00:00.000Z');
  const st = codex.newState('/x/rollout-te.jsonl');
  codex.applyLine(st, { type: 'event_msg', payload: { type: 'task_started' } });
  codex.applyLine(st, { type: 'response_item', timestamp: at(T0), payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["npm","test"]}' } });
  let phase = codex.phaseOf(st, true);
  assert.equal(phase.kind, 'tool');
  assert.equal(codex.toolStartOf(st, phase), T0);
  assert.deepEqual(codex.snapshot(st).pendingAt, { c1: T0 });
  codex.applyLine(st, { type: 'response_item', timestamp: at(T0 + M), payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '' } });
  assert.equal(codex.toolStartOf(st, codex.phaseOf(st, true)), T0 + M, '마지막 열린 호출');
  codex.applyLine(st, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'ok' } });
  assert.equal(codex.toolStartOf(st, codex.phaseOf(st, true)), T0);
  codex.applyLine(st, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } });
  phase = codex.phaseOf(st, true);
  assert.equal(codex.toolStartOf(st, phase), null);
  codex.applyLine(st, { type: 'response_item', timestamp: at(T0), payload: { type: 'function_call', name: 'shell', call_id: 'c3', arguments: '{}' } });
  codex.applyLine(st, { type: 'event_msg', payload: { type: 'task_complete' } });
  assert.deepEqual(st.pendingAt, {});
});

test('agy: 바뀌는 중인 도구 단계를 만든 시각, 허락 대기를 본 단계는 그 뒤부터, 실행할 차례(답변이 낸 호출)는 없음', () => {
  const T0 = Date.parse('2026-11-16T10:00:00.000Z');
  const tool = { type: STEP.TOOL, at: T0, idx: 5, status: 2, tool: { name: 'run_command', what: 'npm test' } };
  const g = { open: tool, last: { idx: 4, type: STEP.REPLY }, wait: null };
  const phase = agyPhase(true, { running: true, steps: 5 }, g);
  assert.equal(phase.kind, 'tool');
  assert.equal(agyToolStart(phase, g), T0);
  assert.equal(agyToolStart(phase, { ...g, resume: { idx: 5, at: T0 + 3 * M } }), T0 + 3 * M);
  assert.equal(agyToolStart(phase, { ...g, resume: { idx: 2, at: T0 + 3 * M } }), T0, '다른 단계의 대기는 상관없다');
  const reply = { open: null, last: { idx: 4, type: STEP.REPLY, tool: { what: 'npm test' } } };
  const p2 = agyPhase(true, { running: true, steps: 5 }, reply);
  assert.equal(p2.kind, 'tool');
  assert.equal(agyToolStart(p2, reply), null);
});

const sess = (extra) => ({ id: 'a', tool: 'claude', live: true, status: 'busy', phase: { kind: 'tool', args: { what: 'Bash' } }, tokens: { total: 10 }, context: { used: 0, window: 1 }, ...extra });

test('표시: 1분 미만은 없음, 1분부터 fmtElapsed, 10분부터 흐린 경고색. 작업 중 도구 실행이 아니면 없음', () => {
  const now = Date.parse('2026-11-16T10:00:00.000Z');
  assert.equal(toolElapsed(sess({ toolStartedAt: now - 59 * S }), now), null);
  let e = toolElapsed(sess({ toolStartedAt: now - M }), now);
  assert.equal(e.text, '1m00s');
  assert.equal(e.fg, PALETTE.info);
  assert.ok(!e.dim);
  e = toolElapsed(sess({ toolStartedAt: now - TOOL_LONG_MS + S }), now);
  assert.equal(e.text, '9m59s');
  assert.ok(!e.long);
  e = toolElapsed(sess({ toolStartedAt: now - TOOL_LONG_MS }), now);
  assert.equal(e.fg, PALETTE.alert);
  assert.ok(e.dim && e.long);
  assert.equal(toolElapsed(sess({ toolStartedAt: now - 2 * 3600 * S - 5 * M }), now).text, '2h05m');
  assert.equal(toolElapsed(sess({ toolStartedAt: now - 5 * M, status: 'waiting', phase: { kind: 'waiting' } }), now), null, '허락 대기');
  assert.equal(toolElapsed(sess({ toolStartedAt: now - 5 * M, phase: { kind: 'think' } }), now), null);
  assert.equal(toolElapsed(sess({ toolStartedAt: null }), now), null);
});

test('STATUS 칸: 넓으면 도구 이름 뒤에 붙고, 좁으면 상태 글을 줄여 붙이고, 더 좁으면 경과 시간이 먼저 빠진다 (폭은 그대로)', () => {
  const now = Date.now();
  const tag = toolElapsed(sess({ toolStartedAt: now - 4 * M - 12 * S }), now);
  const look = { fg: PALETTE.tool };
  const wide = statusCell('도구 실행 · Bash', tag, 40, look);
  assert.equal(text(wide).trimEnd(), '도구 실행 · Bash · 4m12s');
  assert.equal(width(text(wide)), 41);
  const mid = statusCell('도구 실행 · Bash · npm run test:e2e', tag, 24, look);
  assert.match(text(mid), /…\s·\s4m12s $/);
  assert.equal(width(text(mid)), 25);
  const narrow = statusCell('도구 실행 · Bash · npm run test:e2e', tag, 18, look);
  assert.doesNotMatch(text(narrow), /4m12s/);
  assert.equal(width(text(narrow)), 19);

  // 세션 행 전체: 넓은 화면에는 보이고 행 폭은 그대로다. 행은 그리는 시각(NOW)을 쓰므로 맞춰 둔다
  // (불러온 뒤 이 시험까지 몇 초 걸리는 느린 PC 에서 4m09s 처럼 보이지 않게).
  setNow(now);
  const s = sess({ toolStartedAt: now - 4 * M - 12 * S, name: 'demo', model: 'claude-opus-5-5' });
  const plain = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
  for (const W of [160, 100]) {
    const row = plain(sessionRow(s, columns(W), W, false, 0));
    assert.equal(width(row), W, `폭 ${W}`);
    if (W === 160) assert.match(row, /Bash · 4m1\ds/);
  }
});

test('다시 그리기: 도구가 도는 세션은 이미 animating 이라 새 타이머가 필요 없다', () => {
  assert.equal(animating({ data: { sessions: [sess({ toolStartedAt: Date.now() - 5 * M })] } }), true);
});
