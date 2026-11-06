// 위쪽 화면: 요약 헤더, 도구 줄, 세션 표(팀원 행 포함), 세션이 없을 때의 점검 줄.
import { describe } from '../doctor.mjs';
import { BRAND } from '../brand.mjs';
import { fmtAgo, fmtTokens, pad, truncate, width } from '../text.mjs';
import { EDGE, PALETTE, PHASE_COLOR, RESET, style } from './theme.mjs';
import { NOW, SPIN, clock, costOf, gauge, glyph, line, money, segsWidth, shortModel } from './draw.mjs';

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

export function header(view, W) {
  const { sessions } = view.data;
  const live = sessions.filter((s) => s.live);
  const count = (pred) => live.filter(pred).length;
  const working = count((s) => ['busy', 'shell'].includes(s.status));
  const waiting = count((s) => s.status === 'waiting');
  const unseen = count((s) => s.unseen);
  const idle = count((s) => (s.status === 'idle' || s.status === 'live') && !s.unseen);
  const B = PALETTE.bar;
  // 0 인 상태는 빼서 오른쪽 사용량 자리를 남긴다. 좁으면 이름을 줄인다.
  const stat = (glyph, n, long, short, color, bold, narrow) =>
    n
      ? [
          { t: `  ${glyph} `, fg: color, bg: B },
          { t: `${n} ${narrow ? short : long}`, fg: bold ? color : PALETTE.text, bg: B, bold },
        ]
      : [];
  const leftOf = (narrow) => [
    { t: ` ${BRAND.logo} `, fg: PALETTE.chipText, bg: PALETTE.brand, bold: true },
    { t: '  ', bg: B },
    // 응답 대기가 있으면 사람이 할 일이므로 맨 앞에 둔다.
    ...(waiting ? [...stat('◆', waiting, '응답 대기', '응답', PALETTE.waiting, true, narrow).map((x, i) => (i === 0 ? { ...x, t: x.t.trimStart() } : x)), { t: '  ', bg: B }] : []),
    { t: `${live.length} live`, fg: PALETTE.text, bg: B, bold: true },
    ...stat('⠿', working, '작업 중', '작업', PALETTE.busy, false, narrow),
    ...stat('●', unseen, '확인 전', '확인', PALETTE.busy, true, narrow),
    ...stat('○', idle, '대기', '대기', PALETTE.idle, false, narrow),
  ];
  // 오른쪽: 오늘 $52 132M · 7일 $644 1.2B · 12:42:05. 폭이 모자라면 토큰 수, API 표시, 7일, 오늘 순으로 뺀다 (캐시 제외 기준이면 그 표시는 끝까지 남긴다).
  const u = view.data.usage;
  const dot = { t: ' · ', fg: PALETTE.faint, bg: B };
  const net = view.costMode === 'net';
  const period = (label, p, tok) => [
    { t: `${label} `, fg: PALETTE.muted, bg: B },
    { t: money(net ? p.costNoCache ?? null : p.cost, p.unknown), fg: PALETTE.money, bg: B, bold: true },
    ...(tok ? [{ t: ` ${fmtTokens(p.tokens)}`, fg: PALETTE.info, bg: B }] : []),
  ];
  const week = (tok) => (u.loading != null ? [{ t: `7일 집계 중 ${Math.floor(u.loading * 100)}%`, fg: PALETTE.info, bg: B }] : period('7일', u.week, tok));
  // 장부를 못 읽었으면 화면에 있는 세션(모든 도구)의 누적 토큰이라도 보인다.
  const fallback = [{ t: `Σ ${fmtTokens(sessions.reduce((a, s) => a + (s.tokens?.total ?? 0), 0))} tok`, fg: PALETTE.muted, bg: B }];
  const clockSeg = { t: clock(view.data.at), fg: PALETTE.muted, bg: B };
  // 비용은 API 정가 환산이다 (구독 요금제의 실제 청구액이 아님). 폭이 되면 그렇다고 적는다.
  const api = { t: net ? '캐시 제외  ' : 'API 환산  ', fg: net ? PALETTE.brand : PALETTE.info, bg: B };
  const apiShort = { t: net ? '캐시제외 ' : 'API ', fg: net ? PALETTE.brand : PALETTE.info, bg: B };
  const rights = u
    ? [
        [api, ...period('오늘', u.today, true), dot, ...week(true), dot, clockSeg],
        [...period('오늘', u.today, true), dot, ...week(true), dot, clockSeg],
        [api, ...period('오늘', u.today, false), dot, ...week(false), dot, clockSeg],
        [apiShort, ...period('오늘', u.today, false), dot, ...week(false), dot, clockSeg],
        [...period('오늘', u.today, false), dot, ...week(false), dot, clockSeg],
        [apiShort, ...period('오늘', u.today, false), dot, clockSeg],
        [...period('오늘', u.today, false), dot, clockSeg],
        [clockSeg],
      ].filter((r) => !net || r[0] === api || r[0] === apiShort || r.length === 1)
    : [[...fallback, dot, clockSeg], [clockSeg]];
  // 사용량 숫자가 상태 이름보다 중요하므로, 이름을 먼저 줄이고 그래도 모자라면 오른쪽을 줄인다.
  for (const r of rights) {
    for (const narrow of [false, true]) {
      const left = leftOf(narrow);
      const right = [...r, { t: ' ', bg: B }];
      if (segsWidth(left) + segsWidth(right) + 2 <= W) return line([...left, { t: ' '.repeat(W - segsWidth(left) - segsWidth(right)), bg: B }, ...right], W, B);
    }
  }
  return line(leftOf(true), W, B);
}

