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
    phase: { kind: 'idle', text: '실행 중 (세부 정보 미지원)' },
    cost: null,
    now: '',
    updatedAt: Date.now(),
    tokens: emptyTokens(),
    context: { used: 0, window: 0 },
    events: [],
    members: [],
  }));
}
