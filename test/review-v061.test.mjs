import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeClaudeHome } from './fixture.mjs';

const fx = makeClaudeHome();
const cacheRoot = join(process.env.XDG_CACHE_HOME, 'aitop');
const { truncate, width } = await import('../src/text.mjs');
const { toJson } = await import('../src/json.mjs');
const { markDirty, flushCache, CACHE_DIR } = await import('../src/cache.mjs');

test('원래 글이 … 로 끝나는 곳에서 잘려도 … 는 하나만 붙는다', () => {
  assert.equal(truncate('작업 중… 다음 단계', 9), '작업 중…');
  assert.equal(truncate('abc… def', 6), 'abc…');
  assert.equal(width(truncate('abc… def', 6)), 4);
  assert.equal(truncate('가나다라마바사', 7), '가나다…');
});

test('--json 비용은 소수 넷째 자리까지 반올림한다', () => {
  const j = toJson({
    at: 0,
    usage: { today: { cost: 87.75985696000001, tokens: 5 }, week: { cost: 1.23456789, tokens: 9 }, loading: null },
    sessions: [{ tool: 'claude', id: 'a', status: 'idle', cost: 0.123456, costNoCache: null, members: [{ name: 'm', status: 'done', cost: 2.00004999 }] }],
  });
  assert.equal(j.usage.today.cost, 87.7599);
  assert.equal(j.usage.today.tokens, 5);
  assert.equal(j.usage.last7days.cost, 1.2346);
  assert.equal(j.sessions[0].cost, 0.1235);
  assert.equal(j.sessions[0].costNoCache, null);
  assert.equal(j.sessions[0].members[0].cost, 2);
});

test('이 버전보다 낮은 캐시 폴더는 바로 지우고, 같은 형식의 최근 폴더는 남긴다', () => {
  for (const d of ['v2', 'v6-ff9e7b58', 'v7-other', 'v7-stale', 'v12-future']) mkdirSync(join(cacheRoot, d), { recursive: true });
  const old = Date.now() / 1000 - 8 * 86400;
  utimesSync(join(cacheRoot, 'v7-stale'), old, old);
  const src = join(fx.home, 'x.jsonl');
  writeFileSync(src, '{}\n');
  markDirty(src, () => ({ offset: 3 }));
  flushCache();
  const left = readdirSync(cacheRoot).sort();
  assert.ok(existsSync(CACHE_DIR));
  assert.deepEqual(left.filter((d) => d !== CACHE_DIR.split('/').pop()), ['v12-future', 'v7-other']);
});

test('상세 패널 컨텍스트 줄은 왼쪽 칸 폭 안에 % 까지 들어간다', async () => {
  const { render } = await import('../src/ui.mjs');
  const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
  const at = Date.now();
  const s = { tool: 'claude', id: 's', name: 'demo', cwd: '/w', status: 'idle', live: true, phase: { kind: 'idle', text: '대기' }, updatedAt: at, tokens: { total: 1 }, context: { used: 162_000, window: 1_000_000 }, members: [], events: [] };
  for (const W of [100, 140, 200]) {
    const row = render({ data: { sessions: [s], usage: null, errors: [], at }, selectedId: 's', showDetail: true, frame: 0 }, W, 30).map(strip).find((l) => l.includes('컨텍스트 162k'));
    assert.match(row, /16% │/, `W=${W}: ${row}`);
  }
});
