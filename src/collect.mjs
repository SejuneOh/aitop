import { collectClaude } from './sources/claude.mjs';
import { collectCodex } from './sources/codex.mjs';
import { collectGemini } from './sources/gemini.mjs';
import { collectLedger } from './sources/claude-ledger.mjs';
import { createBudget } from './tail.mjs';

const RANK = { waiting: 0, busy: 1, shell: 2, live: 3, idle: 4, ended: 5 };

// budgetBytes: 이번 갱신에서 세션 기록을 읽을 최대 바이트. 실시간 화면은 작게 잡아 큰 기록을 여러 번에 나눠 읽는다.
// 도구마다, 그리고 날짜별 사용량 장부에 한도를 따로 줘서 서로의 읽기를 막지 않게 한다.
export function collect({ budgetBytes = Infinity, ...opts } = {}) {
  const sessions = [];
  const errors = [];
  for (const [tool, fn] of [['claude', collectClaude], ['codex', collectCodex], ['gemini', collectGemini]]) {
    try {
      sessions.push(...fn({ ...opts, budget: createBudget(budgetBytes) }));
    } catch (err) {
      errors.push(`${tool}: ${err.message}`);
    }
  }
  // 장부는 세션 화면보다 덜 급하니 한 번 갱신에 세션 한도의 1/3 만 읽는다 (처음 한 번 다 읽은 뒤에는 캐시와 새 줄만 읽는다).
  let usage = null;
  try {
    usage = collectLedger({ budget: createBudget(budgetBytes / 3) });
  } catch (err) {
    errors.push(`usage: ${err.message}`);
  }
  sessions.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || b.updatedAt - a.updatedAt);
  return { sessions, usage, errors, at: Date.now() };
}
