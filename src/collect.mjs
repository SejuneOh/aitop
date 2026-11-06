import { collectClaude } from './sources/claude.mjs';
import { collectCodex } from './sources/codex.mjs';
import { collectGemini } from './sources/gemini.mjs';
import { collectAgy } from './sources/antigravity.mjs';
import { collectLedger } from './sources/claude-ledger.mjs';
import { createBudget } from './tail.mjs';

const RANK = { waiting: 0, busy: 1, shell: 2, live: 3, idle: 4, ended: 5 };

// 상태 순서가 먼저다. 같은 상태 안에서는 갱신마다 자리가 바뀌지 않도록 바뀌지 않는 값으로 줄 세운다:
// 늦게 시작한 세션이 위, 시작 시각이 없으면 아래, 그다음 도구·id 순.
// 종료 세션은 더 바뀌지 않으므로 최근에 끝난 세션이 위로 오게 마지막 활동 시각으로 줄 세운다.
export function bySession(a, b) {
  const at = (s) => (s.status === 'ended' ? s.updatedAt : s.startedAt) ?? -Infinity;
  return (
    (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) ||
    at(b) - at(a) ||
    String(a.tool ?? '').localeCompare(String(b.tool ?? '')) ||
    String(a.id ?? '').localeCompare(String(b.id ?? ''))
  );
}

// budgetBytes·budgetMs: 이번 갱신에서 세션 기록을 읽을 최대 바이트와 시간. 실시간 화면은 작게 잡아 큰 기록을 여러 번에 나눠 읽는다.
// 돌려주는 more 가 true 면 한도 때문에 덜 읽은 기록이 있다.
// 도구마다, 그리고 날짜별 사용량 장부에 한도를 따로 줘서 서로의 읽기를 막지 않게 한다.
export function collect({ budgetBytes = Infinity, budgetMs = Infinity, ...opts } = {}) {
  const budgets = [];
  const budgetOf = (bytes, ms) => {
    const b = createBudget(bytes, ms);
    budgets.push(b);
    return b;
  };
  const sessions = [];
  const errors = [];
  for (const [tool, fn] of [['claude', collectClaude], ['codex', collectCodex], ['gemini', collectGemini], ['agy', collectAgy]]) {
    try {
      sessions.push(...fn({ ...opts, budget: budgetOf(budgetBytes, budgetMs) }));
    } catch (err) {
      errors.push(`${tool}: ${err.message}`);
    }
  }
  // 장부는 세션 화면보다 덜 급하니 한 번 갱신에 세션 한도의 1/3 만 읽는다 (처음 한 번 다 읽은 뒤에는 캐시와 새 줄만 읽는다).
  let usage = null;
  try {
    usage = collectLedger({ budget: budgetOf(budgetBytes / 3, budgetMs / 2) });
  } catch (err) {
    errors.push(`usage: ${err.message}`);
  }
  sessions.sort(bySession);
  return { sessions, usage, errors, at: Date.now(), more: budgets.some((b) => b.exhausted) };
}
