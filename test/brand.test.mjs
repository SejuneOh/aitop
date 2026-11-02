import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconMode, brand, userVarsSeq } from '../src/brand.mjs';
import { windowTitle } from '../src/attention.mjs';
import { width } from '../src/text.mjs';
import { render } from '../src/ui.mjs';

const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'aitop.mjs');

test('AITOP_ICONS 로 모드를 고르고, 없거나 모르는 값이면 기본(full)', () => {
  assert.equal(iconMode({}), 'full');
  assert.equal(iconMode({ AITOP_ICONS: 'plain' }), 'plain');
  assert.equal(iconMode({ AITOP_ICONS: 'ascii' }), 'ascii');
  assert.equal(iconMode({ AITOP_ICONS: 'nerd' }), 'full');
});

test('모드별 로고, 탭 아이콘, user var', () => {
  assert.deepEqual([brand('full').logo, brand('full').tab, brand('full').userVars], ['⣠⣴⣾', '\u{F06A9}', true]);
  assert.deepEqual([brand('plain').logo, brand('plain').tab, brand('plain').userVars], ['⣠⣴⣾', '⣾', false]);
  assert.deepEqual([brand('ascii').logo, brand('ascii').tab, brand('ascii').userVars], ['>_ai', '', false]);
});

test('로고 폭은 정해져 있다 (헤더 칩이 밀리지 않게)', () => {
  assert.equal(width(brand('full').logo), 3);
  assert.equal(width(brand('ascii').logo), 4);
});

test('창 제목은 아이콘을 맨 앞에 둔다', () => {
  const s = [{ id: 'a', live: true, status: 'waiting' }, { id: 'b', live: true, status: 'idle', unseen: true }];
  assert.equal(windowTitle(s, '\u{F06A9}'), '\u{F06A9} (1◆ 1●) aitop');
  assert.equal(windowTitle([], '⣾'), '⣾ aitop');
  assert.equal(windowTitle(s), '(1◆ 1●) aitop');
});

test('WezTerm user var 는 base64 값으로 내보내고, null 이면 지운다', () => {
  assert.equal(userVarsSeq({ waiting: 2, unseen: 0 }), '\x1b]1337;SetUserVar=aitop=MQ==\x07\x1b]1337;SetUserVar=aitop_waiting=Mg==\x07\x1b]1337;SetUserVar=aitop_unseen=MA==\x07');
  assert.equal(userVarsSeq(null), '\x1b]1337;SetUserVar=aitop=\x07\x1b]1337;SetUserVar=aitop_waiting=\x07\x1b]1337;SetUserVar=aitop_unseen=\x07');
});

test('헤더 칩은 로고만, 시작 화면에도 로고가 보인다', () => {
  const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
  const at = Date.now();
  assert.match(strip(render({ data: { sessions: [], usage: null, errors: [], at }, showDetail: true, frame: 0 }, 100, 10)[0]), /^ ⣠⣴⣾  +\d+ live/);
  assert.match(render({ data: null, frame: 0 }, 60, 5).map(strip).join('\n'), /⣠⣴⣾  세션 기록을 읽는 중/);
});

test('AITOP_ICONS=ascii 면 도움말은 >_ai aitop, 헤더 칩은 >_ai', () => {
  const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { env: { ...process.env, AITOP_ICONS: 'ascii', NO_COLOR: '1' }, encoding: 'utf8' });
  assert.match(run('--help').stdout, /^>_ai aitop - /);
  assert.match(run('--once').stdout, /^ >_ai  +\d+ live/);
});
