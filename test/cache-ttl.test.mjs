// 기다리는 세션의 프롬프트 캐시 만료까지 남은 시간 (#241).
// 이 PC 기록 표본의 usage.cache_creation { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } 모양을 본뜬다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { ClaudeTracker, applyCacheUsage, CACHE_TTL_1H, CACHE_TTL_5M } = await import('../src/sources/claude-tracker.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { flushCache, CACHE_DIR } = await import('../src/cache.mjs');
const { toJson } = await import('../src/json.mjs');
const { cacheState } = await import('../src/ui/draw.mjs');
const { statusCell } = await import('../src/ui/table.mjs');
const { summaryLines } = await import('../src/ui/detail.mjs');
const { animating } = await import('../src/ui.mjs');
const { PALETTE } = await import('../src/ui/theme.mjs');
const { setLang } = await import('../src/i18n.mjs');
const { width } = await import('../src/text.mjs');

const run = () => collectClaude({ showEnded: false, budget: createBudget() });
const S = 1000;
const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const at = (ms) => new Date(ms).toISOString();
const cached = (read, m5, h1) => ({ ...usage(1, 1, read, m5 + h1), cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 } });
const ask = (ms, text = '해줘') => ({ ...user(text), timestamp: at(ms) });
const reply = (id, ms, u) => ({ ...assistant(id, [{ type: 'text', text: '응' }], u), timestamp: at(ms) });
const text = (segs) => segs.map((x) => x.t).join('');

test('TTL 규칙: 1시간 쓰기 → 1시간, 5분 쓰기(또는 쪼갠 값 없는 쓰기) → 5분, 읽기만이면 앞의 TTL, 캐시 없으면 그대로', () => {
  const st = { cacheAt: null, cacheTtl: null, inputAt: null, inputFor: null };
  assert.equal(applyCacheUsage(st, usage(1, 1), T0), false, '캐시를 쓰지도 읽지도 않음');
  assert.equal(st.cacheAt, null);
  assert.equal(applyCacheUsage(st, cached(100, 0, 0), T0), true);
  assert.equal(st.cacheTtl, CACHE_TTL_5M, '처음부터 읽기만이면 기본 5분');
  applyCacheUsage(st, cached(0, 0, 50), T0 + S);
  assert.equal(st.cacheTtl, CACHE_TTL_1H);
  applyCacheUsage(st, cached(100, 0, 0), T0 + 2 * S);
  assert.equal(st.cacheTtl, CACHE_TTL_1H, '읽기만이면 1시간 유지');
  assert.equal(st.cacheAt, T0 + 2 * S, '읽을 때마다 다시 시작');
  applyCacheUsage(st, cached(100, 30, 0), T0 + 3 * S);
  assert.equal(st.cacheTtl, CACHE_TTL_5M);
  applyCacheUsage(st, usage(1, 1, 0, 40), T0 + 4 * S);
  assert.equal(st.cacheTtl, CACHE_TTL_5M, 'cache_creation 이 없는 예전 기록');
});

test('수명은 요청 시작(바로 앞 사용자 줄)부터 잰다. 사용자 줄 없이 이어진 다른 응답은 제 줄 시각', () => {
  const p = fx.transcript('ttl-1', [ask(T0), reply('m1', T0 + 20 * S, cached(0, 0, 500)), reply('m1', T0 + 25 * S, cached(0, 0, 500))]);
  const t = new ClaudeTracker(p);
  t.update();
  assert.equal(t.cacheAt, T0, '같은 요청의 여러 줄은 같은 시작 시각');
  assert.equal(t.cacheExpiresAt, T0 + 3600 * S);
  fx.append(p, [ask(T0 + 100 * S, '다음'), reply('m2', T0 + 130 * S, cached(500, 0, 0))]);
  t.update();
  assert.equal(t.cacheAt, T0 + 100 * S);
  assert.equal(t.cacheTtl, CACHE_TTL_1H);
  fx.append(p, [reply('m3', T0 + 200 * S, cached(500, 10, 0))]);
  t.update();
  assert.equal(t.cacheAt, T0 + 200 * S);
  assert.equal(t.cacheExpiresAt, T0 + 500 * S);
});

