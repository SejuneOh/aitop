// 도움말 화면과 아래 키 안내 줄.
import { pad, width } from '../text.mjs';
import { NO_COLOR, PALETTE } from './theme.mjs';
import { box, line, segsWidth } from './draw.mjs';
import { glyphs, legendMark } from './glyphs.mjs';
import { COMMON, VIEWS, helpContext, keysLine, options, settingsLine, viewText } from '../help.mjs';
import { getLang, t } from '../i18n.mjs';

// 상세 패널을 기본으로 여는 최소 화면 높이. 이보다 낮으면 세션 표에 줄을 준다.
export const DETAIL_MIN_H = 24;

// view.showDetail: 'auto' 는 화면 높이로 정하고, true/false 는 사용자가 d·f 로 고른 값이라 높이와 상관없이 따른다.
export function detailOpen(view, H) {
  return view.showDetail === 'auto' ? H >= DETAIL_MIN_H : Boolean(view.showDetail);
}

// 상태 기호와 열 설명 [기호·열 이름, i18n 키]. 키는 help.mjs 의 VIEWS 에서 화면별로 고른다.
const LEGEND_IDS = [
  ['help.legend', null],
  ['⠋', 'legend.busy'],
  ['◆', 'legend.waiting'],
  ['●', 'legend.unseen'],
  ['○', 'legend.idle'],
  ['·', 'legend.ended'],
  ['★', 'legend.pin'],
  ['', ''],
  ['help.columns', null],
  ['STATUS', 'legend.status'],
  ['TOKENS', 'legend.tokens'],
  ['COST', 'legend.cost'],
  ['CONTEXT', 'legend.context'],
  ['IDLE', 'legend.idleCol'],
  ['legend.hiddenKey', 'legend.hidden'],
  ['+N', 'legend.folded'],
  ['legend.periodKey', 'legend.period'],
  ['legend.filesKey', 'legend.files'],
];

// 지금 언어의 상태 기호·열 설명. 제목 줄은 설명이 null 이다.
export const legend = () => LEGEND_IDS.map(([k, d]) => [/^(help|legend)\./.test(k) ? t(k) : k, d ? t(d) : d]);

// 도움말 줄 목록: 지금 화면의 키 → (표에 검색어가 걸려 있으면) 그 키 → (상세 패널이 열려 있으면) 상세 패널 키 → 어디서나 쓰는 키 → 다른 화면 한 줄씩 → 옵션 → 상태 기호·열.
// 넓으면(100칸 이상) 키는 왼쪽, 옵션·기호·열은 오른쪽 칸에 둔다.
export function helpSections(view = {}, open = false) {
  const ctx = helpContext(view);
  const here = ctx === 'table' ? ['table', ...(view.filter ? ['filtered'] : []), ...(open ? ['detail'] : [])] : [ctx];
  const keys = [...here.map((n) => VIEWS[n]), COMMON].map((v) => viewText(v)).flatMap((v, i) => [...(i ? [['', '']] : []), [`${v.title}${i ? '' : t('help.here')}`, null], ...v.keys]);
  const others = Object.keys(VIEWS).filter((n) => !here.includes(n));
  const rest = [['', ''], [t('help.others'), null], ...others.map((n) => [viewText(VIEWS[n]).title, keysLine(n), 'dim'])];
  const now = settingsLine(view.settings);
  const opts = [
    [t('help.options'), null],
    ...options(),
    ...(view.settings?.configPath ? [[t('help.config'), view.settings.configPath, 'dim']] : []),
    ...(now ? [[t('help.now'), now]] : []),
  ];
  return { keys: [...keys, ...rest], more: [...opts, ['', ''], ...legend().map(([k, d]) => [legendMark(k), d])] };
}

