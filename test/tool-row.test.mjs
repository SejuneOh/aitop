// 첫 화면 도구 줄 (#290): 미설치와 7일 미사용을 나눠 적고, 간격은 2칸, 빈 화면 첫 줄은 다음 할 일을, ? 라벨은 하나로.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { toolStrip } from '../src/ui/table.mjs';
import { footer, legend } from '../src/ui/chrome.mjs';
import { render } from '../src/ui.mjs';
import { width } from '../src/text.mjs';
import { getLang, setLang, t } from '../src/i18n.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const lang0 = getLang();
afterEach(() => setLang(lang0));

const at = Date.parse('2026-11-10T05:00:00Z');
const DAY = 86_400_000;
const check = (tool, state, lastAt, running = 0) => ({ tool, state, path: `~/.${tool}`, records: lastAt ? 3 : 0, lastAt, running, readable: null, hint: null });
const S = (tool, extra = {}) => ({ tool, id: tool, live: true, updatedAt: at, tokens: { total: 1000 }, ...extra });
const data = (sessions, checks) => ({ sessions, usage: null, errors: [], at, tools: { platform: 'linux', processes: true, tools: checks } });
const row = (sessions, checks, W = 100, extra = {}) => strip(toolStrip({ data: data(sessions, checks), ...extra }, W));

// claude 는 실행 중, codex 는 미설치, gemini 는 30일 전 기록.
const mixed = { claude: check('claude', 'ok', at), codex: check('codex', 'missing', null), gemini: check('gemini', 'limited', at - 30 * DAY) };

test('도구 줄: 미설치와 7일 미사용을 따로 적는다 (ko·en)', () => {
  setLang('ko');
  assert.match(row([S('claude')], mixed), /^ ▍claude 1 · 1\.0k  미설치: codex  7일 미사용: gemini\s*$/);
  setLang('en');
  assert.match(row([S('claude')], mixed), /^ ▍claude 1 · 1\.0k  not installed: codex  unused 7d: gemini\s*$/);
});

test('도구 줄: 자리가 모자라면 갈래마다 개수만 적는다', () => {
  setLang('ko');
  const counts = [26, 28, 30, 32, 33, 34, 35, 36, 38, 40].map((W) => row([S('claude')], mixed, W)).filter((l) => /미설치: 1  7일 미사용: 1/.test(l));
  assert.ok(counts.length > 0, '개수 표시가 나오는 폭이 있다');
  for (let W = 8; W <= 60; W++) {
    const l = row([S('claude')], mixed, W);
    assert.equal(width(l), W);
    assert.doesNotMatch(l, /숨김/, `W=${W}: ${l}`);
  }
});

test('도구 줄: 조각 사이 간격은 2칸으로 고르다 (세션 없는 도구 앞도)', () => {
  setLang('ko');
  const checks = { claude: check('claude', 'ok', at), codex: check('codex', 'ok', at - DAY), gemini: check('gemini', 'limited', at - DAY) };
  const l = row([S('claude')], checks).trimEnd();
  assert.equal(l, ' ▍claude 1 · 1.0k  codex  gemini');
  assert.doesNotMatch(l.trim(), / {3,}/);
});

test('빈 화면: 프로세스는 실행 중인데 기록이 없으면 그 사실과 다음 할 일을 첫 줄에 적는다', () => {
  const checks = { claude: check('claude', 'ok', null), codex: check('codex', 'missing', null), gemini: check('gemini', 'limited', null), agy: check('agy', 'missing', null, 1) };
  const view = { data: data([], checks), selectedId: null, showDetail: true, frame: 0 };
  setLang('ko');
  const out = render(view, 120, 30).map(strip).join('\n');
  assert.match(out, /agy 실행 중이지만 읽을 세션 기록이 아직 없습니다\./);
  assert.match(out, /→ 그 도구에 요청을 보내면 여기에 나옵니다\. 점검: aitop --doctor/);
  assert.doesNotMatch(out, /실행 중인 AI 세션이 없습니다/);
  for (const W of [40, 60, 80, 120]) for (const l of render(view, W, 30)) assert.equal(width(strip(l)), W, `W=${W}`);
  // 80칸에서 다음 할 일 줄이 잘리지 않는다.
  assert.match(render(view, 80, 30).map(strip).join('\n'), /aitop --doctor/);
  setLang('en');
  assert.match(render(view, 120, 30).map(strip).join('\n'), /agy running, but no session records to read yet\./);
  // 실행 중인 프로세스가 없으면 예전 안내 그대로.
  const idle = { ...checks, agy: check('agy', 'missing', null, 0) };
  setLang('ko');
  assert.match(render({ ...view, data: data([], idle) }, 120, 30).map(strip).join('\n'), /실행 중인 AI 세션이 없습니다/);
});

test('? 키 이름은 폭과 상관없이 하나다 (ko 도움, en help)', () => {
  const v = { data: { sessions: [{ id: 'a' }] }, showDetail: false };
  for (const [lang, label] of [['ko', '도움'], ['en', 'help']]) {
    setLang(lang);
    for (let W = 30; W <= 200; W += 2) {
      const bar = strip(footer(v, W, 1, { id: 'a', files: [{ path: '/a' }] }));
      assert.match(bar, new RegExp(`\\?\\]?\\s+${label}\\s`), `${lang} W=${W}: ${bar}`);
    }
  }
});

test('? 도움말 범례는 도구 줄 끝 표시(미설치 / 7일 미사용)를 그대로 설명하고 옛 숨김 표시는 없다', () => {
  for (const [lang, miss, idle] of [['ko', '미설치: ', '7일 미사용: '], ['en', 'not installed: ', 'unused 7d: ']]) {
    setLang(lang);
    const keys = legend().map(([k]) => (k ? t(k) : k));
    assert.ok(keys.includes(`${miss}N`), `${lang}: ${keys}`);
    assert.ok(keys.includes(`${idle}N`), `${lang}: ${keys}`);
    assert.ok(!keys.some((k) => /^(숨김|hidden) N$/.test(k)), `${lang}: 옛 숨김 N 이 남지 않는다`);
    // 범례 키는 화면의 도구 줄 글과 같은 모양이다.
    const l = row([S('claude')], mixed);
    assert.ok(l.includes(miss) && l.includes(idle), l);
    const v = { data: { sessions: [], errors: [], at, usage: null }, selectedId: null, showDetail: true, frame: 0, help: true };
    const help = render(v, 120, 60).map(strip).join('\n');
    assert.match(help, new RegExp(`${miss}N`), `${lang}: 도움말 화면에 보인다`);
  }
});