test('응답 대기·다음 지시 대기인 살아 있는 세션에만 만료 시각을 두고 --json 에 ISO 로 넣는다', () => {
  const now = Date.now();
  for (const [id, status, waitingFor, has] of [['ttl-idle', 'idle', undefined, true], ['ttl-wait', 'idle', 'approve Bash', true], ['ttl-busy', 'busy', undefined, false]]) {
    fx.session({ sessionId: id, status, waitingFor });
    fx.transcript(id, [ask(now - 10 * S), reply(`${id}-m`, now - 5 * S, cached(0, 100, 0))]);
    const [s] = run().filter((x) => x.id === id);
    if (has) {
      assert.equal(s.cacheExpiresAt, now - 10 * S + 300 * S, id);
      assert.equal(toJson({ sessions: [s], usage: null }).sessions[0].cacheExpiresAt, at(now + 290 * S));
    } else {
      assert.equal(s.cacheExpiresAt, null, id);
      assert.equal(toJson({ sessions: [s], usage: null }).sessions[0].cacheExpiresAt, null);
    }
  }
  // 오류로 멈춘 세션은 뺀다
  fx.session({ sessionId: 'ttl-stop', status: 'idle' });
  fx.transcript('ttl-stop', [ask(now - 10 * S), reply('ts-m', now - 5 * S, cached(0, 100, 0)), { ...assistant('e', [{ type: 'text', text: 'Login expired' }], usage(0, 0), '<synthetic>'), isApiErrorMessage: true, error: 'authentication_failed' }]);
  assert.equal(run().find((x) => x.id === 'ttl-stop').cacheExpiresAt, null);
});

test('캐시 상태는 저장·복원되고, 이 필드가 없던 캐시는 기록 끝에서 한 번 채운다', () => {
  const p = fx.transcript('ttl-c', [ask(T0), reply('c1', T0 + 3 * S, cached(0, 0, 9))]);
  new ClaudeTracker(p).update();
  flushCache();
  const back = new ClaudeTracker(p);
  assert.equal(back.cacheExpiresAt, T0 + 3600 * S);

  const file = join(CACHE_DIR, createHash('sha1').update(`\0${p}`).digest('hex') + '.json');
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['cacheAt', 'cacheTtl', 'inputAt', 'inputFor']) delete c[k];
  writeFileSync(file, JSON.stringify(c));
  const old = new ClaudeTracker(p);
  assert.equal(old.cacheExpiresAt, T0 + 3600 * S);
  flushCache();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).cacheAt, T0, '다시 적어 두어 다음엔 훑지 않는다');
});

const sess = (extra) => ({ id: 'a', tool: 'claude', live: true, status: 'idle', phase: { kind: 'idle' }, cacheTtl: 300, tokens: { total: 10 }, ...extra });

test('표시: m:ss, 1분 미만은 경고색, 만료는 흐린 글. 기다리지 않거나 끝난 세션은 없음', () => {
  const now = T0;
  let c = cacheState(sess({ cacheExpiresAt: now + 192 * S }), now);
  assert.equal(c.text, '캐시 3:12');
  assert.equal(c.fg, PALETTE.info);
  c = cacheState(sess({ cacheExpiresAt: now + 59 * S }), now);
  assert.equal(c.text, '캐시 0:59');
  assert.equal(c.fg, PALETTE.alert);
  c = cacheState(sess({ cacheExpiresAt: now - S }), now);
  assert.equal(c.text, '캐시 만료');
  assert.equal(c.fg, PALETTE.faint);
  assert.equal(cacheState(sess({ cacheExpiresAt: now + S, status: 'busy' }), now), null);
  assert.equal(cacheState(sess({ cacheExpiresAt: now + S, live: false }), now), null);
  setLang('en');
  try {
    assert.equal(cacheState(sess({ cacheExpiresAt: now + 192 * S }), now).text, 'cache 3:12');
    assert.equal(cacheState(sess({ cacheExpiresAt: now - S }), now).text, 'cache expired');
  } finally {
    setLang('ko');
  }
});

test('STATUS 칸: 들어가면 붙이고, 좁으면 상태 글을 12칸까지 줄여 붙이고, 더 좁으면 캐시를 뺀다 (폭은 그대로)', () => {
  const cache = cacheState(sess({ cacheExpiresAt: T0 + 192 * S }), T0);
  const look = { fg: PALETTE.idle };
  const wide = statusCell('다음 지시 대기', cache, 40, look);
  assert.equal(text(wide).trimEnd(), '다음 지시 대기 · 캐시 3:12');
  assert.equal(width(text(wide)), 41, '폭 40 + 뒤 공백');
  const mid = statusCell('Bash · npm run test:e2e -- --watch', cache, 26, look);
  assert.match(text(mid), /…\s·\s캐시 3:12 $/);
  assert.equal(width(text(mid)), 27);
  const narrow = statusCell('Bash · npm run test:e2e -- --watch', cache, 20, look);
  assert.doesNotMatch(text(narrow), /캐시/);
  assert.equal(statusCell('x', null, 10, look).length, 1);
});

test('캐시 표시는 프레임 타이머를 깨우지 않고, 좁은 상세 요약에서는 가장 먼저 빠진다', () => {
  const s = sess({ cacheExpiresAt: Date.now() + 100 * S, cwd: '/tmp/demo' });
  assert.equal(animating({ data: { sessions: [s] } }), false);
  assert.match(text(summaryLines(s, 120, 0, {})[0]), /캐시 \d:\d\d/);
  assert.doesNotMatch(text(summaryLines(s, 30, 0, {})[0]), /캐시/);
});
