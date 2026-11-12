#!/usr/bin/env node
// 데모 녹화용: 가짜 기록이 든 임시 홈을 만들고, 그 홈을 보도록 환경 변수를 정해 aitop 을 띄운다.
// 실제 ~/.claude, ~/.codex, ~/.gemini, 캐시, 설정, 토큰 파일은 읽지도 쓰지도 않는다. 기록 내용은 모두 지어낸 것이다.
// 쓰는 법: node scripts/demo/seed.mjs [aitop 옵션...]   (예: --lang en)
//          node scripts/demo/seed.mjs --keep   임시 홈만 만들고 경로와 환경 변수를 찍은 뒤 끝낸다 (가짜 프로세스 없음).
//
// 실행 중 표시: aitop 은 진짜 프로세스를 보고 세션이 살아 있는지 정한다 (src/procs.mjs).
// - Claude Code: sessions/<pid>.json 의 pid 가 살아 있는지만 본다. 그래서 아무 일도 안 하는 node 자식 프로세스를 띄우고 그 pid 를 적는다.
// - Codex: argv[0] 이름이 codex 인 프로세스를 찾고, 그 프로세스가 열어 둔 rollout 파일로 세션을 짝짓는다.
//   그래서 argv0 을 'codex' 로 바꾼 node 자식이 rollout 파일을 열어 둔 채 잠든다.
// - agy: argv[0] 이름이 agy 인 프로세스가 열어 둔 presence/<id>.lock 으로 짝짓는다. 같은 방식으로 띄운다.
// 이 자식들은 aitop 이 끝나면(또는 이 스크립트가 신호를 받으면) 모두 죽이고, 임시 홈도 지운다.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os, { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// node:sqlite 의 실험 기능 경고가 화면에 섞이지 않게 그 경고만 삼킨다.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/sqlite/i.test(String(w?.message ?? w)) ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emit;

const BIN = fileURLToPath(new URL('../../bin/aitop.mjs', import.meta.url));
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const aitopArgs = args.filter((a) => a !== '--keep');

// macOS 의 임시 폴더는 심볼릭 링크라 /proc 링크와 맞추려고 실제 경로를 쓴다.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'aitop-demo-')));

// 가짜 프로세스와 임시 홈은 어떻게 끝나든(정상 종료, 예외, 신호) 지운다.
// aitop 은 끝날 때 캐시를 쓰므로, aitop 이 끝난 뒤에 지워야 임시 폴더가 다시 생기지 않는다.
const kids = [];
let timer = null;
let app = null;
let keepRoot = false;
let cleaned = false;
let exitCode = null;
const appAlive = () => app !== null && app.exitCode === null && app.signalCode === null;
const signalExit = (sig) => 128 + (os.constants.signals[sig] ?? 0);

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  clearInterval(timer);
  for (const k of kids) {
    try {
      k.kill('SIGKILL');
    } catch {}
  }
  try {
    if (!keepRoot) rmSync(root, { recursive: true, force: true });
  } catch {}
}

// aitop 이 떠 있으면 sig 를 넘기고 그 종료(app 의 exit 처리기)에서 정리한다. 3초 안에 안 끝나면 SIGKILL.
function finish(code, sig = 'SIGTERM') {
  exitCode ??= code;
  clearInterval(timer);
  if (!appAlive()) {
    cleanup();
    process.exit(exitCode);
  }
  app.kill(sig);
  setTimeout(() => {
    app.kill('SIGKILL');
    cleanup();
    process.exit(exitCode);
  }, 3000).unref();
}

// 마지막 방어선: exit 처리기는 동기 작업만 되므로 남은 aitop 과 가짜 프로세스를 SIGKILL 하고 지운다.
process.on('exit', () => {
  if (appAlive()) app.kill('SIGKILL');
  cleanup();
});
process.on('uncaughtException', (err) => {
  console.error(err);
  finish(1);
});
// aitop 이 터미널을 쓰는 동안 Ctrl-C 는 aitop 이 받는다. 이 스크립트는 무시한다.
process.on('SIGINT', () => {});
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => finish(signalExit(sig), sig));

