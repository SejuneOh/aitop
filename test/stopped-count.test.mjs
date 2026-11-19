// 오류로 멈춘 세션을 대기와 따로 센다: 헤더, n 이동, 창 제목, --line (#262).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAttention, nextAttention, attentionCounts, windowTitle, isStopped } from '../src/attention.mjs';
import { header } from '../src/ui/table.mjs';
import { formatLine } from '../src/line.mjs';
import { setLang } from '../src/i18n.mjs';
import { setAmbiguous } from '../src/text.mjs';

afterEach(() => {
  setLang('ko');
  setAmbiguous('narrow');
});

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-11-10T05:00:00Z');
const mk = (id, extra = {}) => ({ tool: 'claude', id, name: id, cwd: '/w', status: 'idle', live: true, phase: { kind: 'idle' }, updatedAt: at, tokens: { total: 1 }, members: [], events: [], ...extra });
const stopped = (id) => mk(id, { phase: { kind: 'stopped', msg: 'stopAuth' }, stopReason: { kind: 'auth' } });
const view = (sessions) => ({ data: { sessions, usage: null, errors: [], at, tools: { tools: {} } } });

test('멈춘 세션은 살아 있을 때만 멈춤으로 센다', () => {
  assert.equal(isStopped(stopped('a')), true);
  assert.equal(isStopped({ ...stopped('a'), live: false }), false);
  assert.equal(isStopped(mk('b')), false);
});

test('헤더는 멈춤을 기호·글자와 함께 따로 세고 대기 수에서 뺀다 (80·130열, 한/영)', () => {
  const sessions = [mk('w', { status: 'waiting', phase: { kind: 'waiting' } }), stopped('s1'), stopped('s2'), mk('i')];
  for (const W of [80, 130]) {
    setLang('ko');
    const ko = strip(header(view(sessions), W));
    assert.match(ko, /◆ 1 응답/, `${W}: ${ko}`);
    assert.match(ko, /! 2 멈춤/, `${W}: ${ko}`);
    // 대기에는 멈춘 2개가 빠진 1개만 남는다 (좁으면 대기 칸 자체가 빠질 수 있다).
    assert.doesNotMatch(ko, /○ 3/, `${W}: ${ko}`);
    if (W >= 130) assert.match(ko, /○ 1 지시 대기/, ko);
    setLang('en');
    const en = strip(header(view(sessions), W));
    assert.match(en, /! 2 stopped/, `${W}: ${en}`);
  }
  // 응답 대기 바로 뒤에 둔다 (사람이 할 일을 앞에).
  setLang('ko');
  const l = strip(header(view(sessions), 130));
  assert.ok(l.indexOf('! 2') > l.indexOf('◆ 1') && l.indexOf('! 2') < l.indexOf('세션'), l);
});

test('AITOP_AMBIGUOUS=wide 헤더에서도 멈춤(!)과 응답 대기(?)가 다른 기호다', () => {
  setAmbiguous('wide');
  const l = strip(header(view([mk('w', { status: 'waiting', phase: { kind: 'waiting' } }), stopped('s')]), 80));
  assert.match(l, /\? 1 응답/);
  assert.match(l, /! 1 멈춤/);
});

test('n 은 응답 대기 → 멈춤 → 확인 전 순서로 간다', () => {
  const st = createAttention();
  st.unseen.add('u');
  const list = [mk('a'), mk('u'), stopped('s'), mk('w', { status: 'waiting', phase: { kind: 'waiting' } })];
  assert.equal(nextAttention(st, list, 'a').id, 'w');
  assert.equal(nextAttention(st, list.filter((s) => s.id !== 'w'), 'a').id, 's', '응답 대기가 없으면 멈춤이 확인 전보다 먼저');
  assert.equal(nextAttention(st, [mk('a'), mk('u')], 'a').id, 'u');
  assert.equal(nextAttention(st, [mk('a'), { ...stopped('s'), live: false }], 'a'), null, '끝난 세션은 멈춤으로 치지 않는다');
});

test('창 제목에 멈춤 수가 응답 대기와 확인 전 사이에 붙는다', () => {
  const list = [mk('w', { status: 'waiting', phase: { kind: 'waiting' } }), stopped('s'), mk('u', { unseen: true })];
  assert.deepEqual(attentionCounts(list), { waiting: 1, stopped: 1, unseen: 1 });
  assert.equal(windowTitle(list), '(1◆ 1! 1●) aitop');
  assert.equal(windowTitle([stopped('s')]), '(1!) aitop');
});

test('--line 은 멈춤 수를 stop N 으로, 대기 뒤·작업 중 앞에 둔다 (ASCII, tmux 색)', () => {
  assert.equal(formatLine({ today: 1, waiting: 1, stopped: 2, running: 3 }), '$1.00 wait 1 stop 2 run 3');
  assert.equal(formatLine({ stopped: 1 }), 'stop 1');
  assert.equal(formatLine({ stopped: 0 }), 'aitop idle');
  assert.match(formatLine({ stopped: 1 }, { mode: 'tmux' }), /^#\[fg=colour\d+\]stop 1#\[default\]$/);
  assert.equal(formatLine({ stopped: 1 }, { mode: 'tmux', noColor: true }), 'stop 1');
  // 폭이 모자라면 작업 중이 먼저 빠지고 멈춤은 남는다.
  assert.equal(formatLine({ today: 1, waiting: 1, stopped: 2, running: 3 }, { width: 19 }), '$1.00 wait 1 stop 2');
});
