// aitop --report sessions: 기간(--since, 기본 어제 0시부터 지금까지) 안에 사용량이 있는 세션을 한 줄씩 보이고, 맨 위에 요약 카드
// (기간 API 정가 합계, 도구별 비중, 세션 수, --plan 을 주면 구독료 비례 몫의 몇 배인지)를 둔다. 표, --md, --json 셋 중 하나로 낸다.
// 토큰·비용·모델·프로젝트는 날짜별 장부(--report daily 와 같은 값, 같은 프로젝트 규칙)에서, 시작·끝 시각·고친 파일·첫 지시·세션 이름은
// 기록 요약(sources/sheets.mjs)에서 온다. agy 는 시작·끝을 장부의 호출 시각에서 얻고, 고친 파일과 첫 지시는 모른다 ('-').
// 첫 지시는 --show-prompts 일 때만 낸다 (공유용 출력에 개인 내용이 섞이지 않게).
// 기다린 시간(waited)은 기록 요약의 날짜별 w 합이다 (에이전트가 끝낸 뒤 사용자 입력까지, 간격 하나당 2시간 상한, sheets.mjs).
// 부모 세션 기록에서만 세고(서브에이전트는 넣지 않는다), agy 는 모른다 ('-').
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { t } from './i18n.mjs';
import { fmtElapsed, fmtTokens, mask, oneLine, pad, stripControl, truncate, width } from './text.mjs';
import { money } from './line.mjs';
import { tildeIn } from './paths.mjs';
import { dayKey } from './sources/common.mjs';
import { projectLabels } from './sources/projects.mjs';
import { MAX_MS, UNKNOWN, collectReport } from './report.mjs';

const DAY_MS = 86400_000;
// 구독료를 나눌 달 길이 (일).
export const PLAN_DAYS = 30;
// 화면·Markdown 의 첫 지시 길이 (글자 폭).
export const PROMPT_WIDTH = 60;
const TOOLS = ['claude', 'codex', 'agy'];
const STEP_MS = 250;
const FLUSH_MS = 3000;

const used = (x) => x && (x.tokens > 0 || x.cost > 0);
// 장부 days 중 기간 [lo, hi] 안에 사용량이 있는 날.
const inWindow = (b, lo, hi) => Object.entries(b.days ?? {}).filter(([d, x]) => d >= lo && d <= hi && used(x));

// Claude 기록 경로 → { sid, main }. 서브에이전트(<sid>/subagents/agent-x.jsonl)는 부모 세션 id 와 부모 기록 경로.
export function claudeSession(path) {
  const parts = String(path).split(/[\\/]/);
  if (parts.at(-2) === 'subagents' && parts.length >= 3) {
    const sid = parts.at(-3);
    return { sid, main: join(dirname(dirname(dirname(path))), `${sid}.jsonl`), sub: true };
  }
  return { sid: basename(path, '.jsonl'), main: path, sub: false };
}

