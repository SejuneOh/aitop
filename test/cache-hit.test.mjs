// 프롬프트 캐시 적중률 (#334): 계산(분모 0, 서브에이전트 합산, 도구별 토큰 모양), 상세 패널(넓은 화면 합계 줄, 80칸·좁은 폭 요약 줄, 한글 폭),
// --report sessions 의 캐시 칸(장부 벡터에서, 좁은 터미널에서도 남는다), --json 의 cacheHitRate.
process.env.TZ = 'Asia/Seoul';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';
import { at, session } from './detail-fixture.mjs';
import { cacheHitRate, hitText, hitJson, vecTokens, emptyTokens } from '../src/sources/common.mjs';
import { emptySub, sessionTotals } from '../src/sources/claude.mjs';
import { buildSessions, formatSessions, sessionsJson, sessionsMarkdown } from '../src/sessions-report.mjs';
import { toJson } from '../src/json.mjs';
import { detail } from '../src/ui/detail.mjs';
import { setNow } from '../src/ui/draw.mjs';
import { setLang } from '../src/i18n.mjs';
import { width } from '../src/text.mjs';

const fx = makeClaudeHome();
const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'aitop.mjs');
const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');

test('적중률 = 캐시 읽기 / (입력 + 캐시 읽기 + 캐시 쓰기), 분모 0 이면 null', () => {
  assert.equal(cacheHitRate({ input: 10, output: 999, cacheRead: 80, cacheWrite: 10 }), 0.8);
  // 출력은 분모에 넣지 않는다.
  assert.equal(cacheHitRate({ input: 0, output: 5000, cacheRead: 1, cacheWrite: 0 }), 1);
  assert.equal(cacheHitRate(emptyTokens()), null);
  assert.equal(cacheHitRate({ output: 100 }), null);
  assert.equal(cacheHitRate(null), null);
  assert.equal(cacheHitRate({ input: 100, cacheRead: 0, cacheWrite: 0 }), 0);
  // 글과 --json 값.
  assert.equal(hitText(0.873), '87%');
  assert.equal(hitText(0), '0%');
  assert.equal(hitText(0.001), '<1%');
  assert.equal(hitText(0.998), '99%', '다 맞지 않았으면 100% 로 보이지 않는다');
  assert.equal(hitText(1), '100%');
  assert.equal(hitText(null), null);
  assert.equal(hitJson(0.87349), 0.873);
  assert.equal(hitJson(null), null);
});

test('도구별 토큰 모양: Claude·Codex·agy 는 계산, 토큰 내역이 없는 Gemini 는 null', () => {
  // Claude: usage 의 input_tokens 는 캐시를 뺀 몫, 캐시 쓰기는 따로 (claude-tracker).
  assert.equal(cacheHitRate({ input: 100, output: 50, cacheRead: 800, cacheWrite: 100, total: 1050 }), 0.8);
  // Codex: 수집기가 input_tokens 에서 cached_input_tokens 를 빼서 input 에 둔다 (codex.mjs), 캐시 쓰기는 0.
  assert.equal(cacheHitRate({ input: 250, output: 10, cacheRead: 750, cacheWrite: 0, total: 1010 }), 0.75);
  // agy: 호출마다 입력·캐시 읽기·캐시 쓰기를 따로 센다 (antigravity.mjs).
  assert.equal(cacheHitRate({ input: 300, output: 0, cacheRead: 600, cacheWrite: 100, total: 1000 }), 0.6);
  // Gemini CLI: 토큰을 모른다 (emptyTokens).
  assert.equal(cacheHitRate(emptyTokens()), null);
  // 장부 벡터: [입력, 출력, 캐시 읽기, 쓰기 5분, 쓰기 1시간].
  assert.deepEqual(vecTokens([1, 2, 3, 4, 5]), { input: 1, cacheRead: 3, cacheWrite: 9 });
  assert.deepEqual(vecTokens(undefined), { input: 0, cacheRead: 0, cacheWrite: 0 });
});

test('세션 적중률은 메인과 서브에이전트 토큰을 더해서 계산한다', () => {
  const main = { tokens: { input: 100, output: 10, cacheRead: 100, cacheWrite: 0, total: 210 }, cost: 0, costNoCache: 0, files: [], activity: [], artifacts: [] };
  const sub = { ...emptySub(), count: 1, tokens: { input: 0, output: 10, cacheRead: 800, cacheWrite: 0, total: 810 } };
  const s = sessionTotals(main, sub);
  // 메인만이면 50%, 합치면 900 / 1000.
  assert.equal(cacheHitRate(main.tokens), 0.5);
  assert.equal(cacheHitRate(s.tokens), 0.9);
  assert.equal(toJson({ sessions: [{ tool: 'claude', id: 'x', ...s }], at: 0 }).sessions[0].cacheHitRate, 0.9);
});

