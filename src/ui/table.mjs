// 위쪽 화면: 요약 헤더, 도구 줄, 세션 표(팀원 행 포함), 세션이 없을 때의 점검 줄.
import { describe } from '../doctor.mjs';
import { BRAND } from '../brand.mjs';
import { projectBudget } from '../budget.mjs';
import { fmtAgo, fmtTokens, pad, truncate, width } from '../text.mjs';
import { BUDGET_COLOR, PALETTE, PHASE_COLOR, RESET, style } from './theme.mjs';
import { NOW, SPIN, clock, costOf, gauge, glyph, levelBar, line, money, segsWidth, shortModel } from './draw.mjs';
import { glyphs } from './glyphs.mjs';
import { phaseText, t } from '../i18n.mjs';
import { NO_FOLDER } from '../order.mjs';

// 검색어가 세션 이름·폴더·모델 중 하나에 들어 있으면 남긴다 (대소문자 무시).
export function filterSessions(sessions, query) {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => [s.name, s.project, s.cwd, s.model, s.tool].some((v) => String(v ?? '').toLowerCase().includes(q)));
}

// 표 폭이 WIDE 이상이면 COST 와 CONTEXT 막대 11칸을 그대로 두고, 폭에 따라 MODEL(104~)·PROJECT(110~) 를 더한다.
// 그보다 좁으면 위에서부터 차례로 시도한다: CONTEXT 막대를 4칸으로 줄이고, 막대 없이 % 만 남긴다.
// 그래도 STATUS 가 12칸이 안 되면 COST 를 빼고, 마지막에 SESSION 을 줄인다.
// cells 는 CONTEXT 막대 칸 수이고 % 는 늘 5칸을 쓴다. 각 단계는 STATUS 가 minStatus 칸 이상 남을 때만 쓴다.
const WIDE = 96;
const NARROW = [
  { cost: true, cells: 4, minName: 14, minStatus: 20 },
  { cost: true, cells: 0, minName: 14, minStatus: 12 },
  { cells: 0, minName: 14, minStatus: 12 },
  { cells: 0, minName: 10, minStatus: 0 },
];

function layout(W, l) {
  const fixed = { mark: 1, glyph: 2, tool: 7, model: l.model ? 10 : 0, tokens: 7, cost: l.cost ? 9 : 0, ctx: l.cells + 5, age: 4 };
  const gaps = 5 + (l.project ? 1 : 0) + (l.cost ? 1 : 0) + (l.model ? 1 : 0);
  const flex = W - Object.values(fixed).reduce((a, b) => a + b, 0) - gaps - 1;
  const name = Math.max(l.minName, Math.min(32, Math.floor(flex * 0.36)));
  const project = l.project ? Math.max(10, Math.min(22, Math.floor(flex * 0.22))) : 0;
  const status = flex - name - project;
  return { ...fixed, cells: l.cells, name, project, status, showProject: Boolean(l.project), showCost: Boolean(l.cost), showModel: Boolean(l.model) };
}

export function columns(W) {
  if (W >= WIDE) return layout(W, { project: W >= 110, model: W >= 104, cost: true, cells: 11, minName: 14 });
  for (const l of NARROW) {
    const c = layout(W, l);
    if (c.status >= l.minStatus) return c;
  }
  // 가장 좁은 단계에서도 모자라면 SESSION 을 줄여 IDLE 이 밀려나지 않게 한다.
  const c = layout(W, NARROW[NARROW.length - 1]);
  const short = Math.max(0, 4 - c.status);
  return { ...c, name: Math.max(1, c.name - short), status: Math.max(4, c.status) };
}

// 헤더의 7일 비용 막대. days: usage.days7 (오래된 날 → 오늘). 7일 중 가장 큰 날을 █ 로 맞춘다.
// 비용이 0 인 날은 ▁ 를 장식 색(faint)으로, 쓴 날은 ▂~█ 로 그린다. 색이 없어도 쓴 날(▂ 이상)과 안 쓴 날(▁)이 갈린다.
// 가격표에 없는 모델만 쓴 날(아는 비용 0)은 쓰지 않은 날과 헷갈리지 않게 ? 로 둔다.
export function weekBar(days, costMode = 'api') {
  const bar = levelBar(days.map((d) => costOf(d, costMode)));
  return bar.map((x, i) => (x.t === glyphs().week[0] && days[i].unknown ? { t: '?', fg: PALETTE.muted } : x));
}

