// 선택한 세션 상세 패널: 왼쪽 요약, 오른쪽 변경 파일·지시 탭·diff·최근 활동. 100칸 미만에서는 요약을 위쪽 두 줄로 접는다.
import { ellipsis, fmtAgo, fmtTokens, pad, truncateLeft, width } from '../text.mjs';
import { currentTab, filesForTab, turnTabs } from '../turns.mjs';
import { isAbsolute, relative } from 'node:path';
import { PALETTE, PHASE_COLOR } from './theme.mjs';
import { NOW, box, clock, fill, gauge, glyph, hhmm, levelBar, money, rule, segsWidth, tilde } from './draw.mjs';
import { activitySeries } from '../sources/common.mjs';
import { glyphs } from './glyphs.mjs';
import { phaseText } from '../i18n.mjs';

// 세션 폴더 기준 상대 경로. 폴더 밖이면 ~ 로 줄인다.
export function relPath(cwd, p) {
  if (cwd && isAbsolute(p)) {
    const r = relative(cwd, p);
    if (r && !r.startsWith('..') && !isAbsolute(r)) return r;
  }
  return tilde(p);
}

// 오른쪽 칸 여백: 구획 안 내용은 1칸 들여 쓰고, 배경 띠 안은 좌우 2칸, 항목 사이 3칸.
export const INDENT = { t: ' ' };

export const BAND_PAD = 2;

export const BAND_LEFT = { t: ' '.repeat(BAND_PAD) };

export const GAP = '   ';

// 오른쪽 칸 안쪽 줄 수가 이만큼이면 빈 줄 여백을 둔다 (목록·diff 공통).
export const ROOMY = 16;

// ▸ src/ui.mjs   편집 ×3   새 파일   14:02. 파일 이름은 진하게, 폴더는 흐리게.
// 줄 수는 편집마다 더한 값이라 git diff 처럼 읽히지 않게 목록에는 넣지 않는다. 좁으면 시각, 새 파일 표시 순으로 뺀다.
export function fileRow(f, cwd, w, selected) {
  const tail = [{ t: `${GAP}편집 ×${f.edits}`, fg: PALETTE.muted }, ...(f.created ? [{ t: `${GAP}새 파일`, fg: PALETTE.brand }] : []), { t: `${GAP}${hhmm(f.at)}`, fg: PALETTE.info }];
  const tailW = () => tail.reduce((a, x) => a + width(x.t), 0);
  while (tail.length > 1 && w - 2 * BAND_PAD - tailW() < 12) tail.pop();
  const pathW = Math.max(1, w - 2 * BAND_PAD - tailW());
  const path = truncateLeft(relPath(cwd, f.path), pathW);
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  const quiet = f.hidden || f.noise;
  return fill(
    [
      { t: pad(selected ? '▸' : '', BAND_PAD), fg: PALETTE.brand, bold: true },
      { t: path.slice(0, cut), fg: PALETTE.muted },
      { t: pad(path.slice(cut), pathW - width(path.slice(0, cut))), fg: quiet ? PALETTE.muted : PALETTE.text, bold: !quiet },
      ...tail,
    ],
    w,
    selected ? PALETTE.rowFocus : PALETTE.bar,
  );
}

