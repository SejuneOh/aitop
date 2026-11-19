// 실행 중 알림 켜기·끄기 키(a)와 첫 응답 대기 때 켜기 힌트 (#294).
// 실제 알림 도구는 부르지 않는다. 알림 도구 찾기(find)와 실행(spawnFn)을 가짜로 바꿔 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { applyNotifyToggle, createNotifier, createNotifyToggle, notifyExplicitOff, notifyHintDue, toggleNotify } from '../src/notify.mjs';
import { resolveConfig } from '../src/config.mjs';
import { onKey } from '../src/keys.mjs';
import { VIEWS, keysText } from '../src/help.mjs';
import { footer } from '../src/ui/chrome.mjs';
import { t } from '../src/i18n.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const sess = (id, status, extra = {}) => ({ id, status, live: true, tool: 'claude', project: 'demo', cwd: '/w/demo', phase: status === 'waiting' ? { kind: 'waiting', args: { what: 'Bash' } } : { kind: 'idle' }, members: [], ...extra });

// 가짜 spawn: 부른 인자를 남기고, 곧바로 끝난 자식처럼 exit 를 보낸다.
function fakeSpawn() {
  const calls = [];
  const fn = (file, args) => {
    calls.push({ file, args });
    const c = new EventEmitter();
    setImmediate(() => c.emit('exit', 0));
    return c;
  };
  return { fn, calls };
}

test('a 키는 act.toggleNotify 를 부르고, 검색 중에는 글자로 받는다', () => {
  let n = 0;
  const act = { quit() {}, refresh() {}, move() {}, next() {}, keepVisible() {}, toggleNotify: () => n++ };
  const view = { data: { sessions: [] }, focus: null, filter: '' };
  onKey(view, 'a', act);
  assert.equal(n, 1);
  // 검색 중에는 글자로 들어간다.
  const searching = { ...view, searching: true };
  onKey(searching, 'a', act);
  assert.equal(n, 1);
  assert.equal(searching.filter, 'a');
});

test('알리미 setNotify: 꺼진 채 시작해도 켜면 그때 알림 도구를 찾아 알리고, 끄면 알리지 않는다', async () => {
  const sp = fakeSpawn();
  let found = 0;
  const find = () => {
    found++;
    return { kind: 'notify-send', path: '/fake/notify-send' };
  };
  const n = createNotifier({ notify: false, find, spawnFn: sp.fn, platform: 'linux', env: {} });
  assert.equal(found, 0, '꺼진 채 시작하면 알림 도구를 찾지 않는다');
  n.fire([sess('a', 'waiting')]);
  assert.equal(sp.calls.length, 0);
  assert.equal(n.setNotify(true), true);
  assert.equal(found, 1);
  n.fire([sess('a', 'waiting')]);
  assert.equal(sp.calls.length, 1);
  assert.equal(sp.calls[0].file, '/fake/notify-send');
  await new Promise((r) => setImmediate(r));
  assert.equal(n.setNotify(false), false);
  n.fire([sess('b', 'waiting')]);
  assert.equal(sp.calls.length, 1, '끈 뒤에는 알리지 않는다');
  n.setNotify(true);
  assert.equal(found, 1, '다시 켜도 도구는 한 번만 찾는다');
  n.fire([sess('c', 'waiting')]);
  assert.equal(sp.calls.length, 2);
});

test('알리미 setNotify: 알림 도구가 없으면 false 를 돌려준다', () => {
  const sp = fakeSpawn();
  const n = createNotifier({ notify: false, find: () => null, spawnFn: sp.fn, platform: 'linux', env: {} });
  assert.equal(n.setNotify(true), false);
  n.fire([sess('a', 'waiting')]);
  assert.equal(sp.calls.length, 0);
});

test('켜기 힌트: 직접 끄지 않았고 꺼져 있을 때, 실행 중 응답 대기 세션이 처음 보이면 한 번만', () => {
  const st = createNotifyToggle({ on: false, explicitOff: false });
  assert.equal(notifyHintDue(st, [sess('a', 'idle')]), false);
  assert.equal(notifyHintDue(st, [sess('a', 'waiting', { live: false })]), false, '끝난 세션은 세지 않는다');
  assert.equal(notifyHintDue(st, [sess('a', 'waiting', { auto: true })]), false, '자동 실행 세션은 세지 않는다');
  assert.equal(notifyHintDue(st, [sess('a', 'waiting')]), true);
  assert.equal(notifyHintDue(st, [sess('b', 'waiting')]), false, '실행당 한 번');
  // 직접 끈 경우, 켜져 있는 경우, a 를 이미 눌러 본 경우는 띄우지 않는다.
  assert.equal(notifyHintDue(createNotifyToggle({ on: false, explicitOff: true }), [sess('a', 'waiting')]), false);
  assert.equal(notifyHintDue(createNotifyToggle({ on: true }), [sess('a', 'waiting')]), false);
  const pressed = createNotifyToggle();
  toggleNotify(pressed);
  toggleNotify(pressed);
  assert.equal(pressed.on, false);
  assert.equal(notifyHintDue(pressed, [sess('a', 'waiting')]), false);
});