const draw = (W, H, extra) => {
  setNow(at);
  const s = session();
  if (extra) s.tokens = { ...s.tokens, ...extra };
  return detail(s, W, H, 0, { tab: 'now' }).map(strip);
};

test('상세 패널: 넓은 화면은 합계 줄 끝, 80칸은 토큰 내역 괄호 안, 모든 줄이 폭 안 (ko·en)', () => {
  for (const lang of ['ko', 'en']) {
    setLang(lang);
    const hit = lang === 'ko' ? '캐시 적중 80%' : 'cache hit 80%';
    const short = lang === 'ko' ? '·적중 80%)' : '·hit 80%)';
    for (const W of [100, 120, 150]) {
      const lines = draw(W, 24);
      assert.ok(lines.some((l) => l.includes(`571k · ${hit}`)), `${lang} W=${W}`);
      for (const l of lines) assert.equal(width(l), W, `${lang} W=${W}: ${l}`);
    }
    // 80칸: 요약 둘째 줄의 토큰 내역 안.
    assert.ok(draw(80, 16)[2].includes(short), `${lang} 80: ${draw(80, 16)[2]}`);
    // 좁은 폭: 토큰 내역과 함께 빠지고 줄은 폭을 넘지 않는다.
    for (let W = 56; W <= 99; W++) for (const l of draw(W, 16)) assert.ok(width(l) <= W, `${lang} W=${W}: ${l}`);
    assert.ok(!draw(56, 16)[2].includes(short.slice(1, 3)), `${lang} 56`);
    // 토큰 내역을 모르면(분모 0) 적중률 글이 없다.
    const none = { input: 0, cacheRead: 0, cacheWrite: 0 };
    assert.ok(!draw(120, 24, none).some((l) => l.includes(hit)), `${lang} 분모 0`);
    assert.ok(!draw(80, 16, none)[2].includes(short), `${lang} 분모 0 좁은 화면`);
  }
  setLang('ko');
});

// 장부 하루 몫. u: 모델 벡터 [입력, 출력, 캐시 읽기, 쓰기 5분, 쓰기 1시간], f: fast 벡터.
const SINCE = Date.parse('2026-11-15T00:00:00+09:00');
const NOW = Date.parse('2026-11-16T14:30:00+09:00');
const day = (model, tokens, cost, u, f) => ({ tokens, cost, costNoCache: 0, unknown: false, models: { [model]: { tokens, cost, ...(u ? { u } : {}), ...(f ? { f } : {}) } } });
const books = () => [
  // Claude 메인 + 서브에이전트(fast 벡터 포함): 캐시 읽기 (300 + 200) / (100+300+50 + 200+50 + 300) = 500 / 1000.
  { tool: 'claude', path: '/c/projects/-w/aaa.jsonl', project: '/work/app', days: { '2026-11-16': day('claude-opus-5-5', 460, 5, [100, 10, 300, 50, 0]) } },
  { tool: 'claude', path: '/c/projects/-w/aaa/subagents/agent-1.jsonl', project: '/work/app', days: { '2026-11-16': day('claude-opus-5-5', 560, 4, [0, 10, 200, 0, 50], [300, 0, 0, 0, 0]) } },
  // Codex: 입력은 캐시를 뺀 몫. 750 / 1000.
  { tool: 'codex', path: '/x/rollout-1.jsonl', project: '/work/cx', days: { '2026-11-16': day('gpt-5', 1010, 3, [250, 10, 750, 0, 0]) } },
  // agy: 하위 대화 g2 는 부모 g1 에 묶여 함께 센다. (600 + 0) / (300+600+100 + 1000) = 0.3.
  { tool: 'agy', path: '/a/conversations/g1.db', project: '/work/agy', days: { '2026-11-16': day('gemini-3-pro', 1000, 2, [300, 0, 600, 100, 0]) } },
  { tool: 'agy', path: '/a/conversations/g2.db', project: '/work/agy', days: { '2026-11-16': day('gemini-3-pro', 1000, 1, [1000, 0, 0, 0, 0]) } },
  // 벡터 없는 장부 칸(예전 형식)은 모름.
  { tool: 'claude', path: '/c/projects/-w/old.jsonl', project: '/work/old', days: { '2026-11-16': day('claude-opus-5-5', 500, 0.5) } },
  // 입력이 하나도 없는 세션(출력만)도 모름.
  { tool: 'claude', path: '/c/projects/-w/out.jsonl', project: '/work/out', days: { '2026-11-16': day('claude-opus-5-5', 10, 0.1, [0, 10, 0, 0, 0]) } },
];
const agy = new Map([
  ['g1', { cwd: '/work/agy', title: 'agy 대화', root: 'g1' }],
  ['g2', { cwd: '/work/agy', title: '하위', root: 'g1' }],
]);