const HOME = join(root, 'home');
const dirs = {
  claude: join(HOME, '.claude'),
  codex: join(HOME, '.codex'),
  agy: join(HOME, '.gemini', 'antigravity-cli'),
  cache: join(HOME, '.cache'),
  config: join(HOME, '.config'),
  state: join(HOME, '.local', 'state'),
};
const env = {
  ...process.env,
  HOME,
  CLAUDE_CONFIG_DIR: dirs.claude,
  CODEX_HOME: dirs.codex,
  GEMINI_HOME: join(HOME, '.gemini'),
  AITOP_AGY_HOME: dirs.agy,
  XDG_CACHE_HOME: dirs.cache,
  XDG_CONFIG_HOME: dirs.config,
  XDG_STATE_HOME: dirs.state,
};

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ago = (min) => now - min * 60_000;
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const write = (p, text) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

// 가짜 프로젝트 폴더. 가짜 프로세스의 작업 폴더로도 쓰므로 실제로 만든다.
const project = (name) => {
  const p = join(HOME, 'work', name);
  mkdirSync(p, { recursive: true });
  return p;
};

// ---- Claude Code ----

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
let msgN = 0;
const cl = {
  prompt: (at, text) => ({ type: 'user', timestamp: iso(at), message: { content: text } }),
  say: (at, model, text, u) => ({ type: 'assistant', timestamp: iso(at), message: { id: `msg_${++msgN}`, model, content: [{ type: 'text', text }], usage: u } }),
  tool: (at, model, id, name, input, u) => ({ type: 'assistant', timestamp: iso(at), message: { id: `msg_${++msgN}`, model, content: [{ type: 'tool_use', id, name, input }], usage: u } }),
  done: (at, id, patch) => ({ type: 'user', timestamp: iso(at), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...(patch ? { toolUseResult: patch } : {}) }),
};
const patch = (filePath, add, del) => ({
  filePath,
  structuredPatch: [{ oldStart: 10, oldLines: del + 1, newStart: 10, newLines: add + 1, lines: [' // context', ...Array.from({ length: del }, (_, i) => `-old line ${i + 1}`), ...Array.from({ length: add }, (_, i) => `+new line ${i + 1}`)] }],
});

// 몇 시간에 걸쳐 주고받은 기록. 시간별 토큰 막대가 비지 않게 시각을 흩뜨린다.
function claudeHistory({ cwd, branch, model, startMin, steps, files }) {
  const rows = [{ type: 'user', timestamp: iso(ago(startMin)), cwd, gitBranch: branch, message: { content: steps[0] } }];
  let t = startMin;
  let n = 0;
  for (const [i, text] of steps.entries()) {
    if (i) rows.push(cl.prompt(ago(t), text));
    t -= 3;
    rows.push(cl.say(ago(t), model, 'On it.', usage(2400 + i * 300, 900, 48_000 + i * 9000, 6000)));
    const f = files[i % files.length];
    const id = `tu_${cwd.length}_${++n}`;
    rows.push(cl.tool(ago(t - 1), model, id, 'Edit', { file_path: join(cwd, f) }, usage(1800, 1400, 60_000 + i * 9000, 2000)));
    rows.push(cl.done(ago(t - 1.5), id, patch(join(cwd, f), 4 + i * 3, 1 + i)));
    t -= Math.max(4, startMin / (steps.length + 1));
  }
  return rows;
}

let pidFile = 0;
function claudeSession({ pid, id, name, cwd, status, waitingFor, rows, members = [] }) {
  const projDir = join(dirs.claude, 'projects', cwd.replace(/[/.]/g, '-'));
  const transcript = join(projDir, `${id}.jsonl`);
  write(transcript, jsonl(rows));
  for (const m of members) {
    const sub = join(projDir, id, 'subagents');
    write(join(sub, `agent-${m.id}.meta.json`), JSON.stringify({ agentType: m.type, description: m.task, toolUseId: m.toolUseId }));
    write(join(sub, `agent-${m.id}.jsonl`), jsonl(m.rows));
  }
  write(join(dirs.claude, 'sessions', `${pid ?? 900000 + ++pidFile}.json`), JSON.stringify({ pid, sessionId: id, cwd, kind: 'interactive', status, waitingFor, name, startedAt: ago(180), updatedAt: now }));
  return transcript;
}

// ---- Codex ----

