// Windows 데스크톱 알림 (#197). 가짜 exists·spawn 과 platform 주입으로 어느 OS 에서나 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { findNotifier, windowsPowerShell, createNotifier, notifierCommand, toastScript, encodePowerShell } from '../src/notify.mjs';
import { notifierText } from '../src/doctor.mjs';

const SYS_PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('win32: SystemRoot 아래 Windows PowerShell 을 먼저, 없으면 PATH(;)에서 찾는다', () => {
  const have = (...paths) => (p) => paths.includes(p);
  const env = { SystemRoot: 'C:\\Windows', PATH: 'D:\\bin;E:\\ps' };
  assert.deepEqual(findNotifier({ platform: 'win32', env, exists: have(SYS_PS, 'E:\\ps\\powershell.exe') }), { kind: 'powershell', path: SYS_PS });
  assert.deepEqual(findNotifier({ platform: 'win32', env, exists: have('E:\\ps\\powershell.exe') }), { kind: 'powershell', path: 'E:\\ps\\powershell.exe' });
  assert.equal(findNotifier({ platform: 'win32', env, exists: have() }), null);
  // 대소문자가 다른 환경 변수 이름(windir, Path)도 본다.
  assert.equal(windowsPowerShell({ windir: 'C:\\Windows' }, have(SYS_PS)), SYS_PS);
  assert.equal(windowsPowerShell({ Path: 'F:\\x' }, have('F:\\x\\powershell.exe')), 'F:\\x\\powershell.exe');
});

test('win32: --notify 는 powershell 토스트를 창 없이 띄우고, 제목·본문은 인코딩된 스크립트로만 넘긴다', () => {
  const calls = [];
  const spawnFn = (file, args, opts) => {
    const c = new EventEmitter();
    c.pid = 1;
    c.kill = () => {};
    calls.push({ file, args, opts });
    return c;
  };
  const n = createNotifier({ notify: true, platform: 'win32', notifier: { kind: 'powershell', path: SYS_PS }, env: {}, spawnFn });
  const s = { tool: 'claude', project: 'it\'s "x" $(calc) & <b>', id: 's1', phase: null };
  n.fire([s], 'waiting');
  assert.equal(calls.length, 1);
  const { file, args, opts } = calls[0];
  assert.equal(file, SYS_PS);
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert.match(args[5], /^[A-Za-z0-9+/=]+$/);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.detached, undefined);
  const script = Buffer.from(args[5], 'base64').toString('utf16le');
  assert.ok(!script.includes('calc'), '세션 값은 base64 로만 들어간다');
  assert.equal(script, toastScript(...[...script.matchAll(/& \$d '([A-Za-z0-9+/=]*)'/g)].slice(0, 2).map((m) => Buffer.from(m[1], 'base64').toString('utf8'))));
  assert.equal(encodePowerShell(script), args[5]);
  n.killAll();
});

test('--doctor: Windows 는 powershell 알림을 보이고, 없으면 powershell.exe 없음으로 안내한다', () => {
  assert.match(notifierText({ kind: 'powershell', path: SYS_PS }, 'win32', 'ko', false), /^✓ 알림 {4}powershell \(/);
  assert.match(notifierText(null, 'win32', 'ko', false), /^○ 알림 {4}powershell\.exe 없음/);
  assert.match(notifierText(null, 'win32', 'en', false), /^○ notify {2}powershell\.exe not found/);
  assert.doesNotMatch(notifierText(null, 'win32', 'ko', false), /notify-send/);
});

// 실제 토스트는 화면에 뜨므로 AITOP_TOAST_TEST=1 일 때만 (Windows 만). 끝난 상태와 오류 출력을 본다.
test('Windows 실제 실행: powershell 토스트가 오류 없이 끝난다', { skip: (process.platform !== 'win32' || process.env.AITOP_TOAST_TEST !== '1') && 'Windows 에서 AITOP_TOAST_TEST=1 일 때만' }, () => {
  const notifier = findNotifier();
  assert.equal(notifier?.kind, 'powershell');
  const [file, args] = notifierCommand(notifier, 'aitop 알림 확인', 'demo "따옴표" & <b> $(x)');
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim(), '');
});
