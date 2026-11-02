import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { render, PALETTE } from '../src/ui.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-10-30T05:00:00Z');
const min = (m) => at + m * 60_000;
const file = (name, m) => ({ path: `/w/${name}`, edits: 1, add: 1, del: 0, at: min(m), hunks: [], log: [{ at: min(m), add: 1, del: 0 }] });
const turns = Array.from({ length: 8 }, (_, i) => ({ n: i + 1, at: min(i * 10), text: `지시 ${i + 1}` }));
const s = { tool: 'claude', id: 's', name: 'demo', cwd: '/w', model: 'claude-opus-5-5', status: 'busy', live: true, phase: { kind: 'tool', text: '도구' }, updatedAt: at, tokens: { total: 1 }, cost: 1, context: { used: 680_000, window: 1_000_000 }, members: [], events: [], files: turns.map((t, i) => file(`f${i}.mjs`, i * 10 + 1)), turns };
const view = (extra = {}) => ({ data: { sessions: [s], usage: null, errors: [], at }, selectedId: 's', showDetail: true, frame: 0, tab: 'now', ...extra });

test('파일 목록·diff 에 들어가면 상세 상자 테두리만 강조색이 된다', () => {
  const brand = `38;2;${[1, 3, 5].map((i) => parseInt(PALETTE.brand.slice(i, i + 2), 16)).join(';')}m╭`;
  const top = (v) => render(v, 120, 24).find((l) => strip(l).startsWith('╭─ demo'));
  assert.ok(!top(view()).includes(brand));
  assert.ok(top(view({ focus: 'files', filePath: '/w/f7.mjs' })).includes(brand));
});

test('색이 없으면 포커스된 상자를 굵은 선으로 그린다', () => {
  const script = `
    const { render } = await import(${JSON.stringify(new URL('../src/ui.mjs', import.meta.url).href)});
    const v = JSON.parse(process.argv[1]);
    process.stdout.write(render(v, 120, 24).join('\\n'));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(view({ focus: 'files', filePath: '/w/f7.mjs' }))], { env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' });
  assert.match(out, /^┏━ demo/m);
  assert.match(out, /^┃ /m);
  assert.doesNotMatch(out, /\x1b\[/);
});

test('패널 제목은 세션 이름과 도구·모델, 왼쪽 칸은 가로줄 구획', () => {
  const lines = render(view(), 120, 30).map(strip);
  assert.ok(lines.some((l) => /^╭─ demo  claude · claude-opus-5-5 ─/.test(l)));
  for (const name of ['세션', '토큰', '비용']) assert.ok(lines.some((l) => l.startsWith(`│ ── ${name} ─`)), name);
});

test('이전 지시 탭은 3개까지 보이고 나머지는 … +N 으로 접으며, 고른 탭은 늘 보인다', () => {
  const tabLine = (v) => render(v, 140, 30).map(strip).find((l) => l.includes('‹'));
  assert.match(tabLine(view()), /‹이번 지시›  T7  T6  T5  … \+4  전체/);
  // 숨긴 탭 수는 숨긴 쪽에 따로 붙는다.
  assert.match(tabLine(view({ tab: 2 })), /이번 지시  … \+3  T4  T3  ‹T2›  … \+1  전체/);
});

test('좁은 화면에서도 고른 탭은 잘리지 않는다', () => {
  for (const W of [60, 70, 80]) {
    for (const tab of ['all', 2, 'now']) {
      const line = render(view({ tab }), W, 24).map(strip).find((l) => l.includes('‹'));
      assert.match(line, /‹(전체|T2|이번 지시)›/, `${W} ${tab}`);
    }
  }
});

test('컨텍스트 막대는 같은 높이의 얇은 블록으로 그리고 끝 조각을 쓰지 않는다', () => {
  const row = render(view(), 140, 30).map(strip).find((l) => /demo/.test(l) && /%/.test(l) && !l.startsWith('╭'));
  assert.equal(row.match(/(\S+)\s+68%/)[1], '▃'.repeat(11));
});
