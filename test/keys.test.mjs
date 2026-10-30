import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onKey, fixFocus, KEY } from '../src/keys.mjs';

const file = (path) => ({ path, edits: 1, add: 1, del: 0, at: Date.now(), hunks: [] });

function setup(extra = {}) {
  const calls = [];
  const view = { data: { sessions: [{ id: 's1', files: [file('/a'), file('/b'), file('/c')] }, { id: 's2', files: [] }] }, selectedId: 's1', showDetail: true, filter: '', searching: false, help: false, focus: null, filePath: null, diffScroll: 0, ...extra };
  const act = { quit: () => calls.push('quit'), refresh: () => calls.push('refresh'), move: (d) => calls.push(`move ${d}`), next: () => calls.push('next'), keepVisible: () => calls.push('keep') };
  const press = (...keys) => keys.forEach((k) => onKey(view, k, act));
  return { view, calls, press };
}

test('Esc 는 종료하지 않는다. 종료는 q 와 Ctrl-C', () => {
  const { calls, press } = setup();
  press(KEY.esc, KEY.esc);
  assert.deepEqual(calls, []);
  press('q');
  assert.deepEqual(calls, ['quit']);
  const other = setup({ searching: true });
  other.press(KEY.ctrlC);
  assert.deepEqual(other.calls, ['quit']);
});

test('Esc 는 도움말을 닫고, 검색어를 지운다', () => {
  const { view, press, calls } = setup({ help: true, filter: 'abc' });
  press(KEY.esc);
  assert.equal(view.help, false);
  assert.equal(view.filter, 'abc');
  press(KEY.esc);
  assert.equal(view.filter, '');
  assert.deepEqual(calls, []);
});

test('f → ↓ → Enter → Esc → Esc 로 파일 목록과 diff 를 거쳐 세션 선택으로 돌아온다', () => {
  const { view, press, calls } = setup({ showDetail: false });
  press('f');
  assert.equal(view.focus, 'files');
  assert.equal(view.showDetail, true, '상세 패널이 닫혀 있으면 연다');
  assert.equal(view.filePath, '/a');
  press(KEY.down, KEY.down, KEY.down);
  assert.equal(view.filePath, '/c', '끝에서 멈춘다');
  press(KEY.up);
  assert.equal(view.filePath, '/b');
  assert.deepEqual(calls, [], '목록 안에서 ↑↓ 는 세션을 옮기지 않는다');
  press(KEY.enter);
  assert.equal(view.focus, 'diff');
  press(KEY.down, ' ', ']');
  assert.equal(view.filePath, '/c');
  assert.equal(view.diffScroll, 0, '다른 파일로 가면 맨 위부터');
  press(KEY.esc);
  assert.equal(view.focus, 'files');
  press(KEY.esc);
  assert.equal(view.focus, null);
  press(KEY.down);
  assert.deepEqual(calls, ['move 1']);
});

test('고친 파일이 없는 세션에서는 f 가 아무 일도 하지 않는다', () => {
  const { view, press } = setup({ selectedId: 's2' });
  press('f', KEY.tab);
  assert.equal(view.focus, null);
});

test('갱신 뒤 고른 파일이 사라지면 목록의 첫 파일로, 파일이 없어지면 세션 선택으로 돌아간다', () => {
  const { view, press } = setup();
  press('f', KEY.down, KEY.enter);
  view.data.sessions[0].files = [file('/z'), file('/a')];
  fixFocus(view);
  assert.deepEqual([view.focus, view.filePath], ['files', '/z']);
  view.data.sessions[0].files = [];
  fixFocus(view);
  assert.equal(view.focus, null);
});

test('d 로 상세를 닫으면 포커스도 풀린다', () => {
  const { view, press } = setup();
  press('f', 'd');
  assert.deepEqual([view.showDetail, view.focus], [false, null]);
});