test('직접 껐는지: 설정 파일 false·--no-notify 는 직접 끈 것, 기본값은 아니다', () => {
  const file = (values) => ({ path: '/x/config.json', exists: true, values, problems: [] });
  const off = (flags, values) => {
    const cfg = resolveConfig({ flags, env: {}, file: file(values) });
    return notifyExplicitOff(cfg.values.notify, Boolean(cfg.values.notify.value));
  };
  assert.equal(off({}, {}), false, '기본값으로 꺼짐');
  assert.equal(off({}, { notify: false }), true, '설정 파일로 끔');
  assert.equal(off({ notify: false }, { notify: true }), true, '--no-notify 로 끔');
  assert.equal(off({}, { notify: true }), false, '켜져 있음');
});

test('키 줄에 알림 상태를 글자로 보이고, 힌트·켜기 결과도 키 줄에 보인다', () => {
  const data = { sessions: [sess('a', 'waiting')] };
  const base = { data, showDetail: false, filter: '', pins: [] };
  const offLine = strip(footer({ ...base, notify: false }, 160, 1, data.sessions[0]));
  assert.ok(offLine.includes(t('foot.notify', { v: t('set.off') })), offLine);
  assert.ok(strip(footer({ ...base, notify: true }, 160, 1, data.sessions[0])).includes(t('foot.notify', { v: t('set.on') })));
  // --once 출력처럼 view.notify 가 없으면 보이지 않는다.
  assert.ok(!strip(footer(base, 160, 1, data.sessions[0])).includes(t('foot.notify', { v: t('set.off') })));
  const hint = strip(footer({ ...base, notify: false, toast: { key: 'foot.notifyHint', until: Date.now() + 5000 } }, 160, 1, data.sessions[0]));
  assert.ok(hint.includes(t('foot.notifyHint')), hint);
  assert.match(t('foot.notifyHint'), /\ba$/);
});

test('도움말(?)과 --help 키 안내에 a 알림이 있다 (ko·en)', () => {
  assert.ok(VIEWS.table.keys.some((e) => e[0] === 'a'));
  assert.match(keysText('ko'), /a 알림/);
  assert.match(keysText('en'), /a alerts/);
  assert.ok(t('hk.table.notify', null, { lang: 'en' }) !== 'hk.table.notify');
});

test('켜기 힌트: 도움말·검색 중이라 키 줄에 그릴 수 없으면 소비하지 않고, 닫힌 뒤 띄운다', () => {
  const st = createNotifyToggle();
  const waiting = [sess('a', 'waiting')];
  assert.equal(notifyHintDue(st, waiting, { visible: false }), false);
  assert.equal(st.hinted, false, '보이지 않을 때는 실행당 한 번을 쓰지 않는다');
  assert.equal(notifyHintDue(st, waiting, { visible: true }), true);
  assert.equal(notifyHintDue(st, waiting, { visible: true }), false);
});

test('--notify 로 켰어도 알림 도구가 없으면 시작 상태는 꺼짐이고 켜기 힌트도 띄우지 않는다', () => {
  const st = createNotifyToggle({ on: true, explicitOff: false, available: false });
  assert.equal(st.on, false);
  assert.equal(notifyHintDue(st, [sess('a', 'waiting')]), false);
  assert.equal(createNotifyToggle({ on: true, available: true }).on, true);
});

test('a 키 처리(applyNotifyToggle): 켜기·끄기 문구가 상태와 맞고, 도구가 없으면 꺼짐으로 되돌린다', () => {
  const sp = fakeSpawn();
  const st = createNotifyToggle();
  const n = createNotifier({ notify: false, find: () => ({ kind: 'notify-send', path: '/fake/notify-send' }), spawnFn: sp.fn, platform: 'linux', env: {} });
  assert.equal(applyNotifyToggle(st, n), 'foot.notifyOn');
  assert.equal(st.on, true);
  assert.equal(applyNotifyToggle(st, n), 'foot.notifyOff');
  assert.equal(st.on, false);

  const none = createNotifyToggle({ on: true, available: false });
  const nn = createNotifier({ notify: true, find: () => null, spawnFn: sp.fn, platform: 'linux', env: {} });
  assert.equal(nn.desk, null);
  assert.equal(applyNotifyToggle(none, nn), 'foot.notifyNone');
  assert.equal(none.on, false, '도구가 없으면 켜짐으로 남지 않는다');
  nn.fire([sess('a', 'waiting')]);
  assert.equal(sp.calls.length, 0);
});
