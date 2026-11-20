// Antigravity 데스크톱 앱 폴더(~/.gemini/antigravity)의 대화도 읽는다 (#303).
// 가짜 HOME 에 agy CLI 폴더와 앱 폴더를 따로 만들고, 두 쪽 세션이 다 보이는지, 출처(source)가 맞는지,
// 앱 폴더의 다른 파일(토큰 등)은 열지 않는지, AITOP_AGY_HOME 격리가 그대로인지 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, utimesSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSqlite } from '../src/sqlite.mjs';
import * as fx from './agy-fixture.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'aitop-agy-app-')));
const home = join(base, 'home');
const cli = join(home, '.gemini', 'antigravity-cli');
const app = join(home, '.gemini', 'antigravity');
for (const d of [cli, app]) mkdirSync(join(d, 'conversations'), { recursive: true });
// 앱 폴더에 함께 있는 다른 파일. aitop 은 이것을 열면 안 된다.
writeFileSync(join(app, 'mcp_oauth_tokens.json'), '{"token":"SECRET-TOKEN-303"}');
mkdirSync(join(app, 'brain'));
writeFileSync(join(app, 'brain', 'note.md'), 'x');
process.env.AITOP_AGY_HOME = cli;
process.env.AITOP_AGY_APP_HOME = app;
process.env.XDG_CACHE_HOME = join(base, 'cache');
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-empty');
process.env.CODEX_HOME = join(base, 'codex-missing');
process.env.GEMINI_HOME = join(base, 'gemini-missing');

// 앱 폴더 안에서 연 경로를 모은다. node:fs 의 이름 있는 내보내기도 바뀌도록 syncBuiltinESMExports 를 부른다.
const touched = new Set();
for (const name of ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'existsSync', 'lstatSync']) {
  const orig = fs[name];
  fs[name] = function (p, ...rest) {
    const s = String(p?.href ?? p);
    if (s === app || s.startsWith(app + sep)) touched.add(s);
    return orig.call(this, p, ...rest);
  };
}
syncBuiltinESMExports();

const { findAgyRoots, collectAgy, cwdOf, APP_LIVE_MS, APP_TTL_MS, _test: agyTest } = await import('../src/sources/antigravity.mjs');
const { wslWindowsHomes, agyAppEnv } = await import('../src/sources/dirs.mjs');
const { collectAgyLedger, _test: ledgerTest } = await import('../src/sources/agy-ledger.mjs');
const { agyConversations } = await import('../src/sources/projects.mjs');
const { checkTools, doctorText } = await import('../src/doctor.mjs');
const { toJson } = await import('../src/json.mjs');
const { resumeCmd } = await import('../src/resume.mjs');
const { resolveConfig } = await import('../src/config.mjs');
const { createBudget } = await import('../src/tail.mjs');

after(() => rmSync(base, { recursive: true, force: true }));

const noSqlite = !loadSqlite() && 'agy 기록을 immutable 로 열 수 없는 Node (22.15 미만)';
const ws = (dir) => [`file://${dir}`];

test('기록 폴더: CLI 먼저, 앱 폴더는 conversations/ 가 있을 때만. AITOP_AGY_HOME 만 주면 앱 폴더를 읽지 않는다', () => {
  const h = join(base, 'h1');
  mkdirSync(join(h, '.gemini', 'antigravity', 'conversations'), { recursive: true });
  const dirs = (o) => findAgyRoots({ wsl: false, ...o }).map((r) => `${r.source}:${r.dir}`);
  assert.deepEqual(dirs({ env: {}, home: h }), [`cli:${join(h, '.gemini', 'antigravity-cli')}`, `app:${join(h, '.gemini', 'antigravity')}`]);
  assert.deepEqual(dirs({ env: {}, home: join(base, 'h-none') }), [`cli:${join(base, 'h-none', '.gemini', 'antigravity-cli')}`], '앱 폴더가 없으면 넣지 않는다');
  assert.deepEqual(dirs({ env: { AITOP_AGY_HOME: join(base, 'x') }, home: h }), [`cli:${join(base, 'x')}`], '테스트 격리');
  assert.deepEqual(dirs({ env: { AITOP_AGY_APP_HOME: 'off' }, home: h }).length, 1, '환경 변수로 끈다');
  assert.deepEqual(dirs({ env: {}, home: h, app: false }).length, 1, '설정 파일 agyApp: false');
  assert.deepEqual(dirs({ env: { AITOP_AGY_HOME: join(base, 'x'), AITOP_AGY_APP_HOME: app }, home: h }), [`cli:${join(base, 'x')}`, `app:${app}`]);
  assert.deepEqual(dirs({ env: {}, home: h, app: [app] }), [`cli:${join(h, '.gemini', 'antigravity-cli')}`, `app:${app}`], '설정 파일의 경로 목록');
  // WSL: Windows 홈의 앱 폴더도 본다.
  const win = join(base, 'win', 'me');
  mkdirSync(join(win, '.gemini', 'antigravity', 'conversations'), { recursive: true });
  assert.deepEqual(findAgyRoots({ env: {}, home: join(base, 'h-none'), wsl: true, winHomes: () => [win] }).map((r) => r.source + ':' + r.dir).slice(1), [`app:${join(win, '.gemini', 'antigravity')}`]);
  assert.equal(agyAppEnv('OFF'), false);
  assert.equal(agyAppEnv(''), undefined);
});

