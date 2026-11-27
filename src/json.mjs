import { projectBudget } from './budget.mjs';
import { toolsJson } from './doctor.mjs';
import { phaseText } from './i18n.mjs';
import { resumeCmd } from './resume.mjs';
import { cacheHitRate, hitJson, memberStalled } from './sources/common.mjs';
import { artifactLink } from './sources/artifacts.mjs';
import { freshLimits } from './limits.mjs';

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
// opts.platform: 원격 세션(#308) resumeCmd 의 로컬 셸 따옴표를 고르는 플랫폼 (기본 process.platform, 테스트에서 바꿔 끼운다).
// opts.budgetDay: 하루 예산. 있으면 usage.budget 에 예산, 오늘 끝 예상 비용(API 정가 환산, 화면과 같은 기준), 단계를 넣는다.
// --json 의 phase 문구. 한국어 표로 만든다 (영어 화면 1/3 의 계약).
const koPhase = (p) => (p?.kind ? phaseText(p, { lang: 'ko' }) : null);

// --json 모양의 버전 (#308). 다른 aitop 이 --remote 로 이 출력을 읽을 때 모양이 맞는지 본다.
// 필드를 더하기만 하면 그대로 두고, 있던 필드의 뜻이나 모양을 바꿀 때 올린다.
export const SCHEMA = 1;
const remoteOf = (r) => ({ name: r.name, kind: r.kind, ok: Boolean(r.ok), error: r.error ?? null, version: r.version ?? null, schema: r.schema ?? null, at: iso(r.at) });

// Claude 한도 (#332): --statusline 이 저장한 값 중 아직 유효한 창만. 값이 없거나 오래됐으면 null.
// usedPercent 는 0~100 (spend 는 한도를 넘으면 100 초과), resetsAt·at 은 ISO 시각.
const winJson = (w) => (w ? { usedPercent: w.pct, resetsAt: iso(w.resetsAt) } : null);
export function limitsJson(rec, now = Date.now()) {
  const f = freshLimits(rec, now);
  if (!f) return null;
  return { fiveHour: winJson(f.fiveHour), sevenDay: winJson(f.sevenDay), ...(f.spend ? { spend: winJson(f.spend) } : {}), at: iso(f.at) };
}