export function header(view, W) {
  const { sessions } = view.data;
  const live = sessions.filter((s) => s.live);
  const count = (pred) => live.filter(pred).length;
  const working = count((s) => ['busy', 'shell'].includes(s.status));
  const waiting = count((s) => s.status === 'waiting');
  const unseen = count((s) => s.unseen);
  const idle = count((s) => (s.status === 'idle' || s.status === 'live') && !s.unseen);
  const B = PALETTE.bar;
  const G = glyphs();
  // 0 인 상태는 빼서 오른쪽 사용량 자리를 남긴다. 좁으면 이름을 줄인다.
  const stat = (glyph, n, key, color, bold, narrow) =>
    n
      ? [
          { t: `  ${glyph} `, fg: color, bg: B },
          { t: `${n} ${t(key, null, { short: narrow })}`, fg: bold ? color : PALETTE.text, bg: B, bold },
        ]
      : [];
  // drop: 0 은 모두 보이고, 1 은 live 수(다른 수의 합)를 빼고, 2 는 ○ 대기까지 뺀다.
  // 빼고 나서 남는 상태 수가 없으면 live 수는 남긴다.
  const leftOf = (narrow, drop = 0) => {
    const others = [
      ...stat('⠿', working, 'hdr.working', PALETTE.busy, false, narrow),
      ...stat(G.unseen, unseen, 'hdr.unseen', PALETTE.busy, true, narrow),
      ...(drop < 2 ? stat(G.idle, idle, 'hdr.idle', PALETTE.idle, false, narrow) : []),
    ];
    const counts = [
      ...(drop < 1 || !others.length ? [{ t: `${live.length} live`, fg: PALETTE.text, bg: B, bold: true }] : []),
      ...others,
    ].map((x, i) => (i === 0 ? { ...x, t: x.t.trimStart() } : x));
    return [
      { t: ` ${BRAND.logo} `, fg: PALETTE.chipText, bg: PALETTE.brand, bold: true },
      { t: '  ', bg: B },
      // 응답 대기가 있으면 사람이 할 일이므로 맨 앞에 둔다.
      ...(waiting ? [...stat(G.waiting, waiting, 'hdr.waiting', PALETTE.waiting, true, narrow).map((x, i) => (i === 0 ? { ...x, t: x.t.trimStart() } : x)), ...(counts.length ? [{ t: '  ', bg: B }] : [])] : []),
      ...counts,
    ];
  };
  // 오른쪽: 오늘 $52 ($8.40/h) 132M · 7일 $644 ▂▃▅█▁▄▆ 1.2B · 12:42:05. 폭이 모자라면 지출 속도, 7일 막대, 토큰 수, API 표시, 7일, 오늘 순으로 뺀다 (캐시 제외 기준이면 그 표시는 끝까지 남긴다).
  // 하루 예산이 있으면 오늘 $12.30/$50 ($5.00/h) 58.0M · 예상 $45 처럼 붙고, 예상 경고는 시각 다음으로 오래 남는다.
  const u = view.data.usage;
  const dot = { t: ' · ', fg: PALETTE.faint, bg: B };
  const net = view.costMode === 'net';
  // 짧은 달러 표기: 10 이상은 정수, 그 아래는 소수 둘째 자리.
  const usd = (x) => (x >= 10 ? `$${Math.round(x).toLocaleString('en-US')}` : `$${x.toFixed(2)}`);
  // 하루 예산은 비용 기준(c 키)과 상관없이 API 정가 환산으로 본다 (--json 과 같은 단계).
  // API 기준이면 오늘 금액 뒤에 /$50 을 붙이고, 캐시 제외 기준이면 '예산 $12.30/$50' 칸을 따로 둔다.
  // 예상이 80% 이상이면 '예상 $45', 100% 이상이면 경고 색과 '!'. 지출 속도와 헷갈리지 않게 · 로 나눈 칸에 둔다.
  const bud = u ? projectBudget(u, view.budgetDay, { now: view.data.at ?? Date.now() }) : null;
  const ofBudget = bud ? [{ t: `/${Number.isInteger(bud.day) ? `$${bud.day.toLocaleString('en-US')}` : `$${bud.day.toFixed(2)}`}`, fg: PALETTE.muted, bg: B }] : [];
  // 캐시 제외 화면에서 예산 칸 없이 예상만 남으면 캐시 제외 금액으로 읽히지 않게 'API 예상' 이라고 적는다.
  const projOf = (label) => (bud && bud.level !== 'ok' ? { t: `${label} ${usd(bud.projected)}${bud.unknown ? '?' : ''}${bud.level === 'warn' ? '!' : ''}`, fg: BUDGET_COLOR[bud.level], bg: B, bold: true } : null);
  const projSeg = projOf(t('hdr.proj'));
  const projApi = net ? projOf(t('hdr.projApi')) : projSeg;
  // budget: 'full' | 'proj' (아래 right 참고). 오늘 칸 뒤에 붙는 예산 칸.
  const budgetPart = (budget) => {
    if (!bud) return [];
    if (budget === 'full' && net) return [dot, { t: `${t('hdr.budget')} `, fg: PALETTE.muted, bg: B }, { t: money(bud.spent, bud.unknown), fg: PALETTE.money, bg: B }, ...ofBudget, ...(projSeg ? [{ t: ' ', bg: B }, projSeg] : [])];
    return projApi ? [dot, projApi] : [];
  };
  const period = (label, p, tok, rate = [], extra = []) => [
    { t: `${label} `, fg: PALETTE.muted, bg: B },
    { t: money(net ? p.costNoCache ?? null : p.cost, p.unknown), fg: PALETTE.money, bg: B, bold: true },
    ...extra,
    ...rate,
    ...(tok ? [{ t: ` ${fmtTokens(p.tokens)}`, fg: PALETTE.info, bg: B }] : []),
  ];
  // 지출 속도: 최근 1시간 비용(5분 칸 근사)을 시간당으로. 0 이거나 아직 집계 중이면 숨기고, 폭이 모자라면 가장 먼저 뺀다.
  // 아는 몫이 0 인데 가격표에 없는 모델이 섞였으면 금액 없이 (?/h) 만 보인다.
  const hour = u?.lastHour && u.loading == null ? (net ? u.lastHour.costNoCache : u.lastHour.cost) : null;
  const rateText = hour >= 0.005 ? `${usd(hour)}${u.lastHour.unknown ? '?' : ''}` : hour != null && u.lastHour.unknown ? '?' : null;
  const rate = rateText ? [{ t: ` (${rateText}/h)`, fg: PALETTE.muted, bg: B }] : null;
  // bar: 7일 금액 뒤의 날짜별 막대. 집계 중이거나 날짜별 값이 없으면 넣지 않는다.
  const bar = u?.loading == null && u?.days7?.length ? [{ t: ' ', bg: B }, ...weekBar(u.days7, view.costMode).map((x) => ({ ...x, bg: B }))] : null;
  const week = (tok, withBar = false) => (u.loading != null ? [{ t: t('hdr.weekLoading', { pct: Math.floor(u.loading * 100) }), fg: PALETTE.info, bg: B }] : period(t('hdr.week'), u.week, tok, [], withBar && bar ? bar : []));
  // 장부를 못 읽었으면 화면에 있는 세션(모든 도구)의 누적 토큰이라도 보인다.
  const fallback = [{ t: `Σ ${fmtTokens(sessions.reduce((a, s) => a + (s.tokens?.total ?? 0), 0))} tok`, fg: PALETTE.muted, bg: B }];
  const clockSeg = { t: clock(view.data.at), fg: PALETTE.muted, bg: B };
  // 비용은 API 정가 환산이다 (구독 요금제의 실제 청구액이 아님). 폭이 되면 그렇다고 적는다.
  const api = { t: `${t(net ? 'hdr.netLong' : 'hdr.apiLong')}  `, fg: net ? PALETTE.brand : PALETTE.info, bg: B };
  const apiShort = { t: `${t(net ? 'hdr.netShort' : 'hdr.apiShort')} `, fg: net ? PALETTE.brand : PALETTE.info, bg: B };
  // 오른쪽 한 줄의 구성. 위에서부터 차례로 시도한다.
  // api: 'long' | 'short' | null, tok: 토큰 수, week: 7일 칸, bar: 7일 막대, budget: 'full'(/$50 와 예상) | 'proj'(예상만) | 'only'(오늘 금액 없이 예상만).
  // clock: false 면 시각을 뺀다 (캐시 제외 기준에서 오늘 비용을 지킬 때만 쓴다).
  const right = ({ api: a = null, rate: withRate = false, tok = false, week: withWeek = false, bar: withBar = false, budget = 'full', clock = true }) => {
    const label = a === 'long' ? [api] : a === 'short' ? [apiShort] : [];
    const today = budget === 'only' ? [projApi] : [...period(t('hdr.today'), u.today, tok, withRate ? rate : [], budget === 'full' && !net ? ofBudget : []), ...budgetPart(budget)];
    return [...label, ...today, ...(withWeek ? [dot, ...week(tok, withBar)] : []), ...(clock ? [dot, clockSeg] : [])];
  };
  // 7일 막대는 지출 속도 다음으로 먼저 뺀다 (토큰 수보다 먼저).
  const shapes = [
    ...(rate && bar ? [{ api: 'long', rate: true, tok: true, week: true, bar: true }] : []),
    ...(bar ? [{ api: 'long', tok: true, week: true, bar: true }] : []),
    ...(rate && !bar ? [{ api: 'long', rate: true, tok: true, week: true }] : []),
    { api: 'long', tok: true, week: true },
    { tok: true, week: true },
    { api: 'long', week: true },
    { api: 'short', week: true },
    { week: true },
    { api: 'short' },
    {},
    // 예산이 있을 때만: /$50 을 빼고, 그다음 오늘 금액을 빼서 예상 경고를 시각 바로 앞까지 지킨다.
    ...(bud ? [{ api: 'short', budget: 'proj' }, { budget: 'proj' }] : []),
    // 캐시 제외 화면에서도 'API 예상' 은 기준이 드러나므로 캐시 제외 표시 없이 남길 수 있다.
    ...(projSeg ? [{ api: 'short', budget: 'only' }, { budget: 'only' }] : []),
  ];
  const rights = u ? [...shapes.filter((o) => !net || o.api || o.budget === 'only').map(right), [clockSeg]] : [[...fallback, dot, clockSeg], [clockSeg]];
  // 사용량 숫자가 상태 이름보다 중요하므로, 이름을 먼저 줄이고 그래도 모자라면 오른쪽을 줄인다.
  // 시각만 남기 전에는 live 수와 ○ 대기를 먼저 빼서 오늘 비용을 지킨다.
  const fit = (r, narrow, drop) => {
    const left = leftOf(narrow, drop);
    const right = [...r, { t: ' ', bg: B }];
    return segsWidth(left) + segsWidth(right) + 2 <= W ? line([...left, { t: ' '.repeat(W - segsWidth(left) - segsWidth(right)), bg: B }, ...right], W, B) : null;
  };
  const kept = rights.slice(0, -1);
  // 캐시 제외 기준은 '캐시제외' 표시 때문에 9칸이 더 든다. 시각만 남기기 전에 시각을 빼고 '캐시제외 오늘 $5.20' 을 남긴다.
  const bare = u && net ? [right({ api: 'short', clock: false })] : [];
  const tries = [
    ...kept.flatMap((r) => [[r, false, 0], [r, true, 0]]),
    ...[1, 2].flatMap((drop) => kept.map((r) => [r, true, drop])),
    ...[0, 1, 2].flatMap((drop) => bare.map((r) => [r, true, drop])),
    ...[0, 1, 2].map((drop) => [rights.at(-1), true, drop]),
  ];
  for (const [r, narrow, drop] of tries) {
    const out = fit(r, narrow, drop);
    if (out) return out;
  }
  return line(leftOf(true, 2), W, B);
}

