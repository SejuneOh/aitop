// Claude Desktop Cowork(에이전트 모드) 세션 (#304).
// 가짜 앱 폴더에 세션 메타·기록·audit.jsonl 과, 열면 안 되는 다른 파일(쿠키·Local Storage·설정)을 만들고
// 찾기 규칙, 세션 행(tool cowork), 2분 실행 중 판정, isArchived, 응답 대기, 허용 목록, 설정, 장부 합산, 10초 간격을 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, utimesSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'aitop-cowork-')));
const app = join(base, 'win', 'AppData', 'Roaming', 'Claude');
const lams = join(app, 'local-agent-mode-sessions', 'acct-1', 'org-1');
mkdirSync(lams, { recursive: true });
// 앱 폴더에 함께 있는 다른 파일. aitop 은 이것을 열면 안 된다.
writeFileSync(join(app, 'Cookies'), 'SECRET-COOKIE-304');
writeFileSync(join(app, 'config.json'), '{"token":"SECRET-CONFIG-304"}');
mkdirSync(join(app, 'Local Storage', 'leveldb'), { recursive: true });
writeFileSync(join(app, 'Local Storage', 'leveldb', '000003.log'), 'SECRET-LS-304');
mkdirSync(join(app, 'IndexedDB'), { recursive: true });

// Claude 설정 폴더 (장부 중복 확인용). 이 PC 의 실제 기록과 떼어 놓는다.
const claudeHome = join(base, 'claude');
mkdirSync(join(claudeHome, 'projects'), { recursive: true });
mkdirSync(join(claudeHome, 'sessions'), { recursive: true });
const cache = join(base, 'cache');
process.env.AITOP_COWORK_HOME = app;
process.env.CLAUDE_CONFIG_DIR = claudeHome;
delete process.env.AITOP_CLAUDE_DIRS;
process.env.XDG_CACHE_HOME = cache;
process.env.XDG_CONFIG_HOME = join(base, 'config');
process.env.AITOP_AGY_HOME = join(base, 'agy-missing');
process.env.AITOP_AGY_APP_HOME = 'off';
process.env.CODEX_HOME = join(base, 'codex-missing');
process.env.GEMINI_HOME = join(base, 'gemini-missing');

// 앱 폴더 안에서 연 경로를 모은다 (test/agy-app.test.mjs 와 같은 방식).
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

