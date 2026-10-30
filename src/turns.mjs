// 변경 파일을 지시(사용자 프롬프트) 단위로 나눈다. 편집 시각이 어느 지시 뒤에 있는지로 정하므로,
// 서브에이전트가 고친 것도 그 서브에이전트를 부른 지시에 들어간다.

// lock·빌드 결과처럼 사람이 볼 일이 적은 파일은 목록 끝에 흐리게 둔다.
const NOISE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|(^|\/)(dist|build|out|coverage)\//;

export const isNoiseFile = (path) => NOISE.test(path);

// 편집 시각 목록이 없는 기록(예전 캐시 등)은 마지막 편집 시각 하나로 본다.
const timesOf = (f) => f.times ?? [f.at];

// 탭: [이번 지시] → 편집이 있었던 이전 지시들(최신부터) → [전체].
export function turnTabs(s) {
  const turns = s.turns ?? [];
  const files = s.files ?? [];
  const last = turns.at(-1);
  const tabs = [{ key: 'now', label: '이번 지시', from: last?.at ?? 0, to: Infinity, turn: last ?? null }];
  for (let i = turns.length - 2; i >= 0; i--) {
    const from = turns[i].at;
    const to = turns[i + 1].at;
    if (files.some((f) => timesOf(f).some((t) => t >= from && t < to))) tabs.push({ key: turns[i].n, label: `T${turns[i].n}`, from, to, turn: turns[i] });
  }
  tabs.push({ key: 'all', label: '전체', from: 0, to: Infinity, turn: null });
  return tabs;
}

export function currentTab(s, key) {
  const tabs = turnTabs(s);
  return tabs.find((t) => t.key === key) ?? tabs[0];
}

// 고른 탭에 들어가는 파일. 편집 횟수·마지막 시각·변경 조각도 그 탭 기준으로 다시 센다.
export function filesForTab(s, tab) {
  const files = s.files ?? [];
  const inTab = (t) => t >= tab.from && t < tab.to;
  const out = [];
  for (const f of files) {
    if (tab.key === 'all') {
      out.push({ ...f, noise: isNoiseFile(f.path) });
      continue;
    }
    const times = timesOf(f).filter(inTab);
    if (!times.length) continue;
    out.push({ ...f, edits: f.times ? times.length : f.edits, at: Math.max(...times), hunks: f.hunks.filter((h) => inTab(h.at)), noise: isNoiseFile(f.path) });
  }
  return out.sort((a, b) => Number(a.noise) - Number(b.noise) || b.at - a.at);
}

export function visibleFiles(s, key) {
  return s ? filesForTab(s, currentTab(s, key)) : [];
}