test('--report sessions: 장부 벡터에서 세션(서브에이전트·하위 대화 포함) 적중률, 모르면 null', () => {
  const r = buildSessions(books(), { since: SINCE, now: NOW, agy });
  const by = Object.fromEntries(r.sessions.map((s) => [`${s.tool}:${s.projectPath}`, s.cacheHitRate]));
  assert.equal(by['claude:/work/app'], 0.5);
  assert.equal(by['codex:/work/cx'], 0.75);
  assert.equal(by['agy:/work/agy'], 0.3);
  assert.equal(by['claude:/work/old'], null);
  assert.equal(by['claude:/work/out'], null);
  const j = sessionsJson(r, 'x');
  assert.deepEqual(j.sessions.map((s) => s.cacheHitRate).sort(), [0.3, 0.5, 0.75, null, null].sort());
});

test('--report sessions 표: 캐시 칸은 토큰 옆, 좁은 터미널에서도 남고 세션 이름 칸만 준다 (ko·en·Markdown)', () => {
  const r = buildSessions(books(), { since: SINCE, now: NOW, agy });
  setLang('ko');
  const ko = formatSessions(r, { cols: 160 });
  assert.match(ko, /^도구 +모델 +프로젝트 +세션 +시작 +끝 +기다림 +토큰 +캐시 +비용 +파일$/m);
  assert.match(ko, /^codex .* 1\.0k +75% +\$3\.00 /m);
  assert.match(ko, /^agy .* 2\.0k +30% +\$3\.00 /m);
  assert.match(ko, /캐시는 프롬프트 캐시 적중률/);
  setLang('en');
  const wide = formatSessions(r, { cols: 160 }).split('\n');
  const narrow = formatSessions(r, { cols: 80 }).split('\n');
  const head = (ls) => ls.find((l) => l.startsWith('Tool '));
  assert.match(head(narrow), /^Tool +Model +Project +Session +Start +End +Waited +Tokens +Cache +Cost +Files$/);
  // 좁은 터미널에서는 세션 이름 칸만 줄어든다: 캐시 칸 오른쪽 끝의 위치 차이가 이름 칸이 줄어든 만큼과 같다.
  const end = (l) => l.indexOf('Cache') + 'Cache'.length;
  const nameW = (l) => l.indexOf('Start') - l.indexOf('Session');
  assert.equal(end(head(wide)) - end(head(narrow)), nameW(head(wide)) - nameW(head(narrow)));
  assert.ok(narrow.some((l) => /^claude .* 50% +\$/.test(l)));
  assert.ok(narrow.some((l) => /^claude .* - +\$0\.50/.test(l)), '모르면 -');
  assert.match(sessionsMarkdown(r), /\| Tokens \| Cache \| Cost \|/);
  setLang('ko');
});

test('aitop --json: 세션마다 cacheHitRate (0~1, 소수 셋째 자리)', () => {
  fx.session({ sessionId: 'cachehit-1', name: 'cache-demo' });
  // 입력 100 + 캐시 읽기 700 + 캐시 쓰기 100 → 7/9 = 0.778.
  fx.transcript('cachehit-1', [user('시작'), assistant('m1', [{ type: 'text', text: '응답' }], usage(100, 10, 700, 100))]);
  const j = JSON.parse(execFileSync(process.execPath, [BIN, '--json'], { env: process.env, encoding: 'utf8' }));
  const s = j.sessions.find((x) => x.id === 'cachehit-1');
  assert.equal(s.cacheHitRate, 0.778);
  assert.equal(s.tokens.cacheRead, 700);
  // 토큰 내역이 없는 세션은 null.
  assert.equal(toJson({ sessions: [{ tool: 'gemini', id: 'g', tokens: emptyTokens() }], at: 0 }).sessions[0].cacheHitRate, null);
});
