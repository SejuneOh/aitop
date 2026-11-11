import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { header, weekBar } from '../src/ui/table.mjs';
import { glyphs as glyphSet } from '../src/ui/glyphs.mjs';
import { PALETTE } from '../src/ui/theme.mjs';
import { toJson } from '../src/json.mjs';
import { width } from '../src/text.mjs';

const glyphs = (days, mode) => weekBar(days, mode).map((x) => x.t).join('');
const D = (costs, f = 1) => costs.map((c, i) => ({ date: `2026-11-0${4 + i}`, cost: c, costNoCache: c * f, unknown: false }));

test('막대는 7일 중 가장 큰 날을 █ 로 맞추고, 0 인 날은 흐린 ▁, 쓴 날은 ▂ 이상', () => {
  assert.equal(glyphSet().week, '▁▂▃▄▅▆▇█');
  assert.equal(glyphs(D([0, 0, 0, 0, 0, 0, 0])), '▁▁▁▁▁▁▁', '모두 0');
  assert.ok(weekBar(D([0, 0, 0, 0, 0, 0, 0])).every((x) => x.fg === PALETTE.faint));
  assert.equal(glyphs(D([0, 0, 0, 100, 0, 0, 0])), '▁▁▁█▁▁▁', '큰 날 하나');
  assert.equal(glyphs(D([0.01, 0, 0, 100, 0, 0, 0])), '▂▁▁█▁▁▁', '아주 적게 쓴 날도 0 과 구분된다');
  assert.equal(glyphs(D([0, 0, 0, 0, 0, 0, 3])), '▁▁▁▁▁▁█', '오늘만');
  assert.equal(glyphs(D([10, 20, 30, 40, 50, 60, 70])), '▂▃▄▅▆▇█', '오래된 날 → 오늘 순서 그대로');
  const bar = weekBar(D([0, 5, 0, 0, 0, 0, 10]));
  assert.equal(bar[1].fg, PALETTE.info);
  for (const x of bar) assert.ok(![PALETTE.waiting, PALETTE.alert].includes(x.fg));
  const unpriced = D([0, 0, 0, 0, 0, 0, 0]).map((d, i) => (i === 2 ? { ...d, unknown: true } : d));
  assert.equal(glyphs(unpriced), '▁▁?▁▁▁▁', '가격 모르는 모델만 쓴 날은 ? 로 쓰지 않은 날과 갈린다');
  assert.equal(weekBar(unpriced)[2].fg, PALETTE.muted);
  assert.equal(glyphs(D([0, 0, 0, 0, 0, 0, 5]).map((d, i) => (i === 6 ? { ...d, unknown: true } : d))), '▁▁▁▁▁▁█', '아는 몫이 있으면 막대 그대로');
  assert.equal(glyphs(D([10, 0, 0, 0, 0, 0, 5], 0), 'net'), '▁▁▁▁▁▁▁', '캐시 제외 화면은 캐시 제외 비용으로 맞춘다');
});

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const AT = new Date(2026, 10, 10, 18).getTime();
const sess = { tool: 'claude', id: 'a', name: 'a', cwd: '/w', status: 'busy', live: true, phase: { kind: 'think' }, updatedAt: AT, tokens: { total: 1 }, cost: 1, context: {}, members: [], events: [] };
const U = { today: { cost: 12.3, costNoCache: 3, tokens: 5.8e7 }, week: { cost: 174.3, costNoCache: 43, tokens: 2.2e9 }, days7: D([40, 0, 12, 80, 25, 5, 12.3], 0.25), lastHour: { cost: 5, costNoCache: 1, unknown: false }, recentToday: { cost: 5, costNoCache: 1, unknown: false, ms: 3600_000 }, loading: null };
const head = (W, { budgetDay, costMode = 'api', u = U } = {}) => strip(header({ data: { sessions: [sess, { ...sess, id: 'b', status: 'idle' }, { ...sess, id: 'c', status: 'waiting' }], usage: u, at: AT }, costMode, budgetDay }, W));
const BAR = '▅▁▃█▄▂▃';

