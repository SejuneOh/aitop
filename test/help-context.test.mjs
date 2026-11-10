import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../src/ui.mjs';
import { onKey, KEY } from '../src/keys.mjs';
import { VIEWS, OPTIONS, helpContext, keysText, settingsLine } from '../src/help.mjs';
import { width } from '../src/text.mjs';

const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'aitop.mjs');
const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const settings = { budgetDay: 50, notify: true, onWaiting: false, debug: false, configPath: '/home/u/.config/aitop/config.json' };
const view = (extra = {}) => ({ data: { sessions: [], errors: [], at: Date.now(), usage: null }, selectedId: null, showDetail: true, frame: 0, help: true, settings, ...extra });
const screen = (extra, W = 120, H = 40) => render(view(extra), W, H).map(strip);
// 도움말 상자의 첫 줄(제목 아래)
const firstSection = (lines) => lines[2].replace(/^│ /, '').trim();

test('지금 화면의 키가 맨 앞에 온다 (표 · 파일 목록 · diff). 검색어는 화면이 아니라 표에 붙는다', () => {
  assert.equal(helpContext({}), 'table');
  assert.equal(helpContext({ focus: 'files' }), 'files');
  assert.equal(helpContext({ focus: 'diff' }), 'diff');
  assert.equal(helpContext({ filter: 'abc' }), 'table');
  assert.equal(helpContext({ focus: 'diff', filter: 'abc' }), 'diff', '파일 목록·diff 에서는 검색어가 있어도 그 화면');
  assert.equal(helpContext({ focus: 'files', filter: 'abc' }), 'files');
  for (const [extra, title] of [[{}, '세션 표'], [{ focus: 'files' }, '변경 파일 목록'], [{ focus: 'diff' }, 'diff'], [{ filter: 'x' }, '세션 표'], [{ focus: 'diff', filter: 'x' }, 'diff']])
    for (const [W, H] of [[60, 16], [80, 24], [120, 40]]) assert.match(firstSection(screen(extra, W, H)), new RegExp(`^${title}  \\(지금 화면\\)`), `${title} ${W}x${H}`);
  const diff = screen({ focus: 'diff' }, 80, 40).join('\n');
  assert.ok(diff.indexOf('한 줄씩 스크롤') < diff.indexOf('다른 화면'), 'diff 키 → 다른 화면');
  assert.match(diff, /세션 표 +\/ 검색 · ↑↓\/jk 선택/, '다른 화면은 한 줄씩');
  assert.match(diff, /Esc h ← f Tab +파일 목록으로/, 'diff 에서 f·Tab 도 파일 목록으로');
});

test('검색어가 걸린 표: 표 키가 먼저, 그다음 검색어 키 (Esc 지우기, / 새 검색)', () => {
  const all = screen({ filter: 'abc' }, 80, 60).join('\n');
  const at = (t) => all.indexOf(t);
  assert.ok(at('세션 표  (지금 화면)') < at('검색어가 걸린 표') && at('검색어가 걸린 표') > 0);
  assert.ok(at('세션 표  (지금 화면)') < at('검색어 지우기 (표 전체로)'));
  assert.ok(at('검색어 지우기 (표 전체로)') < at('다른 화면'));
  assert.match(all, /지금 검색어를 지우고 새로 입력/);
  assert.match(all, /검색 입력 중 +글자 입력 · Backspace 지우기 · Enter 적용 · Esc 취소/, '입력 중 키는 다른 화면에');
  assert.ok(!screen({}, 80, 60).join('\n').includes('검색어 지우기 (표 전체로)'), '검색어가 없으면 지금 화면에 없다');
});

test('상세 패널이 열려 있으면 표 다음에 상세 패널 키, 닫혀 있으면 다른 화면에', () => {
  const open = screen({}, 80, 40).join('\n');
  assert.ok(open.indexOf('다른 세션을 고르면 상세도 따라 바뀐다') < open.indexOf('다른 화면'));
  const closed = screen({ showDetail: false }, 80, 40).join('\n');
  assert.ok(!closed.includes('다른 세션을 고르면 상세도 따라 바뀐다'));
  assert.match(closed, /상세 패널 +↑↓\/jk 세션 바꾸기/);
});

test('이번 주에 더한 키와 옵션, 지금 설정 값이 보인다', () => {
  const all = screen({}, 120, 40).join('\n');
  for (const k of ['s', 'g', 'c']) assert.match(all, new RegExp(`│ ${k} {11}\\S`), `키 ${k}`);
  for (const [o] of OPTIONS) assert.ok(all.includes(o), o);
  for (const o of ['--notify', '--on-waiting', '--budget-day', '--show-requests', '--debug', '--print-config']) assert.ok(OPTIONS.some(([k]) => k.startsWith(o)), o);
  assert.ok(all.includes(settings.configPath));
  assert.match(all, /지금 +예산 \$50 · 알림 켜짐 · 디버그 꺼짐/);
  assert.equal(settingsLine({ budgetDay: null, notify: false, onWaiting: true, debug: true }), '예산 없음 · 알림 꺼짐 · 대기 명령 있음 · 디버그 켜짐');
  assert.equal(settingsLine(undefined), null);
  // 상태 기호와 열 설명은 그대로 남는다.
  for (const word of ['응답 대기', '완료 · 확인 전', 'IDLE', 'CONTEXT']) assert.ok(all.includes(word), word);
});

