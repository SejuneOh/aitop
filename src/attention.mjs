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
    if (s.id === selectedId || s.status === 'busy' || s.status === 'shell' || !s.live) state.unseen.delete(s.id);
    else if ((before === 'busy' || before === 'shell') && s.status === 'idle') state.unseen.add(s.id);
    state.prev.set(s.id, s.status);
  }
  for (const id of state.prev.keys()) if (!ids.has(id)) state.prev.delete(id);
  for (const id of state.unseen) if (!ids.has(id)) state.unseen.delete(id);
}

export function markSeen(state, id) {
  state.unseen.delete(id);
}

// 다음에 봐야 할 세션: 응답 대기 → 확인 전 순서로, 지금 선택 다음 것부터 한 바퀴 돈다.
export function nextAttention(state, sessions, selectedId) {
  const start = Math.max(0, sessions.findIndex((s) => s.id === selectedId));
  const ordered = [...sessions.slice(start + 1), ...sessions.slice(0, start + 1)];
  return ordered.find((s) => s.status === 'waiting') ?? ordered.find((s) => state.unseen.has(s.id)) ?? null;
}
