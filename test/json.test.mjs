import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'aitop.mjs');

test('aitop --json 은 JSON 으로 읽히고 세션마다 상태·토큰·비용·컨텍스트가 있다', () => {
  fx.session({ sessionId: 'mmmmmmmm-1', name: 'json-demo' });
  fx.transcript('mmmmmmmm-1', [user('시작'), assistant('m1', [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'export TOKEN=sk-ant-api03-abcdefghijklmnopqrst' } }], usage(1000, 10))]);

  const out = execFileSync(process.execPath, [BIN, '--json'], { env: process.env, encoding: 'utf8' });
  const j = JSON.parse(out);
  const s = j.sessions.find((x) => x.id === 'mmmmmmmm-1');
  assert.equal(s.name, 'json-demo');
  assert.equal(s.status, 'busy');
  assert.equal(s.phase, '도구 실행 · Bash');
  assert.equal(s.tokens.total, 1010);
  assert.ok(s.cost > 0);
  assert.equal(s.context.window, 1_000_000);
  assert.ok(!out.includes('sk-ant-api03'), '비밀값은 가려져야 한다');
  assert.ok(j.usage.today.tokens >= 1010);
});

test('--all 과 함께 쓰면 종료 세션도 들어간다', () => {
  fx.transcript('nnnnnnnn-2', [{ ...assistant('m1', [], usage(1, 1)), cwd: '/work/old' }], '-work-old');
  const ids = JSON.parse(execFileSync(process.execPath, [BIN, '--json', '--all'], { env: process.env, encoding: 'utf8' })).sessions.map((x) => x.id);
  assert.ok(ids.includes('nnnnnnnn-2'));
  const live = JSON.parse(execFileSync(process.execPath, [BIN, '--json'], { env: process.env, encoding: 'utf8' })).sessions.map((x) => x.id);
  assert.ok(!live.includes('nnnnnnnn-2'));
});
