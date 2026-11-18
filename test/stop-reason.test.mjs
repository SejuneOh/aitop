// 세션이 오류로 멈춘 이유 (#240). 이 PC 기록 표본의 API 오류 줄 모양을 본뜬 가짜 기록으로 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { ClaudeTracker, stopReasonOf } = await import('../src/sources/claude-tracker.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { flushCache, CACHE_DIR } = await import('../src/cache.mjs');
const { toJson } = await import('../src/json.mjs');
const { phaseText } = await import('../src/i18n.mjs');
const { createEventWatch, takeEvents, createAttention, updateAttention } = await import('../src/attention.mjs');
const { arrange } = await import('../src/order.mjs');

const run = () => collectClaude({ showEnded: false, budget: createBudget() });

// Claude Code 가 남기는 API 오류 줄: model '<synthetic>', isApiErrorMessage, error (연결 끊김은 apiError 도).
const apiError = (text, extra) => ({ ...assistant(`e-${Math.random()}`, [{ type: 'text', text }], usage(0, 0), '<synthetic>'), isApiErrorMessage: true, ...extra });
const authLine = () => apiError('Login expired · Please run /login', { error: 'authentication_failed' });
const netLine = () => apiError('API Error: Connection lost mid-response. The response above may be incomplete.', { error: 'server_error', apiError: 'connection_failed', streamCutCause: 'stale_connection' });
const otherLine = () => apiError('API Error: something else', { error: 'unknown_error' });
// 오류 뒤에 붙는, 대화가 아닌 줄들
const tailRows = [{ type: 'last-prompt' }, { type: 'system', subtype: 'turn_duration', durationMs: 1 }];

test('API 오류 줄의 종류를 가른다', () => {
  assert.deepEqual(stopReasonOf(authLine()), { kind: 'auth' });
  assert.deepEqual(stopReasonOf(netLine()), { kind: 'network' });
  assert.deepEqual(stopReasonOf(otherLine()), { kind: 'api' });
  assert.equal(stopReasonOf(assistant('m', [{ type: 'text', text: 'ok' }], usage(1, 1))), null);
  assert.equal(stopReasonOf(user('hi')), null);
});

test('마지막 대화 줄이 오류면 멈춤, 그 뒤 정상 응답이나 사용자 줄이 오면 지운다', () => {
  const p = fx.transcript('stop-1', [user('해줘'), authLine(), ...tailRows]);
  const t = new ClaudeTracker(p);
  t.update();
  assert.deepEqual(t.stopReason, { kind: 'auth' });
  fx.append(p, [user('/login 했어')]);
  t.update();
  assert.equal(t.stopReason, null, '사용자 줄');
  fx.append(p, [netLine()]);
  t.update();
  assert.deepEqual(t.stopReason, { kind: 'network' });
  fx.append(p, [assistant('ok', [{ type: 'text', text: '이어서' }], usage(1, 1))]);
  t.update();
  assert.equal(t.stopReason, null, '정상 assistant 줄');
});

test('대기 중인 살아 있는 세션은 멈춘 이유를 상태로 보이고 --json 에 phaseKind·stopReason 을 넣는다', () => {
  for (const [id, line, ko, en, kind] of [
    ['stop-a', authLine(), '로그인 필요', 'Login needed', 'auth'],
    ['stop-n', netLine(), '연결 끊김', 'Connection lost', 'network'],
    ['stop-x', otherLine(), 'API 오류로 멈춤', 'API error', 'api'],
  ]) {
    fx.session({ sessionId: id, status: 'idle' });
    fx.transcript(id, [user('해줘'), line, ...tailRows]);
    const [s] = run().filter((x) => x.id === id);
    assert.equal(s.status, 'idle', '대기 판정은 그대로');
    assert.equal(s.phase.kind, 'stopped');
    assert.equal(phaseText(s.phase, { lang: 'ko' }), ko);
    assert.equal(phaseText(s.phase, { lang: 'en', short: true }), en);
    assert.deepEqual(s.stopReason, { kind });
    const j = toJson({ sessions: [s], usage: null, at: Date.now() }).sessions[0];
    assert.equal(j.phaseKind, 'stopped');
    assert.deepEqual(j.stopReason, { kind });
    assert.equal(j.phase, ko);
  }
});