test('60x16 · 80x24 · 120x40 어디서도 넘치지 않고, 넘치는 줄은 스크롤 안내로 끝난다', () => {
  for (const extra of [{}, { focus: 'files' }, { focus: 'diff' }, { filter: 'x' }, { showDetail: false }])
    for (const [W, H] of [[60, 16], [80, 24], [120, 40], [60, 8]]) {
      const lines = screen(extra, W, H);
      assert.equal(lines.length, H, `${W}x${H}`);
      assert.ok(lines.every((l) => width(l) <= W), `${W}x${H} 폭`);
    }
  const small = screen({}, 60, 16);
  assert.match(small.at(-3), /… \d+줄 더 · ↑↓ 로 스크롤/);
  assert.match(small.at(-1), /\?\s+도움 닫기/);
});

test('↑↓ 로 도움말을 스크롤하고 끝에서 멈춘다. ? 는 열고 닫고, 열 때 맨 위로', () => {
  const calls = [];
  const v = view({ selectedId: 's1', data: { sessions: [{ id: 's1' }] }, help: false });
  const act = { quit: () => calls.push('quit'), refresh: () => {}, move: (d) => calls.push(`move ${d}`), next: () => {}, keepVisible: () => {} };
  const press = (...ks) => ks.forEach((k) => onKey(v, k, act));
  press('?');
  assert.equal(v.help, true);
  render(v, 60, 16);
  assert.ok(v.helpMax > 0);
  press(KEY.down, 'j');
  assert.equal(v.helpScroll, 2);
  assert.deepEqual(calls, [], '도움말이 열려 있으면 세션 선택이 움직이지 않는다');
  const lines = render(v, 60, 16).map(strip);
  assert.ok(!firstSection(lines).startsWith('세션 표'), '내려 보인다');
  for (let i = 0; i < 200; i++) press(' ');
  assert.equal(v.helpScroll, v.helpMax, '끝에서 멈춘다');
  assert.doesNotMatch(render(v, 60, 16).map(strip).join('\n'), /줄 더/);
  press(KEY.up);
  assert.equal(v.helpScroll, v.helpMax - 1);
  press('?');
  assert.equal(v.help, false);
  press('?');
  assert.equal(v.helpScroll, 0, '다시 열면 맨 위');
  press(KEY.esc);
  assert.equal(v.help, false);
  press(KEY.down);
  assert.deepEqual(calls, ['move 1'], '닫으면 ↓ 는 다시 세션 선택');
});

test('aitop --help 의 키 안내는 같은 표에서 만든다', () => {
  const out = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  for (const l of keysText().split('\n')) assert.ok(out.includes(l), l);
  for (const k of VIEWS.table.keys) assert.ok(keysText().split('\n')[0].includes(k[2]), k[2]);
  assert.match(out, /키: .*s 정렬 · g 묶기 · c 비용 기준/);
});

test('도움말은 모달: 열려 있으면 스크롤·닫기·나가기만 듣고 다른 키는 버린다', () => {
  const calls = [];
  const v = view({ selectedId: 's1', data: { sessions: [{ id: 's1', files: [{ path: '/a' }] }] }, help: true, focus: null, filter: '', searching: false, sort: 'default', group: 'none', costMode: 'api' });
  const act = { quit: () => calls.push('quit'), refresh: () => calls.push('refresh'), move: (d) => calls.push(`move ${d}`), next: () => calls.push('next'), keepVisible: () => calls.push('keep') };
  const press = (...ks) => ks.forEach((k) => onKey(v, k, act));
  press('/', 's', 'g', 'c', 'd', 'f', KEY.tab, 'n', 'e', KEY.left, KEY.right, KEY.enter, 'x');
  assert.deepEqual(calls, []);
  assert.deepEqual([v.help, v.searching, v.filter, v.sort, v.group, v.costMode, v.showDetail, v.focus], [true, false, '', 'default', 'none', 'api', true, null]);
  render(v, 60, 16);
  press(KEY.pageDown);
  assert.equal(v.helpScroll, Math.min(10, v.helpMax));
  press(KEY.pageUp);
  assert.equal(v.helpScroll, 0);
  press('q');
  assert.deepEqual(calls, ['quit']);
  press(KEY.esc);
  assert.equal(v.help, false);
  press('/');
  assert.equal(v.searching, true, '닫은 뒤에는 / 가 검색을 연다');
});

test('창이 커져 도움말이 덜 넘치면 스크롤 값을 줄여, 첫 ↑ 가 바로 먹힌다', () => {
  const v = view({ helpScroll: 0 });
  render(v, 60, 16);
  v.helpScroll = v.helpMax;
  render(v, 80, 30);
  assert.equal(v.helpScroll, v.helpMax, '큰 창의 끝으로 줄인다');
  const before = v.helpScroll;
  onKey(v, KEY.up, { quit() {}, refresh() {}, move() {}, next() {}, keepVisible() {} });
  assert.equal(v.helpScroll, Math.max(0, before - 1));
});
