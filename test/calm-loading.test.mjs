// 시작할 때 차분한 로딩 (#182): 준비 완료 래치, 정렬·▲ 고정, 진행 줄, 다시 그리기 속도 제한.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { admit, createLoading, latchReady, READY_CAP_MS } from '../src/loading.mjs';
import { arrange } from '../src/order.mjs';
import { render } from '../src/ui.mjs';
import { header, progressStep } from '../src/ui/table.mjs';
import { getLang, setLang } from '../src/i18n.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const AT = new Date(2026, 10, 11, 9).getTime();
const clockAt = (start = 0) => {
  const c = { t: start, now: () => c.t };
  return c;
};
const S = (id, cost, extra = {}) => ({ tool: 'claude', id, name: `s-${id}`, cwd: '/w', project: 'w', status: 'busy', live: true, phase: { kind: 'think' }, updatedAt: AT, startedAt: AT, tokens: { total: 10 }, cost, costNoCache: cost, context: { used: cost * 1000, window: 200_000 }, members: [], events: [], ...extra });
const U = { today: { cost: 12.3, costNoCache: 3, tokens: 5.8e7 }, week: { cost: 174.3, costNoCache: 43, tokens: 2.2e9 }, days7: null, lastHour: { cost: 5, costNoCache: 1 }, loading: null };

test('준비 완료는 처음 more 가 거짓일 때 켜지고, 다시 참이 돼도 꺼지지 않는다', () => {
  const c = clockAt();
  const L = createLoading({ now: c.now });
  assert.equal(latchReady(L, true), false);
  c.t = 500;
  assert.equal(latchReady(L, false), true);
  c.t = 900;
  assert.equal(latchReady(L, true), true, '시간 한도로 more 가 다시 참이 돼도 그대로');
});

test('more 가 계속 참이어도 60초가 지나면 준비 완료', () => {
  const c = clockAt(1000);
  const L = createLoading({ now: c.now });
  for (let t = 0; t < READY_CAP_MS; t += 15) {
    c.t = 1000 + t;
    assert.equal(latchReady(L, true), false, `t=${t}`);
  }
  c.t = 1000 + READY_CAP_MS;
  assert.equal(latchReady(L, true), true);
  c.t += 10_000;
  assert.equal(latchReady(L, true), true);
});

test('준비 완료 전에는 비용·컨텍스트 정렬을 고정하고, 응답 대기는 그동안에도 맨 위', () => {
  const list = [S('a', 1), S('b', 5), S('c', 3), S('w', 0.5, { status: 'waiting', phase: { kind: 'waiting' } }), S('e', 9, { status: 'ended', live: false })];
  for (const sort of ['cost', 'context']) {
    const frozen = arrange(list, { sort, ready: false }).sessions.map((s) => s.id);
    assert.deepEqual(frozen, ['w', 'a', 'b', 'c', 'e'], `${sort}: 받은 순서 그대로, 종료는 아래`);
    // 값이 커져도 자리가 바뀌지 않는다.
    const grown = list.map((s) => (s.id === 'c' ? { ...s, cost: 50, context: { used: 190_000, window: 200_000 } } : s));
    assert.deepEqual(arrange(grown, { sort, ready: false }).sessions.map((s) => s.id), frozen);
    assert.deepEqual(arrange(grown, { sort, ready: true }).sessions.map((s) => s.id), ['w', 'c', 'b', 'a', 'e'], `${sort}: 준비 완료 뒤에 한 번 다시 정렬`);
  }
  // 최근 순 정렬은 기록을 읽는 양과 상관없으므로 고정하지 않는다.
  const recent = [S('a', 1, { updatedAt: 1 }), S('b', 1, { updatedAt: 2 })];
  assert.deepEqual(arrange(recent, { sort: 'recent', ready: false }).sessions.map((s) => s.id), ['b', 'a']);
});

