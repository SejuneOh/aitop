// 시작할 때의 로딩을 차분하게: 준비 완료 래치와, 로딩 중 다시 그리기 속도 제한.
// 캐시가 없으면 세션 기록과 7일 장부를 여러 갱신에 나눠 읽는데, 갱신마다 그리면 숫자·순서·진행률이 쉬지 않고 바뀐다.

// 준비 완료를 기다리는 최대 시간. 디스크가 느려 읽기 한도(바이트·시간)에 계속 걸려도 이만큼 지나면 준비 완료로 본다.
export const READY_CAP_MS = 60_000;
// 로딩 중에는 중요한 변화가 없으면 이 간격보다 자주 화면에 올리지 않는다.
export const LOADING_DRAW_MS = 1000;

// now: 시계 (테스트에서 바꿔 넣는다).
export function createLoading({ now = Date.now, capMs = READY_CAP_MS, drawMs = LOADING_DRAW_MS } = {}) {
  return { now, capMs, drawMs, startedAt: now(), ready: false, shownAt: -Infinity, shown: null };
}

// 준비 완료 = 처음으로 more(세션 기록만, collect 의 sessionsMore)가 거짓인 갱신, 또는 시작 후 capMs. 한 번 켜지면 되돌리지 않는다 (more 는 한도가 시간이기도 해서 다시 참이 될 수 있다).
// 7일 장부(usage.loading)는 준비 완료 조건에 넣지 않고 헤더 진행 줄로만 보인다.
export function latchReady(L, more) {
  if (!L.ready && (more === false || L.now() - L.startedAt >= L.capMs)) L.ready = true;
  return L.ready;
}

// 바로 그려야 하는 변화를 가리는 데 쓰는 값: 세션 목록과 응답 대기 세션.
const signature = (data) => {
  const list = data?.sessions ?? [];
  return `${list.map((s) => s.id).join(',')}|${list.filter((s) => s.status === 'waiting').map((s) => s.id).join(',')}`;
};

// 이번 갱신 결과를 화면에 올릴지 정한다. 준비 완료 전이나 7일 집계 중에는 drawMs 에 한 번만 올리고,
// 첫 화면, 준비 완료 순간, 집계가 끝난 순간, 세션 목록·응답 대기가 바뀐 갱신은 바로 올린다. 로딩이 끝난 뒤에는 늘 올린다.
// 준비 완료 순간은 화면에 마지막으로 올린 값과 견준다 (부르는 쪽이 admit 전에 latchReady 를 먼저 불러도 바로 올린다).
export function admit(L, data) {
  const ready = latchReady(L, data.sessionsMore ?? data.more);
  const loading = data.usage?.loading != null;
  const prev = L.shown;
  const sig = signature(data);
  const urgent =
    !prev ||
    (ready && !prev.ready) ||
    (!loading && prev.loading) ||
    sig !== prev.sig;
  const now = L.now();
  if (!urgent && (!ready || loading) && now - L.shownAt < L.drawMs) return false;
  L.shown = { sig, loading, ready };
  L.shownAt = now;
  return true;
}
