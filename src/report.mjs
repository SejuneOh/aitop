// aitop --report daily: 최근 N일(기본 30, 최대 30)의 날짜별 토큰·비용을 도구별 또는 모델별 표로 내고 끝낸다 (실시간 화면 없음).
// 값은 날짜별 사용량 장부(claude-ledger.mjs 의 collectDaily)에서 오고, 비용은 화면 헤더와 같은 API 정가 환산이다.
// 줄은 최근 날짜가 위(오늘부터 거꾸로)이고, 맨 아래 합계 줄은 위 날짜 줄을 더한 값이다. --json 도 같은 값을 숫자로만 낸다.
// 처음 읽는 동안 stderr 가 터미널이면 진행률을 보이고, 시간 상한을 넘으면 읽은 만큼으로 표를 내고 덜 읽었다고 알린다.
import { t } from './i18n.mjs';
import { fmtTokens, pad, stripControl, width } from './text.mjs';
import { money } from './line.mjs';
import { KEEP_DAYS, lastDays } from './sources/common.mjs';

export const KINDS = ['daily'];
export const BY = ['tool', 'model'];
export const MAX_DAYS = KEEP_DAYS;
export const DEFAULT_DAYS = KEEP_DAYS;
// 전체 시간 상한. 넘으면 읽은 만큼으로 표를 낸다 (캐시에 남은 만큼은 다음 실행이 이어 읽는다).
export const MAX_MS = 120_000;
// 한 번에 읽는 시간. 이만큼마다 진행률을 고치고 캐시를 저장한다.
const STEP_MS = 250;
// 이보다 오래 걸릴 때만 진행률을 보인다 (캐시가 있는 실행에서 깜빡이지 않게).
const PROGRESS_AFTER_MS = 400;
const FLUSH_MS = 3000;
const TOOLS = ['claude', 'codex', 'agy'];

// --report <kind>, --report=<kind>, --by <tool|model>, --by=..., --days <N>, --days=<N> 를 꺼낸다.
// kind 는 --report 를 주지 않았으면 null. --by·--days 는 --report 와 함께일 때만 받는다. capped: --days 를 30으로 줄였는지.
export function reportOption(argv) {
  let kind = null;
  let by = 'tool';
  let days = DEFAULT_DAYS;
  let capped = false;
  let error = null;
  let extra = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(report|by|days)(?:=(.*))?$/.exec(a);
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
      const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (n > 0) {
        capped = n > MAX_DAYS;
        days = Math.min(n, MAX_DAYS);
      } else error ??= raw === '' ? t('opt.daysMissing') : t('opt.daysBad', { value: JSON.stringify(raw) });
    }
  }
  if (!error && extra && !kind) error = t('opt.reportOnly');
  return { kind, by, days, capped, rest, error };
}

const zero = () => ({ tokens: 0, cost: 0, unpriced: false });
// unpriced: 가격표에 없는 모델이 끼어 이 칸의 비용이 실제보다 적을 수 있는지.
const add = (a, tokens, cost, unpriced) => {
  a.tokens += tokens;
  a.cost += cost;
  if (unpriced) a.unpriced = true;
};