test('준비 완료 전에는 ▲ 를 붙이지 않고, 준비 완료 때 다시 정렬해도 고른 세션이 보인다', () => {
  // 12개 세션, 비용 정렬, 화면이 낮아 다 들어가지 않는다. 고른 세션(s-0)은 처음엔 위, 다시 정렬하면 맨 아래로 간다.
  const sessions = Array.from({ length: 12 }, (_, i) => S(String(i), i + 1));
  const view = { data: { sessions, usage: U, errors: [], at: AT }, sort: 'cost', selectedId: '0', showDetail: false, frame: 0, ready: false, costMode: 'api' };
  const before = render(view, 100, 10).map(strip);
  assert.ok(!before.some((l) => l.includes('▲')), '준비 완료 전 ▲ 없음');
  assert.ok(before.some((l) => l.includes('▌') && l.includes('s-0')), '고른 세션이 보인다');
  view.ready = true;
  const after = render(view, 100, 10).map(strip);
  assert.ok(after.some((l) => l.includes('▲')), '준비 완료 뒤 ▲');
  assert.ok(after.some((l) => l.includes('▌') && l.includes('s-0')), '다시 정렬해도 고른 세션이 보인다');
  assert.ok(after.findIndex((l) => l.includes('s-11')) < after.findIndex((l) => l.includes('s-0')), '비용 큰 세션이 위');
});

test('기록을 읽는 중인 세션은 TOKENS·COST·CONTEXT 가 … 이고, 다 읽은 0 은 0 이다', () => {
  const view = { data: { sessions: [S('a', 2, { loading: true, phase: { kind: 'think', msg: 'loading' } }), S('z', 0, { tokens: { total: 5 }, context: { used: 0, window: 200_000 } })], usage: U, errors: [], at: AT }, selectedId: 'a', showDetail: false, frame: 0, ready: false };
  for (const W of [100, 60]) {
    const lines = render(view, W, 10).map(strip);
    const a = lines.find((l) => l.includes('s-a'));
    const z = lines.find((l) => l.includes('s-z'));
    assert.ok(a, `W=${W}`);
    assert.ok(!/\$|\d+%|기록 읽는 중/.test(a), `W=${W} 덜 찬 숫자·진행률 없음: ${a}`);
    assert.ok((a.match(/…/g) ?? []).length >= 3, `W=${W} … 자리표시: ${a}`);
    assert.match(z, /\$0\.00|0%/, `W=${W} 0 은 0: ${z}`);
    assert.ok(!z.includes('…'), `W=${W}`);
  }
});

test('진행률은 10% 단위, 헤더 진행 줄은 넓으면 막대, 60칸이면 글과 % 만', () => {
  assert.deepEqual([0, 0.09, 0.1, 0.39, 0.4, 0.999, 1].map(progressStep), [0, 0, 10, 30, 40, 90, 100]);
  const head = (W, loading) => strip(header({ data: { sessions: [S('a', 1)], usage: { ...U, loading }, at: AT }, costMode: 'api' }, W));
  assert.match(head(100, 0.43), /집계 중 ▕████░░░░░░▏ 40% · 09:00:00 $/);
  assert.equal(head(100, 0.43), head(100, 0.47), '같은 10% 단계 안에서는 헤더가 같다');
  const narrow = head(60, 0.43);
  assert.match(narrow, /집계 중 40% · 09:00:00 $/);
  assert.ok(!/[▕▏█░]/.test(narrow), narrow);
  assert.ok(!/오늘|7일/.test(head(200, 0.43)), '오늘·7일 자리를 진행 줄로 바꾼다');
  const before = getLang();
  try {
    setLang('en');
    assert.match(head(100, 0.43), /Loading ▕████░░░░░░▏ 40% · /);
  } finally {
    setLang(before);
  }
});

