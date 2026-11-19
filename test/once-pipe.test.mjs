// 파이프·파일로 받는 --once: 높이 맞춤 빈 줄과 키 안내 줄, 줄 끝 공백을 빼고 내용만 낸다 (#292).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const BIN = fileURLToPath(new URL('../bin/aitop.mjs', import.meta.url));
const fx = makeClaudeHome();
const { pipeLines } = await import('../src/ui.mjs');
const { setAmbiguous } = await import('../src/text.mjs');

test.after(() => rmSync(dirname(fx.home), { recursive: true, force: true }));

test('pipeLines: 키 안내 줄, 끝의 빈 줄, 상자 아래쪽의 테두리만 있는 줄을 뺀다', () => {
  const box = ['╭─ a ─╮', '│ x │ y │', '│   │   │', '\x1b[2m│\x1b[0m   │   │', '╰─────╯'];
  assert.deepEqual(pipeLines(['head', ...box, '   ', ' [q] quit ']), ['head', '╭─ a ─╮', '│ x │ y │', '╰─────╯']);
  // 포커스(굵은 선) 상자도 같다.
  assert.deepEqual(pipeLines(['┏━ a ━┓', '┃ x ┃', '┃   ┃', '┗━━━━━┛', 'keys']), ['┏━ a ━┓', '┃ x ┃', '┗━━━━━┛']);
  // 상자가 없으면 끝의 빈 줄과 키 줄만 뺀다. 가운데 빈 줄은 남긴다.
  assert.deepEqual(pipeLines(['a', '', 'b', '  ', '\x1b[0m  \x1b[0m', 'keys']), ['a', '', 'b']);
  assert.deepEqual(pipeLines(['keys']), []);
});

test('pipeLines: AITOP_AMBIGUOUS=wide 의 ASCII 테두리(+ - |, # = #)에서도 빈 줄을 뺀다', () => {
  setAmbiguous('wide');
  try {
    const box = ['+- a -+', '| x | y |', '|   |   |', '\x1b[2m|\x1b[0m   |   |', '+-----+'];
    assert.deepEqual(pipeLines(['head', ...box, '', 'keys']), ['head', '+- a -+', '| x | y |', '+-----+']);
    assert.deepEqual(pipeLines(['#= a =#', '# x #', '#   #', '#=====#', 'keys']), ['#= a =#', '# x #', '#=====#']);
  } finally {
    setAmbiguous('narrow');
  }
});

test('pipeLines: 줄 끝 공백을 지우고, 색 코드가 있던 줄은 초기화로 끝낸다', () => {
  assert.deepEqual(pipeLines(['abc   ', 'keys']), ['abc']);
  assert.deepEqual(pipeLines(['\x1b[31mab\x1b[0m\x1b[44m   \x1b[0m', 'keys']), ['\x1b[31mab\x1b[0m']);
  assert.deepEqual(pipeLines(['\x1b[31mab   ', 'keys']), ['\x1b[31mab\x1b[0m'], '색이 다음 줄로 번지지 않는다');
  assert.deepEqual(pipeLines(['\x1b[31mab', 'keys']), ['\x1b[31mab'], '지운 것이 없으면 그대로');
});

const runOnce = (extra = {}) => {
  fx.session({ sessionId: 'pipe0000-1', name: 'fix-login', status: 'busy', cwd: '/work/demo' });
  fx.transcript('pipe0000-1', [user('로그인 고쳐줘'), assistant('m1', [{ type: 'text', text: '고치겠습니다' }], usage(1000, 10))]);
  const env = { ...process.env, COLUMNS: '120', LINES: '40', AITOP_LANG: 'en', ...extra };
  for (const k of ['NO_COLOR', 'FORCE_COLOR', 'AITOP_AMBIGUOUS']) if (!(k in extra)) delete env[k];
  const r = spawnSync(process.execPath, [BIN, '--once'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, lines: r.stdout.replace(/\n$/, '').split('\n') };
};

test('bin: 파이프로 받는 --once 는 키 안내와 높이 맞춤 빈 줄, 줄 끝 공백이 없다', () => {
  const { out, lines } = runOnce();
  assert.match(out, /fix-login/);
  assert.doesNotMatch(out, /\[q\] quit/);
  assert.ok(lines.length < 40, `${lines.length} 줄`);
  // 상세 상자 아래 테두리 바로 위는 내용이 있는 줄이다.
  assert.match(lines.at(-1), /^╰─+╯$/);
  assert.doesNotMatch(lines.at(-2), /^[\s│]*$/);
  for (const l of lines) assert.doesNotMatch(l, /\s$/, JSON.stringify(l));
});

test('bin: AITOP_AMBIGUOUS=wide 의 파이프 --once 도 상세 상자 빈 줄이 없다', () => {
  const { lines } = runOnce({ AITOP_AMBIGUOUS: 'wide' });
  assert.ok(lines.length < 40, `${lines.length} 줄`);
  assert.match(lines.at(-1), /^\+-+\+$/);
  assert.doesNotMatch(lines.at(-2), /^[\s|]*$/);
  assert.equal(lines.filter((l) => /^[\s|]*$/.test(l)).length, 1, '표와 상세 사이 한 줄만 비어 있다');
});