test('WSL 의 Windows 홈: USERPROFILE 이 있으면 그 폴더, 없으면 공용 폴더를 뺀 사용자 폴더', () => {
  const has = () => true;
  assert.deepEqual(wslWindowsHomes({ env: { USERPROFILE: 'C:\\Users\\me' }, has }), ['/mnt/c/Users/me'.split('/').join(sep)]);
  const users = join(base, 'Users');
  for (const n of ['Public', 'Default', 'Default User', 'All Users', 'kim', 'lee']) mkdirSync(join(users, n), { recursive: true });
  writeFileSync(join(users, 'desktop.ini'), '');
  assert.deepEqual(wslWindowsHomes({ env: {}, usersDir: users }), [join(users, 'kim'), join(users, 'lee')]);
  assert.deepEqual(wslWindowsHomes({ env: {}, usersDir: join(base, 'no-users') }), []);
  // USERPROFILE 폴더가 없으면 사용자 폴더 훑기로 넘어간다 (실제 /mnt/c 는 보지 않게 has 를 바꿔 끼운다).
  const inFake = (p) => p.startsWith(users) && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  assert.deepEqual(wslWindowsHomes({ env: { USERPROFILE: 'C:\\Users\\ghost' }, usersDir: users, has: inFake }), [join(users, 'kim'), join(users, 'lee')]);
});

test('CLI 와 앱 대화가 함께 보이고 source 가 맞다. 앱 대화는 최근 2분 안에 바뀌었으면 실행 중', { skip: noSqlite }, () => {
  const now = Date.now();
  fx.makeConversation(cli, 'cli-1', [{ input: 100, output: 10 }]);
  fx.makeSummaries(cli, [{ id: 'cli-1', title: 'CLI 대화', modified: fx.ts(now - 3600_000), ws: ws('/w/cli') }]);
  fx.makeConversation(app, 'app-1', [{ input: 200, output: 20 }]);
  fx.makeSteps(app, 'app-1', [fx.prompt('앱에서 물어봄', now - 60_000)]);
  fx.makeConversation(app, 'app-old', [{ input: 5, output: 1 }]);
  fx.makeSummaries(app, [
    { id: 'app-1', title: '앱 대화', modified: fx.ts(now - 30_000), ws: ws('/w/app') },
    { id: 'app-old', title: '오래된 앱 대화', modified: fx.ts(now - APP_LIVE_MS - 60_000), ws: ws('/w/app') },
  ]);
  const live = collectAgy({ showEnded: false, budget: createBudget() });
  const a = live.find((s) => s.id === 'app-1');
  assert.ok(a, 'agy 프로세스가 없어도 앱 대화가 보인다');
  assert.equal(a.source, 'app');
  assert.equal(a.live, true);
  assert.equal(a.pid, null);
  assert.equal(a.tokens.total, 220);
  assert.equal(a.name, '앱 대화');
  assert.ok(!live.some((s) => s.id === 'app-old'), '2분보다 오래 조용한 앱 대화는 실행 중이 아니다');
  assert.ok(!live.some((s) => s.id === 'cli-1'), 'agy 프로세스가 없는 CLI 대화는 실행 중이 아니다');

  const all = collectAgy({ showEnded: true, budget: createBudget() });
  assert.equal(all.find((s) => s.id === 'cli-1')?.source, 'cli');
  assert.equal(all.find((s) => s.id === 'app-old')?.status, 'ended');
  assert.equal(all.find((s) => s.id === 'app-old')?.source, 'app');

  // --json 과 이어 열기 명령
  const j = toJson({ sessions: [a, all.find((s) => s.id === 'cli-1')] });
  assert.deepEqual(j.sessions.map((s) => s.source), ['app', 'cli']);
  assert.equal(resumeCmd({ ...a, id: '11111111-2222-3333-4444-555555555555' }), null, '앱 대화는 agy CLI 로 이어 열 수 없다');

  // -wal 이 막 바뀐 대화도 실행 중으로 본다 (요약 db 가 아직 합쳐지지 않았을 때).
  // 앱 폴더 목록은 APP_TTL_MS 마다 한 번 보므로 그만큼 지난 것으로 만든 뒤 다시 모은다.
  writeFileSync(join(app, 'conversations', 'app-old.db-wal'), '');
  agyTest.age(APP_TTL_MS);
  assert.ok(collectAgy({ showEnded: false, budget: createBudget() }).some((s) => s.id === 'app-old'));
  const old = (now - APP_LIVE_MS - 60_000) / 1000;
  utimesSync(join(app, 'conversations', 'app-old.db-wal'), old, old);
  agyTest.age(APP_TTL_MS);
  assert.ok(!collectAgy({ showEnded: false, budget: createBudget() }).some((s) => s.id === 'app-old'));
  rmSync(join(app, 'conversations', 'app-old.db-wal'));
});

