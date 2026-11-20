// 성능 테스트용 고정 샘플: 임시 폴더에 Claude 세션(서브에이전트 포함)과 Codex 세션을 30일에 걸쳐 만든다.
// 내용은 고정 씨앗의 의사 난수로 정해지므로 실행할 때마다 같은 크기·같은 줄이 나온다 (시각만 지금 기준).
// 큰 파일을 저장소에 두지 않으려고 실행 때마다 만든다. 실사용자 기록·캐시는 건드리지 않는다 (fixture.mjs 가 환경 변수를 임시 폴더로 돌린다).
import { mkdirSync, writeFileSync, utimesSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeClaudeHome } from '../fixture.mjs';

export const SAMPLE = {
  claudeSessions: 240, // 30일 x 하루 8개
  projects: 12,
  turns: 30, // 세션당 턴. 턴마다 user, assistant(thinking·tool_use, 같은 message.id 2줄), tool_result, assistant(text) 5줄
  subagentEvery: 3, // 3개 세션마다 서브에이전트 2개
  subagentTurns: 15,
  codexSessions: 6,
  codexTurns: 200,
  days: 30,
};

// 고정 씨앗 의사 난수 (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'the a read file test cache ledger session token usage model report daily build check fix render table panel width height line json value error path config agent tool result output input'.split(' ');
const text = (r, n) => Array.from({ length: n }, () => WORDS[(r() * WORDS.length) | 0]).join(' ');
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
const lines = (rows) => rows.map((x) => JSON.stringify(x)).join('\n') + '\n';

function claudeRows(r, sessionId, cwd, start, turns) {
  const rows = [];
  let t = start;
  const at = () => new Date((t += 5_000 + ((r() * 20_000) | 0))).toISOString();
  const model = MODELS[(r() * MODELS.length) | 0];
  const base = { sessionId, cwd, version: '2.1.0', gitBranch: 'main', userType: 'external' };
  let ctx = 20_000;
  for (let i = 0; i < turns; i++) {
    const uid = (k) => `${sessionId}-${i}-${k}`;
    rows.push({ ...base, type: 'user', uuid: uid('u'), timestamp: at(), message: { role: 'user', content: text(r, 20 + ((r() * 40) | 0)) } });
    const toolId = `toolu_${sessionId}_${i}`;
    ctx += 1_000 + ((r() * 3_000) | 0);
    const u1 = { input_tokens: 10, output_tokens: 200 + ((r() * 800) | 0), cache_read_input_tokens: ctx, cache_creation_input_tokens: 1_500 };
    const mid1 = `msg_${sessionId}_${i}_a`;
    // Claude Code 는 같은 message.id 를 내용 조각마다 여러 줄로 쓴다.
    rows.push({ ...base, type: 'assistant', uuid: uid('a0'), timestamp: at(), message: { id: mid1, model, role: 'assistant', content: [{ type: 'thinking', thinking: text(r, 60) }], usage: { ...u1, output_tokens: 50 } } });
    rows.push({ ...base, type: 'assistant', uuid: uid('a1'), timestamp: at(), message: { id: mid1, model, role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: `${cwd}/src/f${i}.mjs` } }], usage: u1 } });
    rows.push({ ...base, type: 'user', uuid: uid('r'), timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text(r, 150 + ((r() * 250) | 0)) }] }, toolUseResult: { type: 'text' } });
    const u2 = { input_tokens: 10, output_tokens: 100 + ((r() * 600) | 0), cache_read_input_tokens: ctx, cache_creation_input_tokens: 800 };
    rows.push({ ...base, type: 'assistant', uuid: uid('a2'), timestamp: at(), message: { id: `msg_${sessionId}_${i}_b`, model, role: 'assistant', content: [{ type: 'text', text: text(r, 40 + ((r() * 80) | 0)) }], usage: u2, stop_reason: 'end_turn' } });
  }
  return { rows, end: t };
}

