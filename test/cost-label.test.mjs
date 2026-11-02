import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const MONEY = '38;2;252;211;77';
const at = Date.now();
const sess = (id, extra = {}) => ({ tool: 'claude', id, name: id, cwd: '/w', status: 'idle', live: true, phase: { kind: 'idle', text: '다음 지시 대기' }, updatedAt: at, tokens: { total: 1000 }, cost: 1, context: {}, members: [], events: [], ...extra });
const usage = { today: { cost: 52.1, tokens: 1e8 }, week: { cost: 644, tokens: 1e9 }, loading: null };
const draw = (sessions, W = 140, H = 30, extra = {}) => render({ data: { sessions, usage, errors: [], at }, selectedId: sessions[0]?.id, showDetail: false, frame: 0, ...extra }, W, H);

test('넓은 화면 헤더는 비용이 API 환산임을 적고, 좁으면 뺀다', () => {
  assert.match(strip(draw([sess('a')], 160)[0]), /API 환산 +오늘 \$52/);
  assert.doesNotMatch(strip(draw([sess('a')], 90)[0]), /API 환산/);
});

test('토큰 0 세션은 숫자 칸을 비우고 아직 지시 없음으로 보인다', () => {
  const row = strip(draw([sess('fresh', { tokens: { total: 0 }, cost: 0 })]).find((l) => l.includes('fresh')));
  assert.match(row, /아직 지시 없음/);
  assert.doesNotMatch(row, /\$0\.00|\s0\s/);
});

test('토큰 0 이어도 작업 중이면 상태 글자는 그대로 둔다', () => {
  const row = strip(draw([sess('busy0', { status: 'busy', tokens: { total: 0 }, phase: { kind: 'think', text: '생각 중' } })]).find((l) => l.includes('busy0')));
  assert.match(row, /생각 중/);
});

test('비용 강조는 화면에 보이는 세션에서 고른다', () => {
  // 비용이 가장 큰 두 세션은 표 아래쪽(화면 밖)에 둔다.
  const list = Array.from({ length: 20 }, (_, i) => sess(`s${String(i).padStart(2, '0')}`, { cost: i < 18 ? 10 + i : 1000 + i }));
  const lines = draw(list, 140, 14);
  const shown = lines.filter((l) => /s\d\d/.test(strip(l)));
  assert.ok(!shown.some((l) => /s1[89]/.test(strip(l))), '큰 비용 세션은 화면 밖');
  assert.equal(shown.filter((l) => l.includes(MONEY)).length, 2, '보이는 행 중 두 개를 강조한다');
});
