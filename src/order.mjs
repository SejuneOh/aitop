// 세션 표의 정렬(s)과 묶기(g). 기본 순서는 받은 목록의 순서 그대로다 (collect.mjs 가 bySession 으로 줄 세워 넘긴다).
// 응답 대기 세션은 사람이 할 일이므로 어떤 정렬·묶기에서도 맨 위에 둔다.
// 묶을 때는 대기 세션을 프로젝트·도구 묶음에 섞지 않고 맨 위 '응답 대기' 묶음 하나로 모은다.
// 대기 세션이 제 프로젝트 묶음 안에 흩어지면 맨 위라는 약속이 깨지고, 묶음 머리 위에 따로 두면 어느 묶음 소속인지 헷갈린다.
import { costOf } from './ui/draw.mjs';

export const SORTS = ['default', 'cost', 'context', 'recent'];
export const GROUPS = ['none', 'project', 'tool'];
export const SORT_LABEL = { default: '기본', cost: '비용', context: '컨텍스트', recent: '최근' };
export const GROUP_LABEL = { none: '없음', project: '프로젝트', tool: '도구' };
export const WAITING_GROUP = '응답 대기';

const next = (list, cur) => list[(Math.max(0, list.indexOf(cur)) + 1) % list.length];
export const nextSort = (sort) => next(SORTS, sort ?? 'default');
export const nextGroup = (group) => next(GROUPS, group ?? 'none');

const ctxPct = (s) => (s.context?.window > 0 ? (s.context.used ?? 0) / s.context.window : -1);
const KEYS = {
  cost: (s, mode) => costOf(s, mode) ?? -1,
  context: ctxPct,
  recent: (s) => s.updatedAt ?? -Infinity,
};

// 종료 세션은 어떤 정렬에서도 (묶음 안에서도) 아래에 둔다. 그다음 큰 값이 위. 값이 같으면 받은 순서(기본 순서)를 지켜 갱신마다 자리가 흔들리지 않게 한다 (Array.prototype.sort 는 안정 정렬).
export function compare(sort, costMode = 'api') {
  const key = KEYS[sort];
  if (!key) return () => 0;
  const ended = (s) => (s.status === 'ended' ? 1 : 0);
  return (a, b) => ended(a) - ended(b) || key(b, costMode) - key(a, costMode);
}

const projectOf = (s) => s.project || String(s.cwd ?? '').split('/').filter(Boolean).at(-1) || '(폴더 없음)';
const GROUP_KEY = { project: projectOf, tool: (s) => s.tool ?? '?' };

// 돌려주는 sessions 는 화면에 그리는 순서 그대로다 (↑↓·n 도 이 순서를 따른다).
// groups 는 묶을 때만 있다: { name, count, cost, unknown, waiting, sessions }. 묶음은 그 안의 첫 세션이 정렬에서 앞선 순으로 놓인다.
export function arrange(sessions, { sort = 'default', group = 'none', costMode = 'api' } = {}) {
  const cmp = compare(sort, costMode);
  const waiting = sessions.filter((s) => s.status === 'waiting').sort(cmp);
  const rest = sessions.filter((s) => s.status !== 'waiting').sort(cmp);
  const keyOf = GROUP_KEY[group];
  if (!keyOf) return { sessions: [...waiting, ...rest], groups: null };
  const byName = new Map();
  for (const s of rest) {
    const name = keyOf(s);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(s);
  }
  const groups = [...(waiting.length ? [[WAITING_GROUP, waiting, true]] : []), ...[...byName].map(([name, list]) => [name, list, false])].map(([name, list, isWaiting]) => ({
    name,
    count: list.length,
    cost: list.reduce((a, s) => a + (costOf(s, costMode) ?? 0), 0),
    unknown: list.some((s) => s.costUnknown),
    waiting: isWaiting,
    sessions: list,
  }));
  return { sessions: groups.flatMap((g) => g.sessions), groups };
}
