// 폭이 모호한 기호(AITOP_AMBIGUOUS=wide)와 좁은 화면의 도구 줄.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';
import { toolStrip } from '../src/ui/table.mjs';
import { gauge, levelBar, rule } from '../src/ui/draw.mjs';
import { columns, sessionRow } from '../src/ui/table.mjs';
import { resolveConfig } from '../src/config.mjs';
import { setAmbiguous, truncate, truncateLeft, width } from '../src/text.mjs';

afterEach(() => setAmbiguous('narrow'));

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-11-10T05:00:00Z');
const mk = (id, extra = {}) => ({ tool: 'claude', id, name: `세션-${id}`, cwd: '/w', status: 'idle', live: true, phase: { kind: 'idle', text: '다음 지시 대기 · 확인' }, updatedAt: at, tokens: { total: 1000 }, cost: 1.5, context: { used: 50, window: 100 }, members: [], events: [], ...extra });
const view = (sessions, extra = {}) => ({ data: { sessions, usage: null, errors: [], at, tools: { tools: {} } }, selectedId: sessions[0]?.id, showDetail: true, frame: 0, ...extra });

// 칸 수가 정해진 자리에 쓰던 기호들. wide 에서는 화면에 하나도 남지 않아야 한다.
const GRID = /[╭╮╰╯─│┏┓┗┛━┃├└▁▂▃▄▅▆▇█▌▍▏◆◇●○▲★]/u;

test('wide 이면 폭이 모호한 글자를 2칸으로 세고, 한글·ASCII 폭은 그대로다', () => {
  assert.equal(width('a·b→c…'), 6);
  setAmbiguous('wide');
  assert.equal(width('a·b→c…'), 9);
  assert.equal(width('한글 abc'), 8);
  assert.equal(width('─●Σé'), 8);
  assert.equal(width('⣠⣴⣾'), 3, '로고의 점자는 모호하지 않아 1칸');
  setAmbiguous('narrow');
  assert.equal(width('─●Σé'), 4);
});

test('wide 에서 자른 글은 … 의 2칸까지 넣어 폭을 넘지 않는다', () => {
  setAmbiguous('wide');
  for (let max = 1; max <= 12; max++) {
    assert.ok(width(truncate('가나다라마바사 · 아자차', max)) <= max, `truncate ${max}`);
    assert.ok(width(truncateLeft('/아주/긴/경로/파일.mjs', max)) <= max, `truncateLeft ${max}`);
  }
  assert.equal(truncate('abcdef', 1), '.', '1칸만 남으면 … 대신 .');
  assert.equal(truncate('abcdef', 4), 'ab…');
});

test('wide 화면은 상자·막대·상태 기호를 1칸 ASCII 로 그리고 모든 줄이 화면 폭이다', () => {
  setAmbiguous('wide');
  const sessions = [mk('a'), mk('b', { status: 'waiting', phase: { kind: 'waiting', text: '응답 대기 · Bash' } }), mk('c', { status: 'ended', live: false, phase: { kind: 'ended', text: '종료' } })];
  for (const [W, H] of [[140, 40], [80, 32], [60, 24]]) {
    const lines = render(view(sessions), W, H).map(strip);
    assert.equal(lines.length, H);
    for (const l of lines) {
      assert.equal(width(l), W, `${W}x${H}: ${l}`);
      assert.doesNotMatch(l, GRID, `${W}x${H}: ${l}`);
    }
  }
  const boxed = render(view(sessions), 80, 32).map(strip);
  assert.match(boxed[2], /^\+- 세션 3 -+\+$/);
  assert.ok(boxed.some((l) => /^\| >o claude/.test(l)), '고른 행은 > 와 o 로');
  assert.ok(boxed.some((l) => /^\|  ! claude/.test(l)), '응답 대기는 !');
});

test('기본(narrow)은 지금 기호 그대로다', () => {
  const lines = render(view([mk('a')]), 80, 32).map(strip);
  assert.match(lines[2], /^╭─ 세션 1 ─+╮$/);
  assert.ok(lines.some((l) => l.startsWith('│ ▌○ claude')));
});

