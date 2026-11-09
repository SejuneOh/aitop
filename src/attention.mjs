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