test('앱 폴더의 대화 목록·기록 서명은 10초(APP_TTL_MS)에 한 번만 다시 본다. 2분 판정은 지금 시각으로', { skip: noSqlite }, () => {
  const now = Date.now();
  fx.makeConversation(app, 'ttl-1', [{ input: 10, output: 1 }]);
  const rows = [
    { id: 'app-1', title: '앱 대화', modified: fx.ts(now - 30_000), ws: ws('/w/app') },
    { id: 'ttl-1', title: '처음 제목', modified: fx.ts(now - 10_000), ws: ws('/w/app') },
  ];
  fx.makeSummaries(app, rows);
  agyTest.age(APP_TTL_MS);
  const pick = () => collectAgy({ showEnded: false, budget: createBudget() }).find((s) => s.id === 'ttl-1');
  assert.equal(pick()?.name, '처음 제목');
  fx.makeSummaries(app, [rows[0], { ...rows[1], title: '바뀐 제목' }]);
  fx.makeConversation(app, 'ttl-1', [{ input: 100, output: 10 }]);
  const cached = pick();
  assert.equal(cached?.name, '처음 제목', 'TTL 안에서는 지난 목록을 쓴다');
  assert.equal(cached?.tokens.total, 11, 'TTL 안에서는 기록 서명도 다시 보지 않는다');
  agyTest.age(APP_TTL_MS);
  const next = pick();
  assert.equal(next?.name, '바뀐 제목');
  assert.equal(next?.tokens.total, 121);

  // 장부도 앱 폴더의 다 읽은 기록은 TTL 안에서 다시 열지 않는다.
  ledgerTest.reset();
  const sum = () => collectAgyLedger({ budget: createBudget() }).days.flatMap((d) => Object.values(d)).reduce((a, x) => a + (x.tokens ?? 0), 0);
  const first = sum();
  fx.makeConversation(app, 'ttl-1', [{ input: 1000, output: 0 }]);
  assert.equal(sum(), first, 'TTL 안');
  ledgerTest.age(APP_TTL_MS);
  assert.equal(sum(), first + 1000, 'TTL 이 지나면 새 호출을 센다');
});

test('장부: 읽기 한도에 걸려 덜 읽은 앱 기록은 TTL 을 기다리지 않고 다음 갱신에 이어 읽는다', { skip: noSqlite }, () => {
  ledgerTest.reset();
  const sum = (budget = createBudget()) => collectAgyLedger({ budget }).days.flatMap((d) => Object.values(d)).reduce((a, x) => a + (x.tokens ?? 0), 0);
  const first = sum();
  fx.makeConversation(app, 'ttl-1', [{ input: 500, output: 0 }]);
  ledgerTest.age(APP_TTL_MS);
  const empty = createBudget(0);
  assert.equal(sum(empty), first, '한도가 바닥나 이번에는 못 읽는다');
  assert.ok(empty.exhausted);
  assert.equal(sum(), first + 500, '다음 갱신에 바로 이어 읽는다');
});