// 폭이 모자랄 때 도구 이름 대신 쓰는 짧은 이름.
export const TOOL_SHORT = { claude: 'cla', codex: 'cdx', gemini: 'gem' };

// 도구 하나의 조각. level 0 은 다 보이고, 2 부터 토큰 수·미설치 글을 빼고, 3 은 이름을 줄인다.
function toolPart(p, level, showEnded) {
  const name = level >= 3 ? TOOL_SHORT[p.tool] : p.tool;
  const extra = level < 2;
  // 세션이 없는 도구는 이름만 흐리게 둔다.
  if (!p.live) {
    // 종료 세션을 함께 볼 때는 그 도구의 누적 토큰을 흐리게 남긴다. 기록 폴더가 없으면 미설치로 보인다.
    const more = !extra ? [] : p.missing ? [{ t: ` ${t('tools.missing')}`, fg: PALETTE.info, italic: true }] : showEnded && p.count ? [{ t: ` · ${fmtTokens(p.tok)}`, fg: PALETTE.info }] : [];
    return [{ t: ` ${name}`, fg: PALETTE.info }, ...more];
  }
  const tc = PALETTE.tools[p.tool];
  return [{ t: glyphs().tool, fg: tc }, { t: name, fg: tc, bold: true }, { t: ` ${p.live}`, fg: PALETTE.text }, ...(extra ? [{ t: ` · ${fmtTokens(p.tok)}`, fg: PALETTE.muted }] : [])];
}

