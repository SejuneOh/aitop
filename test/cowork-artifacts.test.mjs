// Cowork 세션(#304)도 같은 Claude 기록 파서로 Artifact 게시를 모은다 (#305). 서브에이전트 게시도 합친다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'aitop-cowork-art-')));
const app = join(base, 'Claude');
const lams = join(app, 'local-agent-mode-sessions', 'acct-1', 'org-1');
mkdirSync(lams, { recursive: true });
const claudeHome = join(base, 'claude');
mkdirSync(join(claudeHome, 'projects'), { recursive: true });
mkdirSync(join(claudeHome, 'sessions'), { recursive: true });
process.env.AITOP_COWORK_HOME = app;
process.env.CLAUDE_CONFIG_DIR = claudeHome;
delete process.env.AITOP_CLAUDE_DIRS;
process.env.XDG_CACHE_HOME = join(base, 'cache');
process.env.XDG_CONFIG_HOME = join(base, 'config');
process.env.AITOP_AGY_HOME = join(base, 'agy-missing');
process.env.AITOP_AGY_APP_HOME = 'off';
process.env.CODEX_HOME = join(base, 'codex-missing');
process.env.GEMINI_HOME = join(base, 'gemini-missing');

const { collectCowork } = await import('../src/sources/cowork.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { toJson } = await import('../src/json.mjs');
const { detail } = await import('../src/ui/detail.mjs');

after(() => rmSync(base, { recursive: true, force: true }));

const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const iso = (ms) => new Date(ms).toISOString();
const u = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const now = Date.now();
const SID = '22222222-0305-4000-8000-000000000001';
const URL = 'https://claude.ai/artifact/cowork305';

const call = (id, input, at) => ({ type: 'assistant', timestamp: iso(at), entrypoint: 'local-agent', message: { id: `m-${id}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Artifact', input }], usage: u } });
const result = (id, r, at) => ({ type: 'user', timestamp: iso(at), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: r });

writeFileSync(join(lams, 'local_cw305.json'), JSON.stringify({ sessionId: 'local_cw305', cliSessionId: SID, cwd: '/sessions/demo', createdAt: now - 600_000, lastActivityAt: now - 10_000, model: 'claude-opus-5-5', isArchived: false, title: '코워크 보고서' }));
const pdir = join(lams, 'local_cw305', '.claude', 'projects', '-sessions-demo');
mkdirSync(join(pdir, SID, 'subagents'), { recursive: true });
writeFileSync(
  join(pdir, `${SID}.jsonl`),
  lines([
    { type: 'user', timestamp: iso(now - 60_000), entrypoint: 'local-agent', message: { content: '보고서 게시해줘' } },
    call('c1', { file_path: '/sessions/demo/SECRET-305.html' }, now - 50_000),
    result('c1', { url: URL, title: '코워크 보고서 페이지', version: '1794205685-b571', seq: 1, artifact_id: 'cw-1', audience: 'org' }, now - 45_000),
    call('c2', { action: 'list' }, now - 40_000),
    result('c2', { artifacts: [{ url: URL, title: 'LIST' }] }, now - 39_000),
  ]),
);
writeFileSync(join(pdir, SID, 'subagents', 'agent-s1.jsonl'), lines([call('d1', {}, now - 30_000), result('d1', { url: URL, title: '코워크 보고서 페이지', version: '1794205699-c602', seq: 2, artifact_id: 'cw-1', audience: 'org' }, now - 20_000)]));

test('Cowork 세션에도 아티팩트가 보이고 서브에이전트 게시가 버전 범위에 합쳐진다', () => {
  const s = collectCowork({ showEnded: true, budget: createBudget(), selectedId: SID }).find((x) => x.id === SID);
  assert.ok(s, 'Cowork 세션');
  assert.equal(s.tool, 'cowork');
  assert.equal(s.artifacts.length, 1);
  assert.deepEqual([s.artifacts[0].title, s.artifacts[0].from, s.artifacts[0].to, s.artifacts[0].audience], ['코워크 보고서 페이지', 1, 2, 'org']);
  const j = toJson({ sessions: [s], errors: [], at: now }, 'test').sessions[0];
  assert.equal(j.artifacts[0].url, URL);
  const text = detail(s, 140, 24, 0, {}).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /아티팩트 1/);
  assert.match(text, /코워크 보고서 페이지 · v1→v2 · \d\d:\d\d · claude\.ai\/(artifact\/c|…)owork305 · 조직 공유/);
});
