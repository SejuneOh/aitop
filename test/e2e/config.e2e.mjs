// 설정 파일($XDG_CONFIG_HOME/aitop/config.json)을 실제 bin/aitop.mjs 로 읽어 --print-config, --doctor, 테마·아이콘에 반영되는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN, makeSession } from './session.mjs';
import { assistant, user, usage } from '../fixture.mjs';

const fx = makeSession();

function configHome(body, mode = 0o600) {
  const xdg = mkdtempSync(join(tmpdir(), 'aitop-xdg-'));
  mkdirSync(join(xdg, 'aitop'));
  const path = join(xdg, 'aitop', 'config.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  chmodSync(path, mode);
  return { xdg, path };
}
const env = (xdg, extra = {}) => {
  const e = { ...process.env, XDG_CONFIG_HOME: xdg, ...extra };
  for (const k of ['AITOP_THEME', 'AITOP_ICONS', 'AITOP_SHOW_REQUESTS', 'COLORFGBG']) if (!(k in extra)) delete e[k];
  return e;
};
const run = (xdg, args, extra) => execFileSync(process.execPath, [BIN, ...args], { env: env(xdg, extra), encoding: 'utf8', timeout: 20_000 });

test('--print-config 는 키마다 값과 출처, 파일 위치를 보인다', () => {
  const { xdg, path } = configHome({ theme: 'light', icons: 'ascii', bell: true, all: true, budgetDay: 5, nope: 1 });
  const out = run(xdg, ['--print-config', '--all', '--theme', 'dark'], { AITOP_ICONS: 'plain' });
  assert.match(out, new RegExp(`^설정 파일: ${path.replace(/[.]/g, '\\.')} \\(있음\\)`));
  assert.match(out, /^theme +"dark" +flag$/m);
  assert.match(out, /^icons +"plain" +env$/m);
  assert.match(out, /^bell +true +file$/m);
  assert.match(out, /^all +true +flag$/m);
  assert.match(out, /^showRequests +false +default$/m);
  assert.match(out, /^budgetDay +5 +file$/m);
  assert.match(out, /모르는 키 "nope"/);

  const json = JSON.parse(run(xdg, ['--print-config', '--json']));
  assert.equal(json.path, path);
  assert.equal(json.exists, true);
  assert.deepEqual(json.values.theme, { value: 'light', source: 'file' });
  assert.deepEqual(json.values.icons, { value: 'ascii', source: 'file' });
});

test('--no-bell · --no-all · --no-show-requests 는 파일과 환경 변수에서 켠 값을 끈다', () => {
  const { xdg } = configHome({ bell: true, all: true, showRequests: true, notify: true });
  const out = run(xdg, ['--print-config', '--no-bell', '--no-all', '--no-show-requests', '--no-notify'], { AITOP_SHOW_REQUESTS: '1' });
  for (const k of ['bell', 'all', 'showRequests', 'notify']) assert.match(out, new RegExp(`^${k} +false +flag$`, 'm'));
  // 같은 옵션을 켜고 끄면 뒤에 준 쪽을 따른다.
  assert.match(run(xdg, ['--print-config', '--no-bell', '--bell']), /^bell +true +flag$/m);
});

test('설정 파일이 없어도 --print-config 는 위치와 기본값을 보인다', () => {
  const xdg = mkdtempSync(join(tmpdir(), 'aitop-xdg-'));
  const out = run(xdg, ['--print-config']);
  assert.match(out, /^설정 파일: .*\/aitop\/config\.json \(없음\)/);
  assert.match(out, /^theme +auto +default$/m);
});

test('파일의 theme·icons 가 화면 모듈을 불러오기 전에 반영된다', () => {
  const light = configHome({ theme: 'light', icons: 'ascii' }).xdg;
  const dark = configHome({ theme: 'dark' }).xdg;
  // 밝은 테마의 brand 색 #0862cb, 어두운 테마의 brand 색 #7dd3fc
  const lightOut = run(light, ['--once'], { FORCE_COLOR: '1' });
  assert.match(lightOut, /8;98;203/);
  assert.doesNotMatch(lightOut, /125;211;252/);
  assert.match(run(dark, ['--once'], { FORCE_COLOR: '1' }), /125;211;252/);
  // 환경 변수가 파일보다 앞선다.
  assert.match(run(light, ['--once'], { FORCE_COLOR: '1', AITOP_THEME: 'dark' }), /125;211;252/);
  assert.match(run(light, ['--help']), /^>_ai aitop/);
});

test('잘못된 설정은 무시하고 --doctor 에 알린다 (JSON 도)', () => {
  const bad = configHome('{ "theme": ').xdg;
  assert.match(run(bad, ['--once']), /e2e 세션/, '잘못된 JSON 이어도 실행된다');
  assert.match(run(bad, ['--doctor']), /설정 .*config\.json[\s\S]*! 설정 파일이 올바른 JSON 이 아니라/);

  const shared = configHome({ onWaiting: 'echo hi', showRequests: 'yes' }, 0o666).xdg;
  const doc = JSON.parse(run(shared, ['--doctor', '--json']));
  assert.equal(doc.config.exists, true);
  assert.equal(doc.config.values.onWaiting.source, 'default');
  assert.ok(doc.config.problems.some((p) => /onWaiting 은 무시합니다: 그룹·다른 사용자가 쓸 수 있음 \(mode 666\)/.test(p)));
  assert.ok(doc.config.problems.some((p) => /showRequests 값 "yes"/.test(p)));
});

test('파일의 showRequests 가 --json 에 반영된다', () => {
  const id = 'e2ecfg00-1';
  fx.session({ sessionId: id, pid: process.pid, name: '대기 세션', status: 'waiting', waitingFor: 'approve Bash', cwd: '/work/demo' });
  fx.transcript(id, [user('배포해줘'), assistant('w1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { description: 'Deploy', command: 'make deploy' } }], usage(10, 5))]);
  const on = JSON.parse(run(configHome({ showRequests: true }).xdg, ['--json']));
  assert.equal(on.sessions.find((s) => s.id === id).waitDetail, 'make deploy');
  const off = JSON.parse(run(configHome({}).xdg, ['--json']));
  assert.ok(!('waitDetail' in off.sessions.find((s) => s.id === id)));
});

test('하루 예산: --budget-day > AITOP_BUDGET_DAY > 파일, --json 의 usage.budget, 잘못된 값은 오류', () => {
  const { xdg } = configHome({ budgetDay: 50 });
  assert.match(run(xdg, ['--print-config']), /^budgetDay +50 +file$/m);
  assert.match(run(xdg, ['--print-config'], { AITOP_BUDGET_DAY: '30' }), /^budgetDay +30 +env$/m);
  assert.match(run(xdg, ['--print-config', '--budget-day', '20'], { AITOP_BUDGET_DAY: '30' }), /^budgetDay +20 +flag$/m);
  assert.match(run(xdg, ['--print-config', '--budget-day=7.5']), /^budgetDay +7\.5 +flag$/m);
  assert.match(run(xdg, ['--print-config', '--no-budget-day']), /^budgetDay +- +flag$/m);

  fx.transcript('e2ecfg00-2', [user('예산'), assistant('b1', [], usage(1000, 10))]);
  const on = JSON.parse(run(xdg, ['--json']));
  assert.equal(on.usage.budget.day, 50);
  assert.ok(on.usage.budget.projected >= on.usage.today.cost - 1e-4);
  assert.ok(['ok', 'caution', 'warn'].includes(on.usage.budget.level));
  assert.equal(typeof on.usage.budget.unknown, 'boolean');
  assert.ok(!('budget' in JSON.parse(run(xdg, ['--json', '--no-budget-day'])).usage));

  const bad = spawnSync(process.execPath, [BIN, '--budget-day', 'abc'], { env: env(xdg), encoding: 'utf8', timeout: 20_000 });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--budget-day 값 "abc"/);
  const neg = spawnSync(process.execPath, [BIN, '--budget-day', '-5'], { env: env(xdg), encoding: 'utf8', timeout: 20_000 });
  assert.equal(neg.status, 2);
  assert.match(neg.stderr, /--budget-day 값 "-5" 이 잘못되었습니다/);
  const doc = JSON.parse(run(xdg, ['--doctor', '--json'], { AITOP_BUDGET_DAY: 'abc' }));
  assert.ok(doc.config.problems.some((p) => /AITOP_BUDGET_DAY 값 "abc"/.test(p)));
  assert.equal(doc.config.values.budgetDay.source, 'file');
});

// 실시간 화면(가상 터미널)에서 설정 파일의 notify·onWaiting 이 알림으로 이어지는지 본다.
// notify-send 는 PATH 앞에 둔 가짜로 바꿔 호출 여부를 파일에 남긴다.
const hasScript = spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout?.includes('util-linux');

async function liveAlerts(body, { mode = 0o600, args = [] } = {}) {
  const fx = makeSession();
  const dir = mkdtempSync(join(tmpdir(), 'aitop-cfg-alert-'));
  const notifyLog = join(dir, 'notify.log');
  const hookLog = join(dir, 'hook.log');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'notify-send'), `#!/bin/sh\necho called >> '${notifyLog}'\n`, { mode: 0o755 });
  const { xdg } = configHome(typeof body === 'function' ? body(hookLog) : body, mode);
  const other = spawn('sleep', ['60'], { stdio: 'ignore' });
  const wait = (id, name, pid) => {
    fx.session({ sessionId: id, pid, name, status: 'waiting', waitingFor: 'approve Bash', cwd: '/work/demo' });
    fx.transcript(id, [user('해줘'), assistant(id, [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }], usage(10, 5))]);
  };
  wait('e2ecfgold-1', '처음부터 대기', process.pid);
  const cmd = `stty cols 140 rows 45; exec "$AITOP_NODE" "$AITOP_BIN" ${args.join(' ')}`;
  const child = spawn('script', ['-qfec', cmd, '/dev/null'], { cwd: dir, env: { ...env(xdg), PATH: `${join(dir, 'bin')}:${process.env.PATH}`, AITOP_NODE: process.execPath, AITOP_BIN: BIN } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  try {
    const end = Date.now() + 8_000;
    while (!out.includes('처음부터 대기') && Date.now() < end) await sleep(50);
    await sleep(1_500);
    wait('e2ecfgnew-1', '새 대기', other.pid);
    const until = Date.now() + 5_000;
    while (!existsSync(notifyLog) && !existsSync(hookLog) && Date.now() < until) await sleep(100);
    await sleep(1_500);
    return { notified: existsSync(notifyLog), hooked: existsSync(hookLog) };
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    other.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

const skip = !hasScript && 'util-linux script 없음';
const hook = (log) => `echo hit >> '${log}'`;

test('설정 파일의 notify·onWaiting 이 실시간 화면의 알림을 켠다', { skip, timeout: 60_000 }, async () => {
  assert.deepEqual(await liveAlerts((log) => ({ notify: true, onWaiting: hook(log) })), { notified: true, hooked: true });
});

test('그룹·다른 사용자가 쓸 수 있는 파일의 onWaiting 은 실행하지 않는다', { skip, timeout: 60_000 }, async () => {
  assert.deepEqual(await liveAlerts((log) => ({ notify: true, onWaiting: hook(log) }), { mode: 0o666 }), { notified: true, hooked: false });
});

test('--no-notify 는 설정 파일의 notify 를 끈다', { skip, timeout: 60_000 }, async () => {
  // onWaiting 이 실행된 것으로 새 대기를 알아챘음을 확인하고, 그때 데스크톱 알림은 없어야 한다.
  assert.deepEqual(await liveAlerts((log) => ({ notify: true, onWaiting: hook(log) }), { args: ['--no-notify'] }), { notified: false, hooked: true });
});

test('--no-on-waiting 은 설정 파일의 onWaiting 을 끈다', { skip, timeout: 60_000 }, async () => {
  // 데스크톱 알림이 온 것으로 새 대기를 알아챘음을 확인하고, 그때 명령은 실행되지 않아야 한다.
  assert.deepEqual(await liveAlerts((log) => ({ notify: true, onWaiting: hook(log) }), { args: ['--no-on-waiting'] }), { notified: true, hooked: false });
});

test('--print-config 는 notify·onWaiting 의 출처를 보인다', () => {
  const { xdg } = configHome({ notify: true, onWaiting: 'say hi' });
  const out = run(xdg, ['--print-config']);
  assert.match(out, /^notify +true +file$/m);
  assert.match(out, /^onWaiting +"say hi" +file$/m);
  const cli = run(xdg, ['--print-config', '--no-notify', '--on-waiting', 'echo cli']);
  assert.match(cli, /^notify +false +flag$/m);
  assert.match(cli, /^onWaiting +"echo cli" +flag$/m);
  assert.match(run(xdg, ['--print-config', '--no-on-waiting']), /^onWaiting +- +flag$/m);
});