// books: collectDaily 의 [{ tool, days }]. 최근 days 일의 날짜 줄(오늘부터 거꾸로)과 열(도구 또는 모델), 합계를 만든다.
// 열은 기간 합계 비용이 큰 순서(같으면 토큰, 이름 순)이고, 기간 안에 토큰이 하나도 없는 열은 뺀다.
// unpriced: 가격표에 없는 모델이 끼어 비용이 실제보다 적게 잡혔을 수 있는지.
export function buildReport(books, { by = 'tool', days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const dates = lastDays(days, now);
  const rows = dates.map((date) => ({ date, tokens: 0, cost: 0, unpriced: false, items: {} }));
  const at = new Map(rows.map((r) => [r.date, r]));
  const total = { tokens: 0, cost: 0, unpriced: false, items: {} };
  let unpriced = false;
  for (const { tool, days: book } of books) {
    for (const [date, d] of Object.entries(book ?? {})) {
      const row = at.get(date);
      if (!row) continue;
      if (d.unknown) unpriced = true;
      const parts = by === 'model' ? Object.entries(d.models ?? {}) : [[tool, d]];
      for (const [name, x] of parts) {
        add((row.items[name] ??= zero()), x.tokens, x.cost, x.unknown);
        add((total.items[name] ??= zero()), x.tokens, x.cost, x.unknown);
      }
      add(row, d.tokens, d.cost, d.unknown);
      add(total, d.tokens, d.cost, d.unknown);
    }
  }
  const rank = (name) => (by === 'tool' ? TOOLS.indexOf(name) : 0);
  const columns = Object.entries(total.items)
    .filter(([, x]) => x.tokens > 0 || x.cost > 0)
    .sort(([a, x], [b, y]) => y.cost - x.cost || y.tokens - x.tokens || rank(a) - rank(b) || a.localeCompare(b))
    .map(([name]) => name);
  return { report: 'daily', by, days, from: dates.at(-1), to: dates[0], columns, rows, total, unpriced };
}

// --json 모양: 키는 영어, 값은 숫자만 (날짜·이름은 문자열). partial: 시간 상한 때문에 덜 읽었는지.
// 칸마다 unpriced(가격표에 없는 모델이 끼었는지)를 참·거짓으로 둔다. 화면의 ? 와 같은 뜻이다.
export function reportJson(r, version, { partial = false } = {}) {
  const items = (o) => Object.fromEntries(r.columns.map((c) => [c, { tokens: o.items[c]?.tokens ?? 0, cost: o.items[c]?.cost ?? 0, unpriced: Boolean(o.items[c]?.unpriced) }]));
  return {
    version,
    report: r.report,
    by: r.by,
    days: r.days,
    from: r.from,
    to: r.to,
    basis: 'api',
    partial,
    unpriced: r.unpriced,
    columns: r.columns,
    rows: r.rows.map((x) => ({ date: x.date, tokens: x.tokens, cost: x.cost, unpriced: x.unpriced, items: items(x) })),
    total: { tokens: r.total.tokens, cost: r.total.cost, unpriced: r.total.unpriced, items: items(r.total) },
  };
}

// 칸 하나: '1.2M $3.40'. 토큰이 없으면 '-'. 가격표에 없는 모델이 끼었으면 화면 헤더처럼 비용 뒤에 ? 를 붙인다 ('$12.30?').
const cell = (x) => (x && (x.tokens > 0 || x.cost > 0) ? `${fmtTokens(Math.round(x.tokens))} ${money(x.cost)}${x.unpriced ? '?' : ''}` : '-');

// 사람이 읽는 표. 머리글·합계 줄 문구는 화면 언어(t)를 따른다. 도구 이름과 모델 이름은 그대로 쓴다.
export function formatReport(r, { partial = false } = {}) {
  // 모델 이름은 기록에서 온 글이라 제어문자를 지운다.
  const head = [t('report.date'), ...r.columns.map((c) => stripControl(c)), t('report.total')];
  const line = (label, o) => [label, ...r.columns.map((c) => cell(o.items[c])), cell(o)];
  const body = r.rows.map((x) => line(x.date, x));
  const foot = line(t('report.total'), r.total);
  const all = [head, ...body, foot];
  const w = head.map((_, i) => Math.max(...all.map((row) => width(row[i]))));
  const fmt = (row) => row.map((s, i) => pad(s, w[i], i === 0 ? 'left' : 'right')).join('  ').trimEnd();
  const rule = w.map((n) => '-'.repeat(n)).join('  ');
  const out = [t('report.title', { n: r.days, by: t(`report.by.${r.by}`), from: r.from, to: r.to }), '', fmt(head), rule, ...body.map(fmt), rule, fmt(foot)];
  if (!r.columns.length) out.push('', t('report.empty'));
  if (r.unpriced) out.push('', t('report.unpriced'));
  if (partial) out.push('', t('report.partial'));
  return out.join('\n');
}

// 장부를 끝까지(또는 시간 상한까지) 읽는다. 짧게 나눠 읽으며 진행률을 onProgress(0~1, 지난 ms)로 알리고 캐시를 저장한다.
// 돌려주는 값: { books, partial }. partial 이면 시간 상한 때문에 덜 읽은 기록이 있다.
export async function collectReport({ days = DEFAULT_DAYS, maxMs = MAX_MS, now = Date.now(), onProgress = () => {} } = {}) {
  const { createBudget } = await import('./tail.mjs');
  const { collectDaily } = await import('./sources/claude-ledger.mjs');
  const { flushCache } = await import('./cache.mjs');
  const start = Date.now();
  let lastFlush = start;
  for (;;) {
    const budget = createBudget(Infinity, STEP_MS);
    const r = collectDaily({ budget, now, days });
    const spent = Date.now() - start;
    if (!budget.exhausted) return { books: r.books, partial: false };
    onProgress(r.size ? 1 - r.pending / r.size : 0, spent);
    if (Date.now() - lastFlush > FLUSH_MS) {
      flushCache();
      lastFlush = Date.now();
    }
    if (spent >= maxMs) return { books: r.books, partial: true };
    // 다른 일(신호 처리 등)이 돌 틈을 준다.
    await new Promise((resolve) => setImmediate(resolve));
  }
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
