import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';
import { phaseText } from '../src/i18n.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { render } = await import('../src/ui.mjs');

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');

test('팀원 행은 하는 일로 구분되고, 첫 응답 전에는 시작 중으로 비어 있다', () => {
  fx.session({ sessionId: 'gggggggg-4' });
  fx.transcript('gggggggg-4', [user('팀원 둘'), assistant('m1', [{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }, { type: 'tool_use', id: 'tb', name: 'Agent', input: {} }], usage(1, 1))]);
  fx.subagent('gggggggg-4', 'a', { agentType: 'general-purpose', description: 'CTO 검토', toolUseId: 'ta' }, [assistant('s1', [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/a/b.mjs' } }], usage(3, 4), 'claude-haiku-5-5')]);
  fx.subagent('gggggggg-4', 'b', { agentType: 'general-purpose', description: '디자인 검토', toolUseId: 'tb' }, []);

  const [s] = collectClaude({ showEnded: false, budget: createBudget() });
  const a = s.members.find((m) => m.task === 'CTO 검토');
  const b = s.members.find((m) => m.task === '디자인 검토');
  assert.equal(a.started, true);
  assert.equal(b.started, false);
  assert.equal(phaseText(b.phase), '시작 중');

  const lines = render({ data: { sessions: [s], errors: [], at: Date.now() }, selectedId: s.id, showDetail: false, frame: 0 }, 140, 10).map(strip);
  const rowA = lines.find((l) => l.includes('CTO 검토'));
  const rowB = lines.find((l) => l.includes('디자인 검토'));
  assert.match(rowA, /haiku-5-5/);
  assert.match(rowA, /CTO 검토 /);
  assert.doesNotMatch(rowA, /general-purpose/, 'general-purpose 타입 꼬리는 붙이지 않는다');
  assert.match(rowA, /도구 실행 · Read/);
  assert.match(rowB, /시작 중/);
  assert.doesNotMatch(rowB, /\$0\.00| 0 | - /);
});
