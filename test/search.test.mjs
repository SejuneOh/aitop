import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSessions, render } from '../src/ui.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const s = (id, name, project, model = 'claude-opus-5-5') => ({
  tool: 'claude', id, name, project, cwd: `/work/${project}`, model, live: true, status: 'idle',
  phase: { kind: 'idle' }, updatedAt: Date.now(), tokens: { total: 1 }, cost: 0, context: {}, events: [], members: [],
});
const list = [s('a', 'Release-Notes', 'aitop'), s('b', 'chat-api-removal', 'CloudHospital.Api'), s('c', 'theme', 'nvim', 'claude-haiku-5-5')];

test('이름·폴더·모델로 대소문자 없이 거른다', () => {
  assert.deepEqual(filterSessions(list, 'release').map((x) => x.id), ['a']);
  assert.deepEqual(filterSessions(list, 'cloudhospital').map((x) => x.id), ['b']);
  assert.deepEqual(filterSessions(list, 'HAIKU').map((x) => x.id), ['c']);
  assert.equal(filterSessions(list, '').length, 3);
  assert.equal(filterSessions(list, '  ').length, 3);
});

test('검색 중에는 하단에 검색어와 걸린 수가 보이고, 표에는 걸린 세션만 나온다', () => {
  const view = { data: { sessions: list, errors: [], at: Date.now() }, selectedId: 'b', showDetail: false, frame: 0, filter: 'api', searching: true };
  const lines = render(view, 140, 12).map(strip);
  assert.match(lines.at(-1), /\/\s+api▏\s+1개/);
  assert.ok(lines.some((l) => l.includes('chat-api-removal')));
  assert.ok(!lines.some((l) => l.includes('Release-Notes')));
});

test('맞는 세션이 없으면 그렇다고 알린다', () => {
  const view = { data: { sessions: list, errors: [], at: Date.now() }, selectedId: null, showDetail: true, frame: 0, filter: 'zzz' };
  const lines = render(view, 140, 12).map(strip);
  assert.ok(lines.some((l) => l.includes("'zzz' 에 맞는 세션이 없습니다")));
});
