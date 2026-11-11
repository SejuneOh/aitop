import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-10-30T05:00:00Z');
const min = (m) => at + m * 60_000;
const file = (name, m) => ({ path: `/work/demo/${name}`, created: false, edits: 1, add: 1, del: 0, at: min(m), hidden: false, dropped: 0, hunks: [{ at: min(m), agent: '메인', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'], cut: 0 }], log: [{ at: min(m), add: 1, del: 0 }] });

// 지시 8개, 지시마다 파일 하나씩 고친 세션
const files = Array.from({ length: 8 }, (_, i) => file(`f${i}.mjs`, i * 10 + 1));
const turns = Array.from({ length: 8 }, (_, i) => ({ n: i + 1, at: min(i * 10), text: `지시 ${i + 1}` }));
const s = { tool: 'claude', id: 's', name: 'demo', cwd: '/work/demo', status: 'busy', live: true, phase: { kind: 'tool', msg: 'toolUnknown' }, updatedAt: at, tokens: { total: 1 }, context: {}, members: [], events: [], files, turns };
const screen = (W, H, extra = {}, sess = s) => render({ data: { sessions: [sess], usage: null, errors: [], at }, selectedId: 's', showDetail: true, frame: 0, tab: 'now', ...extra }, W, H).map(strip).join('\n');

test('11~15 줄에서 지시 탭이 많아도 지시 문장과 편집 수가 남는다', () => {
  assert.match(screen(90, 22), /‹이번 지시›.*"지시 8"  편집 1회/);
});

test('좁은 화면의 diff 머리에서도 파일 위치는 남는다', () => {
  const out = screen(70, 22, { focus: 'diff', filePath: files[7].path });
  assert.match(out, /── ‹ .*f7\.mjs.* 1\/1 ─/);
});

test('고친 파일이 없는 지시에서는 한 줄로 접고, 목록에 들어가면 다른 지시로 가는 방법을 알린다', () => {
  const later = { ...s, turns: [...turns, { n: 9, at: min(100), text: '질문만' }] };
  assert.match(screen(120, 30, {}, later), /── 변경 파일 · 이번 지시 0개 ─+ 전체 \d+개 · f ─/);
  assert.doesNotMatch(screen(120, 30, {}, later), /이 지시에서는 고친 파일 없음/);
  assert.match(screen(120, 30, { focus: 'files', filePath: null }, later), /이 지시에서는 고친 파일 없음 +←\/→ 다른 지시/);
});

test('폭이 모자라면 가로줄 끝의 설명부터 뺀다', () => {
  const out = screen(70, 22);
  assert.ok(out.split('\n').every((l) => !/편집 기록 · Bash 제외 · \d+개 · f ─.*│.*│/.test(l)));
  assert.match(out, /── 변경 파일 ─/);
});
