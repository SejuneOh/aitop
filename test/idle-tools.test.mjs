// 오래 안 쓴 도구 숨기기 (#131): 실행 중 세션이 없고 7일 동안 쓰지 않은 도구는 도구 줄에서 빼고 끝에 '숨김 N'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_TOOL_MS, toolLastUsed, toolStrip } from '../src/ui/table.mjs';
import { resolveConfig, configText } from '../src/config.mjs';
import { width } from '../src/text.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-11-10T05:00:00Z');
const DAY = 86_400_000;
const check = (tool, lastAt, extra = {}) => ({ tool, state: lastAt == null ? 'missing' : 'ok', lastAt, running: 0, ...extra });
const S = (tool, extra = {}) => ({ tool, id: tool, live: true, updatedAt: at, tokens: { total: 1000 }, ...extra });
const view = (sessions, checks, extra = {}) => ({ data: { sessions, at, tools: checks === undefined ? undefined : { tools: checks } }, ...extra });
const line = (v, W = 100) => strip(toolStrip(v, W));

test('7일 동안 기록이 없는 도구는 숨기고 끝에 숨긴 도구 이름을 적는다', () => {
  const checks = { claude: check('claude', at - DAY), codex: check('codex', at - 8 * DAY), gemini: check('gemini', null, { state: 'limited' }), agy: check('agy', at - 30 * DAY) };
  const l = line(view([S('claude')], checks));
  assert.match(l, /^ ▍claude 1 · 1\.0k +숨김 codex gemini\s*$/);
});

test('7일 안에 쓴 도구는 세션이 없어도 남는다 (경계는 7일)', () => {
  const checks = { claude: check('claude', at - DAY), codex: check('codex', at - IDLE_TOOL_MS + 60_000), gemini: check('gemini', null, { state: 'limited' }), agy: check('agy', at - 2 * DAY) };
  const l = line(view([S('claude')], checks));
  assert.match(l, /codex/);
  assert.match(l, /gemini/, 'Gemini 탭은 agy 기록도 본다');
  assert.doesNotMatch(l, /숨김/);
});

test('실행 중 세션이나 실행 중인 프로세스가 있는 도구는 오래된 기록이어도 보인다', () => {
  const old = at - 100 * DAY;
  const checks = { claude: check('claude', old), codex: check('codex', old, { running: 1 }), gemini: check('gemini', old, { state: 'limited' }) };
  const l = line(view([S('claude', { updatedAt: old })], checks));
  assert.match(l, /claude 1/);
  assert.match(l, /codex/);
  assert.match(l, /숨김 gemini\s*$/);
  assert.equal(toolLastUsed(view([], checks).data, 'codex', at), at);
});

test('미설치 도구도 숨기고, 점검 전(마지막 사용을 모름)에는 숨기지 않는다', () => {
  const checks = { claude: check('claude', at), codex: check('codex', null), gemini: check('gemini', null, { state: 'limited' }) };
  assert.doesNotMatch(line(view([], checks)), /미설치/);
  const before = line(view([], undefined));
  assert.match(before, /claude.*codex.*gemini/);
  assert.doesNotMatch(before, /숨김/);
});

test('hideIdleTools: false 면 셋 다 보이고, 숨김 표시도 좁은 폭에서 자리를 지킨다', () => {
  const checks = { claude: check('claude', at), codex: check('codex', null), gemini: check('gemini', null, { state: 'limited' }) };
  assert.match(line(view([S('claude')], checks, { hideIdleTools: false })), /claude 1.*codex 미설치.*gemini/);
  for (let W = 8; W <= 50; W++) {
    const l = line(view([S('claude'), S('claude', { id: 'b' })], checks), W);
    assert.equal(width(l), W);
    assert.match(l, /▍(claude|cla) 2/, `W=${W} 실행 중인 도구가 먼저: ${l}`);
    // 숨김 표시는 이름 → 개수 → 빼기. 중간에서 잘리지 않는다.
    assert.match(l, W >= 40 ? /숨김 codex gemini/ : W >= 15 ? /숨김 (2|codex gemini)/ : /^[^숨]*$/, `W=${W}: ${l}`);
    assert.doesNotMatch(l, /숨김 ?(…|$)|숨…/, `W=${W}: ${l}`);
  }
});

test('설정 파일 hideIdleTools: 기본 true, --print-config 에 보인다', () => {
  const file = (values) => ({ path: '/x', exists: true, values, problems: [] });
  assert.deepEqual(resolveConfig({ env: {}, file: file({}) }).values.hideIdleTools, { value: true, source: 'default' });
  const off = resolveConfig({ env: {}, file: file({ hideIdleTools: false }) });
  assert.deepEqual(off.values.hideIdleTools, { value: false, source: 'file' });
  assert.match(configText(off), /^hideIdleTools +false +file$/m);
});

test('모든 도구가 숨김 대상이면 숨기지 않고 예전처럼 흐리게 (미설치 포함) 다 보인다', () => {
  const checks = { claude: check('claude', at - 30 * DAY), codex: check('codex', null), gemini: check('gemini', null, { state: 'limited' }) };
  const l = line(view([], checks));
  assert.match(l, /^ +claude +codex 미설치 +gemini\s*$/);
  assert.doesNotMatch(l, /숨김/);
});