const cw = await import('../src/sources/cowork.mjs');
const { findCoworkRoots, collectCowork, auditWait, pickMeta, COWORK_LIVE_MS, COWORK_TTL_MS, _test: coworkTest } = cw;
const { coworkEnv } = await import('../src/sources/dirs.mjs');
const { collectLedger } = await import('../src/sources/claude-ledger.mjs');
const { checkTools, doctorText } = await import('../src/doctor.mjs');
const { toJson } = await import('../src/json.mjs');
const { resumeCmd } = await import('../src/resume.mjs');
const { resolveConfig } = await import('../src/config.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { flushCache } = await import('../src/cache.mjs');
const { findTrace } = await import('../src/trace.mjs');
const { summarize } = await import('../src/summary.mjs');

after(() => rmSync(base, { recursive: true, force: true }));

const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const iso = (ms) => new Date(ms).toISOString();
const u = (input, output) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const SECRET_INPUT = 'rm -rf /SECRET-TOOL-INPUT-304';
const HMAC = 'SECRET-HMAC-304';

// 세션 하나: 메타 local_<id>.json, 기록 .claude/projects/<폴더>/<sid>.jsonl (+ 서브에이전트), audit.jsonl.
function makeSession(id, { sid, title = '코워크 작업', last = Date.now(), archived = false, rows, sub = null, audit = null, enc = '-sessions-demo', mtime = null }) {
  const dir = join(lams, `local_${id}`);
  const meta = { sessionId: `local_${id}`, processName: 'p', cliSessionId: sid, cwd: '/sessions/demo', userSelectedFolders: ['/x'], createdAt: last - 600_000, lastActivityAt: last, model: 'claude-opus-5-5', isArchived: archived, title, vmProcessName: 'vm', initialMessage: 'SECRET-INITIAL-304', enabledMcpTools: [] };
  writeFileSync(join(lams, `local_${id}.json`), JSON.stringify(meta));
  const pdir = join(dir, '.claude', 'projects', enc);
  mkdirSync(pdir, { recursive: true });
  const main = join(pdir, `${sid}.jsonl`);
  writeFileSync(main, lines(rows));
  if (sub) {
    mkdirSync(join(pdir, sid, 'subagents'), { recursive: true });
    writeFileSync(join(pdir, sid, 'subagents', 'agent-a1.meta.json'), '{"description":"SECRET-SUBMETA-304"}');
    writeFileSync(join(pdir, sid, 'subagents', 'agent-a1.jsonl'), lines(sub));
  }
  // 세션 폴더의 다른 파일 (열면 안 된다).
  writeFileSync(join(dir, 'outputs.txt'), 'SECRET-OUTPUT-304');
  if (audit) writeFileSync(join(dir, 'audit.jsonl'), lines(audit));
  if (mtime != null) for (const p of [main]) utimesSync(p, mtime / 1000, mtime / 1000);
  return { dir, main, metaPath: join(lams, `local_${id}.json`) };
}

const convo = (at, id = 'm1', n = 1000) => [
  { type: 'user', timestamp: iso(at - 20_000), entrypoint: 'local-agent', cwd: '/sessions/demo', message: { content: '보고서 정리해줘' } },
  { type: 'assistant', timestamp: iso(at - 10_000), entrypoint: 'local-agent', message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: '정리했습니다' }], usage: u(n, 100) } },
];
const req = (tool, at) => ({ type: 'system', subtype: 'permission_request', session_id: 's', tool_name: tool, tool_input: { command: SECRET_INPUT }, uuid: 'u1', _audit_hmac: HMAC, _audit_timestamp: iso(at) });
const res = (sub, at) => ({ type: 'system', subtype: sub, session_id: 's', tool_name: 'Bash', decision: 'once', granted: true, uuid: 'u2', _audit_hmac: HMAC, _audit_timestamp: iso(at) });
const noise = (at) => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'SECRET-AUDIT-MSG-304' }] }, _audit_hmac: HMAC, _audit_timestamp: iso(at) });

const now = Date.now();
const SID = {
  live: '11111111-0000-4000-8000-000000000001',
  old: '11111111-0000-4000-8000-000000000002',
  arch: '11111111-0000-4000-8000-000000000003',
  wait: '11111111-0000-4000-8000-000000000004',
  ok: '11111111-0000-4000-8000-000000000005',
  auto: '11111111-0000-4000-8000-000000000006',
  fresh: '11111111-0000-4000-8000-000000000007',
};
const S = {
  live: makeSession('aaaa0001', { sid: SID.live, title: '분기 보고서 sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV', last: now - 30_000, rows: convo(now - 30_000), sub: [{ type: 'assistant', timestamp: iso(now - 20_000), message: { id: 's1', model: 'claude-opus-5-5', content: [], usage: u(500, 50) } }] }),
  old: makeSession('aaaa0002', { sid: SID.old, title: '어제 작업', last: now - 3600_000, rows: convo(now - 3600_000, 'm2', 2000), mtime: now - 3600_000 }),
  arch: makeSession('aaaa0003', { sid: SID.arch, title: '보관함', last: now - 10_000, archived: true, rows: convo(now - 10_000, 'm3', 300) }),
  wait: makeSession('aaaa0004', { sid: SID.wait, title: '대기 세션', last: now - 20_000, rows: convo(now - 20_000, 'm4', 400), audit: [noise(now - 40_000), res('permission_response', now - 35_000), req('Bash', now - 15_000), noise(now - 14_000)] }),
  ok: makeSession('aaaa0005', { sid: SID.ok, title: '응답한 세션', last: now - 20_000, rows: convo(now - 20_000, 'm5', 400), audit: [req('Bash', now - 30_000), res('permission_response', now - 25_000)] }),
  auto: makeSession('aaaa0006', { sid: SID.auto, title: '자동 승인 세션', last: now - 20_000, rows: convo(now - 20_000, 'm6', 400), audit: [req('Edit', now - 30_000), res('permission_auto_approved', now - 25_000)] }),
  // 메타의 lastActivityAt 은 오래됐지만 기록이 막 바뀐 세션 → 실행 중.
  fresh: makeSession('aaaa0007', { sid: SID.fresh, title: '기록만 새로움', last: now - 3 * 3600_000, rows: convo(now - 30_000, 'm7', 100) }),
};

