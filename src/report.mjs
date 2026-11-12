// aitop --report daily: 최근 N일(기본 30, 최대 30)의 날짜별 토큰·비용을 도구별 또는 모델별 표로 내고 끝낸다 (실시간 화면 없음).
// 값은 날짜별 사용량 장부(claude-ledger.mjs 의 collectDaily)에서 오고, 비용은 화면 헤더와 같은 API 정가 환산이다.
// 줄은 최근 날짜가 위(오늘부터 거꾸로)이고, 맨 아래 합계 줄은 위 날짜 줄을 더한 값이다. --json 도 같은 값을 숫자로만 낸다.
// 처음 읽는 동안 stderr 가 터미널이면 진행률을 보이고, 시간 상한을 넘으면 읽은 만큼으로 표를 내고 덜 읽었다고 알린다.
// --report monthly: 최근 N달(기본·최대 12)의 달별 표. 지난 날은 월별 보관함(monthly.mjs), 접기 전의 날은 장부에서 센다.
import { t } from './i18n.mjs';
import { fmtTokens, pad, stripControl, truncate, width } from './text.mjs';
import { money } from './line.mjs';
import { KEEP_DAYS, lastDays } from './sources/common.mjs';
import { projectLabels } from './sources/projects.mjs';
import { KEEP_MONTHS, lastMonths, monthOf, monthEnd } from './monthly.mjs';

export const KINDS = ['daily', 'monthly'];
export const BY = ['tool', 'model', 'project'];
// --by project 의 특별한 열: 프로젝트를 못 찾은 기록, 열 수 상한을 넘어 합친 나머지. --json 에도 이 이름 그대로 나간다.
export const UNKNOWN = '(unknown)';
export const OTHERS = '(others)';
// 표 머리글 한 칸의 최대 폭 (긴 프로젝트·모델 이름은 줄인다).
const HEAD_MAX = 24;
export const MAX_DAYS = KEEP_DAYS;
export const DEFAULT_DAYS = KEEP_DAYS;
export const MAX_MONTHS = KEEP_MONTHS;
export const DEFAULT_MONTHS = KEEP_MONTHS;
// 전체 시간 상한. 넘으면 읽은 만큼으로 표를 낸다 (캐시에 남은 만큼은 다음 실행이 이어 읽는다).
export const MAX_MS = 120_000;
// 한 번에 읽는 시간. 이만큼마다 진행률을 고치고 캐시를 저장한다.
const STEP_MS = 250;
// 이보다 오래 걸릴 때만 진행률을 보인다 (캐시가 있는 실행에서 깜빡이지 않게).
const PROGRESS_AFTER_MS = 400;
const FLUSH_MS = 3000;
const TOOLS = ['claude', 'codex', 'agy'];

// --report <kind>, --report=<kind>, --by <tool|model|project>, --by=..., --days <N>, --months <N> (= 꼴도) 를 꺼낸다.
// kind 는 --report 를 주지 않았으면 null. --by·--days·--months 는 --report 와 함께일 때만 받는다.
// --days 는 daily, --months 는 monthly 와만 쓴다. capped: --days 를 30으로(--months 를 12로) 줄였는지.
export function reportOption(argv) {
  let kind = null;
  let by = 'tool';
  let days = DEFAULT_DAYS;
  let months = DEFAULT_MONTHS;
  let capped = false;
  let gave = null;
  let error = null;
  let extra = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(report|by|days|months)(?:=(.*))?$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    const name = m[1];
    const raw = m[2] ?? (argv[i + 1] == null || argv[i + 1].startsWith('-') ? '' : argv[++i]);
    if (name === 'report') {
      if (KINDS.includes(raw)) kind = raw;
      else error ??= raw === '' ? t('opt.reportMissing') : t('opt.reportBad', { value: JSON.stringify(raw) });
    } else if (name === 'by') {
      extra = true;
      if (BY.includes(raw)) by = raw;
      else error ??= raw === '' ? t('opt.byMissing') : t('opt.byBad', { value: JSON.stringify(raw) });
    } else {
      extra = true;
      gave = name;
      const max = name === 'days' ? MAX_DAYS : MAX_MONTHS;
      const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (n > 0) {
        capped = n > max;
        if (name === 'days') days = Math.min(n, max);
        else months = Math.min(n, max);
      } else error ??= raw === '' ? t(`opt.${name}Missing`) : t(`opt.${name}Bad`, { value: JSON.stringify(raw) });
    }
  }
  if (!error && extra && !kind) error = t('opt.reportOnly');
  if (!error && gave && kind && (gave === 'days') !== (kind === 'daily')) error = t(gave === 'days' ? 'opt.daysDaily' : 'opt.monthsMonthly');
  return { kind, by, days, months, capped, rest, error };
}