// 이 기간 동안 세션이 없는 도구는 도구 줄에서 숨긴다 (설정 파일 hideIdleTools 로 끈다).
export const IDLE_TOOL_MS = 7 * 86_400_000;

// 도구의 마지막 사용 시각: 화면의 세션과 기록 폴더(--doctor 점검)의 가장 새 기록. Gemini 탭에는 agy 기록도 들어간다.
// 실행 중인 프로세스가 있으면 지금 쓰는 것으로 본다. 그 도구의 점검 결과가 아직 없으면 null (모름).
export function toolLastUsed(data, tool, now) {
  const checks = data.tools?.tools;
  if (!checks) return null;
  const found = (tool === 'gemini' ? [checks.gemini, checks.agy] : [checks[tool]]).filter(Boolean);
  if (!found.length) return null;
  if (found.some((t) => t.running > 0)) return now;
  const times = [...data.sessions.filter((s) => s.tool === tool).map((s) => s.updatedAt), ...found.map((t) => t.lastAt)].filter((t) => Number.isFinite(t));
  return times.length ? Math.max(...times) : 0;
}

// 도구 줄: 도구마다 실행 중 세션 수와 누적 토큰. 실행 중 세션도 없고 7일 동안 쓰지 않은 도구는 숨기고 끝에 '숨김 codex gemini'
// (자리가 모자라면 '숨김 2') 를 적는다. 기록 폴더가 없는 도구(미설치)도 7일 동안 쓰지 않은 것이라 함께 숨긴다.
// 숨기면 줄에 남는 도구가 하나도 없을 때는 숨기지 않고 예전처럼 흐리게 (미설치 포함) 다 보인다.
// 폭이 모자라면 간격 → 토큰 수 → 이름 순으로 줄이고, 그래도 넘치면 세션이 없는 도구부터 빼고 +N 으로 뺀 수를 적는다.
// 아주 좁으면 실행 중인 도구가 숨김 표시보다 먼저 남고, 숨김 표시는 중간에서 자르지 않고 뺀다.
export function toolStrip(view, W) {
  const now = view.data.at ?? Date.now();
  const all = ['claude', 'codex', 'gemini'].map((tool) => {
    const list = view.data.sessions.filter((s) => s.tool === tool);
    const live = list.filter((s) => s.live).length;
    const last = toolLastUsed(view.data, tool, now);
    return {
      tool,
      count: list.length,
      live,
      tok: list.reduce((a, s) => a + (s.tokens?.total ?? 0), 0),
      missing: view.data.tools?.tools?.[tool]?.state === 'missing',
      // 실행 중 세션이 있는 도구는 늘 보인다. 마지막 사용을 모르면(점검 전) 숨기지 않는다.
      idle: view.hideIdleTools !== false && !live && last != null && now - last >= IDLE_TOOL_MS,
    };
  });
  const visible = all.filter((p) => !p.idle);
  const parts = visible.length ? visible : all;
  const hidden = all.filter((p) => !parts.includes(p));
  // 숨김 표시: 도구 이름을 적고, 자리가 모자라면 개수만 적는다.
  const notes = hidden.length ? [[{ t: t('tools.hidden', { list: hidden.map((p) => p.tool).join(' ') }), fg: PALETTE.info }], [{ t: t('tools.hidden', { list: hidden.length }), fg: PALETTE.info }]] : [[]];
  const plus = (n) => (n ? [{ t: `+${n}`, fg: PALETTE.info }] : []);
  const build = (shown, level, tail = []) => {
    const gap = { t: level ? '  ' : '     ' };
    const end = tail.flatMap((x, i) => [...(i ? [{ t: '  ' }] : []), x]);
    return [{ t: ' ' }, ...shown.flatMap((p, i) => [...(i ? [gap] : []), ...toolPart(p, level, view.showEnded)]), ...(end.length ? [...(shown.length ? [gap] : []), ...end] : [])];
  };
  const fits = (x) => segsWidth(x) <= W;
  let segs = null;
  for (const level of [0, 1, 2, 3]) {
    for (const note of notes) {
      const s = build(parts, level, note);
      if (fits(s)) {
        segs = s;
        break;
      }
    }
    if (segs) break;
  }
  if (!segs) {
    // 실행 중인 도구를 먼저 남기고, 들어가는 만큼만 원래 순서대로 보인다.
    // 앞 차례 도구가 안 들어가면 거기서 멈춘다 (실행 중인 도구 대신 쉬는 도구가 남지 않게).
    const order = [...parts.filter((p) => p.live), ...parts.filter((p) => !p.live)];
    const greedy = (note) => {
      let kept = [];
      for (const p of order) {
        const next = parts.filter((x) => x === p || kept.includes(x));
        if (!fits(build(next, 3, [...plus(parts.length - next.length), ...note]))) break;
        kept = next;
      }
      return { kept, segs: build(kept, 3, [...plus(parts.length - kept.length), ...note]) };
    };
    // 숨김 표시(개수)를 넣었을 때 실행 중인 도구가 덜 남거나 줄에 안 들어가면 숨김 표시를 뺀다.
    const liveOf = (r) => r.kept.filter((p) => p.live).length;
    const bare = greedy([]);
    const noted = hidden.length ? greedy(notes.at(-1)) : bare;
    segs = fits(noted.segs) && liveOf(noted) >= liveOf(bare) ? noted.segs : bare.segs;
  }
  // 종료 세션 표시는 다 들어갈 때만 붙인다 (잘린 조각이 남지 않게).
  const ended = [{ t: '     ' }, { t: t('tools.ended'), fg: PALETTE.info, italic: true }];
  if (view.showEnded && segsWidth(segs) + segsWidth(ended) <= W) segs.push(...ended);
  return line(segs, W);
}