const budget = () => createBudget();
const byId = (list) => new Map(list.map((s) => [s.id, s]));

test('앱 폴더 찾기: 환경 변수 > 설정 > 저절로(macOS, Windows MSIX·일반 설치, WSL). local-agent-mode-sessions/ 가 있는 것만', () => {
  const mk = (p) => (mkdirSync(join(p, 'local-agent-mode-sessions'), { recursive: true }), p);
  const h = join(base, 'h');
  const mac = mk(join(h, 'Library', 'Application Support', 'Claude'));
  assert.deepEqual(findCoworkRoots({ env: {}, home: h, platform: 'darwin' }), [mac]);
  assert.deepEqual(findCoworkRoots({ env: {}, home: join(base, 'none'), platform: 'darwin' }), [], '폴더가 없으면 넣지 않는다');
  assert.deepEqual(findCoworkRoots({ env: { AITOP_COWORK_HOME: 'off' }, home: h, platform: 'darwin' }), [], '환경 변수로 끈다');
  assert.deepEqual(findCoworkRoots({ env: {}, home: h, platform: 'darwin', app: false }), [], '설정 파일 cowork: false');
  assert.deepEqual(findCoworkRoots({ env: { AITOP_COWORK_HOME: app }, home: h, platform: 'darwin', app: false }), [app], '환경 변수가 설정 파일보다 높다');
  assert.deepEqual(findCoworkRoots({ env: {}, home: h, platform: 'linux', wsl: false, app: [app] }), [app], '설정 파일의 경로 목록');
  // Windows: MSIX(Packages\Claude_*) 와 일반 설치(%APPDATA%\Claude). 세션 폴더가 없는 것은 뺀다.
  const local = join(base, 'wl');
  const msix = mk(join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude'));
  mkdirSync(join(local, 'Packages', 'Other_1', 'LocalCache', 'Roaming', 'Claude'), { recursive: true });
  const roaming = mk(join(base, 'wr', 'Claude'));
  assert.deepEqual(findCoworkRoots({ env: { LOCALAPPDATA: local, APPDATA: join(base, 'wr') }, home: h, platform: 'win32' }), [msix, roaming]);
  // WSL: Windows 홈의 AppData 두 곳.
  const win = join(base, 'winhome');
  const wm = mk(join(win, 'AppData', 'Local', 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'Claude'));
  const wr = mk(join(win, 'AppData', 'Roaming', 'Claude'));
  assert.deepEqual(findCoworkRoots({ env: {}, home: join(base, 'none'), platform: 'linux', wsl: true, winHomes: () => [win] }), [wm, wr]);
  assert.deepEqual(findCoworkRoots({ env: {}, home: join(base, 'none'), platform: 'linux', wsl: false, winHomes: () => [win] }), [], 'WSL 이 아니면 Windows 홈을 보지 않는다');
});

test('세션 행: tool cowork, entrypoint local-agent, 메타 제목(가림)·모델·작업 폴더, 기록의 토큰·비용·서브에이전트', () => {
  const list = collectCowork({ showEnded: false, budget: budget() });
  const s = byId(list).get(SID.live);
  assert.ok(s, '실행 중 세션이 보인다');
  assert.equal(s.tool, 'cowork');
  assert.equal(s.entrypoint, 'local-agent');
  assert.equal(s.live, true);
  assert.equal(s.pid, null);
  assert.equal(s.cwd, '/sessions/demo');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.match(s.name, /^분기 보고서 /);
  assert.ok(!s.name.includes('ABCDEFGHIJKLMNOP'), '제목의 비밀값은 가린다');
  assert.equal(s.tokens.main, 1100);
  assert.equal(s.tokens.sub, 550, '서브에이전트 기록도 더한다');
  assert.equal(s.tokens.subCount, 1);
  assert.ok(s.cost > 0);
  assert.equal(resumeCmd(s), null, '이어 열기 명령은 만들지 않는다');
  const j = toJson({ sessions: [s] }).sessions[0];
  assert.equal(j.tool, 'cowork');
  assert.equal(j.entrypoint, 'local-agent');
});

test('실행 중: lastActivityAt 과 기록 수정 시각 중 늦은 쪽이 2분 안. isArchived 면 종료', () => {
  const live = byId(collectCowork({ showEnded: false, budget: budget() }));
  assert.ok(!live.has(SID.old), '1시간 조용한 세션은 실행 중이 아니다');
  assert.ok(!live.has(SID.arch), '보관한 세션은 최근에 바뀌었어도 종료');
  assert.equal(live.get(SID.fresh)?.live, true, '메타는 오래됐어도 기록이 막 바뀌었으면 실행 중');
  const all = byId(collectCowork({ showEnded: true, budget: budget() }));
  assert.equal(all.get(SID.old)?.status, 'ended');
  assert.equal(all.get(SID.arch)?.status, 'ended');
  assert.equal(all.get(SID.old)?.tokens.total, 2100, '--once 처럼 한도 없이 읽으면 끝난 세션도 숫자가 찬다');
  // 2분 판정은 매 갱신 지금 시각으로 한다 (TTL 안이어도).
  const later = byId(collectCowork({ showEnded: false, budget: budget(), now: now + COWORK_LIVE_MS + 5_000 }));
  assert.ok(!later.has(SID.live), '2분이 지나면 바로 종료로 본다');
});

test('응답 대기: audit.jsonl 의 마지막 권한 요청이 마지막 응답보다 뒤면 waiting, 대상은 tool_name', () => {
  const list = collectCowork({ showEnded: false, budget: budget() });
  const m = byId(list);
  const w = m.get(SID.wait);
  assert.equal(w.status, 'waiting');
  assert.equal(w.waitingFor, 'approve Bash');
  assert.equal(w.phase.kind, 'waiting');
  assert.ok(Math.abs(w.waitSince - (now - 15_000)) < 1000, '대기 시작은 요청 시각');
  assert.notEqual(m.get(SID.ok).status, 'waiting', '요청 → 응답');
  assert.notEqual(m.get(SID.auto).status, 'waiting', '요청 → 자동 승인');
  // 헤더·--line 요약도 센다 (claude 가 아닌 몫).
  const sum = summarize(list, now);
  assert.equal(sum.waitingOther, 1);
  assert.equal(sum.waitTop[0].tool, 'cowork');
  // 순수 판정
  const L = (...xs) => xs.map((x) => JSON.stringify(x));
  assert.equal(auditWait(L(req('Bash', now))).tool, 'Bash', '요청만');
  assert.equal(auditWait(L(req('Bash', now), res('permission_response', now))), null, '요청 → 응답');
  assert.equal(auditWait(L(req('Bash', now), res('permission_auto_approved', now))), null, '요청 → 자동 승인');
  assert.equal(auditWait(L(req('Bash', now), res('permission_denied', now))), null, '요청 → 거절');
  assert.equal(auditWait(L(res('permission_response', now), req('Write', now))).tool, 'Write', '응답 뒤의 새 요청');
  assert.equal(auditWait(['{bad', 'permission_ x']), null);
  // 끝난 세션은 audit 에 요청이 남아 있어도 대기가 아니다.
  const ended = byId(collectCowork({ showEnded: true, budget: budget(), now: now + COWORK_LIVE_MS + 5_000 })).get(SID.wait);
  assert.equal(ended.status, 'ended');
});

test('tool_input·_audit_hmac·audit 의 대화 내용과 메타의 initialMessage 는 출력·캐시에 남지 않는다', () => {
  const list = collectCowork({ showEnded: true, budget: budget() });
  const out = JSON.stringify(toJson({ sessions: list }, null, { showRequests: true }));
  flushCache();
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name)));
  };
  try {
    walk(cache);
  } catch {}
  const cached = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const secret of ['SECRET-TOOL-INPUT-304', HMAC, 'SECRET-AUDIT-MSG-304', 'SECRET-INITIAL-304', 'SECRET-SUBMETA-304']) {
    assert.ok(!out.includes(secret), `출력: ${secret}`);
    assert.ok(!cached.includes(secret), `캐시: ${secret}`);
  }
  assert.deepEqual(Object.keys(pickMeta({ initialMessage: 'x', title: 't', foo: 1 })).sort(), ['cliSessionId', 'createdAt', 'cwd', 'isArchived', 'lastActivityAt', 'model', 'sessionId', 'title']);
});

