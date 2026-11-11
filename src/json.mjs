import { projectBudget } from './budget.mjs';
import { toolsJson } from './doctor.mjs';

// aitop --json 출력. 다른 스크립트나 AI 가 읽기 쉬운 모양으로 세션 목록과 사용량 합계를 담는다.
// 텍스트는 수집 단계에서 이미 비밀값 가림이 적용돼 있다.

const pickTokens = (t = {}) => ({ total: t.total ?? 0, input: t.input ?? 0, output: t.output ?? 0, cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0, main: t.main ?? null, sub: t.sub ?? null, subCount: t.subCount ?? null });

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
// 비용(달러)은 소수 넷째 자리까지 반올림한다.
const money = (x) => (typeof x === 'number' ? Math.round(x * 1e4) / 1e4 : (x ?? null));
// 최근 1시간 비용 (5분 칸 단위 근사).
const lastHourOf = (h) => (h ? { cost: money(h.cost), costNoCache: money(h.costNoCache), unknown: Boolean(h.unknown) } : null);
// last7days.daily: 날짜별 API 환산 비용 (오래된 날 → 오늘). unknown 은 가격표에 없는 모델이 섞인 날.
const dailyOf = (days) => (days ? { daily: days.map((d) => ({ date: d.date, cost: money(d.cost), unknown: Boolean(d.unknown) })) } : {});
const usageOf = (u) => (u ? { ...u, ...('cost' in u ? { cost: money(u.cost) } : {}) } : u);

// version 은 aitop 버전, tools 는 aitop --doctor 와 같은 도구별 점검 결과다.
// opts.showRequests: 응답 대기 요청 전체(waitDetail)를 넣는다. 기본은 꺼져 있다.
// opts.budgetDay: 하루 예산. 있으면 usage.budget 에 예산, 오늘 끝 예상 비용(API 정가 환산, 화면과 같은 기준), 단계를 넣는다.
export function toJson(data, version = null, opts = {}) {
  const b = data.usage ? projectBudget(data.usage, opts.budgetDay, { now: data.at ?? Date.now() }) : null;
  return {
    version,
    at: iso(data.at),
    tools: toolsJson(data.tools?.tools),
    usage: data.usage ? { today: usageOf(data.usage.today), last7days: { ...usageOf(data.usage.week), ...dailyOf(data.usage.days7) }, lastHour: lastHourOf(data.usage.lastHour), complete: data.usage.loading == null, ...(b ? { budget: { day: b.day, projected: money(b.projected), unknown: b.unknown, level: b.level } } : {}) } : null,
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
      // phase 는 화면 문구(한국어) 그대로 두고, 언어와 상관없는 상태 이름은 phaseKind 로 준다.
      phase: s.phase?.text ?? null,
      phaseKind: s.phase?.kind ?? null,
      waitingFor: s.waitingFor ?? null,
      // 허락을 기다리는 요청의 전체 내용 (Bash 명령, 파일 경로 등). --show-requests 를 켰을 때만 넣는다. 비밀값 가림은 최선을 다할 뿐이다.
      ...(opts.showRequests ? { waitDetail: s.waitDetail ?? null } : {}),
      now: s.now || null,
      startedAt: iso(s.startedAt),
      updatedAt: iso(s.updatedAt),
      tokens: pickTokens(s.tokens),
      cost: money(s.cost),
      costNoCache: money(s.costNoCache),
      costUnknown: Boolean(s.costUnknown),
      context: { used: s.context?.used ?? 0, window: s.context?.window ?? null },
      // 변경 내용(diff)은 넣지 않고 파일별 통계만 넣는다. 줄 수는 편집마다 더한 누적값이다 (git diff 아님).
      files: (s.files ?? []).map((f) => ({ path: f.path, created: Boolean(f.created), edits: f.edits, writtenLines: f.add, deletedLines: f.del, updatedAt: iso(f.at), agents: f.agents ?? [] })),
      members: (s.members ?? []).map((m) => ({ name: m.name, task: m.task ?? null, model: m.model ?? null, status: m.status, phase: m.phase?.text ?? null, phaseKind: m.phase?.kind ?? null, tokens: m.tokens ?? 0, cost: money(m.cost) })),
    })),
  };
}