function codexRollout({ id, cwd, branch, model, startMin }) {
  const d = new Date(ago(startMin));
  const day = join(dirs.codex, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const path = join(day, `rollout-${iso(ago(startMin)).slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
  const tokens = (at, total, last) => ({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: Math.round(total * 0.8), cached_input_tokens: Math.round(total * 0.6), output_tokens: Math.round(total * 0.2), total_tokens: total }, last_token_usage: { total_tokens: last }, model_context_window: 258_400 } } });
  const rows = [
    { timestamp: iso(ago(startMin)), type: 'session_meta', payload: { id, timestamp: iso(ago(startMin)), cwd, git: { branch } } },
    { timestamp: iso(ago(startMin)), type: 'turn_context', payload: { cwd, model } },
    { timestamp: iso(ago(startMin)), type: 'event_msg', payload: { type: 'task_started', model_context_window: 258_400 } },
    { timestamp: iso(ago(startMin - 0.2)), type: 'event_msg', payload: { type: 'user_message', message: 'Add pagination to the orders endpoint' } },
    { timestamp: iso(ago(startMin - 1)), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg -n \\"listOrders\\" src"}', call_id: 'c1' } },
    { timestamp: iso(ago(startMin - 1.2)), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
    tokens(ago(startMin - 1.3), 84_000, 52_000),
    { timestamp: iso(ago(startMin - 40)), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: `*** Begin Patch\n*** Update File: ${cwd}/src/orders.ts\n@@\n-  return db.orders.all();\n+  const page = Number(q.page ?? 1);\n+  return db.orders.page(page, 50);\n*** End Patch\n` } },
    { timestamp: iso(ago(startMin - 40.2)), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: '{"output":"Success. Updated the following files:\\nM src/orders.ts\\n","metadata":{"exit_code":0}}' } },
    tokens(ago(startMin - 40.3), 310_000, 96_000),
    { timestamp: iso(ago(2)), type: 'event_msg', payload: { type: 'agent_message', message: 'Pagination added. Running the test suite now.' } },
    { timestamp: iso(ago(1)), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test -- orders"}', call_id: 'c3' } },
    tokens(ago(1), 486_000, 118_000),
  ];
  write(path, jsonl(rows));
  return { path, tokens };
}

// ---- Antigravity (agy): SQLite 기록. 필드 번호는 src/sources/antigravity.mjs 와 test/antigravity.test.mjs 를 따른다. ----

const varint = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
const num = (f, v) => Buffer.concat([varint(f * 8), varint(v)]);
const bytes = (f, v) => {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
  return Buffer.concat([varint(f * 8 + 2), varint(b.length), b]);
};
const kv = (k, v) => bytes(20, Buffer.concat([bytes(1, k), bytes(2, v)]));
const generation = ({ model, input, output, cacheRead, step }) => {
  const u = Buffer.concat([num(2, input), num(3, output), num(5, cacheRead)]);
  return bytes(1, Buffer.concat([bytes(17, bytes(2, u)), bytes(19, model), kv('last_step_index', String(step))]));
};
const STEP = { PROMPT: 14, REPLY: 15, TOOL: 132 };
const stamp = (ms) => Buffer.concat([num(1, Math.floor(ms / 1000)), num(2, (ms % 1000) * 1e6)]);
const call = (name, a) => Buffer.concat([bytes(1, 'call_1'), bytes(2, name), bytes(3, JSON.stringify(a))]);
function step({ type, at, text, tool }) {
  const parts = [num(1, type), bytes(5, Buffer.concat([bytes(1, stamp(at)), ...(type === STEP.TOOL && tool ? [bytes(4, call(...tool))] : [])]))];
  if (type === STEP.PROMPT) parts.push(bytes(19, bytes(2, text)));
  if (type === STEP.REPLY) parts.push(bytes(20, Buffer.concat([bytes(1, text), ...(tool ? [bytes(7, call(...tool))] : [])])));
  return Buffer.concat(parts);
}
const dbTime = (ms) => iso(ms).replace('T', ' ').replace('Z', '+00:00');

function agyConversation({ id, title, cwd, model, startMin }) {
  mkdirSync(join(dirs.agy, 'conversations'), { recursive: true });
  mkdirSync(join(dirs.agy, 'presence'), { recursive: true });
  const db = new DatabaseSync(join(dirs.agy, 'conversations', `${id}.db`));
  db.exec(`create table steps (idx integer primary key, step_type integer not null default 0, status integer not null default 0, step_payload blob);
    create table gen_metadata (idx integer primary key, data blob)`);
  const steps = [
    { type: STEP.PROMPT, at: ago(startMin), text: 'Write a migration guide for the v3 config format' },
    { type: STEP.TOOL, at: ago(startMin - 1), tool: ['read_file', { Path: join(cwd, 'docs/config.md') }] },
    { type: STEP.REPLY, at: ago(startMin - 30), text: 'Drafted the guide. Checking examples next.' },
    { type: STEP.TOOL, at: ago(startMin - 60), tool: ['run_command', { CommandLine: 'node scripts/check-examples.mjs' }] },
    { type: STEP.REPLY, at: ago(1), text: 'Examples pass. Updating the changelog.', tool: ['write_to_file', { TargetFile: join(cwd, 'CHANGELOG.md') }] },
  ];
  const ins = db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, 3, ?)');
  steps.forEach((s, i) => ins.run(i, s.type, step(s)));
  const gen = db.prepare('insert into gen_metadata (idx, data) values (?, ?)');
  [0, 1, 2, 3, 4].forEach((s, i) => gen.run(i, generation({ model, input: 9000 + i * 4000, output: 1500 + i * 400, cacheRead: 40_000 + i * 22_000, step: s })));
  db.close();
  const sum = new DatabaseSync(join(dirs.agy, 'conversation_summaries.db'));
  sum.exec(`create table if not exists conversation_summaries (conversation_id text primary key, title text not null default '', step_count integer not null default 0,
      last_modified_time datetime not null, workspace_uris text not null, status text not null default '', agent_name text not null default '',
      parent_conversation_id text not null default '', nesting_depth integer not null default 0, not_fully_idle numeric not null default false, killed numeric not null default false)`);
  sum.prepare('insert into conversation_summaries values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, title, steps.length, dbTime(ago(1)), JSON.stringify([`file://${cwd}`]), 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 1, 0);
  sum.close();
  const lock = join(dirs.agy, 'presence', `${id}.lock`);
  writeFileSync(lock, '');
  return lock;
}

// ---- 가짜 프로세스 ----

// 아무 일도 안 하는 node 자식. argv0 을 바꾸면 /proc/<pid>/cmdline 의 첫 칸이 그 이름이 된다. open 이 있으면 그 파일을 열어 둔다.
function dummy(name, cwd, open) {
  const script = `${open ? `require('fs').openSync(${JSON.stringify(open)}, 'r');` : ''}setInterval(() => {}, 1e9);`;
  const child = spawn(process.execPath, ['-e', script], { argv0: name, cwd, stdio: 'ignore', env: { PATH: process.env.PATH } });
  kids.push(child);
  return child.pid;
}

// ---- 장면 ----

const shop = project('shop-api');
const web = project('storefront-web');
const infra = project('infra');
const docs = project('docs-site');
const pay = project('payments');

const opus = 'claude-opus-5-5';
const sonnet = 'claude-sonnet-5-5';
const live = !keep;

// 1) 도구 실행 중 + 팀원 둘
const busyRows = claudeHistory({ cwd: shop, branch: 'feat/order-export', model: opus, startMin: 170, steps: ['Add CSV export for orders', 'Handle timezones in the export', 'Write tests for the exporter'], files: ['src/export/csv.ts', 'src/export/tz.ts', 'test/export.test.ts'] });
busyRows.push(cl.tool(ago(2), opus, 'agent_1', 'Agent', { subagent_type: 'reviewer', description: 'Review export edge cases' }, usage(2200, 300, 140_000, 1000)));
busyRows.push(cl.tool(ago(1.5), opus, 'agent_2', 'Agent', { subagent_type: 'test-writer', description: 'Add fixtures for DST' }, usage(2100, 280, 142_000, 900)));
const member = (id, type, task, toolUseId, model) => ({ id, type, task, toolUseId, rows: [cl.prompt(ago(1.4), task), cl.say(ago(1), model, 'Looking.', usage(5200, 700, 30_000, 4000)), cl.tool(ago(0.5), model, `${id}_t`, 'Read', { file_path: join(shop, 'src/export/tz.ts') }, usage(800, 120, 34_000, 0))] });
const busyTranscript = claudeSession({
  pid: live ? dummy('claude', shop) : null,
  id: 'd1a2b3c4-0000-4000-8000-000000000001',
  name: 'order export',
  cwd: shop,
  status: 'busy',
  rows: busyRows,
  members: [member('a1', 'reviewer', 'Review export edge cases', 'agent_1', sonnet), member('a2', 'test-writer', 'Add fixtures for DST', 'agent_2', sonnet)],
});

// 2) 허락 대기
const waitRows = claudeHistory({ cwd: infra, branch: 'chore/k8s-limits', model: opus, startMin: 95, steps: ['Tighten memory limits on workers', 'Roll it out to staging'], files: ['k8s/worker.yaml', 'k8s/values-staging.yaml'] });
waitRows.push(cl.tool(ago(0.6), opus, 'tu_wait', 'Bash', { command: 'kubectl apply -f k8s/ --context staging' }, usage(1900, 220, 88_000, 500)));
claudeSession({ pid: live ? dummy('claude', infra) : null, id: 'd1a2b3c4-0000-4000-8000-000000000002', name: 'k8s limits', cwd: infra, status: 'busy', waitingFor: 'approve Bash', rows: waitRows });

// 3) 답변 작성 중
const webRows = claudeHistory({ cwd: web, branch: 'fix/cart-badge', model: sonnet, startMin: 60, steps: ['Cart badge shows stale count', 'Also fix it on mobile'], files: ['src/components/CartBadge.tsx', 'src/hooks/useCart.ts'] });
webRows.push(cl.prompt(ago(0.4), 'Explain the root cause in one paragraph'));
const webTranscript = claudeSession({ pid: live ? dummy('claude', web) : null, id: 'd1a2b3c4-0000-4000-8000-000000000003', name: 'cart badge', cwd: web, status: 'busy', rows: webRows });

// 4) 쉬는 중
claudeSession({ pid: live ? dummy('claude', pay) : null, id: 'd1a2b3c4-0000-4000-8000-000000000004', name: 'refund webhook', cwd: pay, status: 'idle', rows: claudeHistory({ cwd: pay, branch: 'main', model: opus, startMin: 240, steps: ['Retry failed refund webhooks', 'Log the retry count'], files: ['src/webhooks/refund.ts', 'src/log.ts'] }) });

// 5) 끝난 세션 (24시간 안). e 키로 보인다.
claudeSession({ pid: null, id: 'd1a2b3c4-0000-4000-8000-000000000005', name: 'readme pass', cwd: docs, status: 'idle', rows: claudeHistory({ cwd: docs, branch: 'main', model: sonnet, startMin: 600, steps: ['Tidy up the README'], files: ['README.md'] }) });

// Codex: 명령 실행 중
const codex = codexRollout({ id: 'c0dex000-0000-4000-8000-000000000001', cwd: shop, branch: 'feat/orders-pagination', model: 'gpt-5.5', startMin: 130 });
if (live) dummy('codex', shop, codex.path);

// agy: 실행 중
const agyLock = agyConversation({ id: 'a9a9a9a9-0000-4000-8000-000000000001', title: 'v3 config migration guide', cwd: docs, model: 'gemini-3.8-flash', startMin: 120 });
if (live) dummy('agy', docs, agyLock);

// aitop 설정: 데모 화면은 영어, 하루 예산 $60 을 보여 준다.
write(join(dirs.config, 'aitop', 'config.json'), JSON.stringify({ lang: 'en', budgetDay: 60 }));

if (keep) {
  keepRoot = true;
  console.log(`demo home: ${HOME}`);
  for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'AITOP_AGY_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) console.log(`export ${k}=${env[k]}`);
  process.exit(0);
}

// 화면이 살아 있게, 일하는 세션의 기록을 조금씩 늘린다.
const lines = ['Checking DST boundaries.', 'Both reviewers are still running.', 'Merging the fixture names.', 'Export handles UTC offsets now.'];
const webLines = ['The badge read a cached count.', 'useCart never re-subscribed after login.', 'Mobile used a second copy of the hook.'];
let tick = 0;
timer = setInterval(() => {
  tick++;
  const t = Date.now();
  appendFileSync(busyTranscript, jsonl([cl.say(t, opus, lines[tick % lines.length], usage(1200 + tick * 50, 600, 150_000 + tick * 4000, 1500))]));
  appendFileSync(webTranscript, jsonl([cl.say(t, sonnet, webLines[tick % webLines.length], usage(800, 300 + tick * 20, 70_000 + tick * 3000, 800))]));
  appendFileSync(codex.path, jsonl([codex.tokens(t, 486_000 + tick * 9_000, 118_000 + tick * 1500)]));
}, 2000);

app = spawn(process.execPath, [BIN, ...aitopArgs], { stdio: 'inherit', env });
app.on('exit', (code, signal) => {
  cleanup();
  process.exit(exitCode ?? (signal ? signalExit(signal) : (code ?? 1)));
});