export function toolStrip(view, W) {
  const segs = [{ t: ' ' }];
  for (const tool of ['claude', 'codex', 'gemini']) {
    const list = view.data.sessions.filter((s) => s.tool === tool);
    const live = list.filter((s) => s.live).length;
    const tok = list.reduce((a, s) => a + (s.tokens?.total ?? 0), 0);
    // 세션이 없는 도구는 이름만 흐리게 둔다.
    if (!live) {
      // 종료 세션을 함께 볼 때는 그 도구의 누적 토큰을 흐리게 남긴다. 기록 폴더가 없으면 미설치로 보인다.
      const missing = view.data.tools?.tools?.[tool]?.state === 'missing';
      segs.push({ t: ` ${tool}`, fg: PALETTE.info }, ...(missing ? [{ t: ' 미설치', fg: PALETTE.info, italic: true }] : view.showEnded && list.length ? [{ t: ` · ${fmtTokens(tok)}`, fg: PALETTE.info }] : []), { t: '     ' });
      continue;
    }
    segs.push({ t: '▍', fg: PALETTE.tools[tool] }, { t: tool, fg: PALETTE.tools[tool], bold: true }, { t: ` ${live}`, fg: PALETTE.text }, { t: ` · ${fmtTokens(tok)}`, fg: PALETTE.muted }, { t: '     ' });
  }
  if (view.showEnded) segs.push({ t: '종료된 세션 포함 (24시간)', fg: PALETTE.waiting, italic: true });
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
export function sessionRow(s, c, W, selected, frame, hot, costMode = 'api') {
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
  const phaseText = blank && s.tool !== 'gemini' && (s.status === 'idle' || s.status === 'live') ? '아직 지시 없음' : statusText(s.phase);
  const segs = [
    { t: selected ? '▌' : ' ', fg: PALETTE.brand, bold: true },
    { ...g, t: g.t + ' ' },
    { t: pad(s.tool, c.tool) + ' ', fg: ended ? PALETTE.ended : tc, bold: !ended },
  ];
  if (c.showModel) segs.push({ t: pad(shortModel(s.model), c.model) + ' ', fg: ended ? PALETTE.ended : PALETTE.muted });
  segs.push({ t: pad(s.name ?? '', c.name) + ' ', fg: ended ? PALETTE.ended : PALETTE.text, bold: selected });
  if (c.showProject) segs.push({ t: pad(s.project ?? '', c.project) + ' ', fg: ended ? PALETTE.ended : PALETTE.muted });
  segs.push(
    { t: pad(phaseText, c.status) + ' ', fg: pc, bold: s.status === 'waiting' },
    { t: pad(blank ? '' : fmtTokens(s.tokens.total), c.tokens, 'right') + ' ', fg: ended ? PALETTE.ended : PALETTE.muted },
  );
  if (c.showCost) segs.push({ t: pad(blank ? '' : (hot?.has(s.id) ? '▲' : '') + money(costOf(s, costMode), s.costUnknown), c.cost, 'right') + ' ', fg: s.cost == null || ended ? PALETTE.info : hot?.has(s.id) ? PALETTE.money : PALETTE.muted, bold: Boolean(hot?.has(s.id)) });
  segs.push(...gauge(s.context?.used ?? 0, s.context?.window ?? 0, c.cells), { t: ' ' }, { t: pad(idle, c.age, 'right'), fg: waiting ? PALETTE.waiting : PALETTE.info });
  // 종료 행은 밝기 말고도 기울임꼴로 구분한다 (색이 없으면 · 글리프와 '종료' 글자로 구분된다).
  return line(ended ? segs.map((x) => ({ ...x, italic: true })) : segs, W, bg);
}

// 표의 STATUS 칸 글. 응답 대기는 ◆ 와 행 색으로 이미 보이므로 무엇을 허락해 달라는지만 적고, 요청 내용이 없으면 '응답 대기' 를 남긴다.
// 상세 창은 phase.text 전체를 보인다.
export function statusText(phase) {
  const text = phase?.text ?? '';
  return phase?.kind === 'waiting' ? text.replace(/^응답 대기 · /, '') : text;
}

// 메인 세션 아래에 붙는 팀원(서브에이전트) 행. 끝나면 잠깐 "완료"로 보였다가 사라진다.
// parentModel: 부모와 같은 모델이면 모델 칸을 비운다. costMode: 'api' | 'net'.
export function memberRow(m, last, c, W, frame, parentModel, costMode = 'api') {
  const done = m.status === 'done';
  const g = done ? { t: '✓', fg: PALETTE.info } : { t: SPIN[(frame + 3) % SPIN.length], fg: PALETTE.team, bold: true };
  const branch = last ? '└─ ' : '├─ ';
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
  const out = [line([{ t: view.showEnded ? '   지난 24시간 안에 AI 세션이 없습니다.' : '   실행 중인 AI 세션이 없습니다.', fg: PALETTE.muted, italic: true }], W), line([], W)];
  const tools = Object.values(view.data.tools?.tools ?? {});
  const pathW = Math.max(0, ...tools.map((t) => width(t.path)));
  for (const t of tools) {
    const d = describe(t, NOW);
    out.push(line([{ t: `   ${d.mark} `, fg: MARK_COLOR[t.state], bold: true }, { t: pad(t.tool, 7), fg: PALETTE.tools[t.tool], bold: true }, { t: pad(d.state, 10), fg: PALETTE.text }, { t: pad(d.path, pathW + 2), fg: PALETTE.muted }, { t: d.detail, fg: PALETTE.info }], W));
    if (d.hint) out.push(line([{ t: `            → ${d.hint}`, fg: PALETTE.info }], W));
  }
  if (!view.showEnded) out.push(line([], W), line([{ t: '   지난 24시간 세션 보기: ', fg: PALETTE.info }, { t: 'e', fg: PALETTE.text, bold: true }, { t: ' 또는 ', fg: PALETTE.info }, { t: 'aitop --all', fg: PALETTE.text }], W));
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
  const e = EDGE.normal;
  const ln = (t) => style({ fg: PALETTE.line }) + t + RESET;
  const title = ` 세션 ${count} `;
  const top = line([{ t: e.tl + e.h, fg: PALETTE.line }, { t: title, fg: PALETTE.muted }, { t: e.h.repeat(Math.max(0, W - 3 - width(title))) + e.tr, fg: PALETTE.line }], W);
  return [top, ...inner.map((l) => ln(`${e.v} `) + l + ln(` ${e.v}`)), line([{ t: e.bl + e.h.repeat(W - 2) + e.br, fg: PALETTE.line }], W)];
}

// 이 높이 이상이면 세션 표를 상자로 감싼다 (상자 테두리에 두 줄이 든다).
export const TABLE_BOX_H = 30;
