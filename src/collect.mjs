import { collectClaude } from './sources/claude.mjs';
import { collectCodex } from './sources/codex.mjs';
import { collectGemini } from './sources/gemini.mjs';

const RANK = { waiting: 0, busy: 1, shell: 2, live: 3, idle: 4, ended: 5 };

export function collect(opts) {
  const sessions = [];
  const errors = [];
  for (const [tool, fn] of [['claude', collectClaude], ['codex', collectCodex], ['gemini', collectGemini]]) {
    try {
      sessions.push(...fn(opts));
    } catch (err) {
      errors.push(`${tool}: ${err.message}`);
    }
  }
  sessions.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || b.updatedAt - a.updatedAt);
  return { sessions, errors, at: Date.now() };
}
