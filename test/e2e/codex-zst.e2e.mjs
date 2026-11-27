// Codex 압축 rollout(.jsonl.zst, #330) 을 새 프로세스로 읽는다: --report sessions 에 잡히고, zstd 없는 Node 처럼 만들면
// 건너뛰고 --doctor 에 안내한다. zstd 로 압축할 수 없는 Node(22.15 미만)에서는 건너뛴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as zlib from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN } from './session.mjs';
import { makeClaudeHome } from '../fixture.mjs';

const skip = typeof zlib.zstdCompressSync !== 'function' ? 'zstd 없는 Node' : false;

makeClaudeHome();
const codex = mkdtempSync(join(tmpdir(), 'aitop-zst-e2e-'));
// 7일 넘게 쉬어 Codex 가 압축한 기록 (압축본도 원래 수정 시각을 지닌다).
const at = Date.now() - 8 * 86400_000;
const d = new Date(at);
const dir = join(codex, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
if (!skip) {
  mkdirSync(dir, { recursive: true });
  const ts = new Date(at).toISOString();
  const rows = [
    { type: 'session_meta', payload: { id: '7a7a7a7a-0000-4000-8000-000000000001', cwd: '/work/old', timestamp: ts } },
    { type: 'turn_context', payload: { model: 'gpt-5.1-codex', cwd: '/work/old' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'thread_name_updated', thread_name: 'packed session' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 250_000, total_tokens: 250_000 } } } },
  ];
  const p = join(dir, 'rollout-2026-01-01T00-00-00-7a7a7a7a-0000-4000-8000-000000000001.jsonl.zst');
  writeFileSync(p, zlib.zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')));
  utimesSync(p, at / 1000, at / 1000);
}

// zstd 가 없는 Node 처럼: node:zlib 의 zstd 해제 함수를 지운다.
const NO_ZSTD = 'data:text/javascript,import zlib from "node:zlib"; import { syncBuiltinESMExports } from "node:module"; zlib.zstdDecompressSync = undefined; syncBuiltinESMExports();';
const run = (args, env = {}, pre = []) => spawnSync(process.execPath, [...pre, BIN, ...args], { env: { ...process.env, CODEX_HOME: codex, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), 'aitop-zst-cache-')), ...env }, encoding: 'utf8', timeout: 30_000 });
const EN = { AITOP_LANG: '', LANG: 'C', LC_ALL: '', LC_MESSAGES: '' };

test('--report sessions: 압축 기록의 세션 이름·프로젝트·토큰을 보인다', { skip }, () => {
  const r = run(['--report', 'sessions', '--since', '10d', '--json'], EN);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  const s = j.sessions.find((x) => x.tool === 'codex');
  assert.ok(s, r.stdout);
  assert.equal(s.name, 'packed session');
  assert.equal(s.tokens, 250_000);
  assert.equal(s.projectPath, '/work/old');
});

test('zstd 없는 Node: 압축 기록은 건너뛰고 --doctor 에 안내한다', { skip }, () => {
  const r = run(['--report', 'sessions', '--since', '10d', '--json'], EN, ['--import', NO_ZSTD]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).sessions.filter((x) => x.tool === 'codex').length, 0);
  const doc = run(['--doctor'], EN, ['--import', NO_ZSTD]);
  assert.match(doc.stdout, /1 compressed log not read \(Node .+ has no zstd, needs Node 22\.15 or later\)/);
  assert.doesNotMatch(run(['--doctor'], EN).stdout, /compressed log/);
  assert.match(run(['--doctor'], { AITOP_LANG: 'ko' }, ['--import', NO_ZSTD]).stdout, /압축 기록 1개 읽지 못함/);
});
