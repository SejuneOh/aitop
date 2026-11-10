import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MAX_BYTES, configPath, configText, readConfigFile, resolveConfig } from '../src/config.mjs';

// 설정 파일 하나를 임시 폴더에 쓰고 경로를 돌려준다. mode 를 주면 권한도 바꾼다.
function write(body, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'aitop-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  chmodSync(path, mode);
  return path;
}
const resolve = (body, { flags, env = {}, mode, uid } = {}) => resolveConfig({ flags, env, file: readConfigFile(write(body, mode), { uid }) });
const pick = (cfg) => Object.fromEntries(Object.entries(cfg.values).map(([k, v]) => [k, `${v.value}@${v.source}`]));

test('파일 위치: XDG_CONFIG_HOME, 없거나 상대 경로면 ~/.config', () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/u'), '/x/cfg/aitop/config.json');
  assert.equal(configPath({}, '/home/u'), '/home/u/.config/aitop/config.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: 'rel' }, '/home/u'), '/home/u/.config/aitop/config.json');
});

test('파일이 없으면 기본값을 쓰고 문제로 보지 않는다', () => {
  const cfg = resolveConfig({ env: {}, file: readConfigFile('/nonexistent/aitop/config.json') });
  assert.equal(cfg.exists, false);
  assert.deepEqual(cfg.problems, []);
  assert.deepEqual(pick(cfg), { theme: 'null@default', icons: 'full@default', bell: 'false@default', showRequests: 'false@default', all: 'false@default', notify: 'false@default', onWaiting: 'null@default', debug: 'false@default', budgetDay: 'null@default', colorBlind: 'false@default', ambiguous: 'narrow@default' });
});

test('옵션 > 환경 변수 > 파일 > 기본값', () => {
  const body = { theme: 'light', icons: 'ascii', bell: true, showRequests: true, all: true };
  const cfg = resolve(body, { flags: { theme: 'dark', all: true }, env: { AITOP_ICONS: 'plain', AITOP_SHOW_REQUESTS: '0' } });
  const v = pick(cfg);
  assert.equal(v.theme, 'dark@flag');
  assert.equal(v.icons, 'plain@env');
  assert.equal(v.showRequests, 'false@env');
  assert.equal(v.all, 'true@flag');
  assert.equal(v.bell, 'true@file');
  // 잘못된 환경 변수 값은 없는 것으로 보고 파일 값을 쓴다.
  assert.equal(pick(resolve(body, { env: { AITOP_THEME: 'blue' } })).theme, 'light@file');
  assert.equal(pick(resolve(body, { env: { AITOP_THEME: 'dark' } })).theme, 'dark@env');
});

test('잘못된 JSON 은 파일 전체를 무시하고 알린다', () => {
  const cfg = resolve('{ "theme": "light", ');
  assert.equal(cfg.exists, true);
  assert.equal(cfg.values.theme.source, 'default');
  assert.match(cfg.problems[0], /JSON/);
  assert.match(resolve('[1, 2]').problems[0], /JSON 객체/);
});

test('모르는 키와 잘못된 값은 그 키만 무시한다', () => {
  const cfg = resolve({ theme: 'blue', icons: 'full', bell: 'yes', all: true, budgetDay: 0, notify: 1, onWaiting: '', colour: 'x' });
  assert.equal(cfg.values.all.value, true);
  assert.equal(cfg.values.all.source, 'file');
  for (const k of ['theme', 'icons', 'bell', 'budgetDay', 'notify', 'onWaiting']) assert.equal(cfg.values[k].source, 'default', k);
  assert.equal(cfg.problems.length, 7);
  assert.ok(cfg.problems.some((p) => /모르는 키 "colour"/.test(p)));
  assert.ok(cfg.problems.some((p) => /theme 값 "blue"/.test(p)));
  const ok = resolve({ budgetDay: 12.5, notify: true, onWaiting: 'notify-send aitop' });
  assert.deepEqual([ok.values.budgetDay.value, ok.values.notify.value, ok.values.onWaiting.value], [12.5, true, 'notify-send aitop']);
  assert.deepEqual(ok.problems, []);
});

test('onWaiting 은 내 파일이고 그룹·다른 사용자가 쓸 수 없을 때만 받는다', () => {
  const body = { onWaiting: 'say hi', bell: true };
  const mine = process.getuid();
  assert.equal(resolve(body, { mode: 0o600, uid: mine }).values.onWaiting.value, 'say hi');
  assert.equal(resolve(body, { mode: 0o644, uid: mine }).values.onWaiting.value, 'say hi');
  for (const [mode, uid, re] of [
    [0o664, mine, /그룹·다른 사용자가 쓸 수 있음 \(mode 664\)/],
    [0o602, mine, /mode 602/],
    [0o600, mine + 1, /소유자가 현재 사용자가 아님/],
  ]) {
    const cfg = resolve(body, { mode, uid });
    assert.equal(cfg.values.onWaiting.source, 'default');
    assert.equal(cfg.values.bell.value, true, '다른 키는 그대로 쓴다');
    assert.match(cfg.problems.join('\n'), re);
  }
});

test('configText 는 키마다 값과 출처, 파일 위치를 보인다', () => {
  const cfg = resolve({ theme: 'light', foo: 1 }, { flags: { bell: true } });
  const text = configText(cfg);
  assert.match(text, /^설정 파일: .*config\.json \(있음\)/);
  assert.match(text, /^theme +"light" +file$/m);
  assert.match(text, /^bell +true +flag$/m);
  assert.match(text, /^icons +"full" +default$/m);
  assert.match(text, /^! 모르는 키 "foo"/m);
});

test('FIFO·큰 파일은 열지 않고, JSON 오류 문구에서 제어문자를 지운다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitop-config-'));
  const fifo = join(dir, 'config.json');
  execFileSync('mkfifo', [fifo]);
  const f = readConfigFile(fifo);
  assert.equal(f.exists, true);
  assert.match(f.problems[0], /일반 파일이 아니라/);

  const big = resolve(`{"theme":"light","pad":"${'x'.repeat(MAX_BYTES)}"}`);
  assert.equal(big.values.theme.source, 'default');
  assert.match(big.problems[0], /64KB 를 넘어/);

  const esc = resolve('\x1b]0;pwned\x07\x1b[2J{');
  assert.match(esc.problems[0], /JSON/);
  assert.doesNotMatch(esc.problems[0], /[\x00-\x1f]/);
  assert.doesNotMatch(configText(esc), /\x1b/);
});
