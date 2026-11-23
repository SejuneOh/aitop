// --remote (#308) e2e: 실제 ssh·wsl.exe 대신 AITOP_REMOTE_FAKE 로 가짜 원격(remote-fake.mjs)을 node 로 부른다.
// 정상·시간 초과·깨진 JSON·exit 127·exit 2·schema 없음·더 큰 schema 를 흉내 내고, --json·--once·--doctor·잘못된 값·설정 파일·실시간 화면 종료를 본다.
// 셸을 거치지 않으므로 Windows 에서도 돈다 (실시간 화면 확인만 util-linux script 가 있을 때).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN, makeSession } from './session.mjs';

const FAKE = fileURLToPath(new URL('./remote-fake.mjs', import.meta.url));
const fx = makeSession();
const tmp = mkdtempSync(join(tmpdir(), 'aitop-remote-e2e-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const mark = () => join(tmp, `mark-${++n}`);
function run(args, extra = {}) {
  const env = { ...process.env, AITOP_REMOTE_FAKE: FAKE, AITOP_REMOTE_TIMEOUT_MS: '1500', ...extra };
  for (const k of ['NO_COLOR', 'FORCE_COLOR']) if (!(k in extra)) delete env[k];
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 << 20 });
}

test('--json --remote: 원격 세션을 host 와 함께 넣고, 원격마다 결과와 오류 코드를 낸다', () => {
  const t0 = Date.now();
  const r = run(['--json', '--remote', 'dev,wsl:Ubuntu-22.04,slow,broken,missing,old,noschema,newer']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 15_000, '시간 초과 원격을 기다리는 시간은 제한된다');
  const j = JSON.parse(r.stdout);
  assert.equal(j.schema, 1);
  assert.deepEqual(j.remotes.map((x) => [x.name, x.kind, x.ok, x.error]), [
    ['dev', 'ssh', true, null],
    ['wsl:Ubuntu-22.04', 'wsl', true, null],
    ['slow', 'ssh', false, 'timeout'],
    ['broken', 'ssh', false, 'bad'],
    ['missing', 'ssh', false, 'notFound'],
    ['old', 'ssh', false, 'old'],
    ['noschema', 'ssh', false, 'old'],
    ['newer', 'ssh', false, 'newer'],
  ]);
  assert.equal(j.remotes[0].version, '0.41.0');
  assert.match(j.remotes[0].at, /^\d{4}-/);
  const local = j.sessions.filter((s) => s.host == null);
  assert.ok(local.length >= 1, '로컬 세션도 그대로');
  const dev = j.sessions.filter((s) => s.host === 'dev');
  assert.equal(dev.length, 2);
  // 가짜 원격은 받은 인자를 세션 이름에 남긴다: ssh 대상 뒤에 aitop --json --no-remote.
  assert.ok(dev.some((s) => s.name === 'args ssh dev aitop --json --no-remote'), JSON.stringify(dev.map((s) => s.name)));
  assert.ok(j.sessions.some((s) => s.name === 'args wsl Ubuntu-22.04 aitop --json --no-remote'));
  const w = dev.find((s) => s.phaseKind === 'waiting');
  assert.equal(w.name, 'waiting red', 'escape 열은 지운다');
  assert.equal(w.id, 'dev:22222222-2222-4222-8222-222222222222');
  assert.equal(w.remoteId, '22222222-2222-4222-8222-222222222222');
  assert.equal(w.phase, '응답 대기 · Bash');
  // 원격이 준 resumeCmd·pid·waitDetail 은 쓰지 않는다.
  // 로컬 셸 따옴표는 OS 를 따른다 (Windows 는 PowerShell).
  assert.match(w.resumeCmd, process.platform === 'win32' ? /^ssh '-t' dev '/ : /^ssh -t dev '/);
  assert.doesNotMatch(w.resumeCmd, /rm -rf/);
  assert.equal(w.pid, null);
  assert.ok(!('waitDetail' in w));
  // 원격 사용량은 헤더 합계(usage)에 더하지 않는다.
  assert.ok(!j.usage || j.usage.today.cost < 999);
});