test('wide 의 막대·가로줄도 정한 칸 수를 지킨다', () => {
  setAmbiguous('wide');
  assert.equal(width(gauge(30, 100, 11).map((x) => x.t).join('')), 16);
  assert.equal(width(rule([{ t: '변경 파일' }], '2개', 40).map((x) => x.t).join('')), 40);
});

// 도구 줄: 이름이 중간에서 잘리지 않고, 줄이고, 그래도 넘치면 +N.
const tools = [mk('a'), mk('b'), mk('c', { tool: 'codex' })];
const words = (l) => l.trim().split(/\s+/);

test('도구 줄은 폭이 모자라면 간격·토큰 수·이름 순으로 줄이고 끝에 +N 을 붙인다', () => {
  for (const mode of ['narrow', 'wide']) {
    setAmbiguous(mode);
    for (let W = 6; W <= 70; W++) {
      const l = strip(toolStrip(view(tools), W));
      assert.equal(width(l), W);
      // 도구 이름은 다 있거나, 짧은 이름이거나, 없다 (잘린 조각 없음).
      for (const w of words(l)) assert.match(w, /^([▍|]?(claude|codex|gemini|cla|cdx|gem)|\d+|·|[\d.]+[kMB]?|\+\d|)$/u, `${mode} W=${W}: ${l}`);
      const shown = words(l).filter((w) => /^[▍|]?(claude|codex|gemini|cla|cdx|gem)$/u.test(w)).length;
      const more = Number(l.match(/\+(\d)/)?.[1] ?? 0);
      assert.equal(shown + more, 3, `${mode} W=${W}: ${l}`);
    }
  }
  setAmbiguous('narrow');
  assert.match(strip(toolStrip(view(tools), 60)), /claude 2 · 2\.0k +▍codex 1 · 1\.0k +gemini/);
  assert.match(strip(toolStrip(view(tools), 20)), /^ ▍cla 2  ▍cdx 1  \+1 /, '실행 중인 도구가 먼저 남는다');
});

test('ambiguous 설정: 환경 변수 > 파일 > 기본값, 잘못된 값은 알린다', () => {
  const file = (values) => ({ path: '/x', exists: true, values, problems: [] });
  assert.deepEqual(resolveConfig({ env: {}, file: file({}) }).values.ambiguous, { value: 'narrow', source: 'default' });
  assert.deepEqual(resolveConfig({ env: {}, file: file({ ambiguous: 'wide' }) }).values.ambiguous, { value: 'wide', source: 'file' });
  assert.deepEqual(resolveConfig({ env: { AITOP_AMBIGUOUS: 'narrow' }, file: file({ ambiguous: 'wide' }) }).values.ambiguous, { value: 'narrow', source: 'env' });
  const bad = resolveConfig({ env: { AITOP_AMBIGUOUS: 'double' }, file: file({}) });
  assert.equal(bad.values.ambiguous.value, 'narrow');
  assert.match(bad.problems.join('\n'), /AITOP_AMBIGUOUS/);
});

test('wide 에서 고정 표시(★)와 활동·7일 막대도 1칸 기호로 그리고 칸을 지킨다', () => {
  setAmbiguous('wide');
  const bar = levelBar([0, 1, 5, 10]).map((x) => x.t).join('');
  assert.equal(bar, '_.=#');
  for (const W of [60, 100, 140]) {
    const c = columns(W);
    const row = strip(sessionRow(mk('a'), c, W, false, 0, null, 'api', true));
    assert.equal(width(row), W);
    assert.doesNotMatch(row, GRID);
    assert.match(row, /\* 세션-a/);
  }
  setAmbiguous('narrow');
  assert.match(strip(sessionRow(mk('a'), columns(100), 100, false, 0, null, 'api', true)), /★ 세션-a/);
});

test('wide 빈 화면의 점검 줄도 일부 지원 표시를 1칸 기호로 그린다', () => {
  setAmbiguous('wide');
  const checks = { gemini: { tool: 'gemini', state: 'limited', found: false, path: '~/.gemini/tmp', records: 0, lastAt: null, running: 0, hint: null } };
  const lines = render({ ...view([]), data: { sessions: [], usage: null, errors: [], at, tools: { tools: checks } } }, 80, 24).map(strip);
  assert.ok(lines.some((l) => /^ {3}o gemini/.test(l)), lines.join('\n'));
  for (const l of lines) assert.doesNotMatch(l, GRID);
});
