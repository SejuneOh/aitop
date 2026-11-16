import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexId, osc52, resumeCmd, shellQuote, stripControls } from '../src/resume.mjs';
import { KEY, onKey } from '../src/keys.mjs';
import { toJson } from '../src/json.mjs';
import { at, session } from './detail-fixture.mjs';
import { setNow } from '../src/ui/draw.mjs';
import { detail, resumeLines } from '../src/ui/detail.mjs';
import { footer } from '../src/ui/chrome.mjs';
import { keysText } from '../src/help.mjs';
import { width } from '../src/text.mjs';
import { homeEnv } from '../src/sources/dirs.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const UUID = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';

test('셸 따옴표: 안전한 글자는 그대로, 공백·따옴표·$ 는 작은따옴표로 감싼다', () => {
  assert.equal(shellQuote('/home/me/repo'), '/home/me/repo');
  assert.equal(shellQuote('/home/me/my repo'), "'/home/me/my repo'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('$HOME/`x`'), "'$HOME/`x`'");
  assert.equal(shellQuote('a;rm -rf ~'), "'a;rm -rf ~'");
  assert.equal(shellQuote(''), "''");
  // = 로 시작하면 zsh 가 =cmd 를 바꾸므로 감싼다. 가운데 = 는 그대로.
  assert.equal(shellQuote('=ls'), "'=ls'");
  assert.equal(shellQuote('a=b'), 'a=b');
});

test('제어 문자·줄바꿈·폭 0 글자는 명령에 들어가지 않는다', () => {
  assert.equal(stripControls('a\nb\r\tc\x1b[31m\x07\u009bd​e'), 'abc[31mde');
  const cmd = resumeCmd({ tool: 'claude', id: `${UUID}\n`, cwd: '/my repo\n; echo x' });
  assert.ok(!/[\x00-\x1f\x7f]/.test(cmd), cmd);
  assert.equal(cmd, `cd '/my repo; echo x' && claude --resume ${UUID}`);
  // UUID 가 아닌 id 는 명령을 만들지 않는다.
  assert.equal(resumeCmd({ tool: 'claude', id: 'abc\n; echo x', cwd: '/r' }), null);
});

test('도구별 이어 여는 명령', () => {
  assert.equal(resumeCmd({ tool: 'claude', id: UUID, cwd: '/home/me/my repo' }), `cd '/home/me/my repo' && claude --resume ${UUID}`);
  // Claude 는 폴더별로 기록을 찾으므로 폴더를 모르면 만들지 않는다.
  assert.equal(resumeCmd({ tool: 'claude', id: UUID, cwd: null }), null);
  // 옵션처럼 보이는 id 는 받지 않는다.
  for (const tool of ['claude', 'gemini', 'codex']) assert.equal(resumeCmd({ tool, id: '--dangerously-skip-permissions', cwd: '/r' }), null, tool);
  assert.equal(resumeCmd({ tool: 'claude', id: 'fix', cwd: '/r' }), null);
  // Codex id 는 기록 파일 이름이라 UUID 만 꺼낸다 (codex resume <SESSION_ID>).
  assert.equal(resumeCmd({ tool: 'codex', id: `rollout-2026-11-16T09-00-00-${UUID}.jsonl`, cwd: '/r' }), `cd /r && codex resume ${UUID}`);
  assert.equal(codexId('rollout-x.jsonl'), null);
  assert.equal(resumeCmd({ tool: 'codex', id: 'rollout-x.jsonl', cwd: '/r' }), null);
  assert.equal(resumeCmd({ tool: 'codex', id: 'pid-42', cwd: '/r' }), null);
  // Antigravity 는 대화 id 로 agy --conversation <id>. 프로세스만 본 세션(agy-, Gemini CLI pid-)은 없다.
  assert.equal(resumeCmd({ tool: 'gemini', id: UUID, cwd: '/r' }), `cd /r && agy --conversation ${UUID}`);
  assert.equal(resumeCmd({ tool: 'gemini', id: UUID, cwd: null }), `agy --conversation ${UUID}`);
  assert.equal(resumeCmd({ tool: 'gemini', id: 'c0ffee12-3456', cwd: '/r' }), null);
  assert.equal(resumeCmd({ tool: 'gemini', id: 'agy-7', cwd: '/r' }), null);
  assert.equal(resumeCmd({ tool: 'gemini', id: 'pid-7', cwd: '/r' }), null);
  assert.equal(resumeCmd({ tool: 'other', id: 'x' }), null);
  assert.equal(resumeCmd(null), null);
});

test('기본이 아닌 설정 폴더의 세션은 그 폴더를 변수로 집어 이어 연다 (#212 와 함께)', () => {
  // 물려받은 변수가 없고 기본 폴더면 붙이지 않는다.
  assert.equal(homeEnv('claude', '/h/.claude', {}, '/h'), null);
  assert.equal(homeEnv('codex', '/h/.codex', {}, '/h'), null);
  assert.equal(homeEnv('claude', null, {}, '/h'), null);
  // 다른 폴더, 또는 셸에 다른 값이 있을 수 있으면 꼭 집는다.
  assert.deepEqual(homeEnv('claude', '/h/.claude-work', {}, '/h'), ['CLAUDE_CONFIG_DIR', '/h/.claude-work']);
  assert.deepEqual(homeEnv('claude', '/h/.claude', { CLAUDE_CONFIG_DIR: '/h/.claude-work' }, '/h'), ['CLAUDE_CONFIG_DIR', '/h/.claude']);
  assert.deepEqual(homeEnv('codex', '/h/.codex-b', {}, '/h'), ['CODEX_HOME', '/h/.codex-b']);
  // 명령: 변수는 cd 뒤, 도구 앞. 폴더 이름도 따옴표로 감싼다.
  assert.equal(resumeCmd({ tool: 'claude', id: UUID, cwd: '/r', home: '/data/my claude' }), `cd /r && CLAUDE_CONFIG_DIR='/data/my claude' claude --resume ${UUID}`);
  assert.equal(resumeCmd({ tool: 'codex', id: UUID, cwd: '/r', home: '/data/codex-b' }), `cd /r && CODEX_HOME=/data/codex-b codex resume ${UUID}`);
  // Antigravity 는 폴더 변수가 없다.
  assert.equal(resumeCmd({ tool: 'gemini', id: UUID, cwd: '/r', home: '/data/x' }), `cd /r && agy --conversation ${UUID}`);
});

test('OSC 52 바이트: ESC ] 52 ; c ; base64 BEL', () => {
  assert.equal(osc52('hi'), '\x1b]52;c;aGk=\x07');
  const cmd = "cd '/a b' && claude --resume 한글";
  const seq = osc52(cmd);
  assert.ok(seq.startsWith('\x1b]52;c;') && seq.endsWith('\x07'));
  assert.equal(Buffer.from(seq.slice(7, -1), 'base64').toString('utf8'), cmd);
  assert.ok(!/[\x00-\x1f]/.test(seq.slice(1, -1).replace(/^\]52;c;/, '')));
});