export function tableHeader(c, W) {
  const h = (t, n, align) => ({ t: pad(t, n, align) + ' ', fg: PALETTE.info });
  const segs = [{ t: ' '.repeat(c.mark + c.glyph) }, h('TOOL', c.tool)];
  if (c.showModel) segs.push(h('MODEL', c.model));
  segs.push(h('SESSION', c.name));
  if (c.showProject) segs.push(h('PROJECT', c.project));
  segs.push(h('STATUS', c.status), h('TOKENS', c.tokens, 'right'));
  if (c.showCost) segs.push(h('COST', c.cost, 'right'));
  segs.push(h(c.cells ? 'CONTEXT' : 'CTX', c.ctx, c.cells ? 'left' : 'right'), h('IDLE', c.age, 'right'));
  return line(segs, W);
}

// 표에서는 세션 이름과 상태가 먼저 보이도록 나머지 열은 흐리게 둔다.
// hot: 화면에서 비용이 가장 큰 세션들. 그 비용만 돈 색으로 칠한다.
// pinned: p 로 고정한 세션. SESSION 칸 앞에 고정 기호(glyphs().pin)를 붙여 색이 없어도 보이게 한다.
export function sessionRow(s, c, W, selected, frame, hot, costMode = 'api', pinned = false) {
  const waiting = s.status === 'waiting';
  const bg = selected ? PALETTE.rowFocus : waiting ? PALETTE.rowWaiting : undefined;
  // IDLE: 마지막 활동 후 지난 시간. 지금 일하고 있는 세션은 'now'.
  const working = s.status === 'busy' || s.status === 'shell';
  const idle = working ? 'now' : fmtAgo(NOW - (s.updatedAt ?? 0));
  const ended = s.status === 'ended';
  const tc = PALETTE.tools[s.tool];
  const g = glyph(s, frame);
  // 다음 지시를 기다리는 세션은 상태 글자만 흐리게 한다.
  const pc = s.phase?.kind === 'idle' ? PALETTE.info : PHASE_COLOR[s.phase?.kind] ?? PALETTE.muted;
  // 아직 토큰을 하나도 쓰지 않은 세션은 숫자 칸을 비운다. 기다리는 중이면 '아직 지시 없음'.
  const blank = s.lazy || !(s.tokens?.total > 0);
  const status = blank && s.tool !== 'gemini' && (s.status === 'idle' || s.status === 'live') ? t('phase.noPrompt') : statusText(s.phase);
  const segs = [
    { t: selected ? glyphs().select : ' ', fg: PALETTE.brand, bold: true },
    { ...g, t: g.t + ' ' },
    { t: pad(s.tool, c.tool) + ' ', fg: ended ? PALETTE.ended : tc, bold: !ended },
  ];
  if (c.showModel) segs.push({ t: pad(shortModel(s.model), c.model) + ' ', fg: ended ? PALETTE.ended : PALETTE.muted });
  // 좁아도 고정 표시는 남기고 이름 칸을 먼저 줄인다 (이름 칸이 2칸 이하면 기호만).
  const mark = glyphs().pin;
  const pin = pinned ? [{ t: c.name >= width(mark) + 2 ? `${mark} ` : mark, fg: ended ? PALETTE.ended : PALETTE.brand, bold: true }] : [];
  segs.push(...pin, { t: pad(s.name ?? '', c.name - segsWidth(pin)) + ' ', fg: ended ? PALETTE.ended : PALETTE.text, bold: selected });
  if (c.showProject) segs.push({ t: pad(s.project ?? '', c.project) + ' ', fg: ended ? PALETTE.ended : PALETTE.muted });
  segs.push(
    { t: pad(status, c.status) + ' ', fg: pc, bold: s.status === 'waiting' },
    { t: pad(blank ? '' : fmtTokens(s.tokens.total), c.tokens, 'right') + ' ', fg: ended ? PALETTE.ended : PALETTE.muted },
  );
  if (c.showCost) segs.push({ t: pad(blank ? '' : (hot?.has(s.id) ? glyphs().hot : '') + money(costOf(s, costMode), s.costUnknown), c.cost, 'right') + ' ', fg: s.cost == null || ended ? PALETTE.info : hot?.has(s.id) ? PALETTE.money : PALETTE.muted, bold: Boolean(hot?.has(s.id)) });
  segs.push(...gauge(s.context?.used ?? 0, s.context?.window ?? 0, c.cells), { t: ' ' }, { t: pad(idle, c.age, 'right'), fg: waiting ? PALETTE.waiting : PALETTE.info });
  // 종료 행은 밝기 말고도 기울임꼴로 구분한다 (색이 없으면 · 글리프와 '종료' 글자로 구분된다).
  return line(ended ? segs.map((x) => ({ ...x, italic: true })) : segs, W, bg);
}