export function toJson(data, version = null, opts = {}) {
  const b = data.usage ? projectBudget(data.usage, opts.budgetDay, { now: data.at ?? Date.now() }) : null;
  return {
    version,
    schema: SCHEMA,
    at: iso(data.at),
    tools: toolsJson(data.tools?.tools),
    usage: data.usage ? { today: usageOf(data.usage.today), last7days: { ...usageOf(data.usage.week), ...dailyOf(data.usage.days7) }, lastHour: lastHourOf(data.usage.lastHour), complete: data.usage.loading == null, ...(b ? { budget: { day: b.day, projected: money(b.projected), unknown: b.unknown, level: b.level } } : {}) } : null,
    // 이 기기의 Claude 남은 사용 한도 (aitop --statusline 을 Claude Code 상태줄에 넣었을 때만 값이 있다).
    limits: { claude: limitsJson(data.limits, data.at ?? Date.now()) },
    // --remote 로 모은 원격마다 마지막 결과 (#308). 원격을 켜지 않으면 빈 배열. at 은 마지막으로 성공한 시각.
    remotes: (data.remotes ?? []).map(remoteOf),
    sessions: data.sessions.map((s) => ({
      tool: s.tool,
      // 원격 세션의 id 는 '<host>:<원래 id>' 이고 원래 id 는 remoteId 에 있다. 로컬 세션은 host·remoteId 가 null.
      id: s.id,
      host: s.host ?? null,
      remoteId: s.host ? (s.remoteId ?? null) : null,
      name: s.name ?? null,
      project: s.project ?? null,
      cwd: s.cwd ?? null,
      branch: s.branch ?? null,
      model: s.model ?? null,
      kind: s.kind ?? null,
      // 실행 방식 (Claude 기록의 entrypoint: 'cli', 'sdk-cli', Cowork 는 'local-agent' 등, 모르면 null). auto 는 부모 세션을 못 찾은 claude -p 실행 (#286).
      // 부모를 찾은 claude -p 실행은 여기 없고 부모의 members 에 entrypoint·parentId 와 함께 들어간다 (합계도 부모에 더해져 있다).
      entrypoint: s.entrypoint ?? null,
      // 기록이 온 곳. Antigravity(tool 'gemini' 이고 기록이 있는 세션)만 'cli'(agy CLI) 또는 'app'(데스크톱 앱), 나머지는 null (#303).
      source: s.source ?? null,
      auto: Boolean(s.auto),
      pid: s.pid ?? null,
      live: Boolean(s.live),
      status: s.status,
      // phase 는 화면 언어와 상관없이 늘 한국어 문구(예전과 같은 글)로 두고, 언어와 상관없는 상태 이름은 phaseKind 로 준다.
      phase: koPhase(s.phase),
      phaseKind: s.phase?.kind ?? null,
      // 오류로 멈춘 이유 { kind: 'auth'|'network'|'api' } (phaseKind 가 stopped 일 때만), 아니면 null.
      stopReason: s.stopReason ?? null,
      // 프롬프트 캐시가 만료되는 시각 (Claude 의 응답 대기·다음 지시 대기 세션만, 마지막 요청 시작 기준 추정). 이미 지난 시각일 수 있다.
      cacheExpiresAt: iso(s.cacheExpiresAt),
      // 지금 도는 도구가 시작된 시각 (작업 중이고 진행 단계가 도구 실행일 때만, 허락 대기 중이면 null). 화면과 달리 1분 미만도 나간다.
      toolStartedAt: iso(s.toolStartedAt),
      waitingFor: s.waitingFor ?? null,
      // 이 세션을 이어 여는 셸 명령 (resume.mjs). 만들 수 없으면 null.
      resumeCmd: resumeCmd(s, { platform: opts.platform }),
      // 허락을 기다리는 요청의 전체 내용 (Bash 명령, 파일 경로 등). --show-requests 를 켰을 때만 넣는다. 비밀값 가림은 최선을 다할 뿐이다.
      ...(opts.showRequests ? { waitDetail: s.waitDetail ?? null } : {}),
      now: s.now || null,
      startedAt: iso(s.startedAt),
      updatedAt: iso(s.updatedAt),
      tokens: pickTokens(s.tokens),
      // 프롬프트 캐시 적중률 (#334): 캐시 읽기 / (입력 + 캐시 읽기 + 캐시 쓰기), 메인과 서브에이전트 합. 0~1, 소수 셋째 자리. 토큰 내역을 모르면 null.
      cacheHitRate: hitJson(cacheHitRate(s.tokens)),
      cost: money(s.cost),
      costNoCache: money(s.costNoCache),
      costUnknown: Boolean(s.costUnknown),
      context: { used: s.context?.used ?? 0, window: s.context?.window ?? null },
      // 변경 내용(diff)은 넣지 않고 파일별 통계만 넣는다. 줄 수는 편집마다 더한 누적값이다 (git diff 아님).
      files: (s.files ?? []).map((f) => ({ path: f.path, created: Boolean(f.created), edits: f.edits, writtenLines: f.add, deletedLines: f.del, updatedAt: iso(f.at), agents: f.agents ?? [] })),
      // Artifact 도구로 게시한 것 (Claude·Cowork, 서브에이전트 포함, 마지막 게시가 최근인 것부터). url 은 https://claude.ai/ 주소만 두고 나머지는 null, audience 는 기록 값 그대로('owner'·'org' 등).
      // versionFrom·versionTo 는 이 세션에서 본 게시 버전 범위, viaEdits 는 마지막 게시가 edits 로 바로 고친 것인지다.
      artifacts: (s.artifacts ?? []).map((a) => ({ title: a.title ?? null, url: artifactLink(a.url), versionFrom: a.from ?? null, versionTo: a.to ?? null, updatedAt: iso(a.at), audience: a.audience ?? null, viaEdits: Boolean(a.edits) })),
      // startedAt·lastActivityAt 은 세션의 startedAt·updatedAt 과 같은 ISO 시각이다 (모르면 null).
      // stalled 는 화면의 '멈춘 듯' 과 같은 짐작(common.mjs memberStalled)을 data.at 기준으로 본 값이다.
      members: (s.members ?? []).map((m) => ({ ...(m.sdk ? { id: m.id, entrypoint: m.entrypoint ?? null, parentId: m.parentId ?? s.id } : {}), name: m.name, task: m.task ?? null, model: m.model ?? null, status: m.status, phase: koPhase(m.phase), phaseKind: m.phase?.kind ?? null, tokens: m.tokens ?? 0, cost: money(m.cost), startedAt: iso(m.startedAt), lastActivityAt: iso(m.lastActivityAt), stalled: memberStalled(m, data.at ?? Date.now(), s.status) })),
    })),
  };
}
