// aitop --json 출력. 다른 스크립트나 AI 가 읽기 쉬운 모양으로 세션 목록과 사용량 합계를 담는다.
// 텍스트는 수집 단계에서 이미 비밀값 가림이 적용돼 있다.

const pickTokens = (t = {}) => ({ total: t.total ?? 0, input: t.input ?? 0, output: t.output ?? 0, cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0, main: t.main ?? null, sub: t.sub ?? null, subCount: t.subCount ?? null });

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function toJson(data) {
  return {
    at: iso(data.at),
    usage: data.usage ? { today: data.usage.today, last7days: data.usage.week, complete: data.usage.loading == null } : null,
    sessions: data.sessions.map((s) => ({
      tool: s.tool,
      id: s.id,
      name: s.name ?? null,
      project: s.project ?? null,
      cwd: s.cwd ?? null,
      branch: s.branch ?? null,
      model: s.model ?? null,
      kind: s.kind ?? null,
      pid: s.pid ?? null,
      live: Boolean(s.live),
      status: s.status,
      phase: s.phase?.text ?? null,
      waitingFor: s.waitingFor ?? null,
      now: s.now || null,
      startedAt: iso(s.startedAt),
      updatedAt: iso(s.updatedAt),
      tokens: pickTokens(s.tokens),
      cost: s.cost ?? null,
      costNoCache: s.costNoCache ?? null,
      costUnknown: Boolean(s.costUnknown),
      context: { used: s.context?.used ?? 0, window: s.context?.window ?? null },
      // 변경 내용(diff)은 넣지 않고 파일별 통계만 넣는다. 줄 수는 편집마다 더한 누적값이다 (git diff 아님).
      files: (s.files ?? []).map((f) => ({ path: f.path, created: Boolean(f.created), edits: f.edits, writtenLines: f.add, deletedLines: f.del, updatedAt: iso(f.at), agents: f.agents ?? [] })),
      members: (s.members ?? []).map((m) => ({ name: m.name, task: m.task ?? null, model: m.model ?? null, status: m.status, phase: m.phase?.text ?? null, tokens: m.tokens ?? 0, cost: m.cost ?? null })),
    })),
  };
}
