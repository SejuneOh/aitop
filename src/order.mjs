// 세션 표의 정렬(s)과 묶기(g). 기본 순서는 받은 목록의 순서 그대로다 (collect.mjs 가 bySession 으로 줄 세워 넘긴다).
// 응답 대기 세션은 사람이 할 일이므로 어떤 정렬·묶기에서도 맨 위에 둔다.
// 묶을 때는 대기 세션을 프로젝트·도구 묶음에 섞지 않고 맨 위 '응답 대기' 묶음 하나로 모은다.
// 대기 세션이 제 프로젝트 묶음 안에 흩어지면 맨 위라는 약속이 깨지고, 묶음 머리 위에 따로 두면 어느 묶음 소속인지 헷갈린다.
// 고정(p)한 세션은 응답 대기 바로 아래에 고정한 순서대로 둔다. 정렬을 바꿔도 그 순서는 바뀌지 않고, 묶을 때는 '고정' 묶음 하나로 모은다.
// 응답 대기를 고정보다 위에 두는 것은 사람이 할 일이 고정 목록에 가려지지 않게 하려는 것이다. 고정한 세션이 응답 대기가 되면 대기 쪽으로 올라간다.
import { costOf } from './ui/draw.mjs';

export const SORTS = ['default', 'cost', 'context', 'recent'];
export const GROUPS = ['none', 'project', 'tool'];
export const WAITING_GROUP = '응답 대기';
export const PINNED_GROUP = '고정';
// 폴더를 모르는 세션의 프로젝트 묶음 이름. 응답 대기·고정·폴더 없음 이름은 묶음 키라 ko 로 두고 화면(ui/table.mjs groupRow)이 지금 언어로 바꾼다.
// 정렬·묶기 이름(s:비용 g:프로젝트)은 i18n.mjs 의 sort.*·groupBy.* 에 있다.
export const NO_FOLDER = '(폴더 없음)';

// pins 에 id 가 있으면 빼고, 없으면 끝에 붙인다 (고정한 순서를 지킨다). 새 배열을 돌려준다.
export const togglePin = (pins = [], id) => (pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id]);

const next = (list, cur) => list[(Math.max(0, list.indexOf(cur)) + 1) % list.length];
export const nextSort = (sort) => next(SORTS, sort ?? 'default');
export const nextGroup = (group) => next(GROUPS, group ?? 'none');

const ctxPct = (s) => (s.context?.window > 0 ? (s.context.used ?? 0) / s.context.window : -1);
const KEYS = {
  cost: (s, mode) => costOf(s, mode) ?? -1,
  context: ctxPct,
  recent: (s) => s.updatedAt ?? -Infinity,
};

// 기록을 읽는 동안 계속 커지는 값. 준비 완료 전에는 이 값으로 줄 세우지 않는다.
const GROWING = new Set(['cost', 'context']);

// 종료 세션은 어떤 정렬에서도 (묶음 안에서도) 아래에 둔다. 그다음 큰 값이 위. 값이 같으면 받은 순서(기본 순서)를 지켜 갱신마다 자리가 흔들리지 않게 한다 (Array.prototype.sort 는 안정 정렬).
// ready 가 false 면(시작할 때 기록을 아직 읽는 중) 비용·컨텍스트 정렬은 기본 순서에 고정했다가, 준비 완료 때 한 번만 다시 줄 세운다.
export function compare(sort, costMode = 'api', ready = true) {
  const key = KEYS[sort];
  if (!key) return () => 0;
  const ended = (s) => (s.status === 'ended' ? 1 : 0);
  if (ready === false && GROWING.has(sort)) return (a, b) => ended(a) - ended(b);
  return (a, b) => ended(a) - ended(b) || key(b, costMode) - key(a, costMode);
}

const projectOf = (s) => s.project || String(s.cwd ?? '').split('/').filter(Boolean).at(-1) || NO_FOLDER;
const GROUP_KEY = { project: projectOf, tool: (s) => s.tool ?? '?' };

// 돌려주는 sessions 는 화면에 그리는 순서 그대로다 (↑↓·n 도 이 순서를 따른다).
// groups 는 묶을 때만 있다: { name, count, cost, unknown, waiting, pinned, sessions }. 묶음은 그 안의 첫 세션이 정렬에서 앞선 순으로 놓인다.
// pins: 고정한 세션 id (고정한 순서). 화면에 없는 id 는 건너뛴다.
// ready: false 면 준비 완료 전이다 (compare 참고). 응답 대기 세션은 그동안에도 맨 위로 올린다.
export function arrange(sessions, { sort = 'default', group = 'none', costMode = 'api', pins = [], ready = true } = {}) {
  const cmp = compare(sort, costMode, ready);
  const rank = new Map((pins ?? []).map((id, i) => [id, i]));
  const waiting = sessions.filter((s) => s.status === 'waiting').sort(cmp);
  const pinned = sessions.filter((s) => s.status !== 'waiting' && rank.has(s.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  const rest = sessions.filter((s) => s.status !== 'waiting' && !rank.has(s.id)).sort(cmp);
  const keyOf = GROUP_KEY[group];
  if (!keyOf) return { sessions: [...waiting, ...pinned, ...rest], groups: null };
  const byName = new Map();
  for (const s of rest) {
    const name = keyOf(s);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(s);
  }
  const head = [...(waiting.length ? [[WAITING_GROUP, waiting, 'waiting']] : []), ...(pinned.length ? [[PINNED_GROUP, pinned, 'pinned']] : [])];
  const groups = [...head, ...[...byName].map(([name, list]) => [name, list, null])].map(([name, list, kind]) => ({
    name,
    count: list.length,
    cost: list.reduce((a, s) => a + (costOf(s, costMode) ?? 0), 0),
    unknown: list.some((s) => s.costUnknown),
    waiting: kind === 'waiting',
    pinned: kind === 'pinned',
    sessions: list,
  }));
  return { sessions: groups.flatMap((g) => g.sessions), groups };
}