test('--once --remote: 로컬 아래에 호스트 구분 줄과 실패 줄', () => {
  const r = run(['--once', '--remote', 'dev,slow,missing'], { COLUMNS: '120', LINES: '40' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const idx = (re) => lines.findIndex((l) => re.test(l));
  assert.ok(idx(/e2e 세션/) >= 0 && idx(/e2e 세션/) < idx(/── dev · 2 세션 · \d+초 전 ─/), r.stdout);
  assert.ok(idx(/── slow · 연결 안 됨 \(시간 초과\) ─/) > 0, r.stdout);
  assert.ok(idx(/── missing · 연결 안 됨 \(원격에 aitop 없음\) ─/) > 0, r.stdout);
});

test('잘못된 --remote 값은 아무것도 부르지 않고 exit 2', () => {
  for (const bad of ['--remote=-oProxyCommand=x', '--remote=a;b', '--remote=host:22', '--remote=a b']) {
    const m = mark();
    const r = run(['--once', bad], { AITOP_REMOTE_FAKE_MARK: m });
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /^aitop: --remote 값 .* 잘못되었습니다/, bad);
    assert.ok(!existsSync(m), `${bad} 로 원격을 부르지 않는다`);
  }
  const r = run(['--remot', 'dev']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--remote/, '비슷한 옵션을 제안한다');
});

test('설정 파일 remotes 를 쓰고, --no-remote 는 그것도 끈다. --doctor 는 목록만 보이고 접속하지 않는다', () => {
  const cfgHome = join(tmp, 'cfg');
  mkdirSync(join(cfgHome, 'aitop'), { recursive: true });
  writeFileSync(join(cfgHome, 'aitop', 'config.json'), JSON.stringify({ remotes: ['dev', 'wsl:Ubuntu'] }));
  const env = { XDG_CONFIG_HOME: cfgHome };
  assert.deepEqual(JSON.parse(run(['--json'], env).stdout).remotes.map((x) => x.name), ['dev', 'wsl:Ubuntu']);
  assert.deepEqual(JSON.parse(run(['--json', '--remote', 'missing'], env).stdout).remotes.map((x) => x.name), ['missing']);
  const m = mark();
  const off = JSON.parse(run(['--json', '--no-remote'], { ...env, AITOP_REMOTE_FAKE_MARK: m }).stdout);
  assert.deepEqual(off.remotes, []);
  assert.ok(off.sessions.every((s) => s.host == null));
  assert.ok(!existsSync(m));
  const doc = run(['--doctor'], { ...env, AITOP_REMOTE_FAKE_MARK: m });
  assert.equal(doc.status, 0, doc.stderr);
  assert.match(doc.stdout, /원격 +dev, wsl:Ubuntu \(점검에서는 접속하지 않는다\)/);
  assert.ok(!existsSync(m), '--doctor 는 원격을 부르지 않는다');
});

test('원격을 켜지 않으면 --json 의 remotes 는 비어 있고 세션 host 는 null', () => {
  const j = JSON.parse(run(['--json']).stdout);
  assert.deepEqual(j.remotes, []);
  assert.ok(j.sessions.every((s) => s.host === null));
});

const hasScript = spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout?.includes('util-linux');

test('실시간 화면: 원격 구분 줄이 보이고, q 로 끝내면 돌고 있던 원격 자식을 죽인다', { skip: !hasScript && 'util-linux script 없음', timeout: 60_000 }, async () => {
  const m = mark();
  const cmd = 'stty cols 120 rows 40; exec "$AITOP_NODE" "$AITOP_BIN" --remote dev,slow';
  const child = spawn('script', ['-qfec', cmd, '/dev/null'], { env: { ...process.env, AITOP_NODE: process.execPath, AITOP_BIN: BIN, AITOP_REMOTE_FAKE: FAKE, AITOP_REMOTE_TIMEOUT_MS: '60000', AITOP_REMOTE_FAKE_MARK: m } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const screen = () => out.split('\x1b[H').at(-1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  try {
    const end = Date.now() + 15_000;
    while (Date.now() < end && !(/── dev · 2 세션/.test(screen()) && /── slow · 연결 중…/.test(screen()))) await sleep(100);
    assert.match(screen(), /── dev · 2 세션/);
    assert.match(screen(), /── slow · 연결 중…/);
    const slowPid = Number(/^slow (\d+)$/m.exec(readFileSync(m, 'utf8'))?.[1]);
    assert.ok(slowPid > 0);
    child.stdin.write('q');
    assert.equal(await exited, 0);
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      try {
        process.kill(slowPid, 0);
        await sleep(100);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, '끝낼 때 원격 자식을 죽인다');
  } finally {
    child.kill('SIGKILL');
  }
});