test('응답 대기·작업 중이면 멈춤으로 보이지 않고, 정상 줄이 오면 다음 지시 대기로 돌아간다', () => {
  fx.session({ sessionId: 'stop-w', status: 'idle', waitingFor: 'approve Bash' });
  fx.transcript('stop-w', [user('해줘'), authLine()]);
  let [s] = run().filter((x) => x.id === 'stop-w');
  assert.equal(s.phase.kind, 'waiting');
  assert.equal(s.stopReason, null);

  fx.session({ sessionId: 'stop-b', status: 'busy' });
  const p = fx.transcript('stop-b', [user('해줘'), netLine()]);
  [s] = run().filter((x) => x.id === 'stop-b');
  assert.notEqual(s.phase.kind, 'stopped');
  assert.equal(s.stopReason, null);

  fx.session({ sessionId: 'stop-b', status: 'idle' });
  [s] = run().filter((x) => x.id === 'stop-b');
  assert.equal(s.phase.kind, 'stopped');
  fx.append(p, [assistant('ok2', [{ type: 'text', text: '다시 됨' }], usage(1, 1))]);
  [s] = run().filter((x) => x.id === 'stop-b');
  assert.equal(s.phase.kind, 'idle');
  assert.equal(s.stopReason, null);
  assert.equal(toJson({ sessions: [s], usage: null }).sessions[0].stopReason, null);
});

test('멈춘 이유는 캐시에 저장·복원되고, 이 필드가 없던 캐시는 기록 끝에서 한 번 채운다', () => {
  const p = fx.transcript('stop-c', [user('해줘'), netLine(), ...tailRows]);
  const t = new ClaudeTracker(p);
  t.update();
  flushCache();
  assert.deepEqual(new ClaudeTracker(p).stopReason, { kind: 'network' });

  // 예전 캐시: stopReason 이 없다
  const file = join(CACHE_DIR, createHash('sha1').update(`\0${p}`).digest('hex') + '.json');
  const c = JSON.parse(readFileSync(file, 'utf8'));
  delete c.stopReason;
  writeFileSync(file, JSON.stringify(c));
  const old = new ClaudeTracker(p);
  assert.deepEqual(old.stopReason, { kind: 'network' });
  flushCache();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).stopReason, { kind: 'network' }, '다시 적어 두어 다음엔 훑지 않는다');
});

const S = 1000;
const M = 60 * S;
const sess = (status, extra = {}) => ({ id: 'a', status, live: true, tool: 'claude', project: 'demo', context: { used: 0, window: 200_000 }, ...extra });

test('오류로 멈춘 세션에는 done 알림을 보내지 않고 확인 전(●)으로도 치지 않는다', () => {
  const stop = { stopReason: { kind: 'auth' }, phase: { kind: 'stopped', msg: 'stopAuth' } };
  const w = createEventWatch();
  const out = [];
  for (const [at, status, extra] of [[0, 'busy'], [4 * M, 'idle', stop], [4 * M + 6 * S, 'idle', stop], [5 * M, 'idle', stop]]) out.push(...takeEvents(w, [sess(status, extra)], { now: at }));
  assert.deepEqual(out, []);

  // 같은 흐름이라도 멈춘 이유가 없으면 알린다 (대조)
  const w2 = createEventWatch();
  const out2 = [];
  for (const [at, status] of [[0, 'busy'], [4 * M, 'idle'], [4 * M + 6 * S, 'idle']]) out2.push(...takeEvents(w2, [sess(status)], { now: at }));
  assert.deepEqual(out2.map((e) => e.kind), ['done']);

  const a = createAttention();
  updateAttention(a, [sess('busy')], null);
  updateAttention(a, [sess('idle', stop)], null);
  assert.equal(a.unseen.has('a'), false);
});