const zero = () => ({ tokens: 0, cost: 0, unpriced: false });
// unpriced: 가격표에 없는 모델이 끼어 이 칸의 비용이 실제보다 적을 수 있는지.
const add = (a, tokens, cost, unpriced) => {
  a.tokens += tokens;
  a.cost += cost;
  if (unpriced) a.unpriced = true;
};

// 폭을 모를 때(파이프) --by project 표의 열 수 상한.
export const PIPE_COLUMNS = 8;

// books: collectDaily 의 [{ tool, days }] (--by project 면 project 도). 최근 days 일의 날짜 줄(오늘부터 거꾸로)과
// 열(도구, 모델 또는 프로젝트), 합계를 만든다. 열은 기간 합계 비용이 큰 순서(같으면 토큰, 이름 순)이고, 기간 안에 토큰이 하나도 없는 열은 뺀다.
// maxColumns: 열이 이보다 많으면 앞의 maxColumns-1 개만 두고 나머지를 OTHERS 로 합친다 (--by project 표만).
// unpriced: 가격표에 없는 모델이 끼어 비용이 실제보다 적게 잡혔을 수 있는지.
export function buildReport(books, { by = 'tool', days = DEFAULT_DAYS, now = Date.now(), maxColumns = Infinity } = {}) {
  const dates = lastDays(days, now);
  // 프로젝트 경로 → 짧은 이름. paths 는 거꾸로 (--json 에 이름별 경로를 둔다).
  const labels = by === 'project' ? projectLabels(new Set(books.map((b) => b.project).filter(Boolean))) : new Map();
  const paths = {};
  const rows = dates.map((date) => ({ date, tokens: 0, cost: 0, unpriced: false, items: {} }));
  const at = new Map(rows.map((r) => [r.date, r]));
  const total = { tokens: 0, cost: 0, unpriced: false, items: {} };
  let unpriced = false;
  for (const { tool, project, days: book } of books) {
    for (const [date, d] of Object.entries(book ?? {})) {
      const row = at.get(date);
      if (!row) continue;
      if (d.unknown) unpriced = true;
      const parts = by === 'model' ? Object.entries(d.models ?? {}) : by === 'project' ? [[labels.get(project) ?? UNKNOWN, d]] : [[tool, d]];
      if (by === 'project' && project) paths[labels.get(project)] = project;
      for (const [name, x] of parts) {
        add((row.items[name] ??= zero()), x.tokens, x.cost, x.unknown);
        add((total.items[name] ??= zero()), x.tokens, x.cost, x.unknown);
      }
      add(row, d.tokens, d.cost, d.unknown);
      add(total, d.tokens, d.cost, d.unknown);
    }
  }
  const columns = columnsOf(total, rows, by, maxColumns);
  const out = { report: 'daily', by, days, from: dates.at(-1), to: dates[0], columns, rows, total, unpriced };
  if (by === 'project') out.paths = Object.fromEntries(columns.filter((c) => paths[c]).map((c) => [c, paths[c]]));
  return out;
}

// 열: 기간 합계 비용이 큰 순서(같으면 토큰, 이름 순). 토큰이 하나도 없는 열은 빼고, maxColumns 를 넘으면 OTHERS 로 접는다.
function columnsOf(total, rows, by, maxColumns) {
  const rank = (name) => (by === 'tool' ? TOOLS.indexOf(name) : 0);
  const columns = Object.entries(total.items)
    .filter(([, x]) => x.tokens > 0 || x.cost > 0)
    .sort(([a, x], [b, y]) => y.cost - x.cost || y.tokens - x.tokens || rank(a) - rank(b) || a.localeCompare(b))
    .map(([name]) => name);
  if (columns.length > maxColumns) foldOthers(columns, Math.max(1, maxColumns - 1), [...rows, total]);
  return columns;
}

const nextDay = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return lastDays(1, new Date(y, m - 1, d + 1, 12).getTime())[0];
};

