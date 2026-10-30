// 변경 파일을 지시(사용자 프롬프트) 단위로 나눈다. 편집이 어느 지시 뒤에 있는지로 정한다.
// 서브에이전트 편집은 서브에이전트가 시작한 시각(turnAt)으로 나누므로, 그 서브에이전트를 부른 지시에 들어간다.

// lock·빌드 결과처럼 사람이 볼 일이 적은 파일은 목록 끝에 흐리게 둔다.
const NOISE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|(^|\/)(dist|build|out|coverage)\//;

export const isNoiseFile = (path) => NOISE.test(path);

// 편집 기록이 없는 파일(예전 캐시 등)은 마지막 편집 한 번에 세션 합계가 몰린 것으로 본다.
const logOf = (f) => f.log ?? [{ at: f.at, add: f.add, del: f.del, created: f.created, count: f.edits }];
const turnAt = (x) => x.turnAt ?? x.at;

// 화면은 초당 여러 번 그리므로, 파일·지시 목록이 그대로면 계산을 다시 하지 않는다.
const memo = new WeakMap();
function cached(s) {
  let c = memo.get(s);
  if (!c || c.files$ !== s.files || c.turns$ !== s.turns || c.turnsLen !== s.turns?.length) {
    memo.set(s, (c = { files$: s.files, turns$: s.turns, turnsLen: s.turns?.length, tabs: null, files: new Map() }));
  }
  return c;
}

// 탭: [이번 지시] → 편집이 있었던 이전 지시들(최신부터) → [전체].
export function turnTabs(s) {
  const c = cached(s);
  if (c.tabs) return c.tabs;
  const turns = s.turns ?? [];
  const times = (s.files ?? []).flatMap((f) => logOf(f).map(turnAt));
  const last = turns.at(-1);
  const tabs = [{ key: 'now', label: '이번 지시', from: last?.at ?? 0, to: Infinity, turn: last ?? null }];
  for (let i = turns.length - 2; i >= 0; i--) {
    const from = turns[i].at;
    const to = turns[i + 1].at;
    if (times.some((t) => t >= from && t < to)) tabs.push({ key: turns[i].n, label: `T${turns[i].n}`, from, to, turn: turns[i] });
  }
  tabs.push({ key: 'all', label: '전체', from: 0, to: Infinity, turn: null });
  return (c.tabs = tabs);
}

export function currentTab(s, key) {
  const tabs = turnTabs(s);
  return tabs.find((t) => t.key === key) ?? tabs[0];
}

// 고른 탭에 들어가는 파일. 편집 횟수·줄 수·새 파일 여부·마지막 시각·변경 조각을 그 탭 기준으로 다시 센다.
export function filesForTab(s, tab) {
  const c = cached(s);
  if (c.files.has(tab.key)) return c.files.get(tab.key);
  const inTab = (x) => turnAt(x) >= tab.from && turnAt(x) < tab.to;
  const out = [];
  for (const f of s.files ?? []) {
    if (tab.key === 'all') {
      out.push({ ...f, noise: isNoiseFile(f.path) });
      continue;
    }
    const log = logOf(f).filter(inTab);
    if (!log.length) continue;
    const hunks = f.hunks.filter(inTab);
    const kept = new Set(hunks.map((h) => h.at));
    out.push({
      ...f,
      edits: log.reduce((a, e) => a + (e.count ?? 1), 0),
      add: log.reduce((a, e) => a + e.add, 0),
      del: log.reduce((a, e) => a + e.del, 0),
      created: log.some((e) => e.created),
      at: Math.max(...log.map((e) => e.at)),
      hunks,
      dropped: f.hidden ? 0 : log.filter((e) => !kept.has(e.at)).length,
      noise: isNoiseFile(f.path),
    });
  }
  out.sort((a, b) => Number(a.noise) - Number(b.noise) || b.at - a.at);
  c.files.set(tab.key, out);
  return out;
}

export function visibleFiles(s, key) {
  return s ? filesForTab(s, currentTab(s, key)) : [];
}