test('y 는 고른 세션으로 act.copy 만 부르고, 검색 중에는 검색어가 된다', () => {
  const s1 = { id: 's1', tool: 'claude', files: [] };
  const calls = [];
  const view = { data: { sessions: [s1] }, selectedId: 's1', showDetail: true, filter: '', searching: false, help: false, focus: null };
  const act = { copy: (s) => calls.push(s), quit() {}, refresh() {}, move() {}, next() {}, keepVisible() {} };
  onKey(view, 'y', act);
  assert.deepEqual(calls, [s1]);
  // 파일 목록·diff 안에서도 받는다.
  onKey({ ...view, focus: 'files', filePath: null }, 'y', act);
  assert.equal(calls.length, 2);
  const searching = { ...view, searching: true, filter: '' };
  onKey(searching, 'y', act);
  assert.equal(searching.filter, 'y');
  const help = { ...view, help: true };
  onKey(help, 'y', act);
  assert.equal(calls.length, 2);
  // act.copy 가 없어도(테스트·이전 호출부) 터지지 않는다.
  onKey(view, 'y', {});
  onKey(view, KEY.esc, act);
});

test('--json 은 세션마다 resumeCmd 를 넣는다', () => {
  const j = toJson({ at, usage: null, sessions: [{ tool: 'claude', id: UUID, cwd: '/a b', status: 'idle' }, { tool: 'gemini', id: 'pid-1', status: 'live' }] }, '0');
  assert.equal(j.sessions[0].resumeCmd, `cd '/a b' && claude --resume ${UUID}`);
  assert.equal(j.sessions[1].resumeCmd, null);
});