// 월별 표. archive: 월별 보관함(없으면 null), books: 장부 [{ tool, project, days }].
// 보관함은 through 까지의 날을, 장부는 viewLo(다 읽은 창의 첫날) 이후이면서 through 다음 날부터를 센다 (한 날은 한쪽에서만).
// liveLo: 장부 쪽에서 원본 기록이 빠짐없이 남은 첫날 (기본 viewLo).
// 달마다 status: complete(빠짐없이 셌다), partial(일부 날만 셌다), missing(센 날도 값도 없다: 0 이 아니라 모름). current: 이번 달.
// partial: 장부를 시간 상한 때문에 덜 읽었으면, 장부 쪽 날은 센 날로 치지 않는다 (그 달은 complete 가 되지 않는다).
export function buildMonthly(books, archive, { by = 'tool', months = DEFAULT_MONTHS, now = Date.now(), viewLo, liveLo, partial = false, maxColumns = Infinity } = {}) {
  const keys = lastMonths(months, now);
  const shown = new Set(keys);
  const today = lastDays(1, now)[0];
  const through = archive?.through ?? null;
  const from = archive?.from ?? null;
  const holes = archive?.holes ?? [];
  viewLo ??= lastDays(KEEP_DAYS, now).at(-1);
  liveLo ??= viewLo;
  const parts = [];
  for (const k of keys) for (const e of archive?.months?.[k] ?? []) parts.push({ month: k, tool: e.t, model: e.m, project: e.p ?? null, tokens: e.n, cost: e.c, unknown: Boolean(e.x) });
  for (const { tool, project, days } of books)
    for (const [d, day] of Object.entries(days ?? {})) {
      if (d < viewLo || d > today || (through && d <= through) || !shown.has(monthOf(d))) continue;
      const models = day.models && Object.keys(day.models).length ? day.models : { unknown: day };
      for (const [model, x] of Object.entries(models)) parts.push({ month: monthOf(d), tool, model, project: project ?? null, tokens: x.tokens, cost: x.cost, unknown: Boolean(x.unknown) });
    }
  const labels = by === 'project' ? projectLabels(new Set(parts.map((p) => p.project).filter(Boolean))) : new Map();
  const paths = {};
  // 센 날인지: 보관함 [from, through] (빈 날 제외) 또는 장부 [liveLo, 오늘].
  const counted = (d) => (!partial && d >= liveLo) || (through && d >= from && d <= through && !holes.some(([a, b]) => d >= a && d <= b));
  const rows = keys.map((month) => {
    let all = 0;
    let got = 0;
    for (let d = `${month}-01`, end = monthEnd(month); d <= end && d <= today; d = nextDay(d)) {
      all++;
      if (counted(d)) got++;
    }
    return { date: month, month, current: month === keys[0], status: got === 0 ? 'missing' : got < all ? 'partial' : 'complete', tokens: 0, cost: 0, unpriced: false, items: {} };
  });
  const at = new Map(rows.map((r) => [r.month, r]));
  const total = { tokens: 0, cost: 0, unpriced: false, items: {} };
  let unpriced = false;
  for (const p of parts) {
    if (!(p.tokens > 0) && !(p.cost > 0)) continue;
    const row = at.get(p.month);
    const name = by === 'model' ? p.model : by === 'project' ? (labels.get(p.project) ?? UNKNOWN) : p.tool;
    if (by === 'project' && p.project) paths[labels.get(p.project)] = p.project;
    if (p.unknown) unpriced = true;
    for (const o of [row, total]) {
      add((o.items[name] ??= zero()), p.tokens, p.cost, p.unknown);
      add(o, p.tokens, p.cost, p.unknown);
    }
  }
  // 센 날이 없어도 값이 있으면(예: Claude 기록은 지워졌지만 Codex 기록은 남은 달) '일부' 로 값을 보인다.
  for (const r of rows) if (r.status === 'missing' && (r.tokens > 0 || r.cost > 0)) r.status = 'partial';
  const columns = columnsOf(total, rows, by, maxColumns);
  const out = { report: 'monthly', by, months, from: keys.at(-1), to: keys[0], columns, rows, total, unpriced };
  if (by === 'project') out.paths = Object.fromEntries(columns.filter((c) => paths[c]).map((c) => [c, paths[c]]));
  return out;
}