// 키 칸 폭은 제목 줄 사이 묶음마다 그 묶음의 가장 긴 키에 맞춘다 (12~21칸).
// 영어는 키 이름(Typing a search, Changed files)이 길어 설명과 붙어 보이므로 사이를 2칸 둔다 (한국어는 예전대로 1칸).
function helpLines(list) {
  const out = [];
  const gap = getLang() === 'ko' ? 1 : 2;
  const cap = 20 + gap;
  let kw = 12;
  list.forEach(([k, v, dim], i) => {
    if (v == null) {
      const next = list.slice(i + 1);
      const block = next.slice(0, Math.max(0, next.findIndex((e) => e[1] == null)) || next.length);
      kw = Math.min(cap, Math.max(12, ...block.filter((e) => e[1]).map((e) => width(e[0]) + gap)));
      out.push([{ t: k, fg: PALETTE.brand, bold: true }]);
    } else out.push([{ t: pad(k, kw), fg: PALETTE.text, bold: !dim }, { t: v, fg: dim ? PALETTE.info : PALETTE.muted }]);
  });
  return out;
}

// 줄이 넘치면 scroll 만큼 내려 보이고, 아래에 남은 줄이 있으면 마지막 줄에 알린다.
function windowOf(lines, n, scroll) {
  const more = (k) => [{ t: t('help.more', { n: k }), fg: PALETTE.info, italic: true }];
  const part = lines.slice(scroll, scroll + n);
  const left = lines.length - scroll - n;
  return left > 0 ? [...part.slice(0, n - 1), more(left + 1)] : part;
}

// view.helpScroll: ↑↓ 로 내린 줄 수. 넘치지 않으면 0. 내릴 수 있는 끝은 view.helpMax 에 남긴다 (keys.mjs 가 쓴다).
export function help(W, H, view = {}, open = false) {
  const { keys, more } = helpSections(view, open);
  const title = t('help.title');
  const rows = H - 2;
  const wide = W >= 100;
  const cols = wide ? [helpLines(keys), helpLines(more)] : [helpLines([...keys, ['', ''], ...more])];
  const max = Math.max(0, ...cols.map((c) => c.length - rows));
  const scroll = Math.min(max, Math.max(0, view.helpScroll ?? 0));
  view.helpMax = max;
  // PgUp·PgDn 한 번에 넘길 줄 수: 보이는 줄에서 한 줄을 겹쳐 남긴다.
  view.helpPage = Math.max(1, rows - 1);
  view.helpScroll = scroll;
  if (wide) return box(title, W, H, windowOf(cols[0], rows, scroll), windowOf(cols[1], rows, scroll), Math.min(64, Math.floor((W - 7) * 0.5)), PALETTE.brand);
  return box(title, W, H, null, windowOf(cols[0], rows, scroll), 0, PALETTE.brand);
}

// 키 칩. 색이 없으면 [f] 처럼 괄호로 보인다.
export const keyChip = (k) => (NO_COLOR ? { t: `[${k}]` } : { t: ` ${k} `, fg: PALETTE.chipText, bg: PALETTE.muted, bold: true });

export const keyLabel = (v) => ({ t: ` ${v}   `, fg: PALETTE.muted });

// items: { k, t, keep } 또는 { segs, keep }. 폭이 모자라면 keep 이 아닌 항목을 오른쪽부터 뺀다.
export function hintBar(items, W, right = '') {
  const segsOf = (list) => [{ t: ' ' }, ...list.flatMap((i) => i.segs ?? [keyChip(i.k), keyLabel(i.t)])];
  const wOf = (list) => segsWidth(segsOf(list));
  const list = [...items];
  while (wOf(list) > W && list.some((i) => !i.keep)) list.splice(list.findLastIndex((i) => !i.keep), 1);
  const segs = segsOf(list);
  const used = wOf(list);
  if (right && W - used >= width(right) + 1) segs.push({ t: ' '.repeat(W - used - width(right)) }, { t: right, fg: PALETTE.info });
  return line(segs, W);
}

