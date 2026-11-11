// 좁은 가상 터미널과 폭이 모호한 기호(AITOP_AMBIGUOUS=wide): 도구 줄이 글자 중간에서 잘리지 않고, 줄이 밀리지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { BIN, makeSession } from './session.mjs';
import { setAmbiguous, width } from '../../src/text.mjs';

const hasScript = spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout?.includes('util-linux');
const WAIT_MS = 8_000;

makeSession();
const base = { ...process.env, GEMINI_HOME: '/nonexistent/aitop-e2e-gemini' };
delete base.AITOP_AMBIGUOUS;

// cols x rows 가상 터미널에 aitop 을 띄워 첫 화면(세션 행이 보인 화면)의 줄들을 돌려준다.
async function screenAt(cols, rows, env = {}) {
  const cmd = `stty cols ${cols} rows ${rows}; exec "$AITOP_NODE" "$AITOP_BIN"`;
  const child = spawn('script', ['-qfec', cmd, '/dev/null'], { env: { ...base, ...env, AITOP_NODE: process.execPath, AITOP_BIN: BIN } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  const screen = () => out.split('\x1b[H').at(-1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  try {
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end && !/e2e 세션/.test(screen())) await sleep(50);
    await sleep(300);
    const lines = screen().split('\r\n').map((l) => l.replace(/\r$/, ''));
    assert.match(lines.join('\n'), /e2e 세션/, '세션 화면이 나온다');
    return lines;
  } finally {
    child.stdin.write('q');
    await sleep(200);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
}

const TOOL_WORD = /^[▍|]?(claude|codex|gemini|cla|cdx|gem)$/u;

test('좁은 터미널에서 도구 줄은 이름을 자르지 않고 줄이거나 +N 으로 접고, 오래 안 쓴 도구는 숨김 N 으로 센다', { skip: !hasScript && 'util-linux script 없음', timeout: 60_000 }, async () => {
  for (const cols of [40, 28, 18]) {
    const strip = (await screenAt(cols, 24))[1];
    const words = strip.trim().split(/\s+/);
    for (const w of words) assert.match(w, /^([▍]?(claude|codex|gemini|cla|cdx|gem)|\d+|·|[\d.]+[kMB]?|미설치|\+\d|숨김)$/u, `${cols}칸: ${strip}`);
    // 숨김 뒤에는 숨긴 도구 이름이나 개수가 온다.
    const [front, back = ''] = strip.split('숨김');
    const tools = (t) => t.trim().split(/\s+/).filter((w) => TOOL_WORD.test(w)).length;
    const hidden = Number(back.match(/^ (\d)/)?.[1] ?? tools(back));
    // 아주 좁으면 숨김 표시는 통째로 빠질 수 있다 (중간에서 잘리지 않는다).
    const total = tools(front) + Number(front.match(/\+(\d)/)?.[1] ?? 0) + hidden;
    assert.ok(strip.includes('숨김') ? total === 3 : total <= 3 && total >= 1, `${cols}칸: ${strip}`);
    assert.doesNotMatch(strip, /숨(?!김)/, `${cols}칸: ${strip}`);
  }
});

test('AITOP_AMBIGUOUS=wide 이면 상자·상태 기호를 1칸 기호로 그리고 모든 줄이 터미널 폭 안에 든다', { skip: !hasScript && 'util-linux script 없음', timeout: 60_000 }, async () => {
  const cols = 64;
  const lines = await screenAt(cols, 32, { AITOP_AMBIGUOUS: 'wide' });
  setAmbiguous('wide');
  for (const l of lines) {
    assert.ok(width(l) <= cols, `${width(l)}칸: ${l}`);
    assert.doesNotMatch(l, /[╭╮╰╯─│▃▁▌▍◆●○]/u, l);
  }
  assert.match(lines[2], /^\+- 세션 \d+ -+\+$/);
  assert.ok(lines.some((l) => /^\| >o claude/.test(l)), '고른 세션 행');
});

test('--print-config 는 ambiguous 값과 출처를 보인다', () => {
  const out = execFileSync(process.execPath, [BIN, '--print-config'], { env: { ...base, AITOP_AMBIGUOUS: 'wide' }, encoding: 'utf8' });
  assert.match(out, /^ambiguous +"wide" +env$/m);
});