// 표 r 을 열 keep 개 + OTHERS 로 접은 복사본 (r 은 그대로).
function folded(r, keep) {
  const copy = (o) => ({ ...o, items: { ...o.items } });
  const out = { ...r, columns: [...r.columns], rows: r.rows.map(copy), total: copy(r.total) };
  foldOthers(out.columns, keep, [...out.rows, out.total]);
  if (r.paths) out.paths = Object.fromEntries(Object.entries(r.paths).filter(([c]) => out.columns.includes(c)));
  return out;
}

// 표 줄이 터미널 폭 cols 안에 들어가도록, 실제 칸 폭(머리글과 값 중 긴 쪽)을 재어 들어가는 만큼만 열을 남기고 나머지를 OTHERS 로 접는다.
// 한 열도 안 들어가면 열 1개 + OTHERS 로 낸다.
export function fitReport(r, cols) {
  // 열이 1개 이하면 접어도 좁아지지 않는다 (빈 OTHERS 만 붙는다).
  if (!(cols > 0) || r.columns.length <= 1 || tableWidth(r) <= cols) return r;
  for (let keep = r.columns.length - 1; keep >= 1; keep--) {
    const f = folded(r, keep);
    if (tableWidth(f) <= cols) return f;
  }
  return folded(r, 1);
}

// 앞의 keep 개 뒤 열들을 OTHERS 한 열로 합친다 (columns 와 각 줄의 items 를 고친다).
function foldOthers(columns, keep, lines) {
  const rest = columns.splice(keep);
  columns.push(OTHERS);
  for (const o of lines) {
    let sum = null;
    for (const c of rest) {
      const x = o.items[c];
      delete o.items[c];
      if (x) add((sum ??= zero()), x.tokens, x.cost, x.unpriced);
    }
    if (sum) o.items[OTHERS] = sum;
  }
}

// --json 모양: 키는 영어, 값은 숫자만 (날짜·이름은 문자열). partial: 시간 상한 때문에 덜 읽었는지.
// 칸마다 unpriced(가격표에 없는 모델이 끼었는지)를 참·거짓으로 둔다. 화면의 ? 와 같은 뜻이다.
export function reportJson(r, version, { partial = false } = {}) {
  const items = (o) => Object.fromEntries(r.columns.map((c) => [c, { tokens: o.items[c]?.tokens ?? 0, cost: o.items[c]?.cost ?? 0, unpriced: Boolean(o.items[c]?.unpriced) }]));
  const monthly = r.report === 'monthly';
  const row = (x) => (monthly ? { month: x.month, current: x.current, status: x.status } : { date: x.date });
  return {
    version,
    report: r.report,
    by: r.by,
    ...(monthly ? { months: r.months } : { days: r.days }),
    from: r.from,
    to: r.to,
    basis: 'api',
    partial,
    unpriced: r.unpriced,
    columns: r.columns,
    ...(r.paths ? { paths: r.paths } : {}),
    rows: r.rows.map((x) => ({ ...row(x), tokens: x.tokens, cost: x.cost, unpriced: x.unpriced, items: items(x) })),
    total: { tokens: r.total.tokens, cost: r.total.cost, unpriced: r.total.unpriced, items: items(r.total) },
  };
}

// 칸 하나: '1.2M $3.40'. 토큰이 없으면 '-'. 가격표에 없는 모델이 끼었으면 화면 헤더처럼 비용 뒤에 ? 를 붙인다 ('$12.30?').
const cell = (x) => (x && (x.tokens > 0 || x.cost > 0) ? `${fmtTokens(Math.round(x.tokens))} ${money(x.cost)}${x.unpriced ? '?' : ''}` : '-');