test('NO_COLOR 와 폭이 모호한 글자를 2칸으로 그리는 터미널에서는 진행 막대가 # 과 . 이다', () => {
  const src = `const { header } = await import(${JSON.stringify(new URL('../src/ui/table.mjs', import.meta.url).href)});
const { setAmbiguous } = await import(${JSON.stringify(new URL('../src/text.mjs', import.meta.url).href)});
if (process.env.WIDE) setAmbiguous('wide');
process.stdout.write(header({ data: { sessions: [], usage: ${JSON.stringify({ ...U, loading: 0.65 })}, at: ${AT} }, costMode: 'api' }, 100));`;
  const run = (env) => execFileSync(process.execPath, ['--input-type=module', '-e', src], { env: { ...process.env, AITOP_LANG: 'ko', ...env }, encoding: 'utf8' });
  const plain = run({ NO_COLOR: '1' });
  assert.ok(!plain.includes('\x1b['), '색 코드 없음');
  assert.match(plain, /집계 중 \[######\.\.\.\.\] 60%/);
  assert.match(strip(run({ WIDE: '1' })), /집계 중 \[######\.\.\.\.\] 60%/);
});

test('로딩 중 다시 그리기는 초당 한 번, 응답 대기·준비 완료·집계 끝은 바로', () => {
  const c = clockAt();
  const L = createLoading({ now: c.now });
  const data = (more, loading, waiting = []) => ({ more, usage: { ...U, loading }, sessions: ['a', 'b', 'c'].map((id) => ({ id, status: waiting.includes(id) ? 'waiting' : 'busy' })) });
  let shown = 0;
  // 2초 동안 15ms 마다 갱신: 첫 화면 + 1초에 한 번.
  for (; c.t < 2000; c.t += 15) shown += admit(L, data(true, 0.1)) ? 1 : 0;
  assert.ok(shown >= 2 && shown <= 3, `shown=${shown}`);
  // 응답 대기가 생기면 1초를 기다리지 않는다.
  c.t = 5000;
  assert.equal(admit(L, data(true, 0.1)), true, '1초가 지났으면 올린다');
  c.t += 15;
  assert.equal(admit(L, data(true, 0.1)), false);
  assert.equal(admit(L, data(true, 0.1, ['b'])), true, '응답 대기 변화');
  assert.equal(admit(L, data(true, 0.2, ['b'])), false);
  assert.equal(admit(L, data(false, 0.2, ['b'])), true, '준비 완료 순간');
  assert.equal(L.ready, true);
  assert.equal(admit(L, data(false, 0.3, ['b'])), false, '준비 완료 뒤에도 집계 중이면 초당 한 번');
  assert.equal(admit(L, data(false, null, ['b'])), true, '집계가 끝난 순간');
  assert.equal(admit(L, data(false, null, ['b'])), true, '로딩이 끝난 뒤에는 늘 올린다');
});

test('bin 처럼 latchReady 를 먼저 불러도 준비 완료 순간은 장부 집계 중에도 바로 올린다', () => {
  const c = clockAt();
  const L = createLoading({ now: c.now });
  const data = (sessionsMore) => ({ more: true, sessionsMore, usage: { ...U, loading: 0.5 }, sessions: [{ id: 'a', status: 'busy' }] });
  latchReady(L, true);
  assert.equal(admit(L, data(true)), true, '첫 화면');
  c.t += 15;
  latchReady(L, true);
  assert.equal(admit(L, data(true)), false);
  c.t += 15;
  assert.equal(latchReady(L, false), true, 'bin 이 먼저 래치');
  assert.equal(admit(L, data(false)), true, '준비 완료 순간은 1초를 기다리지 않는다');
  c.t += 15;
  latchReady(L, false);
  assert.equal(admit(L, data(false)), false, '그 뒤 집계 중에는 다시 초당 한 번');
});

// 갱신마다 admit 으로 거른 뒤 그린 화면을 세어 실제로 바뀐 횟수를 잰다 (시계 고정).
function countChanges(ticks) {
  const c = clockAt();
  const L = createLoading({ now: c.now });
  const view = { data: null, selectedId: 'a', showDetail: false, frame: 0, ready: false };
  let last = render(view, 100, 12).join('\n');
  let changes = 1;
  for (const d of ticks) {
    c.t += d.dt ?? 15;
    if (!admit(L, d)) continue;
    view.ready = L.ready;
    view.data = { errors: [], at: AT, ...d };
    const frame = render(view, 100, 12).join('\n');
    if (frame !== last) changes++;
    last = frame;
  }
  return changes;
}

test('세션 기록을 다 읽으면 7일 장부가 아직 집계 중이어도 준비 완료, 헤더 진행 줄은 남는다', async () => {
  const { makeClaudeHome, assistant, user, usage } = await import('./fixture.mjs');
  const fx = makeClaudeHome();
  fx.session({ sessionId: 'rrrrrrrr-1' });
  fx.transcript('rrrrrrrr-1', [user('작업'), assistant('m1', [{ type: 'text', text: 'ok' }], usage(1, 1))]);
  // 장부만 큰 기록: 끝난 세션(세션 파일 없음)의 6 MB 기록. 세션 쪽은 끝난 세션 본문을 읽지 않는다.
  const big = 'x'.repeat(1024 * 1024);
  fx.transcript('ssssssss-2', Array.from({ length: 6 }, (_, i) => assistant(`b${i}`, [{ type: 'text', text: big }], usage(1, 1))), '-work-old');
  // 이 PC 의 실제 Gemini 기록(~/.gemini)을 읽지 않게 HOME 을 빈 폴더로 둔 하위 프로세스에서 모은다.
  const src = `const { collect } = await import(${JSON.stringify(new URL('../src/collect.mjs', import.meta.url).href)});
const d = collect({ budgetBytes: 3 * 1024 * 1024, budgetMs: Infinity });
process.stdout.write(JSON.stringify({ more: d.more, sessionsMore: d.sessionsMore, usage: d.usage, sessions: d.sessions.map((s) => ({ id: s.id, status: s.status })) }));`;
  const data = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { env: { ...process.env, HOME: join(fx.home, 'home') }, encoding: 'utf8' }));
  assert.equal(data.sessionsMore, false, '세션 기록은 다 읽었다');
  assert.equal(data.more, true, '장부는 덜 읽었다');
  assert.ok(data.usage.loading != null, '7일 집계 중');
  const L = createLoading();
  assert.equal(admit(L, data), true);
  assert.equal(L.ready, true, '장부를 기다리지 않고 준비 완료');
  const top = strip(header({ data: { ...data, at: AT }, costMode: 'api' }, 100));
  assert.match(top, /집계 중 ▕[█░]{10}▏ \d+%/);
});

test('캐시가 있으면 진행 표시 없이 완성 화면, 화면 변화는 2번 이하', () => {
  const warm = { more: false, usage: U, sessions: [S('a', 3), S('b', 1)] };
  assert.ok(countChanges(Array.from({ length: 5 }, () => ({ ...warm, dt: 1000 }))) <= 2);
  const L = createLoading();
  admit(L, warm);
  assert.equal(L.ready, true, '첫 갱신에 준비 완료');
  const out = render({ data: { ...warm, errors: [], at: AT }, selectedId: 'a', showDetail: false, frame: 0, ready: true }, 100, 12).map(strip).join('\n');
  assert.ok(!/집계 중|…/.test(out), out);
});

test('캐시가 없을 때 화면 변화가 크게 준다 (값이 매 갱신 커져도)', () => {
  // 3초 동안 15ms 마다 세션 값과 7일 진행률이 커지는 갱신 200번.
  const ticks = Array.from({ length: 200 }, (_, i) => ({
    more: i < 150,
    usage: { ...U, loading: i < 199 ? i / 200 : null },
    sessions: [S('a', i + 1, { loading: i < 150, tokens: { total: i * 100 } }), S('b', i / 2 + 1, { loading: i < 100 })],
  }));
  const n = countChanges(ticks);
  assert.ok(n <= 8, `changes=${n}`);
});
