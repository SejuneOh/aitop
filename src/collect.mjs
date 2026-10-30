import { collectClaude } from './sources/claude.mjs';
import { collectCodex } from './sources/codex.mjs';
import { collectGemini } from './sources/gemini.mjs';
import { createBudget } from './tail.mjs';

const RANK = { waiting: 0, busy: 1, shell: 2, live: 3, idle: 4, ended: 5 };

// budgetBytes: 이번 갱신에서 세션 기록을 읽을 최대 바이트. 실시간 화면은 작게 잡아 큰 기록을 여러 번에 나눠 읽는다.
export function collect({ budgetBytes = Infinity, ...opts } = {}) {
  const budget = createBudget(budgetBytes);
  const sessions = [];
  const errors = [];
  for (const [tool, fn] of [['claude', collectClaude], ['codex', collectCodex], ['gemini', collectGemini]]) {
    try {
      sessions.push(...fn({ ...opts, budget }));
    } catch (err) {
      errors.push(`${tool}: ${err.message}`);
    }
  }
  sessions.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || b.updatedAt - a.updatedAt);
  return { sessions, errors, at: Date.now() };
}