test('세션 목록·메타·audit 는 10초(COWORK_TTL_MS)에 한 번만 다시 본다. 2분 판정은 지금 시각으로', () => {
  coworkTest.age(COWORK_TTL_MS);
  const pick = () => byId(collectCowork({ showEnded: false, budget: budget() })).get(SID.ok);
  assert.equal(pick()?.name, '응답한 세션');
  const meta = JSON.parse(readFileSync(S.ok.metaPath, 'utf8'));
  writeFileSync(S.ok.metaPath, JSON.stringify({ ...meta, title: '바뀐 제목' }));
  writeFileSync(join(S.ok.dir, 'audit.jsonl'), lines([req('Bash', now - 30_000), res('permission_response', now - 25_000), req('Read', Date.now())]));
  const cached = pick();
  assert.equal(cached?.name, '응답한 세션', 'TTL 안에서는 지난 메타를 쓴다');
  assert.notEqual(cached?.status, 'waiting', 'TTL 안에서는 audit 도 다시 보지 않는다');
  coworkTest.age(COWORK_TTL_MS);
  const next = pick();
  assert.equal(next?.name, '바뀐 제목');
  assert.equal(next?.waitingFor, 'approve Read');
});

test('장부: Cowork 기록을 Claude 7일 합계에 더하고, ~/.claude/projects 에 같은 기록이 있으면 한 번만 센다', () => {
  const before = collectLedger({ budget: budget(), fold: false }).week.tokens;
  // 오늘 쓴 Cowork 기록: live 1100 + 서브 550 + old 2100 + arch 400(300+100) + wait 500 + ok 500 + auto 500 + fresh 200.
  assert.equal(before, 1100 + 550 + 2100 + 400 + 500 * 3 + 200);
  // 같은 기록(같은 상대 경로)을 Claude 설정 폴더에 복사해도 늘지 않는다.
  const dup = join(claudeHome, 'projects', '-sessions-demo');
  mkdirSync(dup, { recursive: true });
  writeFileSync(join(dup, `${SID.old}.jsonl`), readFileSync(S.old.main, 'utf8'));
  utimesSync(join(dup, `${SID.old}.jsonl`), (now - 3600_000) / 1000, (now - 3600_000) / 1000);
  coworkTest.age(COWORK_TTL_MS);
  // 장부의 파일 목록은 30초 간격이라 시각을 넘겨 다시 모은다.
  const again = collectLedger({ budget: budget(), now: Date.now() + 31_000, fold: false });
  assert.equal(again.week.tokens, before, '중복 없음');
});

