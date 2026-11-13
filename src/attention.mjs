// "끝났는데 아직 안 본" 세션 추적. aitop 메모리에만 두고 파일에는 쓰지 않는다.
// 작업 중(busy·shell)이던 세션이 대기(idle)로 바뀌었는데 그때 선택돼 있지 않았으면 확인 전으로 본다.

export function createAttention() {
  return { prev: new Map(), unseen: new Set() };
}

export function updateAttention(state, sessions, selectedId) {
  const ids = new Set();
  for (const s of sessions) {
    ids.add(s.id);
    const before = state.prev.get(s.id);
    // 상태를 기록 수정 시각으로 추측한 세션(statusGuessed)은, 작업이 아닌 줄이 붙어도 잠깐 작업 중으로 보이므로 확인 전으로 치지 않는다.
    if (s.id === selectedId || s.status === 'busy' || s.status === 'shell' || !s.live) state.unseen.delete(s.id);
    else if ((before === 'busy' || before === 'shell') && s.status === 'idle' && !s.statusGuessed) state.unseen.add(s.id);
    state.prev.set(s.id, s.status);
  }
  for (const id of state.prev.keys()) if (!ids.has(id)) state.prev.delete(id);
  for (const id of state.unseen) if (!ids.has(id)) state.unseen.delete(id);
}

export function markSeen(state, id) {
  state.unseen.delete(id);
}

// 다음에 봐야 할 세션: 지금 선택한 세션은 빼고, 그 다음 것부터 한 바퀴 돌며 응답 대기 → 확인 전 순서로 찾는다.
// 선택이 목록에 없으면(검색으로 가려짐 등) 맨 위부터 찾는다.
export function nextAttention(state, sessions, selectedId) {
  const at = sessions.findIndex((s) => s.id === selectedId);
  const ordered = at < 0 ? sessions : [...sessions.slice(at + 1), ...sessions.slice(0, at)];
  return ordered.find((s) => s.status === 'waiting') ?? ordered.find((s) => state.unseen.has(s.id)) ?? null;
}

// 응답 대기(◆)와 확인 전(●) 수.
export function attentionCounts(sessions) {
  return { waiting: sessions.filter((s) => s.live && s.status === 'waiting').length, unseen: sessions.filter((s) => s.unseen).length };
}

// 창 제목: 맨 앞 아이콘(탭 사이에서 aitop 을 찾게) + 응답 대기·확인 전 수. 예: 󰚩 (2◆ 1●) aitop
export function windowTitle(sessions, icon = '') {
  const { waiting, unseen } = attentionCounts(sessions);
  const marks = [waiting && `${waiting}◆`, unseen && `${unseen}●`].filter(Boolean);
  return (icon ? icon + ' ' : '') + (marks.length ? `(${marks.join(' ')}) aitop` : 'aitop');
}

// 새로 응답 대기가 된 세션 목록. seen 은 지난번 응답 대기 세션 id 집합이며 여기서 갱신한다.
export function freshWaiting(seen, sessions) {
  const now = sessions.filter((s) => s.live && s.status === 'waiting');
  const fresh = now.filter((s) => !seen.has(s.id));
  seen.clear();
  for (const s of now) seen.add(s.id);
  return fresh;
}

// 벨: 새로 응답 대기가 된 세션이 있을 때만 true.
export function newlyWaiting(seen, sessions) {
  return freshWaiting(seen, sessions).length > 0;
}

// --bell · --notify · --on-waiting 이 함께 쓰는 감시. 첫 갱신에서 이미 응답 대기인 세션은 알리지 않는다.
export function createWaitWatch() {
  return { seen: new Set(), ready: false };
}

export function takeNewlyWaiting(watch, sessions) {
  const fresh = freshWaiting(watch.seen, sessions);
  const ready = watch.ready;
  watch.ready = true;
  return ready ? fresh : [];
}

