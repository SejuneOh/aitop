// 기간 리포트의 캐시 (#128): VERSION 14 로 바뀌면 예전(v13) 장부 캐시를 쓰지 않고 다시 세며,
// 평소 실행(collectLedger)은 7일 안에 바뀐 기록만, 리포트(collectDaily)만 30일 안에 바뀐 기록까지 읽는다.
process.env.TZ = 'Asia/Seoul';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeClaudeHome, assistant, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectLedger, collectDaily } = await import('../src/sources/claude-ledger.mjs');
const { CACHE_DIR, flushCache } = await import('../src/cache.mjs');
const { PRICE_TAG } = await import('../src/pricing.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { dayKey } = await import('../src/sources/common.mjs');

const ROOT = join(process.env.XDG_CACHE_HOME, 'aitop');
const keyOf = (path, kind) => createHash('sha1').update(`${kind}\0${path}`).digest('hex');
const now = Date.now();
const today = dayKey(now);

// 오늘 바뀐 기록. 예전 형식(v13) 캐시에는 끝까지 읽었다고, 토큰은 엉뚱한 값으로, 모델 몫 없이 적어 둔다.
const fresh = fx.transcript('cccccccc-1', [{ ...assistant('c1', [], usage(1_000_000, 0), 'claude-opus-5-5'), timestamp: new Date(now - 60_000).toISOString() }]);
const OLD = join(ROOT, `v13-${PRICE_TAG}`);
mkdirSync(OLD, { recursive: true });
writeFileSync(join(OLD, keyOf(fresh, 'ledger') + '.json'), JSON.stringify({ offset: statSync(fresh).size, days: { [today]: { tokens: 42, cost: 1, costNoCache: 1, unknown: false } }, slots: {}, recent: [], path: fresh, ino: statSync(fresh).ino }));

// 10일 전에 마지막으로 바뀐 기록 (줄도 10일 전).
const tenAgo = now - 10 * 86400_000;
const old = fx.transcript('cccccccc-2', [{ ...assistant('c2', [], usage(2_000_000, 0), 'claude-sonnet-5-5'), timestamp: new Date(tenAgo).toISOString() }], '-work-old');
utimesSync(old, tenAgo / 1000, tenAgo / 1000);

test('캐시 폴더는 v14 이고, v13 캐시는 쓰지 않고 기록을 다시 센다', () => {
  assert.match(basename(CACHE_DIR), /^v14-/);
  const r = collectLedger({ budget: createBudget(), now });
  assert.equal(r.today.tokens, 1_000_000, 'v13 의 엉뚱한 값(42)이 아니라 다시 센 값');
  flushCache();
  assert.equal(existsSync(OLD), false, '예전 형식 폴더는 지운다');
  const saved = JSON.parse(readFileSync(join(CACHE_DIR, keyOf(fresh, 'ledger') + '.json'), 'utf8'));
  assert.deepEqual(saved.days[today].models, { 'claude-opus-5-5': { tokens: 1_000_000, cost: 4 } });
});

test('평소 실행은 7일 넘게 바뀌지 않은 기록을 읽지 않고, 리포트만 30일까지 읽는다', () => {
  const r = collectLedger({ budget: createBudget(), now });
  assert.equal(r.week.tokens, 1_000_000);
  flushCache();
  assert.ok(!readdirSync(CACHE_DIR).includes(keyOf(old, 'ledger') + '.json'), '평소 실행은 10일 전 기록의 캐시를 만들지 않는다');
  const b = collectDaily({ budget: createBudget(), now, days: 30 }).books;
  assert.equal(b.length, 2);
  const tokens = b.reduce((a, x) => a + Object.values(x.days).reduce((s, d) => s + d.tokens, 0), 0);
  assert.equal(tokens, 3_000_000);
  flushCache();
  const saved = JSON.parse(readFileSync(join(CACHE_DIR, keyOf(old, 'ledger') + '.json'), 'utf8'));
  assert.equal(saved.days[dayKey(tenAgo)].tokens, 2_000_000, '10일 전 날짜도 캐시에 남는다 (10일이 아니라 30일 보관)');
});
