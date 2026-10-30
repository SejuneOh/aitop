import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude, _stats } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');

const run = (opts = {}) => collectClaude({ showEnded: false, budget: createBudget(), ...opts });

test('살아 있는 세션의 상태·토큰·팀원을 읽는다', () => {
  fx.session({ sessionId: 'aaaaaaaa-1', name: 'demo-session' });
  fx.transcript('aaaaaaaa-1', [user('작업 시작'), assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'Explore' } }], usage(10, 5, 100))]);
  fx.subagent('aaaaaaaa-1', 'sub1', { agentType: 'Explore', description: '파일 조사', toolUseId: 't1' }, [assistant('s1', [{ type: 'tool_use', id: 'x', name: 'Grep', input: { pattern: 'TODO' } }], usage(1, 2))]);

  const [s] = run();
  assert.equal(s.name, 'demo-session');
  assert.equal(s.status, 'busy');
  assert.equal(s.phase.text, '팀원 1명 작업 중');
  assert.equal(s.members.length, 1);
  assert.equal(s.members[0].phase.text, '도구 실행 · Grep');
  assert.equal(s.tokens.total, 115 + 3);
});

test('세션 목록에서 빠지면 tracker 도 정리된다', () => {
  run();
  assert.deepEqual(_stats(), { trackers: 1, subTrackers: 1 });
  unlinkSync(join(fx.home, 'sessions', `${process.pid}.json`));
  assert.deepEqual(run(), []);
  assert.deepEqual(_stats(), { trackers: 0, subTrackers: 0 });
});

test('읽기 한도가 작으면 진행률을 보여 주고, 다음 갱신에서 마저 읽는다', () => {
  fx.session({ sessionId: 'bbbbbbbb-2' });
  const big = 'x'.repeat(2 * 1024 * 1024);
  fx.transcript('bbbbbbbb-2', [user('긴 기록'), assistant('m1', [{ type: 'text', text: big }], usage(1, 1)), assistant('m2', [{ type: 'text', text: big }], usage(1, 1))]);

  const [partial] = run({ budget: createBudget(1) });
  assert.match(partial.phase.text, /^기록 읽는 중 \d+%$/);
  let s;
  for (let i = 0; i < 5; i++) [s] = run({ budget: createBudget(1024 * 1024) });
  assert.doesNotMatch(s.phase.text, /기록 읽는 중/);
  assert.equal(s.tokens.total, 4);
});