// 끝남(done)·context 경고 감시 (#204). 켠 종류만 bin 이 골라 알린다.
// done: 한 작업(턴)의 작업 중(busy·shell) 시간 합이 doneMs 이상이고, 대기(idle)가 settleMs 동안 이어지면 한 번 알린다.
//   도구 호출 사이의 잠깐 대기는 settleMs 안에 다시 작업 중이 되므로 같은 작업으로 이어 센다 (그 틈도 작업 시간에 넣는다).
//   응답 대기(waiting)는 따로 알리므로 끝남으로 치지 않는다. 같은 작업은 이어지지만 기다린 시간은 작업 시간에 넣지 않는다.
//   상태를 추측한 세션(statusGuessed), 끝난 세션, 하위 에이전트 줄은 알리지 않는다.
// context: 사용률이 ctxHigh 이상이 되면 한 번 알리고, ctxRearm 아래로 내려가면(압축 등) 다시 알릴 수 있게 한다.
//   기록을 다 읽기 전(s.loading)의 세션은 기준선만 잡고, 다 읽은 첫 갱신에 이미 높으면 알리지 않는다.
export const DONE_MS = 3 * 60_000;
export const SETTLE_MS = 5_000;
export const CTX_HIGH = 0.9;
export const CTX_REARM = 0.85;

export function createEventWatch({ doneMs = DONE_MS, settleMs = SETTLE_MS, ctxHigh = CTX_HIGH, ctxRearm = CTX_REARM } = {}) {
  return { doneMs, settleMs, ctxHigh, ctxRearm, per: new Map() };
}

const isBusy = (s) => s.status === 'busy' || s.status === 'shell';
const isSub = (s) => Boolean(s.parentId || s.parent || s.kind === 'subagent');
const ctxRatio = (s) => (s.context?.window > 0 ? (s.context.used ?? 0) / s.context.window : null);

// ready 가 false 면(처음 읽는 중) 상태만 기록하고 알리지 않는다. 돌려주는 값: [{ kind: 'done'|'context', session }]
export function takeEvents(watch, sessions, { now = Date.now(), ready = true } = {}) {
  const out = [];
  const ids = new Set();
  for (const s of sessions) {
    if (!s.live || s.status === 'ended' || isSub(s)) continue;
    ids.add(s.id);
    let st = watch.per.get(s.id);
    if (!st) watch.per.set(s.id, (st = { run: false, busyMs: 0, busyAt: null, idleSince: null, ctxArmed: true, first: true }));
    const reset = () => Object.assign(st, { run: false, busyMs: 0, busyAt: null, idleSince: null });

    // done
    if (s.statusGuessed) reset();
    else if (isBusy(s)) {
      st.run = true;
      st.busyAt ??= now;
      st.idleSince = null;
    } else if (s.status === 'idle' && st.run) {
      st.idleSince ??= now;
      if (now - st.idleSince >= watch.settleMs) {
        const worked = st.busyMs + (st.busyAt != null ? st.idleSince - st.busyAt : 0);
        if (ready && worked >= watch.doneMs) out.push({ kind: 'done', session: s });
        reset();
      }
    } else if (s.status === 'waiting' && st.run) {
      // 응답 대기 동안은 작업 시간을 멈춘다.
      if (st.busyAt != null) st.busyMs += (st.idleSince ?? now) - st.busyAt;
      st.busyAt = st.idleSince = null;
    } else reset();

    // context: 처음 다 읽은 세션이나 준비 전에는 이미 높은 값을 알리지 않는다.
    const r = ctxRatio(s);
    if (r != null) {
      if (r < watch.ctxRearm) st.ctxArmed = true;
      else if (r >= watch.ctxHigh && st.ctxArmed) {
        st.ctxArmed = false;
        if (ready && !st.first && !s.loading) out.push({ kind: 'context', session: s });
      }
    }
    if (!s.loading) st.first = false;
  }
  // 끝났거나 목록에서 빠진 세션은 잊는다 (다시 나타나면 처음부터 센다).
  for (const id of watch.per.keys()) if (!ids.has(id)) watch.per.delete(id);
  return out;
}
