import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';
import { width } from '../src/text.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-10-30T05:00:00Z');
const file = (name, m) => ({ path: `/work/demo/${name}`, created: false, edits: 1, add: 1, del: 0, at: at + m * 60_000, hidden: false, dropped: 0, hunks: [{ at: at + m * 60_000, agent: '메인', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'], cut: 0 }], log: [{ at: at + m * 60_000, add: 1, del: 0 }] });
const events = Array.from({ length: 30 }, (_, i) => ({ at: at + i * 1000, kind: 'tool', text: `작업 ${i}` }));
const session = (n) => ({ tool: 'claude', id: 's', name: 'demo', cwd: '/work/demo', status: 'busy', live: true, phase: { kind: 'tool', text: '도구' }, updatedAt: at, tokens: { total: 1 }, context: {}, members: [], events, files: Array.from({ length: n }, (_, i) => file(`f${i}.mjs`, i + 1)), turns: [{ n: 1, at, text: 'footer 정리해줘' }] });

// 상세 패널 오른쪽 칸만 잘라 낸다. 칸의 시작은 최근 활동 가로줄(▌ 막대가 붙지 않는 줄)이 시작하는 화면 열이다.
// diff 화면처럼 그 가로줄이 없으면 첫 줄의 가로줄로 찾는다.
function right(H, extra = {}, n = 3, W = 120) {
  const lines = render({ data: { sessions: [session(n)], usage: null, errors: [], at }, selectedId: 's', showDetail: true, frame: 0, tab: 'now', ...extra }, W, H).map(strip);
  // 높은 화면에서는 세션 표도 상자라서, 상세 패널은 마지막 상자다.
  const top = lines.findLastIndex((l) => l.startsWith('╭'));
  const body = lines.slice(top + 1, lines.findIndex((l, i) => i > top && l.startsWith('╰')));
  // 왼쪽 칸에도 가로줄이 있으므로 라벨로 위치를 찾는다.
  const ruled = body.find((l) => l.includes('── 최근 활동'));
  const col = ruled ? width(ruled.slice(0, ruled.indexOf('── 최근 활동'))) : width(body[0].slice(0, body[0].indexOf('│', 2) + 2));
  return body.map((l) => {
    let w = 0;
    let i = 0;
    const chars = [...l];
    while (i < chars.length && w < col) w += width(chars[i++]);
    return chars.slice(i, -2).join('').trimEnd();
  });
}

test('안쪽 16줄 이상이면 지시 문장 아래와 최근 활동 가로줄 위에 빈 줄을 둔다', () => {
  const R = right(34);
  const note = R.findIndex((l) => l.includes('"footer 정리해줘"'));
  assert.equal(R[note + 1], '');
  assert.match(R[note + 2], /f0\.mjs|f\d\.mjs/);
  const act = R.findIndex((l) => l.startsWith('── 최근 활동'));
  assert.equal(R[act - 1], '');
  assert.match(R[act + 1], /^ \d\d:\d\d:\d\d  • /, '최근 활동은 1칸 들여 쓴다');
});

test('안쪽 15줄 이하면 빈 줄을 두지 않는다', () => {
  const R = right(24);
  const act = R.findIndex((l) => l.startsWith('── 최근 활동'));
  assert.ok(act > 0);
  assert.ok(R.slice(0, act).every((l) => l !== ''), R.slice(0, act).join('\n'));
});

test('파일이 많아도 최근 활동은 3줄 이상 남는다', () => {
  for (const H of [24, 28, 30, 34, 40]) {
    const R = right(H, {}, 20);
    const act = R.findIndex((l) => l.startsWith('── 최근 활동'));
    assert.ok(R.length - act - 1 >= 3, `H=${H}`);
  }
});

test('목록에 들어가 있으면 빈 줄 두 곳에도 ▌ 막대가 이어진다', () => {
  const R = right(34, { focus: 'files', filePath: '/work/demo/f2.mjs' });
  const note = R.findIndex((l) => l.includes('"footer 정리해줘"'));
  const act = R.findIndex((l) => l.startsWith('── 최근 활동'));
  assert.equal(R[note + 1], '▌');
  assert.equal(R[act - 1], '▌');
});

test('diff 는 16줄 이상에서 머리 아래 빈 줄 하나를 둔다', () => {
  const R = right(34, { focus: 'diff', filePath: '/work/demo/f2.mjs' });
  assert.match(R[0], /^── ‹ f2\.mjs/);
  assert.equal(R[1], '');
  assert.match(R[2], /^ \d\d:\d\d:\d\d · 메인 · @@/);
});