// 표의 STATUS 칸 글. 응답 대기는 ◆ 와 행 색으로 이미 보이므로 무엇을 허락해 달라는지만 적고, 요청 내용이 없으면 '응답 대기' 를 남긴다.
// 상세 창은 phaseText 의 긴 문구 전체를 보인다.
export const statusText = (phase) => phaseText(phase, { short: true });

// 메인 세션 아래에 붙는 팀원(서브에이전트) 행. 끝나면 잠깐 "완료"로 보였다가 사라진다.
// parentModel: 부모와 같은 모델이면 모델 칸을 비운다. costMode: 'api' | 'net'.
export function memberRow(m, last, c, W, frame, parentModel, costMode = 'api') {
  const done = m.status === 'done';
  const g = done ? { t: '✓', fg: PALETTE.info } : { t: SPIN[(frame + 3) % SPIN.length], fg: PALETTE.team, bold: true };
  const branch = last ? glyphs().memberLast : glyphs().member;
  const segs = [
    { t: ' '.repeat(c.mark + c.glyph) },
    { t: pad('  ' + branch, c.tool) + ' ', fg: PALETTE.line },
  ];
  // 같은 타입의 팀원이 여럿이어도 구분되도록, 하는 일(description)을 앞에 두고 타입은 흐리게 붙인다.
  // 팀원 행은 PROJECT 칸이 비므로 그 자리까지 하는 일 글을 이어 쓴다. general-purpose 타입은 정보가 없어 붙이지 않는다.
  const nameW = c.name - 2 + (c.showProject ? c.project + 1 : 0);
  const suffix = m.task && m.name !== 'general-purpose' ? ` · ${m.name}` : '';
  const label = truncate(m.task || m.name, nameW);
  const showSuffix = suffix && nameW - width(label) >= width(suffix);
  const started = m.started !== false;
  const sameModel = parentModel && shortModel(m.model) === shortModel(parentModel);
  if (c.showModel) segs.push({ t: pad(started && !sameModel ? shortModel(m.model) : '', c.model) + ' ', fg: PALETTE.info });
  segs.push(
    { ...g, t: g.t + ' ' },
    { t: label, fg: done ? PALETTE.info : PALETTE.team },
    { t: pad(showSuffix ? suffix : '', nameW - width(label)) + ' ', fg: PALETTE.info },
  );
  segs.push(
    { t: pad(statusText(m.phase), c.status) + ' ', fg: done ? PALETTE.info : PHASE_COLOR[m.phase?.kind] ?? PALETTE.muted },
    { t: pad(started ? fmtTokens(m.tokens ?? 0) : '', c.tokens, 'right') + ' ', fg: done ? PALETTE.info : PALETTE.muted },
  );
  if (c.showCost) segs.push({ t: pad(started ? money(costOf(m, costMode), m.costUnknown) : '', c.cost, 'right') + ' ', fg: done ? PALETTE.info : PALETTE.muted });
  // 끝난 팀원은 종료 행처럼 기울임꼴로 둔다.
  return line(done ? segs.map((x) => ({ ...x, italic: true })) : segs, W);
}