test('--report trace 는 Cowork 세션 id 로도 기록을 찾는다', async () => {
  const r = await findTrace(SID.live);
  assert.equal(r.tool, 'claude');
  assert.ok(r.path.startsWith(app), r.path);
});

test('--doctor 에 Cowork 앱 폴더 줄이 보이고, 앱 폴더가 없으면 cowork 가 빠진다', () => {
  const r = checkTools({ home: join(base, 'none'), coworkRoots: [app] });
  assert.equal(r.tools.cowork.state, 'ok');
  assert.equal(r.tools.cowork.records, 7);
  const text = doctorText(r, '9.9.9', Date.now(), 'ko');
  assert.match(text, /✓ cowork +찾음 +\S/);
  assert.match(text, /Claude 앱 · 세션 7개/);
  const en = doctorText(r, '9.9.9', Date.now(), 'en');
  assert.match(en, /Claude app · 7 sessions/);
  assert.equal(checkTools({ home: join(base, 'none'), coworkRoots: [] }).tools.cowork, undefined);
});

test('설정 파일 cowork 와 AITOP_COWORK_HOME: 환경 변수 > 파일 > 기본(true), 잘못된 값은 경고', () => {
  const file = (values) => ({ path: '/x/config.json', exists: true, values, problems: [] });
  assert.deepEqual(resolveConfig({ env: {}, file: file({}) }).values.cowork, { value: true, source: 'default' });
  assert.deepEqual(resolveConfig({ env: {}, file: file({ cowork: false }) }).values.cowork, { value: false, source: 'file' });
  assert.deepEqual(resolveConfig({ env: {}, file: file({ cowork: ['/a/Claude'] }) }).values.cowork, { value: ['/a/Claude'], source: 'file' });
  assert.deepEqual(resolveConfig({ env: { AITOP_COWORK_HOME: 'off' }, file: file({ cowork: true }) }).values.cowork, { value: false, source: 'env' });
  assert.deepEqual(resolveConfig({ env: { AITOP_COWORK_HOME: '/b/Claude' }, file: file({}) }).values.cowork, { value: ['/b/Claude'], source: 'env' });
  for (const v of ['on', '1', 'rel/path']) {
    assert.equal(coworkEnv(v), undefined, v);
    const c = resolveConfig({ env: { AITOP_COWORK_HOME: v }, file: file({ cowork: false }) });
    assert.deepEqual(c.values.cowork, { value: false, source: 'file' }, v);
    assert.ok(c.problems.some((p) => p.includes('AITOP_COWORK_HOME')), v);
  }
  const bad = resolveConfig({ env: {}, file: { path: '/x', exists: true, values: {}, problems: [] } });
  assert.equal(bad.values.cowork.value, true);
});

