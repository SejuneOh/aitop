// claude -p(sdk-cli) 실행을 부모 세션 아래로 붙이고, 부모를 못 찾은 실행은 자동 실행으로 표시한다 (#286).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readdirSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';
import { phaseText, t } from '../src/i18n.mjs';

const fx = makeClaudeHome();
const { collectClaude, claudeLineCounts, _setParentPid, _resetDiscover, _forgetParents, jobIdOf } = await import('../src/sources/claude.mjs');
const { CACHE_ROOT, PARENTS_FILE, flushCache, markDirty } = await import('../src/cache.mjs');
const parentsPath = () => join(CACHE_ROOT, PARENTS_FILE);
const { createBudget } = await import('../src/tail.mjs');
const { render } = await import('../src/ui.mjs');
const { toJson } = await import('../src/json.mjs');
const { attentionCounts, callsYou, createAttention, createEventWatch, freshWaiting, nextAttention, takeEvents, windowTitle } = await import('../src/attention.mjs');
const { summarize } = await import('../src/summary.mjs');
const procs = await import('../src/procs.mjs');

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const run = (opts = {}) => collectClaude({ showEnded: false, budget: createBudget(), ...opts });
const sdk = (row) => ({ ...row, entrypoint: 'sdk-cli' });
const cli = (row) => ({ ...row, entrypoint: 'cli' });
const owner = (sessionId) => ({ type: 'session-owner', sessionId });

// 살아 있는 pid 둘: 이 테스트 프로세스(자식 실행)와 그 부모 프로세스(부모 세션).
const CHILD = process.pid;
const PARENT = process.ppid;
const SHELL = 99_999_001;

function clean() {
  for (const d of ['sessions', 'projects']) for (const n of readdirSync(join(fx.home, d))) rmSync(join(fx.home, d, n), { recursive: true, force: true });
  _setParentPid(null);
  _resetDiscover();
}

