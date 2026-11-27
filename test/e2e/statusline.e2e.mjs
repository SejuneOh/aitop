// aitop --statusline 을 새 프로세스로 실행한다 (#332): 저장 위치·권한, 기본 줄, 사용자 명령 넘기기,
// 화면 모듈·수집기를 불러오지 않는 가벼운 경로, 저장값이 --json·--line·--doctor 에 보이는지.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BIN } from './session.mjs';
import { makeClaudeHome } from '../fixture.mjs';

// 기록 폴더·설정 폴더는 가짜로 둔다 (fixture 가 XDG_CACHE_HOME 도 임시 폴더로 바꾼다). 캐시는 테스트마다 새 빈 폴더.
makeClaudeHome();
const root = mkdtempSync(join(tmpdir(), 'aitop-sl-e2e-'));
after(() => rmSync(root, { recursive: true, force: true }));
const freshCache = () => mkdtempSync(join(root, 'cache-'));

const sec = (ms) => Math.floor(ms / 1000);
const now = Date.now();
const INPUT = JSON.stringify({
  session_id: 'secret-session',
  model: { display_name: 'Opus' },
  workspace: { current_dir: '/home/someone/secret' },
  cost: { total_cost_usd: 1.23 },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: sec(now + 2 * 3600_000 + 30 * 60_000) }, seven_day: { used_percentage: 41.2, resets_at: sec(now + 3 * 86_400_000) } },
});

const run = (args, { input = '', cache, env = {}, nodeArgs = [] } = {}) => spawnSync(process.execPath, [...nodeArgs, BIN, ...args], { input, env: { ...process.env, XDG_CACHE_HOME: cache, ...env }, encoding: 'utf8', timeout: 20_000 });

test('--statusline: 캐시 루트에 claude-limits.json(0600)만 만들고 기본 줄을 낸다', () => {
  const cache = freshCache();
  const r = run(['--statusline'], { input: INPUT, cache });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^5h 24% \(2h(29|30)m\) \| 7d 41%\n$/);
  assert.deepEqual(readdirSync(cache), ['aitop']);
  assert.deepEqual(readdirSync(join(cache, 'aitop')), ['claude-limits.json'], '버전 폴더·다른 파일은 만들지 않는다');
  const file = join(cache, 'aitop', 'claude-limits.json');
  const raw = readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /secret|Opus|cost|1\.23/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('--statusline: rate_limits 가 없으면 빈 줄, 파일을 만들지 않는다', () => {
  const cache = freshCache();
  const r = run(['--statusline'], { input: '{"model":{"display_name":"Opus"}}', cache });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '\n');
  assert.deepEqual(readdirSync(cache), []);
});

test('--statusline -- 명령: 입력을 넘기고 출력·종료 코드를 따른다 (인자 배열과 셸 문자열)', () => {
  const script = join(root, 'echo-status.mjs');
  writeFileSync(script, `let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{process.stdout.write('['+JSON.parse(b).model.display_name+'] mine\\n');process.exit(5)});`);
  const cache = freshCache();
  const arr = run(['--statusline', '--', process.execPath, script], { input: INPUT, cache });
  assert.equal(arr.status, 5);
  assert.equal(arr.stdout, '[Opus] mine\n');
  const sh = run(['--statusline', '--', `"${process.execPath}" "${script}"`], { input: INPUT, cache: freshCache() });
  assert.equal(sh.status, 5);
  assert.equal(sh.stdout, '[Opus] mine\n');
  assert.ok(readFileSync(join(cache, 'aitop', 'claude-limits.json'), 'utf8').includes('23.5'));
});

test('--statusline: --statusline 앞뒤의 다른 옵션은 사용법 오류(2)', () => {
  assert.equal(run(['--lang', 'en', '--statusline'], { cache: freshCache() }).status, 2);
  assert.equal(run(['--statusline', '--json'], { cache: freshCache() }).status, 2);
});

test('--statusline 은 설정·화면 모듈·수집기를 불러오지 않는다', () => {
  // 모듈 해석 훅으로 불러온 aitop 모듈 이름을 파일에 적는다.
  const log = join(root, `loaded-${process.pid}.txt`);
  const hooks = join(root, 'hooks.mjs');
  writeFileSync(hooks, `import { appendFileSync } from 'node:fs';\nexport async function resolve(s, c, next) { const r = await next(s, c); if (r.url.startsWith('file:')) appendFileSync(${JSON.stringify(log)}, r.url + '\\n'); return r; }\n`);
  const reg = join(root, 'register.mjs');
  writeFileSync(reg, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
  const r = run(['--statusline'], { input: INPUT, cache: freshCache(), nodeArgs: ['--import', pathToFileURL(reg).href] });
  assert.equal(r.status, 0, r.stderr);
  const names = [...new Set(readFileSync(log, 'utf8').trim().split('\n').map((u) => u.split('/').slice(-2).join('/')))].filter((n) => !n.endsWith('register.mjs'));
  assert.deepEqual(names.sort(), ['bin/aitop.mjs', 'src/limits.mjs', 'src/paths.mjs', 'src/rename.mjs', 'src/statusline.mjs']);
});

test('--statusline 은 빨리 끝난다 (node 시작 포함 1.5초 안)', () => {
  const cache = freshCache();
  run(['--statusline'], { input: INPUT, cache });
  const t0 = performance.now();
  const r = run(['--statusline'], { input: INPUT, cache });
  const ms = performance.now() - t0;
  assert.equal(r.status, 0);
  assert.ok(ms < 1500, `${Math.round(ms)}ms`);
});

test('저장된 한도가 --json·--line·--doctor 에 보인다', () => {
  const cache = freshCache();
  run(['--statusline'], { input: INPUT, cache });
  const j = JSON.parse(run(['--json'], { cache }).stdout);
  assert.equal(j.limits.claude.fiveHour.usedPercent, 23.5);
  assert.equal(j.limits.claude.sevenDay.usedPercent, 41.2);
  assert.match(j.limits.claude.fiveHour.resetsAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(run(['--line'], { cache }).stdout, /5h24% 7d41%\n$/);
  const doc = run(['--doctor'], { cache, env: { AITOP_LANG: 'en' } }).stdout;
  assert.match(doc, /✓ Claude limits {2}status line connected · last update \d+s ago · 5h 24% · 7d 41%/);
  const empty = freshCache();
  assert.equal(JSON.parse(run(['--json'], { cache: empty }).stdout).limits.claude, null);
  assert.match(run(['--doctor'], { cache: empty, env: { AITOP_LANG: 'en' } }).stdout, /○ Claude limits {2}status line not connected/);
});

test('POSIX: aitop 이 SIGTERM 을 받으면 사용자 명령의 손자까지 끄고 끝난다', { skip: process.platform === 'win32' && 'POSIX 전용' }, async () => {
  const { spawn } = await import('node:child_process');
  const pidFile = join(root, `sig-${process.pid}.pid`);
  const child = spawn(process.execPath, [BIN, '--statusline', '--', `sleep 30 & echo $! > '${pidFile}'; wait`], { env: { ...process.env, XDG_CACHE_HOME: freshCache() }, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end('{}');
  // 손자가 pid 를 적을 때까지 기다린다.
  let pid = 0;
  for (let i = 0; i < 40 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      pid = Number(readFileSync(pidFile, 'utf8')) || 0;
    } catch {}
  }
  assert.ok(pid > 0);
  const closed = new Promise((r) => child.on('close', (code, sig) => r({ code, sig })));
  child.kill('SIGTERM');
  const res = await closed;
  assert.equal(res.code, 143);
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, '손자 sleep 이 남지 않는다');
});