test('WSL 에서 Windows 작업 폴더(file:///c%3A/…)는 /mnt/c/… 로 바꾼다', { skip: process.platform === 'win32' && 'Windows 는 C:\\ 로 둔다' }, () => {
  assert.equal(cwdOf('["file:///c%3A/Users/me/my%20work"]', { wsl: true }), '/mnt/c/Users/me/my work');
  assert.equal(cwdOf('["file:///D:/src/app"]', { wsl: true }), '/mnt/d/src/app');
  assert.equal(cwdOf('["file:///c%3A/"]', { wsl: true }), '/mnt/c');
  assert.equal(cwdOf('["file:///home/me/w"]', { wsl: true }), '/home/me/w', 'Linux 경로는 그대로');
  assert.equal(cwdOf('["file:///c%3A/Users/me"]', { wsl: false }), '/c:/Users/me', 'WSL 이 아니면 바꾸지 않는다');
});

test('7일 사용량 장부와 리포트용 대화 목록은 두 폴더를 함께 센다', { skip: noSqlite }, () => {
  ledgerTest.reset();
  const out = collectAgyLedger({ budget: createBudget() });
  assert.ok(out.paths.includes(join(cli, 'conversations', 'cli-1.db')));
  assert.ok(out.paths.includes(join(app, 'conversations', 'app-1.db')));
  const tokens = out.days.flatMap((d) => Object.values(d)).reduce((a, x) => a + (x.tokens ?? 0), 0);
  assert.ok(tokens >= 330, `CLI 110 + 앱 220 이상 (${tokens})`);
  const conv = agyConversations();
  assert.equal(conv.get('cli-1')?.cwd, '/w/cli');
  assert.equal(conv.get('app-1')?.cwd, '/w/app');
});

test('--doctor 에 앱 폴더 줄이 보인다', { skip: noSqlite }, () => {
  const r = checkTools({ home: join(base, 'h-none') });
  assert.equal(r.tools.agy.state, 'ok');
  assert.deepEqual(r.tools.agy.dirs.map((d) => d.source), ['cli', 'app']);
  const text = doctorText(r, '9.9.9', Date.now(), 'ko');
  assert.match(text, new RegExp(`\\+ +${app.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} {2}Antigravity 앱 · 기록 \\d+개`));
});

test('설정 파일 agyApp 과 AITOP_AGY_APP_HOME: 환경 변수 > 파일 > 기본(true)', () => {
  const file = (values) => ({ path: '/x/config.json', exists: true, values, problems: [] });
  assert.deepEqual(resolveConfig({ env: {}, file: file({}) }).values.agyApp, { value: true, source: 'default' });
  assert.deepEqual(resolveConfig({ env: {}, file: file({ agyApp: false }) }).values.agyApp, { value: false, source: 'file' });
  assert.deepEqual(resolveConfig({ env: { AITOP_AGY_APP_HOME: 'off' }, file: file({ agyApp: true }) }).values.agyApp, { value: false, source: 'env' });
  // off 와 절대 경로 말고는 경고하고 무시한다.
  for (const v of ['on', '1', 'true', 'rel/path']) {
    assert.equal(agyAppEnv(v), undefined, v);
    const c = resolveConfig({ env: { AITOP_AGY_APP_HOME: v }, file: file({ agyApp: false }) });
    assert.deepEqual(c.values.agyApp, { value: false, source: 'file' }, v);
    assert.ok(c.problems.some((p) => p.includes('AITOP_AGY_APP_HOME')), v);
  }
  assert.deepEqual(agyAppEnv('/a/b'), ['/a/b']);
  // AITOP_AGY_HOME 이 있으면 설정 파일 값은 무시되고, 출처는 그 변수로 보인다.
  const masked = resolveConfig({ env: { AITOP_AGY_HOME: '/x' }, file: file({ agyApp: true }) });
  assert.deepEqual(masked.values.agyApp, { value: false, source: 'env', env: 'AITOP_AGY_HOME' });
  assert.ok(masked.problems.some((p) => p.includes('AITOP_AGY_HOME')));
  assert.deepEqual(resolveConfig({ env: { AITOP_AGY_HOME: '/x' }, file: file({}) }).values.agyApp, { value: false, source: 'env', env: 'AITOP_AGY_HOME' });
  assert.deepEqual(resolveConfig({ env: { AITOP_AGY_HOME: '/x', AITOP_AGY_APP_HOME: '/a' }, file: file({}) }).values.agyApp, { value: ['/a'], source: 'env' });
});

test('앱 폴더에서는 conversations/ 와 conversation_summaries.db 만 연다', () => {
  assert.ok(touched.size > 0, '앱 폴더를 읽기는 했다');
  const ok = (p) => p === app || p.startsWith(join(app, 'conversations')) || p.startsWith(join(app, 'conversation_summaries.db'));
  assert.deepEqual([...touched].filter((p) => !ok(p)), []);
});