test('정렬: 응답 대기 > 고정 > 멈춤 > 나머지. 묶을 때는 제 묶음 맨 위', () => {
  const mk = (id, status, kind, project = 'p') => ({ id, status, phase: { kind }, project, cost: 0 });
  const list = [mk('i1', 'idle', 'idle'), mk('s1', 'idle', 'stopped', 'q'), mk('w1', 'waiting', 'waiting'), mk('p1', 'idle', 'idle'), mk('e1', 'ended', 'ended')];
  assert.deepEqual(arrange(list, { pins: ['p1'] }).sessions.map((s) => s.id), ['w1', 'p1', 's1', 'i1', 'e1']);
  assert.deepEqual(arrange(list, { sort: 'cost' }).sessions.map((s) => s.id), ['w1', 's1', 'i1', 'p1', 'e1']);
  const g = arrange(list, { group: 'project' });
  assert.deepEqual(g.groups.map((x) => x.name), ['응답 대기', 'q', 'p']);
});

test('--line 의 멈춤 수(claudeStopped)는 세션 파일과 기록 끝만 보고 센다 (#262)', async () => {
  const { claudeStopped } = await import('../src/sources/claude.mjs');
  fx.session({ sessionId: 'line-stop', status: 'idle' });
  fx.transcript('line-stop', [user('해줘'), authLine(), ...tailRows]);
  assert.equal(claudeStopped(), 1);
  fx.session({ sessionId: 'line-stop', status: 'idle', waitingFor: 'approve Bash' });
  assert.equal(claudeStopped(), 0, '응답 대기는 멈춤이 아니다');
  fx.session({ sessionId: 'line-stop', status: 'busy' });
  assert.equal(claudeStopped(), 0, '작업 중도 아니다');
  fx.session({ sessionId: 'line-ok', status: 'idle' });
  fx.transcript('line-ok', [user('해줘'), assistant('ok', [{ type: 'text', text: '끝' }], usage(1, 1))]);
  assert.equal(claudeStopped(), 0, '정상으로 끝난 대기');
});

test('--line 은 대기 목록과 멈춤 수를 세션 목록 한 번으로 모으고, 시간 상한을 넘기면 멈춤 수를 모름(null)으로 둔다 (#265)', async () => {
  const { claudeLineCounts } = await import('../src/sources/claude.mjs');
  fx.session({ sessionId: 'line-stop', status: 'idle' });
  fx.transcript('line-stop', [user('해줘'), authLine(), ...tailRows]);
  assert.deepEqual(claudeLineCounts(), { waiting: [], stopped: 1 });
  assert.deepEqual(claudeLineCounts({ deadline: Date.now() + 60_000 }), { waiting: [], stopped: 1 }, '상한 안이면 결과가 같다');
  assert.deepEqual(claudeLineCounts({ deadline: 0 }), { waiting: [], stopped: null }, '상한을 넘기면 모자라게 세지 않고 모름');
  // 응답 대기 세션은 상한을 넘겨도 목록에 남는다 (기록 끝 읽기 상한은 멈춤 수에만 건다).
  fx.session({ sessionId: 'line-stop', status: 'idle', waitingFor: 'approve Bash', name: 'line-wait', nameSource: 'user' });
  const late = claudeLineCounts({ deadline: 0 });
  assert.deepEqual([late.waiting.map((w) => w.name), late.stopped], [['line-wait'], 0]);
});

test('--line 줄: 멈춤 수를 모르면(null) 멈춤 칸만 뺀다', async () => {
  const { formatLine } = await import('../src/line.mjs');
  assert.doesNotMatch(formatLine({ today: 1, stopped: null }), /stop/);
  assert.match(formatLine({ today: 1, stopped: 2 }), /stop 2/);
});
