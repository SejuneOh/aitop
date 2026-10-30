// Gemini CLI: 아직 세션 기록 형식을 확인하지 못해 실행 중인 프로세스만 보여 준다.
import { basename } from 'node:path';
import { findProcesses, isGemini } from '../procs.mjs';
import { emptyTokens } from './common.mjs';

export function collectGemini() {
  return findProcesses(isGemini).map((p) => ({
    tool: 'gemini',
    id: `pid-${p.pid}`,
    pid: p.pid,
    kind: 'interactive',
    name: basename(p.cwd ?? '') || 'gemini',
    cwd: p.cwd,
    project: basename(p.cwd ?? ''),
    live: true,
    status: 'live',
    now: '진행 내용·토큰은 아직 지원하지 않습니다',
    updatedAt: Date.now(),
    tokens: emptyTokens(),
    context: { used: 0, window: 0 },
    events: [],
    members: [],
  }));
}
