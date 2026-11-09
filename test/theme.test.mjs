import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickTheme, PALETTES } from '../src/ui/theme.mjs';
import { render } from '../src/ui.mjs';

const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'aitop.mjs');

test('테마는 AITOP_THEME, COLORFGBG 배경색, 기본값 어두움 순으로 고른다', () => {
  assert.equal(pickTheme({}), 'dark');
  assert.equal(pickTheme({ AITOP_THEME: 'light' }), 'light');
  assert.equal(pickTheme({ AITOP_THEME: 'dark', COLORFGBG: '0;15' }), 'dark');
  assert.equal(pickTheme({ COLORFGBG: '0;15' }), 'light');
  assert.equal(pickTheme({ COLORFGBG: '0;7' }), 'light');
  assert.equal(pickTheme({ COLORFGBG: '15;0' }), 'dark');
  assert.equal(pickTheme({ COLORFGBG: '15;default;0' }), 'dark');
  assert.equal(pickTheme({ COLORFGBG: 'x' }), 'dark');
});

// WCAG 상대 휘도 대비
const lum = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// 터미널 배경: 어두운 테마는 Windows Terminal Campbell(#0c0c0c)과 검정, 밝은 테마는 흰색.
const TERMINAL = { dark: ['#0c0c0c', '#000000'], light: ['#ffffff'] };
const INFO = ['text', 'muted', 'info', 'idle', 'ended', 'busy', 'waiting', 'tool', 'team', 'alert', 'money', 'brand'];

// HSV 색상각(0~360). 두 색이 같은 색 계열인지 보는 데 쓴다.
const hue = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (!d) return 0;
  const x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (x * 60 + 360) % 360;
};
const hueGap = (a, b) => {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
};

for (const [name, P] of Object.entries(PALETTES)) {
  test(`${name}: 정보를 담은 글자색은 모든 배경에서 4.5:1 이상이다`, () => {
    const bgs = [...TERMINAL[name], P.rowSel, P.rowFocus, P.rowWaiting, P.bar];
    const colors = [...INFO.map((k) => [k, P[k]]), ...Object.entries(P.tools)];
    for (const bg of bgs) for (const [k, c] of colors) assert.ok(contrast(c, bg) >= 4.5, `${k} ${c} on ${bg}: ${contrast(c, bg).toFixed(2)}`);
    assert.ok(contrast(P.busy, P.addBg) >= 4.5 && contrast(P.alert, P.delBg) >= 4.5, 'diff 의 + / - 줄');
  });

  test(`${name}: text > muted > info 위계가 어느 배경에서도 뚜렷하다`, () => {
    for (const bg of [...TERMINAL[name], P.rowSel, P.rowFocus, P.rowWaiting, P.bar]) {
      assert.ok(contrast(P.text, bg) / contrast(P.muted, bg) >= 1.3, `text/muted on ${bg}`);
      assert.ok(contrast(P.muted, bg) / contrast(P.info, bg) >= 1.3, `muted/info on ${bg}`);
    }
    assert.equal(P.ended, P.info, '종료 행은 info 단계');
  });

  test(`${name}: 대기 색은 사람이 응답할 때만 쓰므로 다른 색과 겹치지 않고, 돈 색과는 색 계열이 다르다`, () => {
    for (const [k, c] of [...Object.entries(P).filter(([k, c]) => typeof c === 'string' && k !== 'waiting'), ...Object.entries(P.tools)]) assert.notEqual(c, P.waiting, k);
    assert.ok(hueGap(P.money, P.waiting) >= 35, `money ${P.money} vs waiting ${P.waiting}: ${hueGap(P.money, P.waiting).toFixed(0)}°`);
    assert.ok(hueGap(P.money, P.busy) >= 35, `money ${P.money} vs busy ${P.busy}`);
  });
}

test('밝은 팔레트의 칩과 diff 배경', () => {
  const P = PALETTES.light;
  assert.ok(contrast(P.chipText, P.brand) >= 4.5, '로고 칩');
  assert.ok(contrast(P.chipText, P.muted) >= 4.5, '키 칩');
  assert.ok(contrast(P.text, P.addBg) >= 7 && contrast(P.text, P.delBg) >= 7, 'diff 배경');
});

test('두 팔레트는 같은 색 이름을 가진다', () => {
  assert.deepEqual(Object.keys(PALETTES.light).sort(), Object.keys(PALETTES.dark).sort());
  assert.deepEqual(Object.keys(PALETTES.light.tools).sort(), Object.keys(PALETTES.dark.tools).sort());
});

test('▲ 가 붙어도 큰 금액과 ? 가 잘리지 않는다', () => {
  const at = Date.now();
  const s = { tool: 'claude', id: 'big', name: 'big', cwd: '/w', status: 'idle', live: true, phase: { kind: 'idle', text: '대기' }, updatedAt: at, tokens: { total: 1000 }, cost: 12345, costUnknown: true, context: {}, members: [], events: [] };
  const row = render({ data: { sessions: [s], usage: null, errors: [], at }, selectedId: 'big', showDetail: false, frame: 0 }, 140, 20).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).find((l) => l.includes(' big '));
  assert.match(row, /▲\$12,345\?/);
});

test('비용 상위에는 ▲, 컨텍스트 85% 이상에는 ! 를 붙인다 (색 없이도 보이게)', () => {
  const at = Date.now();
  const s = (id, cost, used) => ({ tool: 'claude', id, name: id, cwd: '/w', status: 'idle', live: true, phase: { kind: 'idle', text: '대기' }, updatedAt: at, tokens: { total: 1000 }, cost, context: { used, window: 1_000_000 }, members: [], events: [] });
  const lines = render({ data: { sessions: [s('aa', 50, 900_000), s('bb', 40, 100_000), s('cc', 1, 100_000)], usage: null, errors: [], at }, selectedId: 'aa', showDetail: false, frame: 0 }, 140, 20).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const row = (id) => lines.find((l) => l.includes(` ${id} `));
  assert.match(row('aa'), /▲\$50\.00/);
  assert.match(row('aa'), /!90%/);
  assert.match(row('bb'), /▲\$40\.00/);
  assert.doesNotMatch(row('cc'), /▲/);
  assert.match(row('cc'), / 10%/);
});

test('aitop --theme light 는 밝은 팔레트로 그리고, 모르는 값은 오류', () => {
  const run = (...a) => spawnSync(process.execPath, [BIN, '--once', ...a], { env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' }, encoding: 'utf8' });
  const light = run('--theme', 'light');
  assert.equal(light.status, 0);
  assert.match(light.stdout, /38;2;31;35;40m/, '밝은 테마 글자색 #1f2328');
  assert.match(run('--theme=dark').stdout, /38;2;230;232;238m/, '어두운 테마 글자색 #e6e8ee');
  const bad = run('--theme', 'blue');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /모르는 옵션 --theme blue/);
  for (const args of [['--theme'], ['--theme='], ['--theme', '--all']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /--theme 값이 없습니다/);
  }
});
