// 좁은 STATUS 칸은 동사보다 대상을 남기고, 이어 열기 명령은 공백·/ 에서 끊고, NO_COLOR 게이지는 기호로 구분한다 (#293).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sessionRow, statusCell, columns, toolTarget } from '../src/ui/table.mjs';
import { gauge, setNow } from '../src/ui/draw.mjs';
import { detail, resumeLines, wrapCommand, wrapText } from '../src/ui/detail.mjs';
import { resumeCmd } from '../src/resume.mjs';
import { setLang } from '../src/i18n.mjs';
import { width } from '../src/text.mjs';

afterEach(() => setLang('ko'));

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const text = (segs) => segs.map((x) => x.t).join('');
const at = Date.parse('2026-11-10T05:00:00Z');
const phase = { kind: 'tool', args: { what: 'Bash $ npm test' } };
const mk = (extra = {}) => ({ tool: 'claude', id: 'a', name: 'demo', cwd: '/w', status: 'busy', live: true, phase, toolStartedAt: at - (9 * 60 + 55) * 1000, updatedAt: at, tokens: { total: 1000 }, cost: 1, context: { used: 50, window: 100 }, members: [], events: [], ...extra });

test('상태 칸이 좁으면 동사(도구 실행)를 먼저 빼고 대상과 경과 시간을 남긴다', () => {
  const tag = { text: '9m55s' };
  const target = toolTarget(phase);
  assert.equal(target, 'Bash $ npm test');
  assert.equal(text(statusCell('도구 실행 · Bash $ npm test', tag, 40, {}, null, target)).trimEnd(), '도구 실행 · Bash $ npm test · 9m55s');
  assert.equal(text(statusCell('도구 실행 · Bash $ npm test', tag, 28, {}, null, target)).trimEnd(), 'Bash $ npm test · 9m55s');
  for (const w of [12, 16, 21, 22]) {
    const out = text(statusCell('도구 실행 · Bash $ npm test', tag, w, {}, null, target));
    assert.equal(width(out), w + 1, `폭 ${w}`);
    assert.match(out, /^Bas.* · 9m55s *$/, `폭 ${w}: ${out}`);
  }
  // 덧붙임이 없어도 넘치면 동사부터 뺀다.
  assert.match(text(statusCell('도구 실행 · Bash $ npm test', null, 16, {}, null, target)), /^Bash \$ npm test /);
});

test('80·120열 세션 행: 도구 이름이 남고 동사만 남지 않는다 (ko·en)', () => {
  setNow(at);
  for (const lang of ['ko', 'en']) {
    setLang(lang);
    for (const W of [80, 120]) {
      const row = strip(sessionRow(mk(), columns(W), W, false, 0));
      assert.equal(width(row), W);
      assert.match(row, /Bash.*9m55s/, `${lang} ${W}: ${row}`);
      assert.doesNotMatch(row, /(도구 실행|Tool) ·… /, `${lang} ${W}: ${row}`);
    }
  }
});

const ID = 'a0000000-1111-2222-3333-444444444444';
const TAIL = `claude --resume ${ID}`;

test('이어 열기: 꼬리(claude --resume <id>)는 마지막 줄(들)에 온전히, 앞부분은 넘치면 가운데를 … 로 줄인다', () => {
  // 리뷰어 실측 1: w=30, 3줄. && 와 꼬리가 글자 단위로 끊기지 않는다.
  const spaced = `cd '/home/user/my project/x' && ${TAIL}`;
  const r30 = resumeLines(spaced, 30, 3);
  assert.equal(r30.length, 3);
  assert.ok(r30.every((l) => width(l) <= 30), JSON.stringify(r30));
  assert.match(r30[0], /^cd '\/home\/user.*….* project\/x' &&$/, '앞부분은 머리와 && 가 남고 가운데만 줄인다');
  assert.equal(r30.slice(1).join(''), TAIL, '꼬리는 뒤 두 줄에 빠짐없이');
  assert.ok(r30[1].startsWith('claude --resume'), '꼬리는 새 줄에서 시작한다');
  // 폭 29·30 (id 36칸보다 좁다): 그때만 id 가 글자 단위로 끊기고, 꼬리 글자는 모두 보인다.
  for (const w of [29, 30]) {
    const lines = resumeLines(spaced, w, 3);
    assert.ok(lines.every((l) => width(l) <= w));
    assert.equal(lines.slice(1).join(''), TAIL, `${w}: ${JSON.stringify(lines)}`);
  }
  // 폭 46 이상: id 가 한 줄에 온전히, 마지막 줄이다.
  for (const w of [36, 45, 46]) {
    const lines = resumeLines(spaced, w, 3);
    assert.equal(lines.at(-1), ID, `${w}: ${JSON.stringify(lines)}`);
    assert.ok(lines.every((l) => width(l) <= w));
  }
  // 폭 120: 한 줄에 들어가면 그대로.
  assert.deepEqual(resumeLines(spaced, 120, 3), [spaced]);
});

