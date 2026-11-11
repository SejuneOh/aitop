import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-10-30T05:00:00Z');
const file = (name, min) => ({ path: `/work/demo/${name}`, created: false, edits: 1, add: 1, del: 0, at: at + min * 60_000, hidden: false, dropped: 0, hunks: [], log: [{ at: at + min * 60_000, add: 1, del: 0 }] });
const s = {
  tool: 'claude', id: 's', name: 'demo', cwd: '/work/demo', status: 'busy', live: true, phase: { kind: 'tool', msg: 'toolUnknown' }, updatedAt: at, tokens: { total: 1 }, context: {}, members: [],
  events: [{ at, kind: 'prompt', text: 'footer 정리해줘' }],
  files: [file('a.mjs', 2), file('b.mjs', 1)],
  turns: [{ n: 1, at, text: 'footer 정리해줘' }],
};
const screen = (H) => render({ data: { sessions: [s], usage: null, errors: [], at }, selectedId: 's', showDetail: true, frame: 0, tab: 'now' }, 120, H).map(strip).join('\n');

test('안쪽 줄이 10 이하면 가로줄 하나에 탭 이름만 보인다', () => {
  const out = screen(18);
  assert.match(out, /── 변경 파일 · 이번 지시 ─/);
  assert.doesNotMatch(out, /‹이번 지시›/);
});

test('안쪽 줄이 11~15 면 지시 문장을 탭 줄 오른쪽에 붙인다', () => {
  assert.match(screen(22), /‹이번 지시›  전체 +\d\d:\d\d "footer 정리해줘"/);
});

test('안쪽 줄이 16 이상이면 가로줄, 탭, 지시 문장을 따로 둔다', () => {
  const lines = screen(30).split('\n');
  const i = lines.findIndex((l) => l.includes('‹이번 지시›'));
  assert.match(lines[i - 1], /── 변경 파일 ─/);
  assert.match(lines[i + 1], /\d\d:\d\d "footer 정리해줘"/);
  assert.doesNotMatch(lines[i], /footer/);
});