test('상세 패널 넓은 화면: 이어 열기는 왼쪽 칸 맨 아래, 남는 줄이 있을 때만 (H=12·16 은 바뀌기 전과 같다)', () => {
  setNow(at);
  const can = { ...session(), id: UUID };
  // fixture 의 id 'fix' 는 UUID 가 아니라 명령이 없다: 바뀌기 전 화면과 같다.
  const draw = (s, W, H) => detail(s, W, H, 0, { tab: 'now' }).map(strip);
  for (const W of [100, 120, 150]) {
    for (const H of [12, 16]) assert.deepEqual(draw(can, W, H), draw(session(), W, H), `${W}x${H}`);
    const tall = draw(can, W, 24);
    const at24 = tall.findIndex((l) => /── 이어 열기 ─+ y ─/.test(l));
    const cost = tall.findIndex((l) => l.includes('── 비용 '));
    assert.ok(at24 > cost && cost > 0, `${W}x24 비용 다음`);
    assert.ok(tall.some((l) => l.includes(`--resume`)), `${W}x24 명령`);
    // 왼쪽 칸 위쪽(이어 열기 앞)은 명령 없는 화면과 같다.
    const plain = draw(session(), W, 24);
    for (let i = 0; i < at24; i++) assert.equal(tall[i], plain[i], `${W}x24 줄 ${i}`);
  }
  // H=20: 남는 줄만큼만 (가로줄 + 1줄 이상), 넘치지 않는다.
  const mid = draw(can, 120, 20);
  assert.equal(mid.length, 20);
  for (const l of mid) assert.equal(width(l), 120);
});

test('상세 패널 좁은 화면: 셋째 요약 줄은 앞을 잘라 id 를 남기고, 낮으면 없다', () => {
  setNow(at);
  const can = { ...session(), id: UUID };
  const narrow = detail(can, 60, 24, 0, { tab: 'now' }).map(strip);
  assert.match(narrow[3], new RegExp(`^│   이어 열기 y  …[^│]*${UUID} │$`));
  assert.match(detail(can, 90, 24, 0, { tab: 'now' }).map(strip)[3], new RegExp(`&& claude --resume ${UUID} +│$`));
  for (const l of narrow) assert.equal(width(l), 60);
  const low = detail(can, 60, 16, 0, { tab: 'now' }).map(strip);
  assert.ok(!low.some((l) => l.includes('이어 열기')));
  const none = detail({ ...can, tool: 'gemini', id: 'pid-1' }, 120, 24, 0, { tab: 'now' }).map(strip);
  assert.ok(!none.some((l) => l.includes('이어 열기')));
});

test('긴 명령은 줄을 나누고 넘치면 … 로 끝낸다', () => {
  assert.deepEqual(resumeLines('abcdefghij', 4, 2), ['abcd', 'efg…']);
  assert.deepEqual(resumeLines('abc', 4, 2), ['abc']);
  assert.deepEqual(resumeLines(null, 4, 2), []);
});

test('키 줄: y 안내와 복사 알림, 도움말·--help 에 y', () => {
  const sel = { id: UUID, tool: 'claude', cwd: '/r' };
  const view = { data: { sessions: [sel] }, showDetail: true };
  assert.match(strip(footer(view, 200, 1, sel)), /y\s+명령 복사/);
  assert.doesNotMatch(strip(footer({ ...view, showDetail: false }, 200, 1, sel)), /명령 복사/);
  assert.match(strip(footer({ ...view, toast: { key: 'foot.copied', until: Date.now() + 2000 } }, 60, 1, sel)), /^ 이어 여는 명령을 클립보드로 보냄 \(OSC 52\)/);
  assert.doesNotMatch(strip(footer({ ...view, toast: { key: 'foot.copied', until: Date.now() - 1 } }, 200, 1, sel)), /클립보드로 보냄/);
  assert.match(keysText('ko'), /y 명령 복사/);
  assert.match(keysText('en'), /y copy cmd/);
});
