// 테스트용 가짜 Claude 설정 폴더(CLAUDE_CONFIG_DIR)와 캐시 폴더를 만든다.
// 소스 모듈은 가져올 때 경로를 정하므로, 이 함수를 부른 다음에 동적 import 해야 한다.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function makeClaudeHome() {
  const root = mkdtempSync(join(tmpdir(), 'aitop-fixture-'));
  const home = join(root, 'claude');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'projects'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.XDG_CACHE_HOME = join(root, 'cache');
  // 이 PC 의 실제 agy·Codex 기록을 읽지 않게 한다 (기록 폴더가 없으면 보지 않는다).
  process.env.AITOP_AGY_HOME = join(root, 'agy-missing');
  process.env.CODEX_HOME = join(root, 'codex-missing');

  const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

  return {
    home,
    // 살아 있는 세션은 이 테스트 프로세스의 pid 를 쓴다.
    session({ sessionId, pid = process.pid, cwd = '/work/demo', kind = 'bg', status = 'busy', name, updatedAt = Date.now(), ...rest }) {
      writeFileSync(join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, kind, status, name, startedAt: updatedAt - 60_000, updatedAt, ...rest }));
    },
    transcript(sessionId, rows, project = '-work-demo') {
      const dir = join(home, 'projects', project);
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${sessionId}.jsonl`);
      writeFileSync(p, lines(rows));
      return p;
    },
    append(path, rows) {
      appendFileSync(path, lines(rows));
    },
    subagent(sessionId, agentId, meta, rows, project = '-work-demo') {
      const dir = join(home, 'projects', project, sessionId, 'subagents');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
      const p = join(dir, `agent-${agentId}.jsonl`);
      writeFileSync(p, rows.length ? lines(rows) : '');
      return p;
    },
  };
}

export const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });

export const assistant = (id, content, u, model = 'claude-opus-5-5') => ({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model, content, usage: u } });

export const user = (content) => ({ type: 'user', timestamp: new Date().toISOString(), message: { content } });