test('헤더: 7일 금액 뒤에 막대, 폭이 모자라면 지출 속도 다음, 토큰 수보다 먼저 뺀다', () => {
  assert.match(head(160), /오늘 \$12\.30 \(\$5\.00\/h\) 58\.0M · 7일 \$174 ▅▁▃█▄▂▃ 2\.20B · 18:00:00/);
  assert.match(head(120), /7일 \$174 ▅▁▃█▄▂▃ 2\.20B/);
  for (const W of [60, 80, 100]) assert.ok(!head(W).includes(BAR), `W=${W}`);
  assert.match(head(100), /58\.0M · 7일 \$174 2\.20B/, '막대를 빼도 토큰 수는 남는다');
  // 막대가 보이는 폭에서는 막대가 없는 헤더보다 앞선 단계를 쓰고, 막대가 빠지면 막대 없는 헤더와 같다.
  const plain = { ...U, days7: undefined };
  for (let W = 40; W <= 200; W++) {
    const line = head(W);
    assert.ok(width(line) <= W, `W=${W}`);
    if (!line.includes(BAR)) assert.equal(line.replace(/\(\$5\.00\/h\) /, ''), head(W, { u: plain }).replace(/\(\$5\.00\/h\) /, ''), `W=${W}`);
    else assert.match(line, /58\.0M/, `W=${W}: 막대가 있으면 토큰 수도 있다`);
  }
});

test('예산 경고가 있어도 막대가 경고를 밀어내지 않는다 (60·80·100·120·160칸)', () => {
  for (const W of [60, 80, 100, 120, 160]) {
    assert.match(head(W, { budgetDay: 30 }), /예상 \$42!/, `W=${W}`);
    assert.match(head(W, { budgetDay: 30, costMode: 'net' }), /예상 \$42!/, `net W=${W}`);
  }
  assert.match(head(160, { budgetDay: 30 }), /예상 \$42! · 7일 \$174 ▅▁▃█▄▂▃ 2\.20B/);
  for (const W of [60, 80, 100, 120]) assert.ok(!head(W, { budgetDay: 30 }).includes(BAR), `W=${W}`);
});

test('집계 중이거나 날짜별 값이 없으면 막대를 그리지 않는다', () => {
  // 집계 중에는 오늘·7일·1시간·7일 막대 자리에 진행 줄 하나만 둔다.
  const busy = head(200, { u: { ...U, loading: 0.4 } });
  assert.match(busy, /집계 중 ▕████░░░░░░▏ 40% · /);
  assert.ok(!/오늘|7일|\/h/.test(busy), busy);
  assert.ok(!/[▁▂▃▄▅▆▇]/.test(busy));
  assert.ok(!/[▁▂▃▄▅▆▇█]/.test(head(200, { u: { ...U, days7: undefined } })));
  assert.match(head(200, { u: { ...U, days7: D([0, 0, 0, 0, 0, 0, 0]) } }), /7일 \$174 ▁▁▁▁▁▁▁ /, '모두 0 이면 바닥선만');
});

test('NO_COLOR 에서도 막대 글자로 읽힌다', () => {
  const src = `const { header } = await import(${JSON.stringify(new URL('../src/ui/table.mjs', import.meta.url).href)});
const days7 = ${JSON.stringify(U.days7)};
const u = { ...${JSON.stringify({ ...U, days7: undefined })}, days7 };
process.stdout.write(header({ data: { sessions: [], usage: u, at: ${AT} }, costMode: 'api' }, 200));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], { env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' });
  assert.ok(!out.includes('\x1b['), '색 코드 없음');
  assert.ok(out.includes(`7일 $174 ${BAR} 2.20B`), out);
});

test('--json: last7days.daily 에 날짜별 API 환산 비용 (오래된 날 → 오늘)', () => {
  const j = toJson({ at: AT, sessions: [], usage: U });
  assert.deepEqual(j.usage.last7days.daily.map((d) => d.cost), [40, 0, 12, 80, 25, 5, 12.3]);
  assert.equal(j.usage.last7days.daily[0].date, '2026-11-04');
  assert.deepEqual(Object.keys(j.usage.last7days.daily[0]), ['date', 'cost', 'unknown']);
  const unk = toJson({ at: AT, sessions: [], usage: { ...U, days7: U.days7.map((d, i) => (i === 1 ? { ...d, unknown: true } : d)) } });
  assert.deepEqual(unk.usage.last7days.daily.map((d) => d.unknown), [false, true, false, false, false, false, false]);
  assert.equal(j.usage.last7days.cost, 174.3);
  assert.ok(!('daily' in toJson({ at: AT, sessions: [], usage: { ...U, days7: undefined } }).usage.last7days));
});
