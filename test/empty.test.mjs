import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';
import { width } from '../src/text.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.now();
const tools = {
  platform: 'linux',
  processes: true,
  tools: {
    claude: { tool: 'claude', state: 'ok', path: '~/.claude/projects', records: 12, lastAt: at - 120_000, running: 0, readable: true, hint: null },
    codex: { tool: 'codex', state: 'missing', path: '~/.codex/sessions', records: 0, lastAt: null, running: 0, readable: null, hint: 'codex 를 한 번 실행하면 생깁니다' },
    gemini: { tool: 'gemini', state: 'limited', found: false, path: '~/.gemini/tmp', records: 0, lastAt: null, running: 0, readable: null, keys: [], hint: '프로세스만 감지합니다 (세션·토큰은 아직 지원하지 않음)' },
  },
};
const view = (extra = {}) => ({ data: { sessions: [], usage: null, errors: [], at, tools }, selectedId: null, showDetail: true, frame: 0, ...extra });

test('세션이 없으면 도구별 점검 줄과 종료 세션 보기 안내를 보인다', () => {
  const out = render(view(), 120, 24).map(strip).join('\n');
  assert.match(out, /실행 중인 AI 세션이 없습니다/);
  assert.match(out, /✓ claude 찾음\s+~\/\.claude\/projects\s+기록 12개 · 마지막 2분 전 · 실행 0/);
  assert.match(out, /✗ codex\s+없음.*\n\s+→ codex 를 한 번 실행하면 생깁니다/);
  assert.match(out, /○ gemini 일부 지원.*기록 폴더 없음/);
  assert.match(out, /지난 24시간 세션 보기: e 또는 aitop --all/);
});

test('세션이 없으면 키 줄은 e, ?, q 만 보인다', () => {
  const foot = strip(render(view(), 120, 24).at(-1));
  assert.doesNotMatch(foot, /다음|상세|검색|선택/);
  assert.match(foot, /종료 포함.*도움.*나가기/);
});

test('도구 줄은 기록 폴더가 없는 도구를 미설치로 보인다', () => {
  const strip2 = strip(render(view(), 120, 24)[1]);
  assert.match(strip2, /codex 미설치/);
  assert.doesNotMatch(strip2, /claude 미설치|gemini 미설치/);
});

test('검색 결과가 없을 때는 점검 줄 대신 검색 안내만 보인다', () => {
  const out = render(view({ filter: 'zzz' }), 120, 24).map(strip).join('\n');
  assert.match(out, /'zzz' 에 맞는 세션이 없습니다/);
  assert.doesNotMatch(out, /✓ claude/);
});

test('빈 화면은 어느 폭에서도 줄이 넘치지 않는다', () => {
  for (const W of [40, 60, 80, 120]) for (const l of render(view(), W, 24)) assert.equal(width(strip(l)), W, `W=${W}`);
});
