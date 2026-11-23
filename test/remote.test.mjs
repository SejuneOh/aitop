// --remote (#308): 호스트 이름 확인, 실행 인자 모양, 오류 코드 판정, 원격 출력 정리 규칙, 이어 열기 명령, 폴러, 화면.
// 실제 ssh·wsl.exe 는 부르지 않는다 (실행기는 가짜로 바꿔 끼운다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'aitop-remote-cache-'));

const { parseRemote, remoteOption, readConfigFile, resolveConfig, REMOTE_MAX } = await import('../src/config.mjs');
const { classify, cleanSession, cleanSessions, createRemotePoller, phaseFrom, remoteCommand, remoteTargets, runRemote, MAX_SESSIONS, MAX_FILES, MAX_MEMBERS } = await import('../src/remote.mjs');
const { resumeCmd } = await import('../src/resume.mjs');
const { toJson, SCHEMA } = await import('../src/json.mjs');
const { arrange } = await import('../src/order.mjs');
const { render } = await import('../src/ui.mjs');
const { onKey } = await import('../src/keys.mjs');
const { waitingEnv } = await import('../src/notify.mjs');
const { phaseText } = await import('../src/i18n.mjs');
const { width } = await import('../src/text.mjs');

const strip = (x) => x.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07]*\x07/g, '');

// ── 호스트 이름 확인 ─────────────────────────────────────

