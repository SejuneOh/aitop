import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../src/sources/codex.mjs';

const lines = [
  { type: 'session_meta', payload: { id: 'abc', timestamp: '2026-03-03T05:37:29.677Z', cwd: '/w/omniapi', git: { branch: 'feat/222' } } },
  { type: 'turn_context', payload: { cwd: '/w/omniapi', model: 'gpt-5-codex' } },
  { timestamp: '2026-03-03T05:40:56Z', type: 'event_msg', payload: { type: 'task_started', model_context_window: 258400 } },
  { timestamp: '2026-03-03T05:40:57Z', type: 'event_msg', payload: { type: 'user_message', message: '리팩터링 계획은?' } },
  { timestamp: '2026-03-03T05:40:58Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd && ls -la"}' } },
  { timestamp: '2026-03-03T05:41:00Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /w/omniapi/src/App.cs\n' } },
  {
    timestamp: '2026-03-03T05:41:01Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, total_tokens: 1050 },
        last_token_usage: { total_tokens: 900 },
        model_context_window: 258400,
      },
    },
  },
];

test('Codex 세션 기록에서 진행 내용과 토큰을 읽는다', () => {
  const st = _test.newState('/x/rollout.jsonl');
  for (const l of lines) _test.applyLine(st, l);
  assert.equal(st.id, 'abc');
  assert.equal(st.branch, 'feat/222');
  assert.equal(st.model, 'gpt-5-codex');
  assert.equal(st.busy, true);
  assert.deepEqual(st.tokens, { input: 400, output: 50, cacheRead: 600, cacheWrite: 0, total: 1050 });
  assert.equal(st.context, 900);
  assert.equal(st.window, 258400);
  assert.deepEqual(st.events.map((e) => [e.kind, e.text]), [
    ['prompt', '리팩터링 계획은?'],
    ['tool', '$ pwd && ls -la'],
    ['tool', 'apply_patch App.cs'],
  ]);

  _test.applyLine(st, { type: 'event_msg', payload: { type: 'task_complete' } });
  assert.equal(st.busy, false);
});
