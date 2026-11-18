// 헤더 문구(세션 N, 지시 대기), 범례의 상태 덧붙임 묶음, 좁은 STATUS 칸에서 경고 덧붙임을 먼저 남기기 (#264).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { header, sessionRow, statusCell, columns } from '../src/ui/table.mjs';
import { cacheState, toolElapsed } from '../src/ui/draw.mjs';
import { legend } from '../src/ui/chrome.mjs';
import { glyphs, legendMark } from '../src/ui/glyphs.mjs';
import { setLang, t } from '../src/i18n.mjs';
import { setAmbiguous, width } from '../src/text.mjs';
import { PALETTE } from '../src/ui/theme.mjs';

afterEach(() => {
  setLang('ko');
  setAmbiguous('narrow');
});

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const text = (segs) => segs.map((x) => x.t).join('');
const at = Date.parse('2026-11-10T05:00:00Z');
const mk = (id, extra = {}) => ({ tool: 'claude', id, name: id, cwd: '/w', status: 'idle', live: true, phase: { kind: 'idle' }, updatedAt: at, tokens: { total: 1000 }, cost: 1, context: { used: 50, window: 100 }, members: [], events: [], ...extra });
const view = (sessions) => ({ data: { sessions, usage: null, errors: [], at, tools: { tools: {} } } });

test('한국어 헤더는 live 를 번역하고, 다음 지시 대기를 응답 대기와 다른 말로 센다', () => {
  const sessions = [mk('w', { status: 'waiting', phase: { kind: 'waiting' } }), mk('a'), mk('b')];
  const ko = strip(header(view(sessions), 130));
  assert.match(ko, /세션 3/);
  assert.doesNotMatch(ko, /live/);
  assert.match(ko, /○ 2 지시 대기/);
  assert.match(ko, /◆ 1 응답 대기/);
  setLang('en');
  const en = strip(header(view(sessions), 130));
  assert.match(en, /3 live/);
  assert.match(en, /○ 2 idle/);
});

test('범례에 상태 덧붙임 묶음이 있고, 기호는 지금 세트를 따른다 (한/영)', () => {
  for (const lang of ['ko', 'en']) {
    setLang(lang);
    const L = legend();
    const at = L.findIndex(([k]) => k === t('help.extras'));
    assert.ok(at > 0, lang);
    const keys = L.slice(at + 1).map(([k]) => k);
    assert.deepEqual(keys, ['✓', '▲', t('legend.cacheKey'), t('legend.toolKey'), `${glyphs().elapsed}3m12s`, t('legend.stalledKey')]);
    assert.equal(t('legend.stalledKey'), t('member.stalled'), '팀원 행에 보이는 글 그대로');
    assert.ok(L.slice(at + 1).every(([, d]) => d && width(d) <= 48), `${lang}: 도움말 오른쪽 칸에 잘리지 않는다`);
  }
  setAmbiguous('wide');
  assert.equal(legendMark('▲'), '^');
});

const S = 1000;
const look = { fg: PALETTE.idle };

test('경고 단계의 캐시 덧붙임은 좁은 STATUS 칸에서 상태 글보다 먼저 남는다', () => {
  const warn = cacheState(mk('a', { cacheExpiresAt: at + 42 * S }), at);
  const calm = cacheState(mk('a', { cacheExpiresAt: at + 192 * S }), at);
  assert.equal(warn.warn, true);
  assert.equal(calm.warn, false);
  // 80열 한국어 STATUS 칸 폭(22)과 비슷한 폭들. 넓을 때는 예전대로 다 붙는다.
  assert.equal(text(statusCell('다음 지시 대기', warn, 40, look, '지시 대기')).trimEnd(), '다음 지시 대기 · 캐시 0:42');
  for (const w of [22, 20]) {
    const out = text(statusCell('다음 지시 대기 · 에이전트 1', warn, w, look, '지시 대기'));
    assert.equal(width(out), w + 1, `폭 ${w}`);
    assert.match(out, /^지시 대기 (· )?캐시 0:42 *$/, `폭 ${w}: ${out}`);
    // 경고가 아니면 예전대로 덧붙임을 뺀다.
    assert.doesNotMatch(text(statusCell('다음 지시 대기 · 에이전트 1', calm, w, look, '지시 대기')), /캐시/);
  }
  // 원문을 자르기보다 짧은 문구가 먼저다 (폭 24·26 에서 '다음 지시… · 캐시' 가 아니다).
  for (const w of [26, 24]) {
    const out = text(statusCell('다음 지시 대기 · 에이전트 1', warn, w, look, '지시 대기'));
    assert.equal(width(out), w + 1, `폭 ${w}`);
    assert.match(out, /^지시 대기 · 캐시 0:42 *$/, `폭 ${w}: ${out}`);
  }
  // 상태 글에 4칸 이상 남으면 줄여 두고, 그보다 좁으면 줄임표만 남기지 않고 덧붙임만 둔다.
  const w16 = text(statusCell('Bash · npm run test', warn, 16, look));
  assert.equal(width(w16), 17);
  assert.match(w16, /^Bas… · 캐시 0:42 $/, w16);
  const w14 = text(statusCell('Bash · npm run test', warn, 14, look));
  assert.equal(width(w14), 15);
  assert.match(w14, /^캐시 0:42 +$/, w14);
  for (const w of [13, 10, 8]) {
    const only = text(statusCell('Bash · npm run test', warn, w, look));
    assert.equal(width(only), w + 1, `폭 ${w}`);
    assert.match(only, /^캐시 0:/, `폭 ${w}: ${only}`);
  }
});

test('10분 넘은 도구 경과 시간도 경고 단계라 좁아도 남는다', () => {
  const s = mk('b', { status: 'busy', phase: { kind: 'tool' }, toolStartedAt: at - 12 * 60 * S });
  const tag = toolElapsed(s, at);
  assert.equal(tag.warn, true);
  assert.match(text(statusCell('도구 실행 · Bash · npm run test:e2e', tag, 16, look)), /… · 12m00s +$/);
});

test('80열 한국어 세션 행: 캐시 1분 미만이면 짧은 상태 글과 함께 보이고 행 폭은 그대로다 (기본·wide 기호)', () => {
  for (const mode of ['narrow', 'wide']) {
    setAmbiguous(mode);
    const s = mk('c', { phase: { kind: 'idle', args: { agents: 1 } }, cacheExpiresAt: Date.now() + 40 * S, cacheTtl: 300 });
    const row = strip(sessionRow(s, columns(80), 80, false, 0));
    assert.equal(width(row), 80, mode);
    assert.match(row, /지시 대기 (· )?캐시 0:[34]\d/, `${mode}: ${row}`);
  }
});