// 샘플을 만들고 { root, env(자식에 줄 환경 변수, 캐시 폴더는 부르는 쪽이 정한다), bytes, files } 를 돌려준다.
// 만드는 도중 실패하면 임시 폴더를 지우고 다시 던진다.
export function makeSample(now = Date.now()) {
  const fx = makeClaudeHome(); // CLAUDE_CONFIG_DIR·XDG_CACHE_HOME·XDG_CONFIG_HOME·CODEX_HOME 등을 임시 폴더로 돌린다
  const root = dirname(fx.home);
  try {
    return fill(fx, root, now);
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

export const removeSample = (s) => rmSync(s.root, { recursive: true, force: true });

function fill(fx, root, now) {
  const r = rng(136);
  let bytes = 0;
  let files = 0;
  const write = (p, rows, mtime) => {
    writeFileSync(p, lines(rows));
    utimesSync(p, mtime / 1000, mtime / 1000);
    bytes += statSync(p).size;
    files++;
  };

  const perDay = SAMPLE.claudeSessions / SAMPLE.days;
  for (let i = 0; i < SAMPLE.claudeSessions; i++) {
    const proj = i % SAMPLE.projects;
    const cwd = `/work/perf-${proj}`;
    const dir = join(fx.home, 'projects', `-work-perf-${proj}`);
    const sessionId = `perf${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`;
    // i 가 작을수록 최근. 하루 perDay 개씩 SAMPLE.days 일.
    const start = now - Math.floor(i / perDay) * 86400_000 - 3 * 3600_000 - ((r() * 3600_000) | 0);
    const { rows, end } = claudeRows(r, sessionId, cwd, start, SAMPLE.turns);
    mkdirSync(dir, { recursive: true });
    write(join(dir, `${sessionId}.jsonl`), rows, Math.min(end, now));
    if (i % SAMPLE.subagentEvery === 0) {
      const sub = join(dir, sessionId, 'subagents');
      mkdirSync(sub, { recursive: true });
      for (let k = 0; k < 2; k++) {
        const agentId = `a${i}x${k}`;
        writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `perf agent ${k}` }));
        const s = claudeRows(r, sessionId, cwd, start + 60_000, SAMPLE.subagentTurns);
        write(join(sub, `agent-${agentId}.jsonl`), s.rows.map((x) => ({ ...x, isSidechain: true, agentId })), Math.min(s.end, now));
      }
    }
  }
  // 실행 중 세션 하나 (pid 는 이 테스트 프로세스)
  fx.session({ sessionId: 'perf0000-0000-4000-8000-000000000000', cwd: '/work/perf-0', status: 'idle', name: 'perf live', updatedAt: now });

  const codexHome = join(root, 'codex');
  for (let i = 0; i < SAMPLE.codexSessions; i++) {
    const d = new Date(now - i * 4 * 86400_000);
    const day = join(codexHome, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    mkdirSync(day, { recursive: true });
    const cwd = `/work/perf-codex-${i}`;
    const t0 = d.getTime() - SAMPLE.codexTurns * 10_000;
    const rows = [
      { timestamp: new Date(t0).toISOString(), type: 'session_meta', payload: { id: `perf-codex-${i}`, timestamp: new Date(t0).toISOString(), cwd } },
      { timestamp: new Date(t0).toISOString(), type: 'turn_context', payload: { cwd, model: 'gpt-5.6-terra' } },
    ];
    let total = 0;
    let out = 0;
    for (let k = 0; k < SAMPLE.codexTurns; k++) {
      const ts = new Date(t0 + k * 10_000).toISOString();
      rows.push({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: text(r, 60) }] } });
      total += 3_000;
      out += 200;
      rows.push({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: total - 500, output_tokens: out, total_tokens: total + out }, last_token_usage: { input_tokens: 3_000, cached_input_tokens: 2_500, output_tokens: 200, total_tokens: 3_200 }, model_context_window: 258400 } } });
    }
    write(join(day, `rollout-perf-codex-${i}.jsonl`), rows, d.getTime());
  }

  // 사용자 셸의 AITOP_* (AITOP_REPORT_MS·AITOP_TICK_BYTES·AITOP_THEME·AITOP_CLAUDE_DIRS 등)는 결과·속도를 바꾸므로 모두 뺀다.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AITOP_')));
  const env = {
    ...inherited,
    CLAUDE_CONFIG_DIR: fx.home,
    CODEX_HOME: codexHome,
    GEMINI_HOME: join(root, 'gemini-missing'),
    AITOP_AGY_HOME: join(root, 'agy-missing'),
    AITOP_COWORK_HOME: 'off',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    AITOP_LANG: 'en',
    NO_COLOR: '1',
    COLUMNS: '120',
    LINES: '40',
  };
  return { root, env, bytes, files };
}