// 사람이 읽는 표. 머리글·합계 줄 문구는 화면 언어(t)를 따른다. 도구·모델·프로젝트 이름은 그대로 쓴다.
const colName = (c) => (c === UNKNOWN ? t('report.unknown') : c === OTHERS ? t('report.others') : truncate(stripControl(c), HEAD_MAX));
// 표의 머리글·날짜 줄·합계 줄 글과 칸 폭 w.
function table(r) {
  // 모델·프로젝트 이름은 기록에서 온 글이라 제어문자를 지운다.
  const head = [t(r.report === 'monthly' ? 'report.month' : 'report.date'), ...r.columns.map(colName), t('report.total')];
  const line = (label, o) => (o.status === 'missing' ? [label, ...r.columns.map(() => ''), t('report.missing')] : [label, ...r.columns.map((c) => cell(o.items[c])), cell(o)]);
  // 달 표시: 이번 달 *, 일부만 센 달 ~.
  const mark = (x) => (x.month ? `${x.month}${x.current ? ' *' : ''}${x.status === 'partial' ? ' ~' : ''}` : x.date);
  const body = r.rows.map((x) => line(mark(x), x));
  const foot = line(t('report.total'), r.total);
  const all = [head, ...body, foot];
  const w = head.map((_, i) => Math.max(...all.map((row) => width(row[i]))));
  return { head, body, foot, w };
}

// 표 한 줄의 폭 (칸 사이는 두 칸).
const tableWidth = (r) => {
  const { w } = table(r);
  return w.reduce((a, n) => a + n, 0) + 2 * (w.length - 1);
};

export function formatReport(r, { partial = false } = {}) {
  const { head, body, foot, w } = table(r);
  const fmt = (row) => row.map((s, i) => pad(s, w[i], i === 0 ? 'left' : 'right')).join('  ').trimEnd();
  const rule = w.map((n) => '-'.repeat(n)).join('  ');
  const monthly = r.report === 'monthly';
  const title = monthly ? t('report.titleMonthly', { n: r.months, by: t(`report.by.${r.by}`), from: r.from, to: r.to }) : t('report.title', { n: r.days, by: t(`report.by.${r.by}`), from: r.from, to: r.to });
  const out = [title, '', fmt(head), rule, ...body.map(fmt), rule, fmt(foot)];
  if (!r.columns.length) out.push('', t('report.empty'));
  if (monthly) {
    const notes = [];
    if (r.rows.some((x) => x.current)) notes.push(t('report.noteCurrent'));
    if (r.rows.some((x) => x.status === 'partial')) notes.push(t('report.notePartial'));
    if (r.rows.some((x) => x.status === 'missing')) notes.push(t('report.noteMissing'));
    if (notes.length) out.push('', ...notes);
  }
  if (r.unpriced) out.push('', t('report.unpriced'));
  if (partial) out.push('', t('report.partial'));
  return out.join('\n');
}