// 변경 조각을 고친 순서의 역순(최신 먼저)으로, 조각마다 시각 · 누가 · 위치 머리를 달아 보인다.
// 같은 파일을 여러 번 고치면 줄 번호 기준이 매번 달라져 하나의 diff 로 합칠 수 없다.
export function diffBody(f, w) {
  if (f.hidden) return [[INDENT, { t: '비밀값이 있을 수 있는 파일이라 변경 내용을 숨겼습니다', fg: PALETTE.info, italic: true }]];
  if (!f.hunks.length) return [[INDENT, { t: f.deleted ? '이 파일을 삭제했습니다' : '보관된 변경 내용이 없습니다', fg: PALETTE.info, italic: true }]];
  const nums = w >= 50;
  const textW = w - 1 - (nums ? 5 : 0);
  const out = [];
  for (const h of f.hunks) {
    const head = h.unnumbered ? `@@ ${h.context ?? ''}`.trimEnd() : `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
    out.push([{ t: `${clock(h.at)} · ${h.agent ?? '메인'} · ${head}`, fg: PALETTE.tool, dim: true }]);
    let n = h.newStart;
    for (const l of h.lines) {
      const k = l[0];
      // 줄 번호를 모르는 변경(Codex)은 번호 칸을 비운다.
      const no = { t: pad(k === '-' || h.unnumbered ? '' : String(n), 4, 'right') + ' ', fg: PALETTE.info };
      if (k !== '-') n++;
      const seg = k === '+' ? { fg: PALETTE.busy, bg: PALETTE.addBg } : k === '-' ? { fg: PALETTE.alert, bg: PALETTE.delBg } : { fg: PALETTE.muted };
      out.push([...(nums ? [no] : []), { ...seg, t: pad(l, textW) }]);
    }
    if (h.cut) out.push([{ t: `… ${h.cut}줄 생략`, fg: PALETTE.info, italic: true }]);
  }
  if (f.dropped) out.push([{ t: `… 이전 변경 ${f.dropped}개는 보관 한도를 넘어 생략`, fg: PALETTE.info, italic: true }]);
  return out.map((r) => [INDENT, ...r]);
}

// diff 는 오른쪽 칸 전체를 쓴다. 스크롤 위치는 여기서 내용 길이에 맞춰 다시 맞춘다.
export function diffView(s, files, f, w, rows, view) {
  const body = diffBody(f, w);
  const gap = rows >= ROOMY ? 1 : 0;
  const page = rows - 1 - gap;
  view.diffPage = Math.max(1, page - 1);
  const top = Math.min(Math.max(0, view.diffScroll ?? 0), Math.max(0, body.length - page));
  view.diffScroll = top;
  const meta = `${files.indexOf(f) + 1}/${files.length}${body.length > page ? ` · ${Math.round(((top + page) / body.length) * 100)}%` : ''}`;
  // 좁으면 편집 수를 줄이거나 빼고, 파일 위치와 스크롤 위치는 남긴다.
  const room = w - 10 - width(meta);
  const stats = [` · 편집 ×${f.edits} · 쓴 줄 ${f.add} · 지운 줄 ${f.del}`, ` · ×${f.edits}`, ''].find((x) => room - width(x) >= 12) ?? '';
  const name = truncateLeft(relPath(s.cwd, f.path), Math.max(8, room - width(stats)));
  const label = [{ t: '‹ ', fg: PALETTE.brand, bold: true }, { t: name, fg: PALETTE.text, bold: true }, { t: stats, fg: PALETTE.info }];
  return [rule(label, meta, w, PALETTE.brand), ...(gap ? [[]] : []), ...body.slice(top, top + page)];
}

// 사용자 입력(❯)만 진하게 두고 나머지 본문은 흐리게. 파일 목록에 들어가 있으면(dim) 전부 흐리게.
export function activity(s, n, dim = false) {
  const tc = PALETTE.tools[s.tool];
  const icon = { prompt: { t: '❯ ', fg: tc, bold: true }, tool: { t: `${glyphs().event} `, fg: PALETTE.tool }, reply: { t: '↳ ', fg: PALETTE.muted } };
  // 기록 줄 순서와 시각이 어긋날 때가 있어(병렬 도구 호출 등) 시각 순으로 다시 정렬한다. 같은 시각이면 기록 순서를 지킨다.
  const events = [...(s.events ?? [])].sort((a, b) => a.at - b.at).slice(-n);
  if (!events.length) return [[INDENT, { t: '아직 기록된 활동이 없습니다', fg: PALETTE.info, italic: true }]];
  const rows = events.map((e) => [INDENT, { t: clock(e.at) + '  ', fg: PALETTE.info }, icon[e.kind], { t: e.text, fg: e.kind === 'prompt' ? PALETTE.text : PALETTE.muted, bold: e.kind === 'prompt' }]);
  return dim ? rows.map((r) => r.map((x) => ({ ...x, fg: PALETTE.info, bold: false }))) : rows;
}

// 최근 활동 가로줄 뒤에 붙는 시간별 토큰 막대: '── 최근 활동  ▁▁▃█▂ 24시간 ──'. 한 칸이 1시간이고 오른쪽 끝이 지금이다.
// 24칸이 들어가지 않으면 최근 12시간, 그것도 안 되면 막대를 뺀다. 24시간 안에 토큰이 하나도 없으면 그리지 않는다.
// 0 인 시간은 ▁, 쓴 시간은 ▂ 이상이라 색이 없어도(NO_COLOR) 갈린다. dim 이면(파일 목록에 들어가 있으면) 제목처럼 흐리게.
export function activitySpark(s, room, dim = false) {
  const all = activitySeries(s.activity, NOW);
  if (!all.some((x) => x > 0)) return [];
  for (const n of [24, 12]) {
    const tail = { t: ` ${n}시간`, fg: PALETTE.info };
    const bar = levelBar(all.slice(-n)).map((x) => (dim ? { ...x, fg: PALETTE.faint } : x));
    const segs = [{ t: '  ' }, ...bar, dim ? { ...tail, fg: PALETTE.faint } : tail];
    if (segsWidth(segs) <= room) return segs;
  }
  return [];
}

// ‹이번 지시›  T5  T3  전체. 색을 꺼도 보이게 고른 탭은 ‹ › 로 감싼다. 폭이 모자라면 가운데 지시 탭부터 줄인다.
// 이전 지시 탭은 3개까지만 보이고 나머지는 … +N 으로 접는다. 고른 탭이 들어가게 창을 옮긴다.
export const TAB_WINDOW = 3;

// 숨긴 탭 수는 숨긴 쪽에 따로 붙인다: 이번 지시  … +2  T4  T3  ‹T2›  … +1  전체.
// 폭이 모자라면 가운데 탭 → … +N → '이번 지시' 이름 → 고르지 않은 양끝 탭 순으로 줄여, 고른 탭은 늘 남긴다.
export function tabsLine(tabs, tab, w) {
  const seg = (t, short) => (t.key === tab.key ? { t: `‹${t.label}›`, fg: PALETTE.text, bg: PALETTE.rowSel, bold: true } : { t: short && t.key === 'now' ? '이번' : t.label, fg: PALETTE.muted });
  const turns = tabs.slice(1, -1);
  const at = turns.findIndex((t) => t.key === tab.key);
  const start = at >= TAB_WINDOW ? at - TAB_WINDOW + 1 : 0;
  let shown = turns.slice(start, start + TAB_WINDOW);
  let ends = [tabs[0], tabs.at(-1)];
  let marks = true;
  let short = false;
  const build = () => {
    const first = turns.indexOf(shown[0]);
    const before = shown.length ? first : 0;
    const after = turns.length - before - shown.length;
    const parts = [];
    if (ends.includes(tabs[0])) parts.push(seg(tabs[0], short));
    if (marks && before) parts.push({ t: `… +${before}`, fg: PALETTE.info });
    parts.push(...shown.map((t) => seg(t, short)));
    if (marks && after) parts.push({ t: `… +${after}`, fg: PALETTE.info });
    if (ends.includes(tabs.at(-1))) parts.push(seg(tabs.at(-1), short));
    return parts.flatMap((x) => [x, { t: '  ' }]);
  };
  const fits = () => segsWidth(build()) <= w;
  while (!fits() && shown.some((t) => t.key !== tab.key)) shown.splice(shown.findIndex((t) => t.key !== tab.key), 1);
  if (!fits()) marks = false;
  if (!fits()) short = true;
  for (const end of [tabs[0], tabs.at(-1)]) if (!fits() && end.key !== tab.key) ends = ends.filter((t) => t !== end);
  return build();
}

// 탭 아래 설명: 지시면 시각과 첫 줄, 전체면 편집 수.
export function tabNote(tab, files) {
  if (tab.key === 'all') return [{ t: `세션 전체 · 편집 ${files.reduce((a, f) => a + f.edits, 0)}회`, fg: PALETTE.info, italic: true }];
  const p = tab.turn;
  const edits = files.reduce((a, f) => a + f.edits, 0);
  return [{ t: p ? `${hhmm(p.at)} "${p.text}"` : '지시 기록 없음', fg: PALETTE.info, italic: true }, ...(edits ? [{ t: `  편집 ${edits}회`, fg: PALETTE.muted }] : [])];
}

// 허락을 기다리는 요청을 폭에 맞춰 여러 줄로 나눈다. 명령은 띄어쓰기와 상관없이 글자 단위로 끊어 빠짐없이 보인다.
export const REQUEST_LINES = 6;

export function wrapText(text, w) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    let cw = 0;
    for (const ch of para) {
      const k = width(ch);
      if (cw + k > w && cur) {
        out.push(cur);
        cur = '';
        cw = 0;
      }
      cur += ch;
      cw += k;
    }
    out.push(cur);
  }
  return out;
}

// ── 요청 ── 구획: 응답 대기 중이고 요청 내용을 알 때만. 최대 max 줄, 넘치면 마지막 줄 끝을 … 로 바꾼다.
export function requestBlock(s, w, max = REQUEST_LINES) {
  if (s.status !== 'waiting' || !s.waitDetail || max < 1) return [];
  const textW = Math.max(1, w - width(INDENT.t));
  let lines = wrapText(s.waitDetail, textW);
  if (lines.length > max) {
    lines = lines.slice(0, max);
    const last = [...lines[max - 1]];
    const mark = ellipsis(textW);
    while (last.length && width(last.join('')) + width(mark) > textW) last.pop();
    lines[max - 1] = last.join('') + mark;
  }
  return [rule([{ t: '요청', fg: PALETTE.waiting, bold: true }], '', w), ...lines.map((l) => [INDENT, { t: l, fg: PALETTE.text }])];
}

// 오른쪽 칸: 고친 파일이 없으면 최근 활동만, 있으면 위쪽 절반까지 변경 파일 구획(배경 띠), 파일을 열면 diff.
// 머리는 안쪽 줄 수에 따라: 16 이상 가로줄+탭+지시, 11~15 가로줄+탭(지시는 탭 줄 오른쪽), 10 이하 가로줄만.
export function rightColumn(s, w, rows, view) {
  // --show-requests 를 켰고 응답 대기 중이면 요청 내용을 맨 위에 두고, 아래 구획에는 적어도 4줄을 남긴다.
  const req = view?.showRequests ? requestBlock(s, w, Math.min(REQUEST_LINES, rows - 5)) : [];
  if (req.length) return [...req, ...rightColumn({ ...s, waitDetail: null }, w, rows - req.length, view)];
  const all = s.files ?? [];
  const focused = view?.focus === 'files';
  // 가로줄 끝에 '─' 두 칸은 남긴다 (── 3칸 + 최근 활동 9칸 + 막대 + ' ─' 2칸).
  const activityRule = () => rule([{ t: '최근 활동', fg: focused ? PALETTE.muted : PALETTE.text, bold: true }, ...activitySpark(s, w - 3 - 9 - 2, focused)], '', w);
  if (!all.length) return [activityRule(), ...activity(s, rows - 1)];
  const tab = currentTab(s, view?.tab);
  const files = filesForTab(s, tab);
  const open = view?.focus === 'diff' && files.find((f) => f.path === view.filePath);
  if (open) return diffView(s, files, open, w, rows, view);
  // 이번 지시에 고친 파일이 없으면 한 줄로 접고 남는 줄을 최근 활동에 준다. 목록에 들어가면(f) 다시 펼친다.
  if (!files.length && !focused) {
    const folded = rule([{ t: '변경 파일', fg: PALETTE.text, bold: true }, { t: ` · ${tab.label} 0개`, fg: PALETTE.muted }], `전체 ${all.length}개 · f`, w);
    return [folded, activityRule(), ...activity(s, rows - 2)];
  }

  // 목록에 들어가 있으면 구획 왼쪽에 ▌ 막대를 세우고 가로줄을 강조색으로 바꾼다.
  const gutter = focused ? [{ t: glyphs().select, fg: PALETTE.brand }] : [];
  const inner = w - segsWidth(gutter);
  const tier = rows >= ROOMY ? 3 : rows >= 11 ? 2 : 1;
  const label = [{ t: '변경 파일', fg: focused ? PALETTE.brand : PALETTE.text, bold: true }, ...(tier === 1 ? [{ t: ` · ${tab.label}`, fg: PALETTE.muted }] : [])];
  // git diff 가 아니라 Edit/Write 기록이고 Bash 로 바꾼 파일은 빠진다는 것을 화면에서 바로 알 수 있게 한다.
  const meta = `편집 기록 · Bash 제외 · ${files.length}개${focused ? '' : ' · f'}`;
  const head = [rule(label, meta, inner, focused ? PALETTE.brand : PALETTE.line)];
  // 11~15 줄에서는 지시 문장이 탭에 밀려 사라지지 않게 그 자리를 먼저 남긴다.
  const note = tabNote(tab, files);
  const noteW = tier === 2 ? Math.min(note.reduce((a, x) => a + width(x.t), 0), Math.floor(inner / 2)) + 1 : 0;
  if (tier >= 2) head.push([INDENT, ...tabsLine(turnTabs(s), tab, inner - 1 - noteW), ...(tier === 2 ? [{ t: ' ' }, ...note] : [])]);
  if (tier === 3) head.push([INDENT, ...note]);

  // 넉넉하면(tier 3) 지시 문장과 목록 사이, 목록과 최근 활동 사이에 빈 줄을 하나씩 둔다.
  // 목록은 칸의 절반까지만 쓰므로 빈 줄을 넣어도 최근 활동은 6줄 넘게 남는다.
  const gap = tier === 3 ? 1 : 0;
  const selIdx = focused ? files.findIndex((f) => f.path === view.filePath) : -1;
  const listRows = Math.max(1, Math.ceil(rows / 2) - head.length - gap);
  const overflow = files.length > listRows;
  const slots = overflow ? listRows - 1 : listRows;
  const start = selIdx >= slots ? selIdx - slots + 1 : 0;
  const shown = files.slice(start, start + slots);
  const list = [];
  if (!files.length) list.push(fill([BAND_LEFT, { t: '· 이 지시에서는 고친 파일 없음', fg: PALETTE.info, italic: true }, { t: `${GAP}${focused ? '←/→' : 'f 다음 ←/→'} 다른 지시`, fg: PALETTE.info }], inner, PALETTE.bar));
  shown.forEach((f, k) => list.push(fileRow(f, s.cwd, inner, start + k === selIdx)));
  if (overflow) list.push(fill([BAND_LEFT, { t: `+${files.length - shown.length}개 더`, fg: PALETTE.muted }], inner, PALETTE.bar));
  const block = [...head, ...(gap ? [[]] : []), ...list, ...(gap ? [[]] : [])];
  const R = block.map((segs) => [...gutter, ...segs]);
  R.push(activityRule(), ...activity(s, rows - R.length - 1, focused));
  return R;
}

// 이 폭보다 좁으면 왼쪽 칸을 위쪽 요약 두 줄로 접고, 변경 파일·최근 활동이 안쪽 전체 폭을 쓴다.
export const NARROW_W = 100;

const FOLDER_MIN = 28;

// 조각 묶음을 폭에 맞춘다. 넘치면 drop 값이 큰 묶음부터 빼고, 그래도 넘치면 fill 이 뒤를 자른다.
function fitGroups(groups, w) {
  const kept = groups.filter((g) => g);
  const total = () => kept.reduce((a, g) => a + segsWidth(g.segs), 0);
  while (total() > w) {
    const i = kept.reduce((best, g, k) => ((g.drop ?? 0) > (kept[best].drop ?? 0) ? k : best), 0);
    if (!kept[i].drop) break;
    kept.splice(i, 1);
  }
  return kept.flatMap((g) => g.segs);
}

// 좁은 화면의 요약 두 줄.
// 1줄: 상태 · 폴더 · 브랜치 · 종류 · 시작.
// 2줄: 571k +서브2 (입력 90.3k·출력 18.4k·캐시 463k) · $0.17 · ctx 5% · pid 218093. 캐시는 읽기와 쓰기를 더한 값이다.
// 폭이 모자라면 pid → 토큰 내역 → 서브에이전트 수 → ctx 순으로 뺀다.
export function summaryLines(s, w, frame, view) {
  const g = glyph(s, frame);
  const phase = [{ ...g, t: g.t + ' ' }, { t: phaseText(s.phase) || s.status, fg: PHASE_COLOR[s.phase?.kind] ?? PALETTE.text, bold: true }];
  const sep = { t: ' · ', fg: PALETTE.info };
  const optional = [
    s.branch && [sep, { t: s.branch, fg: PALETTE.info }],
    s.kind && [sep, { t: s.kind, fg: PALETTE.info }],
    s.startedAt && [sep, { t: `시작 ${hhmm(s.startedAt)} (${fmtAgo(NOW - s.startedAt)} 전)`, fg: PALETTE.info }],
  ].filter(Boolean);
  // 폴더가 FOLDER_MIN 칸(짧으면 제 길이)을 얻을 때까지 시작 → 종류 → 브랜치 순으로 뺀다. 폴더는 왼쪽부터 줄여 끝 이름을 남긴다.
  const path = tilde(s.cwd ?? '');
  const want = Math.min(width(path), FOLDER_MIN);
  const room = (k) => w - segsWidth(phase) - (path ? 3 : 0) - optional.slice(0, k).reduce((a, x) => a + segsWidth(x), 0);
  let k = optional.length;
  while (k > 0 && room(k) < want) k--;
  const folder = path ? [sep, { t: truncateLeft(path, Math.max(1, room(k))), fg: PALETTE.muted }] : [];
  const first = [...phase, ...folder, ...optional.slice(0, k).flat()];

  const t = s.tokens ?? {};
  const net = view?.costMode === 'net';
  const total = { segs: [{ t: fmtTokens(t.total), fg: PALETTE.text, bold: true }] };
  const parts = { segs: [{ t: ' (', fg: PALETTE.info }, { t: `입력 ${fmtTokens(t.input)}·출력 ${fmtTokens(t.output)}·캐시 ${fmtTokens((t.cacheRead ?? 0) + (t.cacheWrite ?? 0))}`, fg: PALETTE.info }, { t: ')', fg: PALETTE.info }], drop: 3 };
  const sub = t.subCount ? { segs: [{ t: ` +서브${t.subCount}`, fg: PALETTE.muted }], drop: 2 } : null;
  const cost = s.cost != null ? { segs: [sep, ...(net ? [{ t: '캐시제외 ', fg: PALETTE.muted }] : []), { t: money(net ? s.costNoCache : s.cost, s.costUnknown), fg: PALETTE.money, bold: true }] } : null;
  let ctx = null;
  if (s.context?.window) {
    const r = Math.min(1, Math.max(0, s.context.used / s.context.window || 0));
    const hot = r >= 0.85;
    ctx = { segs: [sep, { t: 'ctx ', fg: PALETTE.info }, { t: `${hot ? '!' : ''}${Math.round(r * 100)}%`, fg: hot ? PALETTE.alert : PALETTE.muted, bold: hot }], drop: 1 };
  }
  const pid = s.pid ? { segs: [sep, { t: `pid ${s.pid}`, fg: PALETTE.info }], drop: 4 } : null;
  // 둘째 줄은 상태 글자 아래에 맞춰 2칸 들여 쓴다.
  const second = fitGroups([total, sub, parts, cost, ctx, pid], w - 2);
  return [first, [{ t: '  ' }, ...second]];
}

export function detail(s, W, H, frame, view) {
  const tc = PALETTE.tools[s.tool];
  // 제목: 세션 이름은 진하게, 도구·모델은 도구 색으로.
  const title = [{ t: s.name ?? s.tool, fg: PALETTE.text, bold: true }, { t: `  ${s.tool}${s.model ? ' · ' + s.model : ''}`, fg: tc }];
  if (W < NARROW_W) {
    const inner = W - 4;
    const top = summaryLines(s, inner, frame, view);
    const R = rightColumn(s, inner, H - 2 - top.length, view);
    return box(title, W, H, null, [...top, ...R], 0, tc, Boolean(view?.focus));
  }
  const leftW = Math.min(46, Math.max(30, Math.floor((W - 4) * 0.38)));
  const L = [];
  // 왼쪽 칸도 오른쪽 칸처럼 라벨 가로줄로 나누고 내용은 1칸 들여 쓴다.
  const section = (name) => L.push(rule([{ t: name, fg: PALETTE.text, bold: true }], '', leftW));
  const kv = (k, v, fg = PALETTE.text) => L.push([INDENT, { t: pad(k, 9), fg: PALETTE.muted }, { t: v ?? '-', fg }]);
  const more = (segs) => L.push([INDENT, { t: ' '.repeat(9) }, ...segs]);

  const g = glyph(s, frame);
  L.push([{ ...g, t: g.t + ' ' }, { t: phaseText(s.phase) || s.status, fg: PHASE_COLOR[s.phase?.kind] ?? PALETTE.text, bold: true }]);
  section('세션');
  kv('폴더', tilde(s.cwd));
  if (s.branch) kv('브랜치', s.branch);
  kv('모델', s.model ?? '-');
  kv('종류', `${s.kind ?? '-'}${s.pid ? ` · pid ${s.pid}` : ''}`);
  if (s.startedAt) kv('시작', `${clock(s.startedAt)}  (${fmtAgo(NOW - s.startedAt)} 전)`);

  // 합계 = 메인 + 서브 = 입력 + 출력 + 캐시 읽기 + 캐시 쓰기 가 화면에서 그대로 맞아떨어지게 보인다.
  const t = s.tokens ?? {};
  section('토큰');
  kv('합계', fmtTokens(t.total));
  if (t.subCount) more([{ t: `메인 ${fmtTokens(t.main)} + 서브 ${t.subCount}개 ${fmtTokens(t.sub)}`, fg: PALETTE.info }]);
  more([{ t: `입력 ${fmtTokens(t.input)} · 출력 ${fmtTokens(t.output)}`, fg: PALETTE.info }]);
  more([{ t: `캐시 읽기 ${fmtTokens(t.cacheRead)} · 쓰기 ${fmtTokens(t.cacheWrite)}`, fg: PALETTE.info }]);
  if (s.cost != null) section('비용');
  else if (s.context?.window) section('컨텍스트');
  if (s.cost != null) {
    const net = view?.costMode === 'net';
    L.push([INDENT, { t: pad(net ? '캐시제외' : 'API 환산', 9), fg: PALETTE.muted }, { t: money(net ? s.costNoCache : s.cost, s.costUnknown), fg: PALETTE.money, bold: true }]);
    more([{ t: net ? `API 환산 ${money(s.cost, s.costUnknown)}` : `캐시 제외 ${money(s.costNoCache, s.costUnknown)}`, fg: PALETTE.info }, ...(s.costUnknown ? [{ t: '  ? 가격표에 없는 모델 포함', fg: PALETTE.info }] : [])]);
  }
  if (s.context?.window) {
    L.push([INDENT, { t: pad('컨텍스트', 9), fg: PALETTE.muted }, { t: pad(`${fmtTokens(s.context.used)}/${fmtTokens(s.context.window)}`, 11) + ' ', fg: PALETTE.text }, ...gauge(s.context.used, s.context.window, Math.max(4, leftW - width(INDENT.t) - 26))]);
  }

  const R = rightColumn(s, W - leftW - 7, H - 2, view);
  return box(title, W, H, L, R, leftW, tc, Boolean(view?.focus));
}