// 세션이 없을 때: aitop --doctor 와 같은 도구별 점검 줄과 종료 세션 보기 안내.
export const MARK_COLOR = { ok: PALETTE.busy, missing: PALETTE.alert, limited: PALETTE.muted };

export function emptyLines(view, W) {
  const out = [line([{ t: `   ${t(view.showEnded ? 'empty.none24' : 'empty.none')}`, fg: PALETTE.muted, italic: true }], W), line([], W)];
  const tools = Object.values(view.data.tools?.tools ?? {});
  const pathW = Math.max(0, ...tools.map((r) => width(r.path)));
  for (const r of tools) {
    const d = describe(r, NOW);
    // 일부 지원(○)은 폭이 모호한 글자라 기호 세트를 따른다.
    const mark = r.state === 'limited' ? glyphs().idle : d.mark;
    out.push(line([{ t: `   ${mark} `, fg: MARK_COLOR[r.state], bold: true }, { t: pad(r.tool, 7), fg: PALETTE.tools[r.tool], bold: true }, { t: pad(d.state, 10), fg: PALETTE.text }, { t: pad(d.path, pathW + 2), fg: PALETTE.muted }, { t: d.detail, fg: PALETTE.info }], W));
    if (d.hint) out.push(line([{ t: `            → ${d.hint}`, fg: PALETTE.info }], W));
  }
  if (!view.showEnded) out.push(line([], W), line([{ t: `   ${t('empty.show')}`, fg: PALETTE.info }, { t: 'e', fg: PALETTE.text, bold: true }, { t: t('empty.or'), fg: PALETTE.info }, { t: 'aitop --all', fg: PALETTE.text }], W));
  return out;
}

