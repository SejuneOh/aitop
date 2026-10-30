import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onKey, KEY } from '../src/keys.mjs';

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