test('ssh 인자로 위험한 값은 원격 이름으로 받지 않는다', () => {
  for (const bad of ['-oProxyCommand=x', 'a;b', '-x', 'a b', 'host:22', 'me@host:22', '$(id)', 'a`b`', 'a|b', '', '@host', 'me@', 'wsl:', 'wsl:-d', 'wsl:Ubu ntu', 'wsl:a;b', 'a\nb', 'x'.repeat(300)]) {
    assert.equal(parseRemote(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseRemote('dev'), { name: 'dev', kind: 'ssh', target: 'dev' });
  assert.deepEqual(parseRemote('me@vm2.local'), { name: 'me@vm2.local', kind: 'ssh', target: 'me@vm2.local' });
  assert.deepEqual(parseRemote('wsl:Ubuntu-22.04'), { name: 'wsl:Ubuntu-22.04', kind: 'wsl', target: 'Ubuntu-22.04' });
});

test('--remote 는 쉼표 목록, = 꼴, --no-remote 를 받고 뒤에 준 쪽을 따른다', () => {
  assert.deepEqual(remoteOption(['--remote', 'dev,me@vm2,wsl:Ubuntu-22.04', '--once']), { value: ['dev', 'me@vm2', 'wsl:Ubuntu-22.04'], rest: ['--once'], error: null });
  assert.deepEqual(remoteOption(['--remote=dev, dev ,x']).value, ['dev', 'x']);
  assert.equal(remoteOption(['--remote', 'dev', '--no-remote']).value, null);
  assert.deepEqual(remoteOption(['--no-remote', '--remote', 'dev']).value, ['dev']);
  assert.equal(remoteOption(['--once']).value, undefined);
});

test('--remote 의 잘못된 값은 오류 문구로 알린다 (값이 옵션처럼 보이면 값으로 먹지 않는다)', () => {
  assert.match(remoteOption(['--remote', '-oProxyCommand=x']).error, /--remote 값이 없습니다/);
  assert.match(remoteOption(['--remote=-oProxyCommand=x']).error, /--remote 값 "-oProxyCommand=x" 이 잘못/);
  assert.match(remoteOption(['--remote=host:22']).error, /~\/\.ssh\/config/);
  assert.match(remoteOption(['--remote=a;b']).error, /잘못/);
  assert.match(remoteOption(['--remote']).error, /값이 없습니다/);
  const many = Array.from({ length: REMOTE_MAX + 1 }, (_, i) => `h${i}`).join(',');
  assert.match(remoteOption([`--remote=${many}`]).error, /16개까지/);
});

test('설정 파일 remotes: 옵션 > 파일, --no-remote 는 파일 값도 끈다, 잘못된 값은 문제로 남긴다', () => {
  const file = { path: '/x', exists: true, values: { remotes: ['dev', 'wsl:Ubuntu'] }, problems: [] };
  assert.deepEqual(resolveConfig({ env: {}, file }).values.remotes, { value: ['dev', 'wsl:Ubuntu'], source: 'file' });
  assert.deepEqual(resolveConfig({ env: {}, file, flags: { remotes: ['vm'] } }).values.remotes, { value: ['vm'], source: 'flag' });
  assert.deepEqual(resolveConfig({ env: {}, file, flags: { remotes: null } }).values.remotes, { value: null, source: 'flag' });
  const dir = mkdtempSync(join(tmpdir(), 'aitop-remote-cfg-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ remotes: ['-oProxyCommand=x'] }));
  const r = readConfigFile(path);
  assert.equal(r.values.remotes, undefined);
  assert.match(r.problems.join('\n'), /remotes/);
});

// ── 실행 인자 ────────────────────────────────────────────

test('ssh·wsl 실행 인자는 셸 없는 배열이고, 호스트 앞에 -- 를 둔다', () => {
  assert.deepEqual(remoteCommand(parseRemote('me@vm2'), { fake: '' }), ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T', '--', 'me@vm2', 'aitop', '--json', '--no-remote']]);
  assert.deepEqual(remoteCommand(parseRemote('wsl:Ubuntu-22.04'), { fake: '' }), ['wsl.exe', ['-d', 'Ubuntu-22.04', '--', 'aitop', '--json', '--no-remote']]);
  assert.deepEqual(remoteCommand(parseRemote('dev'), { fake: '/t/fake.mjs', node: '/n' }), ['/n', ['/t/fake.mjs', 'ssh', 'dev', 'aitop', '--json', '--no-remote']]);
  assert.ok(!remoteCommand(parseRemote('dev'), { fake: '' })[1].some((a) => /StrictHostKeyChecking/i.test(a)), '호스트 키 확인을 끄지 않는다');
});

// ── 오류 코드 ────────────────────────────────────────────

const exitErr = (code, extra = {}) => Object.assign(new Error('x'), { code, ...extra });
const ok = (obj) => ({ stdout: Buffer.from(JSON.stringify(obj)) });

test('끝난 호출을 오류 코드로 가른다', () => {
  assert.equal(classify({ err: exitErr('ENOENT') }).error, 'notFound');
  assert.equal(classify({ err: exitErr(null, { killed: true, signal: 'SIGKILL' }) }).error, 'timeout');
  assert.equal(classify({ err: exitErr('ERR_CHILD_PROCESS_STDIO_MAXBUFFER') }).error, 'bad');
  assert.equal(classify({ err: exitErr(127), stderr: 'bash: aitop: command not found' }).error, 'notFound');
  assert.equal(classify({ err: exitErr(2), stderr: 'aitop: unknown option --no-remote' }).error, 'old');
  assert.equal(classify({ err: exitErr(255), stderr: 'me@vm: Permission denied (publickey).' }).error, 'auth');
  assert.equal(classify({ err: exitErr(255), stderr: 'Host key verification failed.' }).error, 'auth');
  assert.equal(classify({ err: exitErr(255), stderr: 'ssh: connect to host vm port 22: Connection refused' }).error, 'unreachable');
  // wsl.exe 의 오류 출력은 UTF-16 이다. NUL 을 지우고 읽는다.
  assert.equal(classify({ err: exitErr(1), stderr: Buffer.from('Permission denied', 'utf16le') }).error, 'auth');
  assert.equal(classify({ err: exitErr(-1), stderr: Buffer.from('There is no distribution with the supplied name.', 'utf16le') }).error, 'unreachable');
  assert.equal(classify({ stdout: Buffer.from('{"sessions": [') }).error, 'bad');
  assert.equal(classify({ stdout: Buffer.from('[]') }).error, 'bad');
  assert.equal(classify(ok({ version: '0.39.0', sessions: [] })).error, 'old');
  assert.equal(classify(ok({ version: '9.0.0', schema: SCHEMA + 1, sessions: [] })).error, 'newer');
  const good = classify(ok({ version: '0.41.0', schema: SCHEMA, sessions: [] }));
  assert.equal(good.error, null);
  assert.equal(good.json.schema, SCHEMA);
});

// ── 정리 규칙 ────────────────────────────────────────────

const raw = (extra = {}) => ({ tool: 'claude', id: 'abc', name: 'n', cwd: '/w', status: 'idle', phase: '다음 지시 대기', phaseKind: 'idle', tokens: { total: 10 }, members: [], files: [], ...extra });

test('원격 세션은 허용 필드만 다시 만들고 버릴 필드는 버린다', () => {
  const s = cleanSession(raw({ resumeCmd: 'rm -rf /', waitDetail: 'secret', pid: 42, tools: {}, usage: {}, evil: 1 }), 'dev');
  assert.equal(s.id, 'dev:abc');
  assert.equal(s.remoteId, 'abc');
  assert.equal(s.host, 'dev');
  for (const k of ['resumeCmd', 'waitDetail', 'pid', 'tools', 'usage', 'evil']) assert.ok(!(k in s), k);
});

test('제어 문자·escape 열은 지우고 긴 문자열은 200자로 자르고 비밀값은 가린다', () => {
  const s = cleanSession(raw({ name: 'a\x1b[31mred\x1b]0;title\x07\x00‮', project: 'x'.repeat(5000), branch: 'api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789' }), 'dev');
  assert.equal(s.name, 'ared');
  assert.equal(s.project.length, 200);
  assert.doesNotMatch(s.branch, /sk-abcdefghijklmnop/);
});

test('이상한 tool·status·phaseKind·숫자·시각은 받지 않거나 기본값으로 둔다', () => {
  assert.equal(cleanSession(raw({ tool: 'evil' }), 'dev'), null);
  assert.equal(cleanSession(raw({ id: 42 }), 'dev'), null);
  const s = cleanSession(raw({ status: 'pwned', phaseKind: '__proto__', cost: -5, tokens: { total: Infinity, input: '9' }, startedAt: 'not a date', context: { used: -1, window: 'big' } }), 'dev');
  assert.equal(s.status, 'idle');
  assert.equal(s.phase, null);
  assert.equal(s.cost, null);
  assert.equal(s.tokens.total, 0);
  assert.equal(s.tokens.input, 0);
  assert.equal(s.startedAt, null);
  assert.deepEqual(s.context, { used: 0, window: null });
  assert.equal(cleanSession(raw({ startedAt: '2026-11-20T03:00:00.000Z' }), 'dev').startedAt, Date.parse('2026-11-20T03:00:00.000Z'));
});

test('개수 상한: 세션 500, 파일 200, 멤버 50, 아티팩트 링크는 claude.ai 만', () => {
  const many = Array.from({ length: 600 }, (_, i) => raw({ id: `s${i}` }));
  assert.equal(cleanSessions({ sessions: many }, 'dev').length, MAX_SESSIONS);
  const s = cleanSession(raw({
    files: Array.from({ length: 300 }, (_, i) => ({ path: `/f${i}`, edits: 1, writtenLines: 2, deletedLines: 1 })),
    members: Array.from({ length: 80 }, (_, i) => ({ name: `m${i}`, status: 'weird' })),
    artifacts: [{ title: 't', url: 'https://evil.example/x' }, { title: 'u', url: 'https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000001' }],
  }), 'dev');
  assert.equal(s.files.length, MAX_FILES);
  assert.deepEqual(s.files[0], { path: '/f0', created: false, edits: 1, add: 2, del: 1, at: 0, agents: [], hunks: [], remote: true });
  assert.equal(s.members.length, MAX_MEMBERS);
  assert.equal(s.members[0].status, 'done');
  assert.equal(s.artifacts[0].url, null);
  assert.match(s.artifacts[1].url, /^https:\/\/claude\.ai\//);
  // 같은 id 는 한 번만.
  assert.equal(cleanSessions({ sessions: [raw(), raw()] }, 'dev').length, 1);
});

test('--json 의 한국어 phase 문구에서 phase 를 되살려 지금 언어로 보인다', () => {
  assert.deepEqual(phaseFrom('tool', '도구 실행 · Bash'), { kind: 'tool', args: { what: 'Bash' } });
  assert.equal(phaseText(phaseFrom('tool', '도구 실행 · Bash'), { lang: 'en' }), 'Running tool · Bash');
  assert.deepEqual(phaseFrom('waiting', '응답 대기 · Edit'), { kind: 'waiting', args: { what: 'Edit' } });
  assert.deepEqual(phaseFrom('think', '작업 중 · 3단계'), { kind: 'think', msg: 'steps', args: { n: '3' } });
  assert.deepEqual(phaseFrom('stopped', '로그인 필요'), { kind: 'stopped', msg: 'stopAuth', args: {} });
  assert.equal(phaseFrom('think', '에이전트 2개 실행 중 · 생각 중 · 에이전트 2개 실행 중').args.agents, 2);
  assert.deepEqual(phaseFrom('tool', '모르는 문구'), { kind: 'tool', msg: 'toolUnknown', args: {} });
  assert.deepEqual(phaseFrom('unseen', '완료 · 확인 전'), { kind: 'done', args: {} });
  assert.equal(phaseFrom('constructor', 'x'), null);
});

// ── 이어 열기 ────────────────────────────────────────────

const ID = '11111111-1111-4111-8111-111111111111';
const remoteClaude = (host, cwd = "/srv/it's here") => cleanSession(raw({ id: ID, cwd, resumeCmd: 'rm -rf /' }), host);

// POSIX 셸이 명령을 어떻게 나누는지 본다 (첫 단어를 인자 출력 함수로 바꿔 실행한다).
function shellWords(cmd) {
  const r = spawnSync('/bin/sh', ['-c', `f() { for a; do printf '%s\\0' "$a"; done; }; f ${cmd.replace(/^\S+ /, '')}`], { encoding: 'utf8' });
  return [cmd.split(' ')[0], ...r.stdout.split('\0').slice(0, -1)];
}

test('y: 원격 ssh 세션은 ssh -t <host> 로 감싼 이어 열기 명령을 로컬에서 다시 만든다 (따옴표 들어간 폴더)', { skip: process.platform === 'win32' && 'POSIX 셸로 확인' }, () => {
  const cmd = resumeCmd(remoteClaude('me@vm2'));
  assert.doesNotMatch(cmd, /rm -rf/);
  const words = shellWords(cmd);
  assert.deepEqual(words.slice(0, 3), ['ssh', '-t', 'me@vm2']);
  assert.equal(words.length, 4, '원격 셸이 받는 한 줄은 한 인자다');
  // 원격 셸이 그 한 줄을 다시 나누면 cd <폴더> && claude --resume <id> 가 된다.
  const inner = spawnSync('/bin/sh', ['-c', `f() { for a; do printf '%s\\0' "$a"; done; }; f ${words[3].replace(/^cd /, '').replace(' && ', ' ')}`], { encoding: 'utf8' }).stdout.split('\0').slice(0, -1);
  assert.deepEqual(inner, ["/srv/it's here", 'claude', '--resume', ID]);
});

test('y: WSL 세션은 wsl.exe -d <배포판> --cd <폴더> -- <명령>', () => {
  const cmd = resumeCmd(remoteClaude('wsl:Ubuntu-22.04', '/home/me/repo'));
  assert.equal(cmd, `wsl.exe -d Ubuntu-22.04 --cd /home/me/repo -- claude --resume ${ID}`);
  // 폴더를 모르면 Claude 는 이어 열 수 없다 (로컬 규칙 그대로).
  assert.equal(resumeCmd(cleanSession(raw({ id: ID, cwd: null }), 'dev')), null);
});

// ── --json ───────────────────────────────────────────────

test('--json: 최상위 schema, 세션마다 host·remoteId, remotes 목록', () => {
  const local = { tool: 'claude', id: 'loc', status: 'idle', members: [] };
  const remote = remoteClaude('dev');
  const at = Date.parse('2026-11-23T00:00:00Z');
  const j = toJson({ sessions: [local, remote], remotes: [{ name: 'dev', kind: 'ssh', ok: true, error: null, version: '0.41.0', schema: 1, at }, { name: 'vm', kind: 'ssh', ok: false, error: 'timeout', at: null }], at }, '0.41.0');
  assert.equal(j.schema, SCHEMA);
  assert.deepEqual(j.remotes, [
    { name: 'dev', kind: 'ssh', ok: true, error: null, version: '0.41.0', schema: 1, at: '2026-11-23T00:00:00.000Z' },
    { name: 'vm', kind: 'ssh', ok: false, error: 'timeout', version: null, schema: null, at: null },
  ]);
  assert.equal(j.sessions[0].host, null);
  assert.equal(j.sessions[0].remoteId, null);
  assert.equal(j.sessions[1].host, 'dev');
  assert.equal(j.sessions[1].id, `dev:${ID}`);
  assert.equal(j.sessions[1].remoteId, ID);
  assert.match(j.sessions[1].resumeCmd, /^ssh -t dev /);
  assert.deepEqual(toJson({ sessions: [], at }).remotes, []);
});

test('--on-waiting 환경 변수에 AITOP_HOST (로컬은 빈 값)', () => {
  assert.equal(waitingEnv(remoteClaude('dev')).AITOP_HOST, 'dev');
  assert.equal(waitingEnv({ tool: 'claude', id: 'x' }).AITOP_HOST, '');
});

// ── 실행기·폴러 ──────────────────────────────────────────

// 가짜 execFile: 부른 인자를 남기고, 정해 둔 결과로 콜백을 부른다. kill 되면 killed 오류로 끝난다.
function fakeExec(plan) {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    const child = { killed: false, stdin: { end() {} }, kill() {
      this.killed = true;
      setImmediate(() => cb(Object.assign(new Error('killed'), { code: null, killed: true, signal: 'SIGKILL' }), Buffer.alloc(0), Buffer.alloc(0)));
    } };
    calls.push({ file, args, opts, child });
    const p = plan(args);
    if (p) setImmediate(() => cb(p.err ?? null, Buffer.from(p.stdout ?? ''), Buffer.from(p.stderr ?? '')));
    return child;
  };
  return { exec, calls };
}

test('runRemote: 셸 없이 부르고, 시간을 넘기면 SIGKILL 하고 timeout 으로 끝난다', async () => {
  const { exec, calls } = fakeExec(() => null);
  const r = await runRemote(parseRemote('dev'), { exec, timeoutMs: 20, fake: '' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  assert.equal(calls[0].file, 'ssh');
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.maxBuffer, 8 * 1024 * 1024);
  assert.equal(calls[0].child.killed, true);
});

test('runRemote: 성공하면 세션을 정리해 돌려주고 시각을 남긴다', async () => {
  const { exec } = fakeExec(() => ({ stdout: JSON.stringify({ version: '0.41.0', schema: 1, sessions: [raw()] }) }));
  const r = await runRemote(parseRemote('wsl:Ubuntu'), { exec, fake: '', now: () => 123 });
  assert.equal(r.ok, true);
  assert.equal(r.at, 123);
  assert.equal(r.version, '0.41.0');
  assert.deepEqual(r.sessions.map((s) => s.id), ['wsl:Ubuntu:abc']);
});

test('폴러: 앞 호출이 끝나지 않은 원격은 건너뛰고, stop 은 돌고 있는 자식을 죽인다', async () => {
  const { exec, calls } = fakeExec((args) => (args.includes('fast') ? { stdout: JSON.stringify({ schema: 1, sessions: [raw()] }) } : null));
  const run = (r, o) => runRemote(r, { ...o, exec, fake: '' });
  const p = createRemotePoller(remoteTargets(['slow', 'fast', 'bad;name']), { run, timeoutMs: 60_000 });
  assert.deepEqual(p.snapshot().statuses.map((s) => [s.name, s.pending]), [['slow', true], ['fast', true]], '잘못된 이름은 빠진다');
  p.pollAll();
  await new Promise((r) => setTimeout(r, 20));
  p.pollAll();
  assert.equal(calls.filter((c) => c.args.includes('slow')).length, 1, '진행 중인 원격은 다시 부르지 않는다');
  assert.equal(calls.filter((c) => c.args.includes('fast')).length, 2);
  const snap = p.snapshot();
  assert.deepEqual(snap.sessions.map((s) => s.id), ['fast:abc']);
  assert.equal(snap.statuses[1].ok, true);
  p.stop();
  assert.equal(calls.find((c) => c.args.includes('slow')).child.killed, true);
});

// ── 화면 ─────────────────────────────────────────────────

const now = Date.now();
const sess = (id, extra = {}) => ({ tool: 'claude', id, name: id, project: 'p', cwd: '/w/p', status: 'idle', live: true, phase: { kind: 'idle' }, updatedAt: now, startedAt: now - 1000, tokens: { total: 1000 }, cost: 1, context: { used: 1000, window: 200_000 }, members: [], events: [], ...extra });
const rsess = (host, id, extra = {}) => ({ ...cleanSession(raw({ id, name: `${host}-${id}`, files: [{ path: '/srv/a.mjs', edits: 2, writtenLines: 3, deletedLines: 1 }], artifacts: [{ title: 'doc', url: 'https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000001' }] }), host), updatedAt: now, ...extra });
const statuses = [
  { name: 'dev', kind: 'ssh', ok: true, error: null, pending: false, at: now - 10_000 },
  { name: 'vm', kind: 'ssh', ok: false, error: 'timeout', pending: false, at: null },
  { name: 'wsl:우분투', kind: 'wsl', ok: false, error: null, pending: true, at: null },
];
const data = () => ({ sessions: [sess('local1'), rsess('dev', 'r1'), rsess('dev', 'r2', { status: 'waiting', phase: { kind: 'waiting', args: { what: 'Bash' } } }), sess('local2', { status: 'waiting', phase: { kind: 'waiting', args: {} } })], remotes: statuses, usage: null, errors: [], at: now });
const view = (extra = {}) => ({ data: data(), selectedId: 'local1', showDetail: false, frame: 0, costMode: 'api', sort: 'default', group: 'none', pins: [], ...extra });
const draw = (v, W = 120, H = 30) => render(v, W, H).map(strip);

test('표: 로컬 세션이 맨 위, 그 아래 호스트별 구분 줄과 그 호스트 세션 (구획 안에서는 대기 우선)', () => {
  const lines = draw(view());
  const idx = (re) => lines.findIndex((l) => re.test(l));
  assert.ok(idx(/local2/) < idx(/local1/), '로컬 안에서 대기 우선');
  assert.ok(idx(/local1/) < idx(/── dev · 2 세션 · 10초 전 ─/));
  assert.ok(idx(/── dev ·/) < idx(/dev-r2/) && idx(/dev-r2/) < idx(/dev-r1/), '구획 안에서도 대기 우선');
  assert.ok(idx(/── vm · 연결 안 됨 \(시간 초과\) ─/) > idx(/dev-r1/));
  assert.ok(idx(/── wsl:우분투 · 연결 중… ─/) > 0);
  // ↑↓ 순서(arrange)도 화면 순서와 같다.
  assert.deepEqual(arrange(data().sessions, { remotes: statuses }).sessions.map((s) => s.id), ['local2', 'local1', 'dev:r2', 'dev:r1']);
});

test('표: 좁은 폭·한글 호스트 이름에서도 구분 줄이 폭을 넘지 않고 상태 글을 남긴다', () => {
  for (const W of [40, 60, 80, 140]) {
    const lines = render(view(), W, 30);
    for (const l of lines) assert.ok(width(strip(l)) <= W, `W=${W}: ${strip(l)}`);
    assert.ok(lines.map(strip).some((l) => /연결 안 됨 \(시간 초과\)/.test(l)), `W=${W}`);
  }
});

test('원격을 켜지 않으면 구분 줄이 없다', () => {
  const v = view();
  v.data.sessions = v.data.sessions.filter((s) => !s.host);
  delete v.data.remotes;
  assert.ok(!draw(v).some((l) => /── (dev|vm) ·/.test(l)));
});

test('상세 패널: 원격 세션은 호스트를 보이고, diff 를 열면 "원격 세션은 변경 내용 없음" 안내', () => {
  const v = view({ selectedId: 'dev:r1', showDetail: true });
  const lines = draw(v, 120, 40).join('\n');
  assert.match(lines, /@ dev/);
  assert.match(lines, /호스트\s+dev/);
  assert.match(lines, /a\.mjs/);
  const act = { quit() {}, refresh() {}, move() {}, next() {}, keepVisible() {} };
  onKey(v, 'f', act);
  onKey(v, '\r', act);
  assert.equal(v.focus, 'diff');
  assert.match(draw(v, 120, 40).join('\n'), /원격 세션은 변경 내용 없음/);
});

test('아티팩트 원본(Enter)은 원격 세션에서 막고 안내한다', () => {
  const v = view({ selectedId: 'dev:r1', showDetail: true });
  const notices = [];
  let loaded = 0;
  const act = { quit() {}, refresh() {}, move() {}, next() {}, keepVisible() {}, notice: (k) => notices.push(k), loadArtifact: () => (loaded++, { kind: 'missing' }) };
  onKey(v, 'v', act);
  assert.equal(v.focus, 'artifacts');
  onKey(v, '\r', act);
  assert.equal(v.focus, 'artifacts', '원본 화면으로 가지 않는다');
  assert.equal(loaded, 0);
  assert.deepEqual(notices, ['foot.remoteNoSource']);
});