test('이어 열기: 리뷰어 실측 2 - 120열 상세 패널에서 긴 경로여도 3줄 안에 --resume 과 id 가 보이고, 복사 내용은 그대로다', () => {
  setNow(at);
  const cwd = '/tmp/aitop-fixture-QoNo1Dxyzlongname1234567890abcdefghij/work/demo';
  const s = { tool: 'claude', id: ID, name: 'demo', cwd, status: 'idle', live: true, phase: { kind: 'idle' }, updatedAt: at, startedAt: at - 60_000, tokens: { total: 1000 }, cost: 1, context: { used: 50, window: 100 }, members: [], events: [], files: [] };
  const full = resumeCmd(s);
  assert.equal(full, `cd ${cwd} && ${TAIL}`, 'y 로 복사하는 명령은 줄이지 않는다');
  const out = detail(s, 120, 40, 0, { tab: 'now' }).map(strip);
  const at0 = out.findIndex((l) => /── 이어 열기 ─+ y ─/.test(l));
  assert.ok(at0 > 0);
  const block = out.slice(at0 + 1, at0 + 4).join('\n');
  assert.match(block, /claude --resume/);
  assert.ok(block.includes(ID), block);
  assert.doesNotMatch(out[at0 + 1], /^│ cd \/tmp\/ +│/, '첫 줄이 cd /tmp/ 하나뿐이지 않다');
  // 폭 46 그대로도 같다.
  const lines = resumeLines(full, 46, 3);
  assert.equal(lines.at(-1), ID);
  assert.match(lines[0], /^cd \/tmp\/.*…/);
});

test('이어 열기: Windows 경로의 \\ 도 끊는 자리이고, 요청 내용 줄바꿈(wrapText)은 글자 단위 그대로', () => {
  const win = wrapCommand(String.raw`cd 'C:\Users\me\src\proj' && x`, 16);
  assert.ok(win.every((l) => width(l) <= 16));
  assert.ok(win[0].endsWith('\\'), JSON.stringify(win));
  assert.deepEqual(wrapText('ab cd/ef', 4), ['ab c', 'd/ef']);
  // 꼬리가 없는 명령은 예전처럼 나누고 넘치면 … 로 끝낸다.
  assert.deepEqual(resumeLines('abcdefghij', 4, 2), ['abcd', 'efg…']);
});

test('게이지: 60% 이상 ~, 85% 이상 !, 0% 로 보이면 칸을 채우지 않는다', () => {
  const tail = (u) => gauge(u, 1000, 11).at(-1).t.trim();
  assert.equal(tail(590), '59%');
  assert.equal(tail(600), '~60%');
  assert.equal(tail(840), '~84%');
  assert.equal(tail(850), '!85%');
  assert.equal(tail(1000), '!100%');
  const zero = gauge(4, 1000, 11);
  assert.equal(zero[0].t, '', '0% 는 빈 칸만');
  assert.equal(zero.at(-1).t.trim(), '0%');
  assert.equal(width(text(gauge(700, 1000, 11))), 16, '폭은 그대로');
});

test('NO_COLOR 게이지는 █ ░ 와 ~ ! 로 색 없이도 구분된다', () => {
  const draw = pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'ui', 'draw.mjs')).href;
  const run = (u) => spawnSync(process.execPath, ['--input-type=module', '-e', `const { gauge } = await import(process.argv[1]); console.log(gauge(${u}, 1000, 10).map((x) => x.t).join(''));`, draw], { env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' }).stdout.trim();
  assert.equal(run(0), '░░░░░░░░░░   0%');
  assert.equal(run(700), '███████░░░ ~70%');
  assert.equal(run(900), '█████████░ !90%');
});

test('이어 열기: 긴 경로(2000자)도 빨리 그린다 (스피너 120ms 마다 다시 그리므로)', () => {
  for (const env of ['', ' && CLAUDE_CONFIG_DIR=/home/u/.claude-work']) {
    const cmd = `cd /mnt/c/Users/${'x'.repeat(2000)}${env} && ${TAIL}`;
    resumeLines(cmd, 46, 3);
    const t0 = performance.now();
    const lines = resumeLines(cmd, 46, 3);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `${ms.toFixed(1)}ms`);
    assert.equal(lines.length, 3);
    assert.equal(lines.at(-1), ID);
    assert.ok(lines.every((l) => width(l) <= 46));
  }
});

test('이어 열기: CLAUDE_CONFIG_DIR 이 있으면 경로와 값만 줄여 && 와 변수 이름이 남는다', () => {
  const cmd = `cd '/home/user/my project/x' && CLAUDE_CONFIG_DIR=/home/u/.claude-work ${TAIL}`;
  for (const w of [30, 46]) {
    const lines = resumeLines(cmd, w, 3);
    assert.match(lines[0], /^cd '.*… ?.* && CLAUDE_CONFIG_DIR=\/.*$/, `${w}: ${JSON.stringify(lines)}`);
    assert.ok(lines.every((l) => width(l) <= w));
    assert.equal(lines.slice(1).join(lines[1] === 'claude --resume' ? ' ' : ''), TAIL);
  }
});