// 장부와 기록 요약을 읽는다. since: 기간 시작 ms (로컬 0시). 돌려주는 값: { books, extra, agy, partial }.
// books 는 collectReport(by project)의 장부, extra 는 기록 경로 → { days, custom, title }, agy 는 대화 id → { cwd, title, root }.
// 처음 읽는 동안 onProgress(0~1, 지난 ms) 로 진행률을 알리고, 시간 상한(maxMs, 장부와 합쳐서)을 넘으면 읽은 만큼으로 partial 을 켠다.
export async function collectSessions({ since, now = Date.now(), maxMs = MAX_MS, onProgress = () => {}, stepMs = STEP_MS } = {}) {
  const start = Date.now();
  const span = Math.max(1, Math.ceil((now - since) / DAY_MS)) + 1;
  const got = await collectReport({ span, maxMs, now, by: 'project', onProgress: (r, ms) => onProgress(r * 0.7, ms), stepMs });
  const { createBudget } = await import('./tail.mjs');
  const { flushCache } = await import('./cache.mjs');
  const { sheetOf } = await import('./sources/sheets.mjs');
  const { codexIndexName } = await import('./sources/codex.mjs');
  const lo = dayKey(since);
  const hi = dayKey(now);
  const want = new Map();
  let agyUsed = false;
  for (const b of got.books) {
    if (!b.path || !inWindow(b, lo, hi).length) continue;
    if (b.tool === 'agy') agyUsed = true;
    else if (b.tool === 'codex') want.set(b.path, { tool: 'codex' });
    else if (b.tool === 'claude') {
      const s = claudeSession(b.path);
      want.set(b.path, { tool: 'claude', sub: s.sub });
      // 서브에이전트만 기간 안에 쓰였어도 부모 기록에서 이름을 찾는다.
      if (s.sub && !want.has(s.main) && existsSync(s.main)) want.set(s.main, { tool: 'claude', sub: false });
    }
  }
  const sheets = [...want].map(([p, o]) => sheetOf(p, o.tool, { sub: o.sub }));
  let partial = got.partial;
  let lastFlush = Date.now();
  for (;;) {
    const budget = createBudget(Infinity, stepMs);
    for (const s of sheets) s.update(budget);
    if (!budget.exhausted) break;
    const spent = Date.now() - start;
    const size = sheets.reduce((a, s) => a + s.tail.size, 0);
    const left = sheets.reduce((a, s) => a + s.left, 0);
    onProgress(0.7 + 0.3 * (size ? 1 - left / size : 0), spent);
    if (Date.now() - lastFlush > FLUSH_MS) {
      flushCache();
      lastFlush = Date.now();
    }
    if (spent >= maxMs) {
      partial = true;
      break;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const extra = new Map();
  for (const s of sheets) {
    // Codex: 기록 안의 이름 바꾸기가 먼저, 없으면 session_index.jsonl 의 이름.
    const custom = s.custom ?? (s.tool === 'codex' ? codexIndexName(s.path, s.id) : null);
    extra.set(s.path, { days: s.days, custom, title: s.title });
  }
  let agy = new Map();
  if (agyUsed) {
    const { agyConversations } = await import('./sources/projects.mjs');
    agy = agyConversations();
  }
  return { books: got.books, extra, agy, partial };
}

// 세션 표. books: [{ tool, path, project, days }], extra: 경로 → { days, custom, title }, agy: 대화 id → { title, root }.
// 줄은 기간 안 API 정가 비용이 큰 순서(같으면 토큰, 늦게 끝난 순)다. 스탠드업·공유에서 "어디에 많이 들었나" 가 먼저 보이게.
// plan: 월 구독료(USD). 주면 summary.plan 에 기간 몫(경과 일수/30)과 그 몇 배인지를 둔다.
export function buildSessions(books, { since, now = Date.now(), extra = new Map(), agy = new Map(), plan = null } = {}) {
  const lo = dayKey(since);
  const hi = dayKey(now);
  const groups = new Map();
  for (const b of books) {
    const win = inWindow(b, lo, hi);
    if (!win.length) continue;
    let key;
    let main = false;
    let mainPath = null;
    if (b.tool === 'claude') {
      const s = claudeSession(b.path ?? '');
      key = `claude:${s.sid}`;
      main = !s.sub;
      mainPath = s.main;
    } else if (b.tool === 'agy') {
      const id = basename(b.path ?? '', '.db');
      const root = agy.get(id)?.root ?? id;
      key = `agy:${root}`;
      main = root === id;
      mainPath = root;
    } else {
      key = `${b.tool}:${b.path}`;
      main = true;
      mainPath = b.path;
    }
    const g = groups.get(key) ?? { tool: b.tool, mainPath, parts: [], project: null, mainProject: undefined };
    groups.set(key, g);
    g.parts.push({ b, win });
    if (main) g.mainProject = b.project ?? null;
    g.project ??= b.project ?? null;
  }
  const projects = [...groups.values()].map((g) => (g.mainProject !== undefined ? g.mainProject : g.project));
  const labels = projectLabels(new Set(projects.filter(Boolean)));
  const sessions = [];
  let gi = 0;
  for (const g of groups.values()) {
    const project = projects[gi++];
    const models = {};
    let tokens = 0;
    let cost = 0;
    let unpriced = false;
    let a = null;
    let z = null;
    const files = new Set();
    let more = false;
    let filesKnown = g.tool !== 'agy';
    const time = (x) => {
      if (Number.isFinite(x?.a) && (a == null || x.a < a)) a = x.a;
      if (Number.isFinite(x?.z) && (z == null || x.z > z)) z = x.z;
    };
    const paths = new Set();
    for (const { b, win } of g.parts) {
      paths.add(b.path);
      for (const [, d] of win) {
        tokens += d.tokens;
        cost += d.cost;
        if (d.unknown) unpriced = true;
        const parts = d.models && Object.keys(d.models).length ? d.models : { unknown: d };
        for (const [m, x] of Object.entries(parts)) {
          const o = (models[m] ??= { tokens: 0, cost: 0 });
          o.tokens += x.tokens;
          o.cost += x.cost;
        }
        if (g.tool === 'agy') time(d);
      }
    }
    if (g.tool === 'claude') paths.add(g.mainPath);
    let prompt = null;
    // 기다린 시간: 부모 기록의 기록 요약이 있을 때만 (없으면 모름).
    let waited = g.tool !== 'agy' && extra.has(g.mainPath) ? 0 : null;
    for (const p of paths) {
      const e = extra.get(p);
      if (!e) {
        if (g.tool !== 'agy' && g.parts.some((x) => x.b.path === p)) filesKnown = false;
        continue;
      }
      for (const [d, x] of Object.entries(e.days ?? {}).sort(([k1], [k2]) => (k1 < k2 ? -1 : 1))) {
        if (d < lo || d > hi) continue;
        time(x);
        for (const f of x.f ?? []) files.add(f);
        if (x.more) more = true;
        if (p === g.mainPath && x.p && prompt == null) prompt = x.p;
        if (p === g.mainPath && waited != null) waited += x.w ?? 0;
      }
    }
    const main = g.tool === 'agy' ? agy.get(g.mainPath) : extra.get(g.mainPath);
    const custom = g.tool === 'agy' ? null : (main?.custom ?? null);
    const other = main?.title ?? null;
    const label = project ? labels.get(project) : null;
    const name = custom ?? other ?? (project ? basename(String(project)) : null) ?? g.tool;
    const ranked = Object.entries(models)
      .filter(([, x]) => used(x))
      .sort(([m1, x], [m2, y]) => y.cost - x.cost || y.tokens - x.tokens || m1.localeCompare(m2));
    sessions.push({
      tool: g.tool,
      model: ranked[0]?.[0] ?? null,
      models: ranked.map(([m]) => m),
      project: label ?? UNKNOWN,
      projectPath: project ?? null,
      name,
      start: a,
      end: z,
      tokens,
      cost,
      unpriced,
      files: filesKnown ? files.size : null,
      filesMore: filesKnown && more,
      prompt,
      waited,
    });
  }
  const rank = (x) => TOOLS.indexOf(x.tool);
  sessions.sort((x, y) => y.cost - x.cost || y.tokens - x.tokens || (y.end ?? 0) - (x.end ?? 0) || rank(x) - rank(y) || x.name.localeCompare(y.name));
  return { report: 'sessions', since, now, days: Math.max(0, now - since) / DAY_MS, sessions, summary: summaryOf(sessions, since, now, plan) };
}

function summaryOf(sessions, since, now, plan) {
  // waited: 아는 세션의 기다린 시간 합. 아는 세션이 하나도 없으면 null.
  const total = { sessions: sessions.length, tokens: 0, cost: 0, unpriced: false, tools: {}, waited: null };
  for (const s of sessions) {
    if (s.waited != null) total.waited = (total.waited ?? 0) + s.waited;
    total.tokens += s.tokens;
    total.cost += s.cost;
    if (s.unpriced) total.unpriced = true;
    const o = (total.tools[s.tool] ??= { sessions: 0, tokens: 0, cost: 0, share: 0 });
    o.sessions++;
    o.tokens += s.tokens;
    o.cost += s.cost;
  }
  // 비중은 비용으로 나눈다. 비용이 모두 0 이면(가격표에 없는 모델만) 토큰으로 나눈다.
  const byCost = total.cost > 0;
  for (const o of Object.values(total.tools)) o.share = byCost ? o.cost / total.cost : total.tokens > 0 ? o.tokens / total.tokens : 0;
  total.tools = Object.fromEntries(Object.entries(total.tools).sort(([a, x], [b, y]) => y.share - x.share || TOOLS.indexOf(a) - TOOLS.indexOf(b)));
  total.shareBy = byCost ? 'cost' : 'tokens';
  if (plan > 0) {
    const days = Math.max(0, now - since) / DAY_MS;
    const prorated = (plan * days) / PLAN_DAYS;
    total.plan = { monthly: plan, days, prorated, ratio: prorated > 0 ? total.cost / prorated : null };
  } else total.plan = null;
  return total;
}

// --json 모양: 키는 영어, 숫자는 숫자로. 시각은 ISO 문자열(모르면 null). 첫 지시(prompt)는 prompts 일 때만 둔다.
export function sessionsJson(r, version, { partial = false, prompts = false } = {}) {
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const s = r.summary;
  return {
    version,
    report: 'sessions',
    since: dayKey(r.since),
    from: iso(r.since),
    to: iso(r.now),
    days: r.days,
    basis: 'api',
    partial,
    unpriced: s.unpriced,
    summary: {
      sessions: s.sessions,
      tokens: s.tokens,
      cost: s.cost,
      unpriced: s.unpriced,
      shareBy: s.shareBy,
      tools: s.tools,
      plan: s.plan,
      // 기다린 시간 합 (ms, 추정). 모르면 null.
      waitedMs: s.waited,
    },
    sessions: r.sessions.map((x) => ({
      tool: x.tool,
      model: x.model,
      models: x.models,
      project: x.project,
      // 홈 아래 경로는 ~ 로 줄인다 (공유용 출력에 사용자 이름이 덜 드러나게).
      projectPath: x.projectPath == null ? null : tildeIn(x.projectPath),
      name: x.name,
      start: iso(x.start),
      end: iso(x.end),
      tokens: x.tokens,
      cost: x.cost,
      unpriced: x.unpriced,
      files: x.files,
      // 기다린 시간 (ms, 추정). agy 처럼 모르면 null.
      waitedMs: x.waited,
      ...(prompts ? { prompt: x.prompt } : {}),
    })),
  };
}

const two = (n) => String(n).padStart(2, '0');
const hm = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;
const mdhm = (ms) => {
  const d = new Date(ms);
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm(d)}`;
};
// 끝 시각: 시작과 같은 날이면 시:분만.
const endText = (x) => (x.end == null ? '-' : x.start != null && dayKey(x.start) === dayKey(x.end) ? hm(new Date(x.end)) : mdhm(x.end));
const startText = (x) => (x.start == null ? '-' : mdhm(x.start));
const costText = (x) => (used(x) && !(x.unpriced && !(x.cost > 0)) ? money(x.cost) : '-');
const waitedText = (ms) => (ms == null ? '-' : fmtElapsed(ms));
const filesText = (x) => (x.files == null ? '-' : `${x.files}${x.filesMore ? '+' : ''}`);
const modelText = (x) => (x.model ? `${x.model}${x.models.length > 1 ? ` +${x.models.length - 1}` : ''}` : '-');
const projectText = (x) => (x.project === UNKNOWN ? t('report.unknown') : x.project);
// 기록에서 온 글: 제어문자를 지우고 한 줄로.
const clean = (s) => oneLine(stripControl(String(s ?? '')));
// 첫 지시: 한 줄, 제어문자 제거, 비밀값 가림, 약 60 글자 폭에서 자른다.
export const promptText = (s) => (s ? truncate(mask(clean(s)), PROMPT_WIDTH) : '-');
// 0 보다 크지만 반올림하면 0% 인 몫은 <1% 로 (쓴 도구가 0% 로 보이지 않게).
const pct = (n) => (n > 0 && n < 0.005 ? '<1%' : `${Math.round(n * 100)}%`);
const daysText = (n) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1));

// 요약 카드의 줄들 (표와 Markdown 이 같은 글을 쓴다). md 면 굵게 표시.
function cardLines(r, md = false) {
  const s = r.summary;
  const b = (x) => (md ? `**${x}**` : x);
  const out = [t('sessions.cardTotal', { cost: b(s.unpriced && !(s.cost > 0) ? '-' : money(s.cost)), tokens: fmtTokens(Math.round(s.tokens)), n: s.sessions })];
  const tools = Object.entries(s.tools).map(([tool, o]) => `${tool} ${pct(o.share)}`);
  if (tools.length) out.push(t(s.shareBy === 'cost' ? 'sessions.cardTools' : 'sessions.cardToolsTokens', { tools: tools.join(' · ') }));
  if (s.plan) {
    const p = s.plan;
    out.push(t('sessions.cardPlan', { plan: money(p.monthly), days: daysText(p.days), prorated: money(p.prorated), ratio: b(p.ratio == null ? '-' : `${p.ratio >= 10 ? Math.round(p.ratio) : p.ratio.toFixed(1)}x`) }));
  }
  if (s.waited != null) out.push(t('sessions.cardWaited', { waited: b(waitedText(s.waited)) }));
  return out;
}

function titleOf(r) {
  return t('sessions.title', { from: `${dayKey(r.since)} 00:00`, to: `${dayKey(r.now)} ${hm(new Date(r.now))}`, days: daysText(r.days) });
}

// 기다림 칸은 시작·끝 옆에 둔다 (시간끼리). 좁은 터미널에서는 다른 칸처럼 그대로 두고 세션 이름 칸이 줄어든다.
const HEAD_KEYS = ['tool', 'model', 'project', 'name', 'start', 'end', 'waited', 'tokens', 'cost', 'files'];
const rowCells = (x) => [x.tool, clean(modelText(x)), clean(projectText(x)), clean(x.name), startText(x), endText(x), waitedText(x.waited), used(x) ? fmtTokens(Math.round(x.tokens)) : '-', costText(x), filesText(x)];
const RIGHT = new Set([6, 7, 8, 9]);
// 칸 폭 상한 (세션 이름은 터미널 폭에 맞춘다).
const MAX_W = { 1: 24, 2: 20 };
const NAME_MIN = 12;
const NAME_MAX = 40;

// 사람이 읽는 표. cols: 터미널 폭 (모르면 0). 세션 이름 칸이 남는 폭을 쓴다. prompts 면 줄 끝에 첫 지시 칸을 둔다.
export function formatSessions(r, { partial = false, prompts = false, cols = 0 } = {}) {
  const head = HEAD_KEYS.map((k) => t(`sessions.col.${k}`));
  if (prompts) head.push(t('sessions.col.prompt'));
  const body = r.sessions.map((x) => {
    const c = rowCells(x);
    if (prompts) c.push(promptText(x.prompt));
    return c;
  });
  const all = [head, ...body];
  const w = head.map((_, i) => Math.max(...all.map((row) => width(row[i]))));
  for (const [i, max] of Object.entries(MAX_W)) w[i] = Math.min(w[i], Math.max(max, width(head[i])));
  // 첫 지시 칸은 맨 끝이라 채우지 않는다. 세션 이름 칸은 남는 폭(최소 NAME_MIN, 최대 NAME_MAX).
  const fixed = w.reduce((a, n, i) => (i === 3 || (prompts && i === w.length - 1) ? a : a + n), 0) + 2 * (w.length - 1);
  const room = cols > 0 ? cols - fixed - (prompts ? PROMPT_WIDTH : 0) : NAME_MAX;
  w[3] = Math.min(w[3], Math.max(NAME_MIN, Math.min(NAME_MAX, room)));
  const fmt = (row) => row.map((s, i) => (prompts && i === row.length - 1 ? s : pad(s, w[i], RIGHT.has(i) ? 'right' : 'left'))).join('  ').trimEnd();
  const rule = w.map((n, i) => '-'.repeat(prompts && i === w.length - 1 ? Math.min(n, PROMPT_WIDTH) : n)).join('  ');
  const out = [titleOf(r), '', ...cardLines(r).map((l) => `  ${l}`), ''];
  if (r.sessions.length) out.push(fmt(head), rule, ...body.map(fmt));
  else out.push(t('sessions.empty'));
  out.push('', t('sessions.noteBasis'));
  if (r.summary.unpriced) out.push(t('report.unpriced'));
  if (partial) out.push(t('report.partial'));
  return out.join('\n');
}

// Markdown 표 칸: 줄바꿈은 공백으로 바꾸고, | 와 서식 글자(\ ` * _ [ ] < > # ~ !)는 \ 로 이스케이프한다.
// 붙여 넣은 곳에서 표가 깨지거나 세션 이름이 굵게·링크·HTML 로 바뀌지 않게.
export const mdCell = (s) => stripControl(String(s ?? '').replace(/\r\n?|\n/g, ' ')).trim().replace(/[\\`*_[\]<>#~!|]/g, '\\$&') || '-';

// 그대로 붙여 넣을 수 있는 Markdown: 제목, 요약 몇 줄, 표.
export function sessionsMarkdown(r, { partial = false, prompts = false } = {}) {
  const head = HEAD_KEYS.map((k) => t(`sessions.col.${k}`));
  if (prompts) head.push(t('sessions.col.prompt'));
  const out = [`**${mdCell(titleOf(r))}**`, '', ...cardLines(r, true).map((l) => `- ${l}`), ''];
  if (r.sessions.length) {
    out.push(`| ${head.map(mdCell).join(' | ')} |`, `|${head.map((_, i) => (RIGHT.has(i) ? ' ---: ' : ' --- ')).join('|')}|`);
    for (const x of r.sessions) {
      const c = rowCells(x);
      if (prompts) c.push(promptText(x.prompt));
      out.push(`| ${c.map(mdCell).join(' | ')} |`);
    }
  } else out.push(t('sessions.empty'));
  out.push('', `_${t('sessions.noteBasis')}_`);
  if (r.summary.unpriced) out.push('', `_${mdCell(t('report.unpriced'))}_`);
  if (partial) out.push('', `_${mdCell(t('report.partial'))}_`);
  return out.join('\n');
}
