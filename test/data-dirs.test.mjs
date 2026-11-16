// Claude 설정 폴더·Codex 홈을 여러 개 읽는다 (#212).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, renameSync, utimesSync, copyFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assistant, user, usage } from './fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'aitop-dirs-'));
const C1 = join(root, 'claude-a');
const C2 = join(root, 'claude-b');
const X1 = join(root, 'codex-a');
const X2 = join(root, 'codex-b');
for (const d of [C1, C2]) for (const s of ['sessions', 'projects']) mkdirSync(join(d, s), { recursive: true });
// 같은 폴더를 링크로 한 번 더 적어도 한 번만 읽는다.
symlinkSync(C1, join(root, 'claude-a-link'), process.platform === 'win32' ? 'junction' : 'dir');
process.env.CLAUDE_CONFIG_DIR = [C1, C2, join(root, 'claude-a-link'), ''].join(delimiter);
process.env.CODEX_HOME = [X1, X2].join(delimiter);
process.env.XDG_CACHE_HOME = join(root, 'cache');
process.env.XDG_CONFIG_HOME = join(root, 'config');
process.env.XDG_STATE_HOME = join(root, 'state');
process.env.AITOP_AGY_HOME = join(root, 'agy-missing');
process.env.GEMINI_HOME = join(root, 'gemini-missing');

