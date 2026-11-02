import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const root = mkdtempSync(join(tmpdir(), 'aitop-doctor-'));
process.env.CODEX_HOME = join(root, 'codex-missing');
process.env.GEMINI_HOME = join(root, 'gemini');
mkdirSync(join(root, 'gemini', 'tmp', 'abc', 'chats'), { recursive: true });
writeFileSync(join(root, 'gemini', 'tmp', 'abc', 'chats', 'session-1.json'), JSON.stringify({ sessionId: 'g1', messages: [{ text: 'SECRET-VALUE-123' }], startTime: 'x' }));
fx.session({ sessionId: 'dddddddd-1', name: 'doc' });
fx.transcript('dddddddd-1', [user('안녕'), assistant('m1', [{ type: 'text', text: '네' }], usage(10, 1))]);

const { checkTools, describe, doctorText, toolsJson } = await import('../src/doctor.mjs');
const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'aitop.mjs');

test('기록이 있는 도구는 찾음, 기록 수, 실행 수를 보인다', () => {
  const { tools } = checkTools();
  assert.equal(tools.claude.state, 'ok');
  assert.equal(tools.claude.records, 1);
  assert.equal(tools.claude.running, 1);
  assert.equal(tools.claude.readable, true);
  const d = describe(tools.claude, tools.claude.lastAt + 5000);
  assert.equal(d.mark, '✓');
  assert.equal(d.detail, '기록 1개 · 마지막 5초 전 · 실행 1');
});

test('기록 폴더가 없는 도구는 없음과 다음 행동을 보인다', () => {
  const t = checkTools().tools.codex;
  assert.equal(t.state, 'missing');
  const d = describe(t);
  assert.equal(d.mark, '✗');
  assert.equal(d.state, '없음');
  assert.match(d.hint, /codex 를 한 번 실행하면/);
  assert.doesNotMatch(d.detail, /기록 0개/);
});

test('Gemini 는 일부 지원으로 보이고, 기록은 키 이름만 보인다', () => {
  const t = checkTools().tools.gemini;
  assert.equal(t.state, 'limited');
  assert.deepEqual(t.keys, ['sessionId', 'messages', 'startTime']);
  const text = doctorText(checkTools(), '9.9.9');
  assert.match(text, /○ gemini/);
  assert.match(text, /키: sessionId, messages, startTime/);
  assert.doesNotMatch(text, /SECRET-VALUE/);
  assert.doesNotMatch(JSON.stringify(toolsJson(checkTools().tools)), /SECRET-VALUE/);
});

test('aitop --doctor 와 --doctor --json 을 실행할 수 있다', () => {
  const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { env: process.env, encoding: 'utf8' });
  const text = run('--doctor');
  assert.equal(text.status, 0);
  assert.match(text.stdout, /연결 점검/);
  assert.match(text.stdout, /✓ claude/);
  const j = JSON.parse(run('--doctor', '--json').stdout);
  assert.equal(j.tools.codex.state, 'missing');
  assert.match(j.tools.claude.lastAt, /^\d{4}-\d\d-\d\dT/);
  const data = JSON.parse(run('--json').stdout);
  assert.match(data.version, /^\d+\.\d+\.\d+/);
  assert.equal(data.tools.claude.state, 'ok');
});