// 화면에 보이는 세션 중 비용이 가장 큰 두 개 (0 보다 클 때만).
export function topCost(sessions, costMode = 'api') {
  const v = (s) => costOf(s, costMode) ?? 0;
  const top = sessions.filter((s) => v(s) > 0 && s.status !== 'ended').sort((a, b) => v(b) - v(a)).slice(0, 2);
  return new Set(top.map((s) => s.id));
}

// 표를 둥근 상자로 감싼다. 안쪽 줄은 이미 폭 W-4 로 그려져 있다.
export function tableBox(inner, W, count) {
  const e = glyphs().edge.normal;
  const ln = (t) => style({ fg: PALETTE.line }) + t + RESET;
  const title = ` ${t('table.title', { n: count })} `;
  const top = line([{ t: e.tl + e.h, fg: PALETTE.line }, { t: title, fg: PALETTE.muted }, { t: e.h.repeat(Math.max(0, W - 3 - width(title))) + e.tr, fg: PALETTE.line }], W);
  return [top, ...inner.map((l) => ln(`${e.v} `) + l + ln(` ${e.v}`)), line([{ t: e.bl + e.h.repeat(W - 2) + e.br, fg: PALETTE.line }], W)];
}

// 이 높이 이상이면 세션 표를 상자로 감싼다 (상자 테두리에 두 줄이 든다).
export const TABLE_BOX_H = 30;

// 묶음 이름. 응답 대기·고정·폴더 없음 묶음은 order.mjs 가 ko 이름을 붙이므로 화면에서 지금 언어로 바꾼다.
const groupName = (g) => (g.waiting ? t('group.waiting') : g.pinned ? t('group.pinned') : g.name === NO_FOLDER ? t('group.noFolder') : g.name);

// 묶기(g) 화면의 묶음 머리 한 줄: 이름 · 세션 수 · 묶음 비용. 세션 행보다 한 단계 흐리게 둔다.
export function groupRow(g, W) {
  return line([
    { t: '  ▾ ', fg: PALETTE.info },
    { t: groupName(g), fg: PALETTE.muted, bold: true },
    { t: `  ${t('group.count', { n: g.count })}`, fg: PALETTE.info },
    ...(g.cost > 0 || g.unknown ? [{ t: ' · ', fg: PALETTE.info }, { t: money(g.cost, g.unknown), fg: PALETTE.muted }] : []),
  ], W);
}