test('앱 폴더에서는 세션 메타·기록 jsonl·audit.jsonl 만 열고, 그 밖에는 폴더 목록만 본다', () => {
  assert.ok(touched.size > 0, '앱 폴더를 읽기는 했다');
  const sessions = join(app, 'local-agent-mode-sessions');
  const ok = (p) => {
    if (p === app || p === join(app, 'local-agent-mode-sessions')) return true;
    if (!p.startsWith(sessions + sep)) return false;
    const rel = p.slice(sessions.length + 1).split(sep);
    // <uuid>, <uuid>/<uuid> 폴더 (목록만)
    if (rel.length <= 2) return statSync(p, { throwIfNoEntry: false })?.isDirectory() !== false;
    if (rel.length === 3) return /^local_[\w-]+\.json$/.test(rel[2]);
    if (rel.length === 4 && rel[3] === 'audit.jsonl') return true;
    // local_<id>/.claude/projects 아래의 폴더와 .jsonl
    if (rel[3] !== '.claude' || (rel.length > 4 && rel[4] !== 'projects')) return false;
    // 없는 경로(서브에이전트 폴더가 있는지 본 것)는 연 것이 아니다.
    const st = statSync(p, { throwIfNoEntry: false });
    return rel.length <= 5 || p.endsWith('.jsonl') || !st || st.isDirectory();
  };
  assert.deepEqual([...touched].filter((p) => !ok(p)), []);
  assert.ok(![...touched].some((p) => p.endsWith('.meta.json')), '서브에이전트 메타도 열지 않는다');
});