test('(a) 부모 프로세스가 Claude 세션이면 그 세션의 팀원 행으로 붙고, 비용은 부모 합계에 더한다', () => {
  clean();
  fx.session({ sessionId: 'aaaa1111-parent', pid: PARENT, name: 'parent' });
  fx.transcript('aaaa1111-parent', [cli(user('리뷰 봇 띄워')), cli(assistant('p1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'claude -p hi' } }], usage(10, 10)))]);
  fx.session({ sessionId: 'cccc2222-child', pid: CHILD, name: 'review-run' });
  fx.transcript('cccc2222-child', [owner('cccc2222-child'), sdk(user('리뷰해')), sdk(assistant('c1', [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'x' } }], usage(100, 50)))]);
  // 자식 → 쉘 → 부모 세션 (두 단계).
  _setParentPid((pid) => (pid === CHILD ? SHELL : pid === SHELL ? PARENT : null));

  const list = run();
  assert.deepEqual(list.map((s) => s.id), ['aaaa1111-parent'], '자식은 최상위에서 빠진다');
  const [p] = list;
  assert.equal(p.entrypoint, 'cli');
  assert.equal(p.tokens.total, 20 + 150, '부모 합계에 더한다');
  assert.equal(p.tokens.sub, 150);
  assert.equal(p.tokens.subCount, 1);
  const m = p.members.find((x) => x.sdk);
  assert.equal(m.id, 'cccc2222-child');
  assert.equal(m.parentId, 'aaaa1111-parent');
  assert.equal(m.status, 'busy');
  assert.equal(phaseText(m.phase), '도구 실행 · Grep');

  const lines = render({ data: { sessions: list, errors: [], at: Date.now() }, selectedId: p.id, showDetail: false, frame: 0 }, 140, 10).map(strip);
  assert.ok(lines.some((l) => /-p review-run/.test(l)), '팀원 행 이름 앞에 -p');

  const j = toJson({ sessions: list, at: Date.now() }).sessions;
  assert.equal(j.length, 1);
  assert.equal(j[0].entrypoint, 'cli');
  assert.equal(j[0].auto, false);
  const jm = j[0].members.find((x) => x.id === 'cccc2222-child');
  assert.equal(jm.entrypoint, 'sdk-cli');
  assert.equal(jm.parentId, 'aaaa1111-parent');
});

test('(a2) 부모 pid 로 붙었던 실행은 끝난 뒤에도(기본 보기, --all, 다시 켠 뒤) 같은 부모에 붙어 합계가 같다', () => {
  // (a) 에서 이어진다: 실행이 끝나 세션 파일이 지워지고, 이제 부모 pid 로는 찾을 수 없다.
  unlinkSync(join(fx.home, 'sessions', `${CHILD}.json`));
  _setParentPid(() => null);
  _resetDiscover();
  const saved = JSON.parse(readFileSync(parentsPath(), 'utf8'));
  assert.equal(saved['cccc2222-child'].parentId, 'aaaa1111-parent', '캐시 폴더에 남긴다');

  const plain = run();
  assert.deepEqual(plain.map((s) => s.id), ['aaaa1111-parent'], '기본 보기에서 사라지지 않고 부모 아래');
  assert.equal(plain[0].tokens.total, 170, '부모 합계가 줄지 않는다');
  const m = plain[0].members.find((x) => x.sdk);
  assert.equal(m.status, 'done', '끝난 팀원 행 (MEMBER_FADE_MS 동안)');

  const all = run({ showEnded: true });
  assert.deepEqual(all.map((s) => s.id), ['aaaa1111-parent'], '--all 에서도 최상위 자동 행으로 다시 나오지 않는다');
  assert.equal(all[0].tokens.total, 170);

  // aitop 을 다시 켠 것처럼 기억을 비워도 파일에서 읽는다.
  _forgetParents();
  _resetDiscover();
  assert.equal(run()[0].tokens.total, 170);
});

test('기억 파일: 다른 aitop 이 그사이 쓴 기억을 지우지 않고 합치며, 버전 폴더를 정리해도 남는다', () => {
  clean();
  // --line 같은 다른 aitop 이 그사이 쓴 기억 (하나는 24시간이 지났다).
  const before = JSON.parse(readFileSync(parentsPath(), 'utf8'));
  writeFileSync(parentsPath(), JSON.stringify({ ...before, 'other-run': { parentId: 'other-parent', at: Date.now() }, 'old-run': { parentId: 'x', at: Date.now() - 25 * 3600_000 } }));
  fx.session({ sessionId: 'aaaa7777-p2', pid: PARENT });
  fx.transcript('aaaa7777-p2', [cli(user('p2')), cli(assistant('q1', [], usage(1, 1)))]);
  fx.session({ sessionId: 'cccc8888-c2', pid: CHILD });
  fx.transcript('cccc8888-c2', [owner('cccc8888-c2'), sdk(user('c2')), sdk(assistant('q2', [], usage(1, 1)))]);
  _setParentPid((pid) => (pid === CHILD ? PARENT : null));
  run();
  const saved = JSON.parse(readFileSync(parentsPath(), 'utf8'));
  assert.equal(saved['cccc8888-c2'].parentId, 'aaaa7777-p2');
  assert.equal(saved['other-run'].parentId, 'other-parent', '남의 기억을 지우지 않는다');
  assert.equal(saved['cccc2222-child'].parentId, 'aaaa1111-parent', '이 aitop 의 이전 기억도 남는다');
  assert.equal(saved['old-run'], undefined, '24시간 지난 것만 버린다');
  assert.deepEqual(readdirSync(CACHE_ROOT).filter((n) => n.endsWith('.tmp')), [], '임시 파일이 남지 않는다');

  // 예전 버전 캐시 폴더를 지우는 정리(removeOldDirs)가 돌아도 기억 파일은 남는다.
  mkdirSync(join(CACHE_ROOT, 'v1-old'), { recursive: true });
  markDirty(join(fx.home, 'projects', '-work-demo', 'aaaa7777-p2.jsonl'), () => ({ offset: 0 }));
  flushCache();
  assert.equal(existsSync(join(CACHE_ROOT, 'v1-old')), false);
  assert.equal(existsSync(parentsPath()), true);
});

test('(a3) 기본 보기에서도 jobs/<id> 의 끝난 하위 실행 여럿이 살아 있는 부모 합계에 들어가고, --all 과 같다', () => {
  clean();
  fx.session({ sessionId: 'b8f62ea6-live-job', pid: PARENT, cwd: '/work/demo' });
  fx.transcript('b8f62ea6-live-job', [cli(user('작업')), cli(assistant('L1', [], usage(1, 1)))]);
  const jobDir = join(fx.home, 'jobs', 'b8f62ea6', 'tmp');
  const folder = jobDir.replace(/[^A-Za-z0-9]/g, '-');
  for (let i = 0; i < 5; i++) {
    const id = `5ub${i}0000-run`;
    fx.transcript(id, [owner(id), sdk({ ...user('하위'), cwd: jobDir }), sdk(assistant(`r${i}`, [], usage(10, 0)))], folder);
  }
  // 하위 실행 하나는 서브에이전트를 띄웠다.
  fx.subagent('5ub00000-run', 'q', { agentType: 'Explore', description: '조사', finished: true }, [assistant('q1', [], usage(1, 0))], folder);

  const plain = run();
  assert.deepEqual(plain.map((s) => s.id), ['b8f62ea6-live-job']);
  const all = run({ showEnded: true });
  assert.deepEqual(all.map((s) => s.id), ['b8f62ea6-live-job']);
  for (const [s, what] of [[plain[0], '기본'], [all[0], '--all']]) {
    assert.equal(s.tokens.total, 2 + 50 + 1, what);
    assert.equal(s.tokens.subCount, 6, `${what}: 실행 5 + 그 서브에이전트 1`);
    assert.equal(s.members.filter((m) => m.sdk).length, 5);
  }
  assert.equal(plain[0].cost, all[0].cost);
});

test('(b) 끝난 실행은 작업 폴더 jobs/<id>/ 로 id 가 <id> 로 시작하는 세션 아래로 붙는다', () => {
  clean();
  fx.transcript('b8f62ea6-0000-job', [cli({ ...user('백그라운드 작업'), cwd: '/work/demo' }), cli(assistant('j1', [], usage(1, 1)))]);
  fx.transcript('dddd3333-sub', [owner('dddd3333-sub'), sdk({ ...user('하위 실행'), cwd: join(fx.home, 'jobs', 'b8f62ea6', 'tmp') }), sdk(assistant('d1', [], usage(40, 2)))], '-jobs-b8f62ea6-tmp');
  // 맞는 세션이 없는 jobs 폴더의 실행은 최상위에 자동 실행으로 남는다.
  fx.transcript('9999aaaa-orphan', [owner('9999aaaa-orphan'), sdk({ ...user('고아'), cwd: join(fx.home, 'jobs', '12345678', 'tmp') }), sdk(assistant('o1', [], usage(1, 1)))], '-jobs');

  // 실시간 화면처럼 한도가 있으면 끝난 기록은 선택해야 읽는다. 부모를 읽으면 붙은 실행도 (아직 안 읽었어도) 마저 읽는다.
  const lazy = run({ showEnded: true, budget: createBudget(1e9), selectedId: 'b8f62ea6-0000-job' });
  assert.equal(lazy.find((s) => s.id === 'b8f62ea6-0000-job').tokens.total, 44);
  assert.ok(!lazy.some((s) => s.id === 'dddd3333-sub'));

  const eager = run({ showEnded: true });
  assert.deepEqual(eager.map((s) => s.id).sort(), ['9999aaaa-orphan', 'b8f62ea6-0000-job']);
  assert.equal(eager.find((s) => s.id === '9999aaaa-orphan').auto, true);
  const job = eager.find((s) => s.id === 'b8f62ea6-0000-job');
  assert.equal(job.tokens.total, 2 + 42);
  assert.deepEqual(job.members, [], '끝난 부모는 서브에이전트처럼 행 없이 합계만');
});

test('(c) cron 처럼 부모가 없는 sdk-cli 실행은 최상위에 자동 표시, 응답 대기여도 사람을 부르지 않는다', () => {
  clean();
  fx.session({ sessionId: 'eeee4444-cron', pid: CHILD, cwd: '/home/u', status: 'idle', waitingFor: 'approve Bash' });
  fx.transcript('eeee4444-cron', [owner('eeee4444-cron'), sdk(user('메일 요약')), sdk(assistant('e1', [], usage(5, 5)))]);
  _setParentPid(() => 1);

  const list = run();
  assert.equal(list.length, 1);
  const [s] = list;
  assert.equal(s.auto, true);
  assert.equal(s.status, 'waiting');
  assert.equal(callsYou(s), false);
  assert.deepEqual(attentionCounts(list), { waiting: 0, stopped: 0, unseen: 0 });
  assert.equal(nextAttention(createAttention(), list, null), null, 'n 이동 대상이 아니다');
  assert.equal(freshWaiting(new Set(), list).length, 0, '알림 대상이 아니다');
  assert.equal(windowTitle(list), 'aitop');
  assert.equal(summarize(list).waiting, 0);
  assert.deepEqual(claudeLineCounts().waiting, [], '--line 도 세지 않는다');
  const w = createEventWatch({ doneMs: 0, settleMs: 0 });
  const busy = { ...s, status: 'busy', context: { used: 95, window: 100 } };
  takeEvents(w, [busy], { now: 0 });
  assert.deepEqual(takeEvents(w, [{ ...busy, status: 'idle' }], { now: 10 }), [], '완료·컨텍스트 알림도 없다');

  const row = render({ data: { sessions: list, errors: [], at: Date.now() }, selectedId: null, showDetail: false, frame: 0 }, 140, 10).map(strip).find((l) => l.includes('/home/u') || l.includes('u · eeee4444'));
  assert.ok(row.includes(`${t('session.auto')} `), '이름 앞에 자동 글자');
  assert.equal(toJson({ sessions: list, at: Date.now() }).sessions[0].auto, true);
});

test('(d) 일반 cli 세션은 부모 프로세스가 Claude 세션이어도 붙이지 않고, 서브에이전트는 그대로다', () => {
  clean();
  fx.session({ sessionId: 'ffff5555-outer', pid: PARENT });
  fx.transcript('ffff5555-outer', [cli(user('바깥')), cli(assistant('o1', [], usage(1, 1)))]);
  fx.session({ sessionId: 'abab6666-inner', pid: CHILD });
  fx.transcript('abab6666-inner', [cli(user('안쪽')), cli(assistant('i1', [{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }], usage(2, 2)))]);
  fx.subagent('abab6666-inner', 'x', { agentType: 'Explore', description: '조사', toolUseId: 'ta' }, [assistant('s1', [], usage(3, 3))]);
  _setParentPid((pid) => (pid === CHILD ? PARENT : null));

  const list = run();
  assert.deepEqual(list.map((s) => s.id).sort(), ['abab6666-inner', 'ffff5555-outer']);
  const inner = list.find((s) => s.id === 'abab6666-inner');
  assert.equal(inner.members.length, 1);
  assert.equal(inner.members[0].sdk, undefined);
  assert.equal(inner.tokens.total, 4 + 6);
  assert.ok(list.every((s) => !s.auto));
  assert.equal(attentionCounts([{ ...inner, status: 'waiting', live: true }]).waiting, 1, '사람이 연 세션의 대기는 그대로 센다');
});

test('jobIdOf: 설정 폴더의 jobs 와 그 위 홈의 .claude/jobs, 짧은 조각은 버린다', () => {
  assert.equal(jobIdOf('/h/.claude/jobs/b8f62ea6/tmp', ['/h/.claude']), 'b8f62ea6');
  assert.equal(jobIdOf('/x/cfg/jobs/AB12CD34', ['/x/cfg']), 'ab12cd34');
  assert.equal(jobIdOf('/x/.claude/jobs/b8f62ea6/tmp', ['/x/cfg']), 'b8f62ea6');
  assert.equal(jobIdOf('C:\\u\\.claude\\jobs\\b8f62ea6\\tmp', ['C:\\u\\.claude']), 'b8f62ea6');
  assert.equal(jobIdOf('/h/.claude/jobs/ab/tmp', ['/h/.claude']), null);
  assert.equal(jobIdOf('/work/demo', ['/h/.claude']), null);
  assert.equal(jobIdOf(null, ['/h/.claude']), null);
});

test('부모 pid: Linux /proc stat 4번째 칸, macOS ps 의 ppid 칸, Windows CIM ParentProcessId', () => {
  const { parsePpid, parentPidFrom, parsePs, createWinScanner } = procs;
  const stat = '4242 (node (x) y) S 4100 4242 4100 0 -1 4194560';
  assert.equal(parsePpid(stat), 4100);
  assert.equal(parsePpid('garbage'), null);
  assert.equal(parentPidFrom(4242, { os: 'linux', readStat: () => stat }), 4100);
  assert.equal(parentPidFrom(4242, { os: 'linux', readStat: () => { throw new Error('ENOENT'); } }), null);

  const ps = parsePs('  4242  4100 /usr/local/bin/claude -p hi\n  4100     1 /bin/zsh', () => true, true);
  assert.deepEqual(ps[0], { pid: 4242, ppid: 4100, argv: ['/usr/local/bin/claude', '-p', 'hi'] });
  assert.equal(parentPidFrom(4242, { os: 'darwin', list: () => ps }), 4100);
  assert.equal(parentPidFrom(7, { os: 'darwin', list: () => ps }), null);
  assert.deepEqual(parsePs('  12 /bin/x', () => true), [{ pid: 12, argv: ['/bin/x'] }], '예전 형식은 그대로');

  const cim = [
    { p: 4242, q: 4100, n: 'claude.exe', c: 'claude -p hi', s: 2000 },
    { p: 4100, q: 1, n: 'claude.exe', c: 'claude', s: 1000 },
    // 부모 pid 를 나중에 뜬 다른 프로세스가 다시 쓴 경우
    { p: 5000, q: 5001, n: 'claude.exe', c: 'claude -p x', s: 1000 },
    { p: 5001, q: 1, n: 'pwsh.exe', c: 'pwsh', s: 9000 },
  ];
  const scanner = createWinScanner({ runSync: () => JSON.stringify(cim), runAsync: async () => JSON.stringify(cim) });
  assert.equal(parentPidFrom(4242, { os: 'win32', scanner }), 4100);
  assert.equal(parentPidFrom(5000, { os: 'win32', scanner }), null);
  assert.equal(parentPidFrom(1, { os: 'win32', scanner }), null);
});
