// 설치한 aitop 을 임시 기록 폴더로 실행해 본다 (CI 의 Windows 작업용, #194). 실제 홈의 기록은 읽지 않는다.
// 사용: node test/smoke.mjs            → PATH 의 aitop 을 부른다 (npm i -g 로 설치한 것, Windows 는 aitop.cmd)
//       AITOP_BIN=bin/aitop.mjs node test/smoke.mjs → 저장소의 bin 을 node 로 부른다
// Claude 세션 pid 는 이 스크립트라서, 도는 동안 aitop 이 실행 중인 세션으로 본다.
// Codex 는 프로세스가 없으므로, 프로세스 목록을 못 얻는 Windows 에서만 최근 기록으로 실행 중이 된다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const WIN = process.platform === 'win32';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const fx = makeClaudeHome();
const root = mkdtempSync(join(tmpdir(), 'aitop-smoke-'));
const cwd = WIN ? 'C:\\work\\smoke-claude' : '/work/smoke-claude';
fx.session({ sessionId: 'smoke000-1', name: 'smoke session', status: 'idle', cwd });
fx.transcript('smoke000-1', [user('hello'), assistant('m1', [{ type: 'text', text: 'hi' }], usage(1200, 300))], WIN ? 'C--work-smoke-claude' : '-work-smoke-claude');

// Codex rollout 하나 (방금 쓴 것)
const codexHome = join(root, 'codex');
const d = new Date();
const day = join(codexHome, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
mkdirSync(day, { recursive: true });
const codexCwd = WIN ? 'C:\\work\\smoke-codex' : '/work/smoke-codex';
writeFileSync(
  join(day, 'rollout-smoke.jsonl'),
  [
    { timestamp: d.toISOString(), type: 'session_meta', payload: { id: 'smoke-codex', timestamp: d.toISOString(), cwd: codexCwd } },
    { timestamp: d.toISOString(), type: 'turn_context', payload: { cwd: codexCwd, model: 'gpt-5.6-terra' } },
    { timestamp: d.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 500, total_tokens: 5500 }, last_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 500, total_tokens: 5500 }, model_context_window: 258400 } } },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n',
);

const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  GEMINI_HOME: join(root, 'gemini-missing'),
  XDG_STATE_HOME: join(root, 'state'),
  AITOP_LANG: 'en',
  NO_COLOR: '1',
  COLUMNS: '120',
  LINES: '40',
};

const BIN = process.env.AITOP_BIN;
function aitop(args, extra = {}) {
  const opts = { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 };
  // Windows 의 npm 실행 파일은 aitop.cmd 라 셸을 거쳐야 부를 수 있다 (인자는 공백 없는 옵션뿐).
  const r = BIN ? spawnSync(process.execPath, [resolve(BIN), ...args], opts) : spawnSync('aitop', args, { ...opts, shell: WIN });
  const show = `aitop ${args.join(' ')}\nstatus=${r.status} error=${r.error?.message ?? ''}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
  assert.equal(r.status, 0, show);
  console.log(`ok: aitop ${args.join(' ')}`);
  return r.stdout;
}

assert.equal(aitop(['--version']).trim(), VERSION);
assert.match(aitop(['--help']), /print the current state once and exit/);
const doctor = aitop(['--doctor']);
assert.match(doctor, /setup check/);
assert.match(doctor, /claude/i);

const once = aitop(['--once']);
assert.match(once, /smoke session/);
if (WIN) assert.match(once, /smoke-codex/);

const json = JSON.parse(aitop(['--json']));
const claude = json.sessions.find((s) => s.tool === 'claude');
assert.ok(claude?.live, 'Claude 세션이 실행 중으로 보인다');
const codex = json.sessions.find((s) => s.tool === 'codex');
if (WIN) {
  assert.ok(codex?.live, '프로세스 목록이 없어도 최근 Codex 기록은 실행 중으로 보인다');
  assert.equal(codex.status === 'idle' || codex.status === 'busy', true);
}

const report = JSON.parse(aitop(['--report', 'daily', '--json']));
assert.ok(report.total.tokens > 0, '리포트 합계에 fixture 토큰이 들어간다');
aitop(['--report', 'daily']);

// XDG_CACHE_HOME·XDG_CONFIG_HOME 이 없을 때의 기본 폴더 (Windows 는 %LOCALAPPDATA%\aitop\cache, %APPDATA%\aitop)
const local = join(root, 'LocalAppData');
const roaming = join(root, 'RoamingAppData');
const bare = { LOCALAPPDATA: local, APPDATA: roaming };
for (const k of ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME']) delete env[k];
if (WIN) {
  aitop(['--once'], bare);
  assert.ok(existsSync(join(local, 'aitop', 'cache')), '캐시는 %LOCALAPPDATA%\\aitop\\cache 에 쓴다');
  const cfg = aitop(['--print-config'], bare);
  // 경로는 ~ 로 줄어 보일 수 있어 폴더 이름만 본다.
  assert.match(cfg, /RoamingAppData[\\/]aitop[\\/]config\.json/, cfg);
}

rmSync(root, { recursive: true, force: true });
console.log('smoke ok');
