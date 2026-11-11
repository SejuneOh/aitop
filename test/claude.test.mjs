import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeCost } from '../src/pricing.mjs';
import { ClaudeTracker } from '../src/sources/claude-tracker.mjs';
import { phaseText } from '../src/i18n.mjs';

test('Opus 5.5 환산 비용: 입력 4, 출력 20, 캐시 읽기 0.2, 1시간 캐시 쓰기 2배', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 } };
  assert.deepEqual(claudeCost('claude-opus-5-5', u), { total: 4 + 20 + 0.2 + 8, noCache: 4 + 20 });
  assert.equal(claudeCost('claude-opus-5-5', { output_tokens: 1_000_000, speed: 'fast' }).total, 40);
  assert.equal(claudeCost('unknown-model', u), null);
});

const asst = (id, content, usage) => ({ type: 'assistant', timestamp: '2026-10-30T00:00:00Z', message: { id, model: 'claude-opus-5-5', content, usage } });
const user = (content) => ({ type: 'user', timestamp: '2026-10-30T00:00:01Z', message: { content } });

test('같은 message.id 가 여러 줄이어도 토큰은 한 번만 더하고, 진행 단계를 따라간다', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'aitop-')), 's.jsonl');
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
  const lines = [
    user('테스트 해줘'),
    asst('m1', [{ type: 'text', text: '실행합니다' }], u),
    asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], u),
  ];
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = new ClaudeTracker(f);
  t.update();
  assert.equal(t.tokens.total, 115);
  assert.deepEqual(t.phase(), { kind: 'tool', args: { what: 'Bash' } });
  assert.equal(phaseText(t.phase()), '도구 실행 · Bash');

  t.apply(user([{ type: 'tool_result', tool_use_id: 't1' }]));
  assert.equal(phaseText(t.phase()), '생각 중');

  t.apply(asst('m2', [{ type: 'tool_use', id: 't2', name: 'Agent', input: { subagent_type: 'Explore' } }], u));
  assert.deepEqual(t.phase(), { kind: 'team', args: { n: 1 } });
  assert.equal(phaseText(t.phase()), '팀원 1명 작업 중');
  assert.equal(t.tokens.total, 230);
});