// 정렬·묶기가 기본이 아닐 때만 지금 상태를 짧게 보인다 (예: s:비용 g:프로젝트). 표 순서를 읽는 데 필요하므로 d·e·c 안내보다 늦게 빠진다.
function orderHint(view) {
  const parts = [
    ...(view.sort && view.sort !== 'default' ? [['s', t(`sort.${view.sort}`)]] : []),
    ...(view.group && view.group !== 'none' ? [['g', t(`groupBy.${view.group}`)]] : []),
  ];
  if (!parts.length) return null;
  const segs = parts.flatMap(([k, v], i) => [{ t: i ? ' ' : '', fg: PALETTE.info }, { t: k, fg: PALETTE.muted, bold: true }, { t: `:${v}`, fg: PALETTE.info }]);
  return { segs: [...segs, { t: '   ' }] };
}

export function footer(view, W, matched, sel) {
  const RO = t('foot.readOnly');
  const tail = [
    { k: '?', t: t('foot.help'), keep: true },
    { k: 'q', t: t('key.quit'), keep: true },
  ];
  const ended = { k: 'e', t: t(view.showEnded ? 'foot.hideEnded' : 'foot.showEnded') };
  // 도움말이 열려 있으면 ↑↓ 는 도움말을 스크롤하고 ? · Esc 는 닫는다.
  if (view.help) return hintBar([{ k: '↑↓', t: t('key.scroll') }, { k: '?', t: t('foot.closeHelp'), keep: true }, { k: 'Esc', t: t('key.close') }, { k: 'q', t: t('key.quit'), keep: true }], W, RO);
  if (view.searching) {
    const input = NO_COLOR ? [{ t: '[/]' }] : [{ t: ' / ', fg: PALETTE.chipText, bg: PALETTE.brand, bold: true }];
    return hintBar([{ segs: [...input, { t: ` ${view.filter ?? ''}`, fg: PALETTE.text, bold: true }, { t: glyphs().cursor, fg: PALETTE.brand }, { t: `  ${t('foot.count', { n: matched })}   `, fg: PALETTE.muted }], keep: true }, { k: '⏎', t: t('key.apply'), keep: true }, { k: 'Esc', t: t('foot.clear'), keep: true }], W);
  }
  if (view.focus) {
    const keys =
      view.focus === 'diff'
        ? [{ k: '↑↓', t: t('key.scroll') }, { k: 'space', t: t('key.page') }, { k: '[ ]', t: t('key.prevNext') }, { k: 'Esc', t: t('foot.toFiles'), keep: true }]
        : [{ k: '←→', t: t('foot.prompts') }, { k: '↑↓', t: t('foot.pickFile') }, { k: '⏎', t: t('foot.viewDiff') }, { k: 'Esc', t: t('foot.toSessions'), keep: true }];
    return hintBar([...keys, ...tail], W, RO);
  }
  // 세션이 하나도 없으면 쓸 수 있는 키만 남긴다.
  if (!view.filter && !view.data?.sessions?.length) return hintBar([ended, ...tail], W, RO);
  const order = orderHint(view);
  const search = view.filter
    ? { segs: [{ t: ` /${view.filter} `, fg: PALETTE.chipText, bg: PALETTE.brand, bold: true }, { t: ` ${t('foot.count', { n: matched })} `, fg: PALETTE.muted }, keyChip('Esc'), keyLabel(t('foot.clearSearch'))], keep: true }
    : { k: '/', t: t('key.search') };
  const items = [
    search,
    { k: '↑↓', t: t('key.select') },
    { k: 'n', t: t('foot.next') },
    ...(order ? [order] : []),
    ...(sel?.files?.length ? [{ k: 'f', t: t('foot.files') }] : []),
    { k: 'd', t: t(view.showDetail ? 'foot.hideDetail' : 'foot.showDetail') },
    ended,
    { k: 'c', t: t('foot.costMode') },
    // 고정은 폭이 모자라면 가장 먼저 빠진다.
    ...(sel ? [{ k: 'p', t: t(view.pins?.includes(sel.id) ? 'foot.unpin' : 'key.pin') }] : []),
    ...tail,
  ];
  return hintBar(items, W, RO);
}