// 장부를 끝까지(또는 시간 상한까지) 읽는다. 짧게 나눠 읽으며 진행률을 onProgress(0~1, 지난 ms)로 알리고 캐시를 저장한다.
// 돌려주는 값: { books, partial }. partial 이면 시간 상한 때문에 덜 읽은 기록이 있다.
// by 가 'project' 면 장부마다 project(작업 폴더)를 붙인다.
// span: 주면 days 대신 최근 span 일(상한 없음) 안에 바뀐 기록을 읽는다 (월별 리포트). 이때는 접지 않는다 (collectMonthly 가 접는다).
// stepMs: 한 번에 읽는 시간 (테스트가 시간 상한을 흉내 낼 때 줄인다).
export async function collectReport({ days = DEFAULT_DAYS, span = null, maxMs = MAX_MS, now = Date.now(), by = 'tool', onProgress = () => {}, stepMs = STEP_MS } = {}) {
  const { createBudget } = await import('./tail.mjs');
  const { collectDaily, collectSpan } = await import('./sources/claude-ledger.mjs');
  const { flushCache } = await import('./cache.mjs');
  const { attachProjects } = await import('./sources/projects.mjs');
  const done = (books, partial) => ({ books: by === 'project' ? attachProjects(books) : books, partial });
  const start = Date.now();
  let lastFlush = start;
  for (;;) {
    const budget = createBudget(Infinity, stepMs);
    const r = span ? collectSpan({ budget, now, days: span }) : collectDaily({ budget, now, days });
    const spent = Date.now() - start;
    // 다 읽었으면 지난 날을 월별 보관함에 접는다 (화면을 띄우지 않고 리포트만 쓰는 사용자도 보관함이 이어지게).
    if (!budget.exhausted) {
      const out = done(r.books, false);
      if (!span) await foldDaily(out.books, now, days, by === 'project');
      return out;
    }
    onProgress(r.size ? 1 - r.pending / r.size : 0, spent);
    if (Date.now() - lastFlush > FLUSH_MS) {
      flushCache();
      lastFlush = Date.now();
    }
    if (spent >= maxMs) return done(r.books, true);
    // 다른 일(신호 처리 등)이 돌 틈을 준다.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// --report daily 가 다 읽은 장부(최근 days 일)를 보관함에 접는다. 접을 날이 없으면 파일만 읽고 끝난다.
async function foldDaily(books, now, days, attached) {
  const { foldArchive, foldHi } = await import('./monthly.mjs');
  const { attachProjects } = await import('./sources/projects.mjs');
  foldArchive(books, { lo: lastDays(Math.max(7, Math.min(KEEP_DAYS, days)), now).at(-1), hi: foldHi(now), now, attach: attached ? (b) => b : attachProjects });
}

// --report monthly 용 장부 읽기와 접기. 보관함을 아직 1년치로 채운 적이 없거나(backfilled) 마지막으로 접은 날이 30일 창보다 오래됐으면,
// 12개월 전 달 1일부터 바뀐 기록을 모두 읽어(시간 상한·진행률은 daily 와 같다) 한 번 채운다. 아니면 30일 창만 읽는다.
// 다 읽었을 때만 접는다. 돌려주는 값: { books, archive, viewLo, liveLo, partial, state } (buildMonthly 참고).
export async function collectMonthly({ maxMs = MAX_MS, now = Date.now(), onProgress = () => {}, stepMs = STEP_MS } = {}) {
  const m = await import('./monthly.mjs');
  const { archive, state } = m.readArchive();
  const lo30 = lastDays(KEEP_DAYS, now).at(-1);
  const backfill = Boolean(archive) && (!archive.backfilled || archive.through == null || archive.through < m.addDays(lo30, -1));
  const lo = backfill ? m.keepFrom(now) : lo30;
  const [y, mo, d] = lo.split('-').map(Number);
  const span = Math.ceil((now - new Date(y, mo - 1, d).getTime()) / 86400_000) + 1;
  const got = await collectReport({ span, maxMs, now, by: 'project', onProgress, stepMs });
  // 30일 창만 읽을 때도, 보관함이 아는 '빠짐없는 첫날(from)' 보다 앞은 일부로 둔다 (지워진 기록은 창 안에서도 돌아오지 않는다).
  let liveLo = !backfill && archive?.from > lo ? archive.from : lo;
  if (backfill) {
    // Claude Code 는 수정 시각이 오래된 기록부터 지운다 (cleanupPeriodDays, 기본 30일). 남은 Claude 기록 중 가장 오래된
    // 수정 시각이 든 날까지는 지워진 기록이 있었을 수 있어 '일부' 로 두고, 그다음 날부터 빠짐없다고 본다.
    // (오래 이어 쓴 기록 하나에 옛날 날짜가 있어도 경계는 수정 시각이다.) Codex·agy 는 기록을 지우지 않는다.
    const { oldestClaudeMtime } = await import('./sources/claude-ledger.mjs');
    const oldest = oldestClaudeMtime();
    const next = oldest == null ? lo : m.addDays(lastDays(1, oldest)[0], 1);
    liveLo = next > lo ? next : lo;
  }
  if (!got.partial && archive) m.foldArchive(got.books, { lo, hi: m.foldHi(now), complete: liveLo, now, gap: backfill ? 'hole' : 'refuse', backfilled: backfill });
  // 다른 aitop 이 먼저 썼을 수도 있으니 다시 읽는다 (그 경우도 파일 안은 늘 from~through 의 합이다).
  const after = archive ? m.readArchive().archive : null;
  return { books: got.books, archive: after, viewLo: lo, liveLo, partial: got.partial, state };
}

// stderr 진행률. 터미널일 때만, 처음 PROGRESS_AFTER_MS 가 지난 뒤부터 같은 줄을 고쳐 쓴다. done() 은 그 줄을 지운다.
export function progressWriter(stream = process.stderr) {
  let shown = false;
  return {
    update(ratio, ms) {
      if (!stream.isTTY || ms < PROGRESS_AFTER_MS) return;
      shown = true;
      stream.write(`\r\x1b[2K${t('report.progress', { pct: Math.floor(Math.max(0, Math.min(1, ratio)) * 100), s: Math.round(ms / 1000) })}`);
    },
    done() {
      if (shown) stream.write('\r\x1b[2K');
    },
  };
}