const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
function transcript(home, id, rows, project = '-work-demo') {
  const dir = join(home, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, lines(rows));
  return p;
}
// 살아 있는 세션은 이 테스트 프로세스의 pid 를 쓴다. 폴더가 다르면 같은 pid 파일 이름도 따로 센다.
function session(home, sessionId, cwd) {
  const now = Date.now();
  writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, cwd, kind: 'bg', status: 'busy', startedAt: now - 60_000, updatedAt: now }));
}
// 두 번째 세션: 살아 있는 다른 pid(부모 프로세스). 기록은 두 폴더에 있고 C2 쪽이 더 최근이며 이름이 붙어 있다.
function sessionPid(home, pid, sessionId, cwd) {
  const now = Date.now();
  writeFileSync(join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, kind: 'bg', status: 'busy', startedAt: now - 60_000, updatedAt: now }));
}
function rollout(home, name, output) {
  const d = new Date();
  const dir = join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-${name}.jsonl`);
  const count = { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: output, total_tokens: output }, last_token_usage: { total_tokens: 1 } } } };
  writeFileSync(p, lines([{ type: 'session_meta', payload: { id: name, cwd: `/work/${name}` } }, { type: 'turn_context', payload: { model: 'gpt-5.1-codex', cwd: `/work/${name}` } }, count]));
  return p;
}

session(C1, 'aaaaaaaa-1111', '/work/one');
session(C2, 'bbbbbbbb-2222', '/work/two');
transcript(C1, 'aaaaaaaa-1111', [user('하나'), assistant('m1', [{ type: 'text', text: '네' }], usage(1000, 100))], '-work-one');
// 두 번째 폴더의 기록에만 /rename 이름(custom-title)이 있다 (#213).
transcript(C2, 'bbbbbbbb-2222', [user('둘'), assistant('m2', [{ type: 'text', text: '네' }], usage(2000, 200)), { type: 'custom-title', customTitle: '둘째-이름', sessionId: 'bbbbbbbb-2222' }], '-work-two');
sessionPid(C1, process.ppid, 'gggggggg-7777', '/work/seven');
const oldCopy = transcript(C1, 'gggggggg-7777', [user('일곱'), assistant('m7', [{ type: 'text', text: '네' }], usage(1, 1))], '-work-seven');
utimesSync(oldCopy, Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);
transcript(C2, 'gggggggg-7777', [user('일곱'), assistant('m7', [{ type: 'text', text: '네' }], usage(1, 1)), { type: 'custom-title', customTitle: '새-쪽', sessionId: 'gggggggg-7777' }], '-work-seven');
// 같은 끝난 세션 기록이 두 폴더에 복사돼 있다. 한 번만 센다.
const dupA = transcript(C1, 'cccccccc-3333', [user('셋'), assistant('m3', [{ type: 'text', text: '네' }], usage(4000, 400))], '-work-three');
mkdirSync(join(C2, 'projects', '-work-three'), { recursive: true });
copyFileSync(dupA, join(C2, 'projects', '-work-three', 'cccccccc-3333.jsonl'));
rollout(X1, 'x1', 100_000);
rollout(X2, 'x2', 200_000);
const dupX = rollout(X1, 'x3', 50_000);
const copy = dupX.replace(X1, X2);
mkdirSync(join(copy, '..'), { recursive: true });
copyFileSync(dupX, copy);
// 홈마다 session_index.jsonl. x1 은 자기 홈(X1) 이름이 이기고, x2 는 X2 에만 있다.
writeFileSync(join(X1, 'session_index.jsonl'), lines([{ id: 'x1', thread_name: '알파', updated_at: '2026-11-16T00:00:00Z' }]));
writeFileSync(join(X2, 'session_index.jsonl'), lines([{ id: 'x1', thread_name: '다른-홈', updated_at: '2026-11-16T00:00:00Z' }, { id: 'x2', thread_name: '베타', updated_at: '2026-11-16T00:00:00Z' }]));

const dirs = await import('../src/sources/dirs.mjs');
const { collectClaude, claudeWaiting, _setStaleKeepMs } = await import('../src/sources/claude.mjs');
const { collectCodex } = await import('../src/sources/codex.mjs');
const { collectLedger, collectDaily, oldestClaudeMtime } = await import('../src/sources/claude-ledger.mjs');
const { attachProjects } = await import('../src/sources/projects.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { resolveConfig, readConfigFile, configText } = await import('../src/config.mjs');
const { checkTools, doctorText } = await import('../src/doctor.mjs');
const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'aitop.mjs');

test('구분자로 나눈 경로: 빈 칸은 버리고, 남는 것이 없으면 정하지 않은 것', () => {
  assert.deepEqual(dirs.splitPaths('/a:/b::/c ', ':'), ['/a', '/b', '/c']);
  assert.deepEqual(dirs.splitPaths('C:\\a;D:\\b', ';'), ['C:\\a', 'D:\\b']);
  assert.equal(dirs.splitPaths('', ':'), undefined);
  assert.equal(dirs.splitPaths(' : ', ':'), undefined);
  assert.equal(dirs.splitPaths(undefined), undefined);
  // 값 전체가 있는 폴더면 나누지 않는다.
  const exists = (p) => p === '/old:style';
  assert.deepEqual(dirs.splitPaths('/old:style', ':', exists), ['/old:style']);
  assert.deepEqual(dirs.splitPaths('/a:/b', ':', exists), ['/a', '/b']);
  // 폴더인지 보기 전에 ~ 를 푼다.
  assert.deepEqual(dirs.splitPaths('~/old:style', ':', (p) => p === join(homedir(), 'old:style')), ['~/old:style']);
  if (process.platform !== 'win32') {
    const colon = join(root, 'with:colon');
    mkdirSync(colon);
    assert.deepEqual(dirs.splitPaths(colon, ':'), [colon]);
  }
});

test('같은 실제 경로(링크, ~)는 한 번만, 처음 적은 순서대로', () => {
  assert.deepEqual(dirs.claudeDirs(), [C1, C2]);
  assert.deepEqual(dirs.codexHomes(), [X1, X2]);
  assert.deepEqual(dirs.uniqueDirs(['~/p', '~/p/', '/q'], '/h'), ['/h/p', '/q']);
  assert.equal(dirs.pathLike('~/x'), true);
  assert.equal(dirs.pathLike('rel/x'), false);
  assert.equal(dirs.pathLike('C:\\x'), true);
});

test('설정: AITOP_* > 설정 파일 > 물려받은 CLAUDE_CONFIG_DIR·CODEX_HOME > 기본값, 잘못된 목록은 무시', () => {
  const file = (values, problems = []) => ({ path: '/x', exists: true, values, problems });
  // aitop 전용 변수는 설정 파일보다 먼저.
  const own = resolveConfig({ env: { AITOP_CLAUDE_DIRS: `/e1${delimiter}/e2`, CLAUDE_CONFIG_DIR: '/inh' }, file: file({ claudeDirs: ['/f1'] }) });
  assert.deepEqual(own.values.claudeDirs, { value: ['/e1', '/e2'], source: 'env', env: 'AITOP_CLAUDE_DIRS' });
  assert.deepEqual(own.problems, []);
  // 물려받은 CLAUDE_CONFIG_DIR 는 설정 파일 다음.
  const fromFile = resolveConfig({ env: { CLAUDE_CONFIG_DIR: '/inh', CODEX_HOME: '/inh-codex' }, file: file({ claudeDirs: ['/f1', '~/f2'], codexHomes: ['/g'] }) }).values;
  assert.deepEqual(fromFile.claudeDirs, { value: ['/f1', '~/f2'], source: 'file' });
  assert.deepEqual(fromFile.codexHomes, { value: ['/g'], source: 'file' });
  const inherited = resolveConfig({ env: { CLAUDE_CONFIG_DIR: `/i1${delimiter}/i2` }, file: file({}) });
  assert.deepEqual(inherited.values.claudeDirs, { value: ['/i1', '/i2'], source: 'env', env: 'CLAUDE_CONFIG_DIR' });
  assert.match(configText(inherited), /claudeDirs +\/i1,\/i2 +env \(CLAUDE_CONFIG_DIR\)/);
  assert.equal(resolveConfig({ env: { CODEX_HOME: '' }, file: file({}) }).values.codexHomes.source, 'default');
  assert.equal(resolveConfig({ env: { AITOP_CODEX_HOMES: ' ' }, file: file({ codexHomes: ['/g'] }) }).values.codexHomes.source, 'file');
  const p = join(root, 'cfg-bad.json');
  writeFileSync(p, JSON.stringify({ claudeDirs: ['relative/dir'], codexHomes: [] }));
  const bad = readConfigFile(p);
  assert.deepEqual(bad.values, {});
  assert.equal(bad.problems.length, 2);
});

test('살아 있는 세션은 두 Claude 폴더 모두에서 보인다', () => {
  const ids = collectClaude({ showEnded: false, budget: createBudget(), selectedId: null }).map((s) => s.id).sort();
  assert.deepEqual(ids, ['aaaaaaaa-1111', 'bbbbbbbb-2222', 'gggggggg-7777']);
  const ended = collectClaude({ showEnded: true, budget: createBudget(), selectedId: null }).filter((s) => s.id === 'cccccccc-3333');
  assert.equal(ended.length, 1);
});

test('두 Claude 폴더 중 다른 폴더 기록의 custom-title 이 그 세션 이름이 된다', () => {
  const s = collectClaude({ showEnded: false, budget: createBudget(), selectedId: null });
  const byId = Object.fromEntries(s.map((x) => [x.id, x]));
  assert.equal(byId['bbbbbbbb-2222'].name, '둘째-이름');
  assert.equal(byId['bbbbbbbb-2222'].customName, '둘째-이름');
  assert.equal(byId['aaaaaaaa-1111'].customName, null);
});

test('같은 세션 기록이 두 폴더에 있으면 더 최근에 바뀐 쪽을 읽는다', () => {
  const s = collectClaude({ showEnded: false, budget: createBudget(), selectedId: null }).find((x) => x.id === 'gggggggg-7777');
  assert.equal(s.name, '새-쪽');
});

const liveIds = () => collectClaude({ showEnded: false, budget: createBudget(), selectedId: null }).map((x) => x.id).sort();

test('폴더의 sessions/ 가 사라지면 그 폴더 세션은 바로 빠진다', () => {
  assert.ok(liveIds().includes('bbbbbbbb-2222'));
  renameSync(join(C2, 'sessions'), join(C2, 'sessions-moved'));
  try {
    assert.ok(!liveIds().includes('bbbbbbbb-2222'));
    assert.ok(liveIds().includes('aaaaaaaa-1111'));
  } finally {
    renameSync(join(C2, 'sessions-moved'), join(C2, 'sessions'));
  }
  assert.ok(liveIds().includes('bbbbbbbb-2222'));
});

test('읽기 오류(EACCES)는 잠깐 동안만 직전 결과를 쓰고, 그 뒤에는 뺀다', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const before = liveIds();
  chmodSync(C2, 0o000);
  try {
    assert.deepEqual(liveIds(), before);
    // --line 의 응답 대기 목록도 같은 경로를 쓴다 (예외 없이 돈다).
    assert.ok(Array.isArray(claudeWaiting()));
    _setStaleKeepMs(-1);
    assert.ok(!liveIds().includes('bbbbbbbb-2222'));
    assert.ok(liveIds().includes('aaaaaaaa-1111'));
  } finally {
    _setStaleKeepMs(30_000);
    chmodSync(C2, 0o755);
  }
  assert.deepEqual(liveIds(), before);
});

test('설정 파일 목록 때문에 쓰지 않는 CLAUDE_CONFIG_DIR 도 기록이 있으면 후보', () => {
  const inh = join(root, 'inherited-claude');
  transcript(inh, 'hhhhhhhh-1', [user('x')]);
  const c = dirs.candidateDirs({ home: join(root, 'nohome'), claude: [C1], codex: [X1], env: { CLAUDE_CONFIG_DIR: inh } });
  assert.deepEqual(c.claude, [inh]);
  assert.deepEqual(dirs.candidateDirs({ home: join(root, 'nohome'), claude: [C1, inh], codex: [X1], env: { CLAUDE_CONFIG_DIR: inh } }).claude, []);
});

test('Codex 홈마다 session_index 이름이 그 홈의 세션에 붙는다', () => {
  const s = collectCodex({ showEnded: false, budget: createBudget(), canList: () => false });
  const byId = Object.fromEntries(s.map((x) => [x.id, x.customName]));
  assert.deepEqual(byId, { x1: '알파', x2: '베타', x3: null });
});

test('Codex 홈 두 곳의 기록을 다 읽고, 같은 rollout 은 한 번만', () => {
  const got = collectCodex({ showEnded: false, budget: createBudget(), canList: () => false }).map((s) => s.id).sort();
  assert.deepEqual(got, ['x1', 'x2', 'x3']);
});

test('장부와 리포트: 두 폴더 기록을 더하고 복사본은 한 번만 센다', () => {
  const books = collectDaily({ budget: createBudget(), days: 30 }).books;
  const claude = books.filter((b) => b.tool === 'claude');
  const codex = books.filter((b) => b.tool === 'codex');
  assert.equal(claude.length, 4);
  assert.equal(codex.length, 3);
  const tokens = (bs) => bs.reduce((n, b) => n + Object.values(b.days).reduce((m, d) => m + d.tokens, 0), 0);
  assert.equal(tokens(claude), 1100 + 2200 + 4400 + 2);
  assert.equal(tokens(codex), 350_000);
  const today = collectLedger({ budget: createBudget(), fold: false }).today;
  assert.equal(today.tokens, 1100 + 2200 + 4400 + 2 + 350_000);
  // 프로젝트 이름은 각 폴더의 기록에서 찾는다.
  const projects = attachProjects(claude).map((b) => b.project).sort();
  assert.deepEqual(projects, ['-work-one', '-work-seven', '-work-three', '-work-two']);
});

test('월별 경계: 폴더마다 가장 오래된 기록 중 가장 늦은 시각', () => {
  const old = transcript(C1, 'dddddddd-old', [user('x')], '-work-old');
  const t1 = Date.now() / 1000 - 40 * 86400;
  utimesSync(old, t1, t1);
  const old2 = transcript(C2, 'eeeeeeee-old', [user('x')], '-work-old');
  const t2 = Date.now() / 1000 - 20 * 86400;
  utimesSync(old2, t2, t2);
  assert.equal(Math.round(oldestClaudeMtime() / 1000), Math.round(t2));
});

test('--doctor: 읽는 폴더 전부와, 기록이 있는데 읽지 않는 후보 폴더', () => {
  const home = join(root, 'home');
  transcript(join(home, '.claude-work'), 'ffffffff-1', [user('x')]);
  mkdirSync(join(home, '.claude-empty', 'projects'), { recursive: true });
  rollout(join(home, '.codex-alt'), 'y1', 10);
  writeFileSync(join(home, '.claude.json'), '{}');
  const r = checkTools({ home });
  assert.deepEqual(r.tools.claude.dirs.map((d) => d.found), [true, true]);
  assert.equal(r.tools.claude.records, 6);
  assert.deepEqual(r.tools.claude.candidates, [{ path: join(home, '.claude-work'), records: 1 }]);
  assert.deepEqual(r.tools.codex.candidates.map((c) => c.path), [join(home, '.codex-alt')]);
  assert.equal(r.tools.codex.records, 3);
  const text = doctorText(r, '9.9.9', Date.now(), 'ko');
  assert.ok(text.includes(join(C2, 'projects')));
  assert.match(text, /읽지 않는 기록 폴더 .*\.claude-work \(기록 1개\)/);
  assert.match(text, /claudeDirs/);
  assert.match(text, /codexHomes/);
});

test('aitop --print-config 와 --doctor --json 에 목록이 보인다', () => {
  const env = { ...process.env, AITOP_LANG: 'en' };
  const cfg = JSON.parse(spawnSync(process.execPath, [BIN, '--print-config', '--json'], { env, encoding: 'utf8' }).stdout);
  assert.deepEqual(cfg.values.claudeDirs.value, [C1, C2, join(root, 'claude-a-link')]);
  assert.equal(cfg.values.claudeDirs.source, 'env');
  assert.equal(cfg.values.claudeDirs.env, 'CLAUDE_CONFIG_DIR');
  const doc = JSON.parse(spawnSync(process.execPath, [BIN, '--doctor', '--json'], { env, encoding: 'utf8' }).stdout);
  assert.equal(doc.tools.claude.dirs.length, 2);
  assert.equal(doc.tools.codex.dirs.length, 2);
  assert.ok(Array.isArray(doc.tools.claude.candidates));
});
