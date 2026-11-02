import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');

test('응답 대기 중에 서브에이전트가 돌고 있으면 함께 보인다', () => {
  fx.session({ sessionId: 'wwwwwwww-1', status: 'waiting', waitingFor: 'input needed' });
  fx.transcript('wwwwwwww-1', [user('검토해줘'), assistant('m1', [{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }], usage(1, 1))]);
  fx.subagent('wwwwwwww-1', 'a', { agentType: 'general-purpose', description: '리뷰', toolUseId: 'ta' }, [assistant('s1', [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/a.mjs' } }], usage(3, 4))]);
  const [s] = collectClaude({ showEnded: false, budget: createBudget() });
  assert.equal(s.status, 'waiting', '판정은 Claude Code 가 적은 값을 따른다');
  assert.equal(s.phase.text, '응답 대기 · input needed · 에이전트 1개 실행 중');
});

test('서브에이전트가 없으면 응답 대기 문구는 그대로', () => {
  fx.session({ sessionId: 'wwwwwwww-2', pid: process.pid, status: 'waiting', waitingFor: 'approve Bash' });
  fx.transcript('wwwwwwww-2', [user('실행해줘')]);
  const s = collectClaude({ showEnded: false, budget: createBudget() }).find((x) => x.id === 'wwwwwwww-2');
  assert.equal(s.phase.text, '응답 대기 · approve Bash');
});
