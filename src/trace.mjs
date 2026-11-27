// aitop --report trace <세션>: 세션 하나의 호출 트리 (#258). 지시 → 도구 호출·응답 → 서브에이전트 가지마다 시간·토큰·추정 비용을 붙인다.
// build(lines, opts) 는 파일을 읽지 않는 순수 함수다 (나중에 상세 화면에서 증분으로 다시 쓰기 위해). 읽기는 readTrace, 찾기는 findTrace 가 한다.
// 비용 규칙: 응답(API 호출) 한 번의 비용은 그 응답이 부른 도구들이 똑같이 나눠 갖는다 (도구를 부르기로 한 호출의 몫).
// 도구를 부르지 않은 응답은 '응답' 줄로 남는다. 서브에이전트(Agent·Task) 줄의 비용은 그 가지 전체(서브에이전트 기록 포함) 합이다.
// Codex·agy 는 아직 트리를 만들지 않는다 (findTrace 가 도구만 알려 주고 bin 이 미지원으로 알린다).
// 실시간 tracker·캐시는 쓰지 않는다. 기록 파일을 한 번 스트림으로 읽을 뿐, 디스크에 쓰지 않는다.
import { createReadStream, existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, resolve } from 'node:path';
import { t } from './i18n.mjs';
import { claudeCost } from './pricing.mjs';
import { fmtElapsed, fmtTokens, mask, maskStrict, oneLine, pad, stripControl, truncate, width } from './text.mjs';
import { money } from './line.mjs';
import { glyphs } from './ui/glyphs.mjs';
import { isNoisePrompt, sessionName, toolDetail } from './sources/common.mjs';
import { plainName, rolloutNames } from './zstd.mjs';

// 노드 수 상한 (묶고 접은 뒤). 넘으면 오래된 지시부터 뺀다.
export const MAX_NODES = 300;
// 기본으로 펼치는 깊이. 지시가 0, 그 아래 도구가 1, 서브에이전트 안 도구가 2. 더 깊은 것은 접고 수만 남긴다.
export const DEPTH = 2;
// 출력 폭 (80열 기준). 좁은 터미널에서는 그 폭, 최소 MIN_COLS.
export const COLS = 80;
const MIN_COLS = 50;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
// 이 시간 넘게 기록이 바뀌지 않았으면 끝난 세션으로 보고, 결과 없는 도구를 진행 중이 아니라 결과 없음으로 둔다.
// 실시간 화면이 서브에이전트를 실행 중으로 보지 않는 기준(claude.mjs 의 MEMBER_STALE_MS)과 같다.
export const STALE_MS = 15 * 60_000;
// 지시 글·서브에이전트 설명의 최대 길이 (화면은 칸에 맞춰 더 자르고, --json 은 이 길이까지).
const TEXT_MAX = 500;
// 읽을 때 남길 사용자 줄 글의 길이 (지시 판정과 지시 글에 충분한 만큼).
const KEEP_TEXT = 2000;

const timeOf = (ts) => {
  const v = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(v) ? v : null;
};
const tokensOf = (u) => (u ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0);
// 기록에서 온 글: 제어문자를 지우고 한 줄로, 비밀값을 가린다.
const clean = (s) => mask(oneLine(stripControl(String(s ?? ''))));
// 옵트인으로 내보내는 글(지시 글, 서브에이전트 설명): 도구 인자(toolDetail)와 같은 maskStrict 로 가리고 TEXT_MAX 에서 자른다.
const argText = (s) => {
  if (s == null) return null;
  const v = maskStrict(oneLine(stripControl(String(s)))).trim();
  if (!v) return null;
  return v.length > TEXT_MAX ? v.slice(0, TEXT_MAX - 1) + '…' : v;
};

function node(kind, id, name, start) {
  return { id, kind, name, start, end: null, status: kind === 'prompt' || kind === 'turn' ? 'done' : 'running', tokens: 0, cost: 0, children: [] };
}

// 기록 하나(메인 또는 서브에이전트)를 따라가며 노드를 만든다. top: 메인이면 사용자 지시마다 prompt 노드를 연다.
// 돌려주는 값: { list: 맨 위 노드들(메인은 prompt, 서브에이전트는 도구·응답), first, last }.
function walk(lines, ctx, top) {
  const list = [];
  let cur = null;
  let first = null;
  let last = null;
  let model = null;
  const turns = new Map();
  // 지시 앞에 나온 줄(이어 시작한 세션 등)은 번호 0 의 빈 지시에 둔다.
  const holder = () => {
    if (!top) return list;
    if (!cur) {
      cur = Object.assign(node('prompt', 'p0', 'prompt', null), { n: 0 });
      list.push(cur);
    }
    return cur.children;
  };
  for (const raw of lines) {
    let x = raw;
    if (typeof x === 'string') {
      try {
        x = JSON.parse(x);
      } catch {
        continue;
      }
    }
    if (!x || typeof x !== 'object') continue;
    // 예전 Claude Code 는 서브에이전트 줄을 메인 기록에 isSidechain 으로 섞었다. 부모를 알 수 없어 메인 트리에서는 뺀다.
    if (top && x.isSidechain) continue;
    const at = timeOf(x.timestamp);
    if (at != null) {
      first ??= at;
      last = at;
    }
    if (x.isMeta || !x.message) continue;
    if (x.type === 'assistant') {
      const m = x.message;
      if (m.model && !String(m.model).startsWith('<')) model = m.model;
      const id = m.id ?? `m${ctx.seq++}`;
      let turn = turns.get(id);
      if (!turn) {
        turn = node('turn', id, 'reply', at);
        turns.set(id, turn);
        holder().push(turn);
      }
      turn.end = at ?? turn.end;
      // 같은 message.id 가 블록마다 반복되므로 마지막 usage 를 쓴다. id 가 없으면 세지 않는다 (claude-tracker.mjs addUsage 와 같은 규칙).
      if (m.usage && m.id) {
        turn.usage = m.usage;
        turn.model = m.model ?? model;
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type !== 'tool_use') continue;
        const agent = AGENT_TOOLS.has(c.name);
        const n = node(agent ? 'agent' : 'tool', String(c.id ?? `u${ctx.seq++}`), String(c.name ?? '?'), at);
        if (agent) n.agent = c.input?.subagent_type ?? null;
        if (ctx.showArgs) n.detail = agent ? argText(c.input?.description) : toolDetail(c.name, c.input);
        if (ctx.waiting?.has(n.id)) n.status = 'waiting';
        turn.children.push(n);
        ctx.tools.set(n.id, n);
      }
    } else if (x.type === 'user') {
      const c = x.message.content;
      if (Array.isArray(c)) {
        for (const p of c) {
          if (p?.type !== 'tool_result') continue;
          const n = ctx.tools.get(p.tool_use_id);
          if (!n) continue;
          n.end = at;
          n.status = p.is_error ? 'error' : 'done';
        }
      }
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join(' ') : '';
      if (top && text && !isNoisePrompt(text)) {
        cur = node('prompt', `p${ctx.prompts + 1}`, 'prompt', at);
        cur.n = ++ctx.prompts;
        if (ctx.showArgs) cur.text = argText(text);
        list.push(cur);
      }
    }
    if (top && cur && at != null) cur.end = at;
  }
  // 응답 비용을 매기고, 도구를 부른 응답은 그 도구들로 바꾼다 (비용은 도구 수로 나눈다).
  const settle = (arr) => {
    const out = [];
    for (const n of arr) {
      if (n.kind === 'prompt') {
        n.children = settle(n.children);
        out.push(n);
        continue;
      }
      const tok = tokensOf(n.usage);
      const price = n.usage ? claudeCost(n.model, n.usage) : null;
      const unpriced = !price && tok > 0;
      const cost = price?.total ?? 0;
      delete n.usage;
      delete n.model;
      if (!n.children.length) {
        Object.assign(n, { tokens: tok, cost, ...(unpriced ? { unpriced: true } : {}) });
        out.push(n);
        continue;
      }
      const k = n.children.length;
      for (const c of n.children) {
        Object.assign(c, { tokens: tok / k, cost: cost / k, ...(unpriced ? { unpriced: true } : {}) });
        c.children = [];
        out.push(c);
      }
    }
    return out;
  };
  return { list: settle(list), first, last };
}

// 서브에이전트 기록을 Agent·Task 노드(meta.toolUseId 와 같은 tool_use id)의 자식으로 붙인다. 서브에이전트 안의 Agent 도 같은 방법으로 따라간다.
function attach(nodes, ctx, seen) {
  for (const n of nodes) {
    if (n.kind === 'agent') {
      const sub = ctx.subs.get(n.id);
      if (sub && !seen.has(sub)) {
        seen.add(sub);
        const w = walk(sub.lines ?? [], ctx, false);
        n.children = w.list;
        n.agent ??= sub.meta?.agentType ?? null;
        if (ctx.showArgs) n.detail ??= argText(sub.meta?.description);
        n.linked = true;
      }
    }
    attach(n.children, ctx, seen);
  }
}

// 결과가 없는 도구: 마지막 지시 안이고 부모 가지가 끝나지 않았으면 진행 중, 아니면 결과를 잃은 것(끊김)으로 실패.
function finish(nodes, open) {
  for (const n of nodes) {
    if ((n.kind === 'tool' || n.kind === 'agent') && n.end == null && n.status !== 'waiting' && !open) {
      n.status = 'error';
      n.lost = true;
    }
    finish(n.children, open && !((n.kind === 'agent' || n.kind === 'tool') && n.end != null));
  }
}

// 가지 합계: tokens·cost 는 자기 몫 + 자식 합. 상태는 진행 중 > 대기 > 실패 순으로 위로 올린다 (지시만).
function total(n) {
  for (const c of n.children) {
    total(c);
    n.tokens += c.tokens;
    n.cost += c.cost;
    if (c.unpriced) n.unpriced = true;
  }
  if (n.kind === 'prompt') {
    const st = new Set(n.children.map((c) => c.status));
    n.status = st.has('running') ? 'running' : st.has('waiting') ? 'waiting' : 'done';
  }
}

// 이어진 같은 이름의 도구(자식 없는 것)를 한 줄로 묶는다: "Grep ×38". 응답 줄끼리도 묶는다.
function group(nodes) {
  const out = [];
  for (const n of nodes) {
    n.children = group(n.children);
    const prev = out.at(-1);
    const same = prev && (n.kind === 'tool' || n.kind === 'turn') && prev.kind === n.kind && prev.name === n.name && !n.children.length && !prev.children.length;
    if (!same) {
      out.push(n);
      continue;
    }
    if (!prev.count) {
      prev.count = 1;
      prev.errors = prev.status === 'error' ? 1 : 0;
      prev.ids = [prev.id];
      delete prev.detail;
    }
    prev.count++;
    prev.ids.push(n.id);
    if (n.status === 'error') prev.errors++;
    if (n.lost) prev.lost = true;
    prev.tokens += n.tokens;
    prev.cost += n.cost;
    if (n.unpriced) prev.unpriced = true;
    // 묶음의 끝: 모두 끝났으면 가장 늦은 끝, 하나라도 끝나지 않았으면 모름.
    prev.end = prev.end != null && n.end != null ? Math.max(prev.end, n.end) : null;
    const rank = { running: 3, waiting: 2, error: 1, done: 0 };
    if (rank[n.status] > rank[prev.status]) prev.status = n.status;
  }
  return out;
}

const countAll = (nodes) => nodes.reduce((a, n) => a + 1 + countAll(n.children), 0);

// depth 보다 깊은 노드는 접는다: 자식을 지우고 숨긴 노드 수를 folded 에 남긴다.
function fold(nodes, depth, d = 0) {
  for (const n of nodes) {
    if (d >= depth && n.children.length) {
      n.folded = countAll(n.children);
      n.children = [];
    } else fold(n.children, depth, d + 1);
  }
}

// 노드 수 상한: 어느 깊이든 전체 노드 수가 max 를 넘지 않게 한다. 최근 것부터 남기고, 자리가 모자라면 앞쪽 형제를 빼고
// 그 부모에 뺀 수(omitted)를 남긴다. 맨 위(지시 목록)에서 뺀 지시 수는 돌려준다.
function trim(n, budget) {
  let left = budget - 1;
  const kept = [];
  let i = n.children.length - 1;
  for (; i >= 0 && left > 0; i--) {
    left -= trim(n.children[i], left);
    kept.unshift(n.children[i]);
  }
  if (i >= 0) {
    n.omitted = (n.omitted ?? 0) + i + 1;
    n.children = kept;
  }
  return budget - left;
}

function cap(prompts, max) {
  const root = { children: prompts };
  trim(root, max + 1);
  prompts.splice(0, prompts.length, ...root.children);
  return root.omitted ?? 0;
}

const walkAll = (nodes, f) => {
  for (const n of nodes) {
    f(n);
    walkAll(n.children, f);
  }
};

// 기록 줄들 → 호출 트리. lines: 메인 기록의 줄(객체 또는 JSON 문자열). opts:
//   subagents: [{ meta, lines }] (meta 는 subagents/agent-<id>.meta.json, toolUseId 로 부모 Agent·Task 호출에 붙는다)
//   showArgs: 도구 인자(detail)·지시 글(text)을 넣을지 (기본 false, 넣을 때도 비밀값을 가린다)
//   maxNodes, depth, group(false 면 묶지 않음), waiting(허락 대기 중인 tool_use id 집합: 기록만으로는 알 수 없어 밖에서 준다)
//   ended: 세션이 끝났는지 (readTrace 의 mtime 이 STALE_MS 보다 오래됐으면). 끝났으면 결과 없는 도구는 진행 중이 아니라 결과 없음.
// 돌려주는 값: { tool, start, end, tokens, cost, unpriced, counts, omitted, nodes }. nodes 는 지시(prompt) 목록이다.
export function build(lines, opts = {}) {
  const { subagents = [], showArgs = false, maxNodes = MAX_NODES, depth = DEPTH, waiting = null, ended = false } = opts;
  const ctx = { seq: 0, prompts: 0, tools: new Map(), subs: new Map(), showArgs, waiting: waiting ? new Set(waiting) : null };
  for (const s of subagents) if (s?.meta?.toolUseId) ctx.subs.set(String(s.meta.toolUseId), s);
  const w = walk(lines, ctx, true);
  const prompts = w.list;
  attach(prompts, ctx, new Set());
  // 부모 호출을 찾지 못한 서브에이전트는 시작 시각이 들어가는 지시 끝에 붙인다.
  const used = new Set();
  walkAll(prompts, (n) => n.linked && used.add(n.id));
  for (const s of subagents) {
    const id = String(s?.meta?.toolUseId ?? '');
    if (id && used.has(id)) continue;
    const sw = walk(s?.lines ?? [], ctx, false);
    if (!sw.list.length) continue;
    const a = node('agent', id || `a${ctx.seq++}`, 'Agent', sw.first);
    Object.assign(a, { agent: s?.meta?.agentType ?? null, children: sw.list, end: sw.last, status: 'done' });
    if (showArgs) a.detail = argText(s?.meta?.description);
    let home = prompts.filter((p) => p.start != null && sw.first != null && p.start <= sw.first).at(-1) ?? prompts[0];
    if (!home) prompts.push((home = Object.assign(node('prompt', 'p0', 'prompt', sw.first), { n: 0 })));
    home.children.push(a);
  }
  const lastPrompt = prompts.at(-1);
  for (const p of prompts) finish(p.children, p === lastPrompt && !ended);
  const root = { kind: 'root', tokens: 0, cost: 0, children: prompts };
  total(root);
  const counts = { prompts: ctx.prompts, tools: 0, agents: 0, errors: 0, running: 0 };
  walkAll(prompts, (n) => {
    if (n.kind === 'tool' || n.kind === 'agent') counts.tools++;
    if (n.kind === 'agent') counts.agents++;
    if (n.status === 'error') counts.errors++;
    if ((n.kind === 'tool' || n.kind === 'agent') && n.status === 'running') counts.running++;
  });
  let nodes = opts.group === false ? prompts : group(prompts);
  fold(nodes, depth);
  const omitted = cap(nodes, Math.max(1, maxNodes));
  // linked 는 안에서만 쓴다.
  walkAll(nodes, (n) => delete n.linked);
  return { tool: 'claude', start: w.first, end: w.last, tokens: root.tokens, cost: root.cost, unpriced: Boolean(root.unpriced), counts, omitted, nodes };
}

// ---- 찾기와 읽기 (I/O) ----

const HEAD_BYTES = 256 * 1024;
// 이름으로 찾을 때 볼 최근 기록 수 (기록이 수천 개여도 오래 걸리지 않게).
const NAME_SCAN = 300;

function list(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
const mtimeOf = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

// 기록 앞부분의 ai-title 과 뒤쪽의 마지막 custom-title(/rename). 이름으로 찾을 때와 머리글에 쓴다.
export function claudeNames(path) {
  let title = null;
  let custom = null;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = statSync(path).size;
      for (const start of size > HEAD_BYTES ? [0, size - HEAD_BYTES] : [0]) {
        const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
        const text = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, start));
        for (const l of text.split('\n')) {
          if (!l.includes('"ai-title"') && !l.includes('"custom-title"')) continue;
          try {
            const x = JSON.parse(l);
            if (x.type === 'ai-title' && x.aiTitle) title = sessionName(x.aiTitle);
            if (x.type === 'custom-title') custom = sessionName(x.customTitle);
          } catch {}
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {}
  return { title, custom, name: custom ?? title };
}

// 세션 찾기. query: 기록 파일 경로, 세션 id(앞부분도 됨, 대소문자 무시), 또는 세션 이름(/rename 이름·제목, 일부도 됨).
// id 는 aitop --json 의 id·이어 열기 명령(resume.mjs)이 쓰는 값과 같다: Claude 는 기록 파일 이름의 UUID, Codex 는 rollout 파일 이름 끝의 UUID, agy 는 대화 id.
// 돌려주는 값: { tool, path, id, name } 또는 { error: 'none'|'many', candidates }.
export async function findTrace(query, { claudeRoots, codexRoots, agyRoot } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { error: 'none', candidates: [] };
  if (claudeRoots == null || codexRoots == null) {
    const d = await import('./sources/dirs.mjs');
    // Claude Desktop Cowork 세션의 기록 폴더도 함께 본다 (#304).
    claudeRoots ??= [...d.claudeProjectRoots(), ...(await import('./sources/cowork.mjs')).coworkProjectRoots()];
    codexRoots ??= d.codexSessionRoots();
  }
  // agy 기록 폴더: CLI 폴더와 앱 폴더 (#303). agyRoot 는 폴더 하나 또는 목록.
  const agyDirs = agyRoot == null ? (await import('./sources/antigravity.mjs')).agyRoots().map((r) => r.dir) : [agyRoot].flat();
  // 1) 파일 경로
  if (/\.(jsonl|db|jsonl\.zst)$/i.test(q) && existsSync(q)) {
    const p = resolve(q);
    const name = basename(p);
    if (/\.db$/i.test(name)) return { tool: 'agy', path: p, id: name.slice(0, -3), name: null };
    // Codex 압축 기록(.jsonl.zst)도 같은 id (zstd.mjs).
    if (/^rollout-/.test(name)) return { tool: 'codex', path: p, id: plainName(name).slice(0, -6), name: null };
    return { tool: 'claude', path: p, id: name.slice(0, -6), name: claudeNames(p).name };
  }
  const low = q.toLowerCase();
  const found = [];
  // 2) id: Claude 기록 (projects/<폴더>/<id>.jsonl, 같은 id 가 여러 폴더에 있으면 최근 것 하나)
  const claude = [];
  for (const root of claudeRoots) {
    for (const dir of list(root)) {
      for (const f of list(join(root, dir))) {
        if (!f.endsWith('.jsonl')) continue;
        claude.push({ tool: 'claude', id: f.slice(0, -6), path: join(root, dir, f) });
      }
    }
  }
  const byId = new Map();
  for (const c of claude) {
    if (!c.id.toLowerCase().startsWith(low)) continue;
    c.mtime = mtimeOf(c.path);
    const prev = byId.get(c.id);
    if (!prev || c.mtime > prev.mtime) byId.set(c.id, c);
  }
  found.push(...byId.values());
  // Codex: sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl (7일 넘게 쉰 기록은 .jsonl.zst, 둘 다 있으면 .jsonl)
  const digits = (p) => list(p).filter((n) => /^\d+$/.test(n)).map((n) => join(p, n));
  for (const root of codexRoots) {
    for (const y of digits(root))
      for (const m of digits(y))
        for (const d of digits(m))
          for (const f of rolloutNames(list(d))) {
            const u = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i.exec(f)?.[1];
            if (u && u.toLowerCase().startsWith(low)) found.push({ tool: 'codex', id: u, path: join(d, f), mtime: mtimeOf(join(d, f)) });
          }
  }
  // agy: conversations/<id>.db
  for (const dir of agyDirs) for (const f of list(join(dir, 'conversations'))) {
    if (f.endsWith('.db') && f.toLowerCase().startsWith(low) && !found.some((x) => x.tool === 'agy' && x.id === f.slice(0, -3))) found.push({ tool: 'agy', id: f.slice(0, -3), path: join(dir, 'conversations', f), mtime: mtimeOf(join(dir, 'conversations', f)) });
  }
  // 3) 이름: 최근 Claude 기록의 /rename 이름·제목. 순서: id 가 똑같은 것 > 이름이 똑같은 것 > id 앞부분 > 이름에 들어 있는 것.
  // id 가 똑같거나 id 앞부분으로 하나가 정해지면 이름을 읽지 않는다 (최근 기록 300개를 읽는 비용을 아낀다). 이름은 많아야 한 번 읽는다.
  const exact = found.filter((c) => c.id.toLowerCase() === low);
  let pick = exact.length === 1 ? exact : found.length === 1 ? found : [];
  if (!pick.length) {
    for (const c of claude) c.mtime ??= mtimeOf(c.path);
    const recent = claude.sort((a, b) => b.mtime - a.mtime).slice(0, NAME_SCAN);
    const named = [];
    for (const c of recent) {
      const n = claudeNames(c.path).name;
      if (n && n.toLowerCase().includes(low)) named.push({ ...c, name: n });
    }
    const same = named.filter((c) => c.name.toLowerCase() === low);
    pick = same.length ? same : found.length ? found : named;
  }
  pick.sort((a, b) => b.mtime - a.mtime);
  if (pick.length === 1) {
    const c = pick[0];
    return { tool: c.tool, path: c.path, id: c.id, name: c.name ?? (c.tool === 'claude' ? claudeNames(c.path).name : null) };
  }
  if (!pick.length) return { error: 'none', candidates: [] };
  return { error: 'many', candidates: pick.slice(0, 5).map((c) => ({ tool: c.tool, id: c.id, name: c.name ?? (c.tool === 'claude' ? claudeNames(c.path).name : null), mtime: c.mtime })) };
}

// 줄 하나에서 build 가 쓰는 필드만 남긴다. 도구 결과 본문·이미지·응답 글은 버려 큰 기록에서도 메모리를 적게 쓴다.
// 도구 인자(input)는 showArgs 일 때만 남긴다 (서브에이전트 종류·설명만 늘 남긴다).
export function slim(x, showArgs = false) {
  if (!x || typeof x !== 'object') return null;
  const out = { type: x.type, timestamp: x.timestamp };
  if (x.isSidechain) out.isSidechain = true;
  if (x.isMeta) out.isMeta = true;
  const m = x.message;
  if (!m || typeof m !== 'object' || (x.type !== 'assistant' && x.type !== 'user')) return out;
  const cut = (v) => (typeof v === 'string' ? v.slice(0, KEEP_TEXT) : '');
  let content;
  if (typeof m.content === 'string') content = cut(m.content);
  else if (Array.isArray(m.content)) {
    content = [];
    for (const c of m.content) {
      if (c?.type === 'tool_use') {
        const agent = AGENT_TOOLS.has(c.name);
        const input = showArgs ? c.input : agent ? { subagent_type: c.input?.subagent_type } : undefined;
        content.push({ type: 'tool_use', id: c.id, name: c.name, input });
      } else if (c?.type === 'tool_result') content.push({ type: 'tool_result', tool_use_id: c.tool_use_id, is_error: c.is_error });
      else if (c?.type === 'text' && x.type === 'user') content.push({ type: 'text', text: cut(c.text) });
    }
  }
  out.message = { id: m.id, model: m.model, usage: m.usage, content };
  return out;
}

// 파일 한 개를 한 번 스트림으로 읽어 줄 배열로 (slim 한 줄). 읽지 못한 줄은 버린다.
async function readLines(path, showArgs) {
  const out = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) {
    if (!l) continue;
    try {
      const x = slim(JSON.parse(l), showArgs);
      if (x) out.push(x);
    } catch {}
  }
  return out;
}

// Claude 기록과 그 서브에이전트 기록(<id>/subagents/agent-*.jsonl 과 .meta.json)을 읽는다. build 에 그대로 넘긴다.
// mtime: 메인·서브에이전트 기록 가운데 가장 최근 수정 시각 (끝난 세션인지 볼 때 쓴다).
export async function readTrace(path, { showArgs = false } = {}) {
  const lines = await readLines(path, showArgs);
  let mtime = mtimeOf(path);
  const dir = join(path.replace(/\.jsonl$/, ''), 'subagents');
  const subagents = [];
  for (const f of list(dir).sort()) {
    if (!f.endsWith('.meta.json')) continue;
    const id = f.slice('agent-'.length, -'.meta.json'.length);
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, f), 'utf8')) ?? {};
    } catch {}
    const p = join(dir, `agent-${id}.jsonl`);
    mtime = Math.max(mtime, mtimeOf(p));
    subagents.push({ id, meta, lines: existsSync(p) ? await readLines(p, showArgs) : [] });
  }
  return { lines, subagents, mtime };
}

// ---- 출력 ----

const two = (n) => String(n).padStart(2, '0');
const hms = (ms) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};
const mdhm = (ms) => {
  const d = new Date(ms);
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const costText = (n) => (n.unpriced && !(n.cost > 0) ? '-' : money(n.cost));
const durText = (n) => (n.start != null && n.end != null ? fmtElapsed(n.end - n.start) : n.status === 'running' ? t('trace.running') : '-');
const MARK = { done: 'traceDone', error: 'traceFail', running: 'traceRun', waiting: 'waiting' };

// 줄 하나의 이름 칸: 지시는 번호·시작 시각(·지시 글), 도구는 이름(×묶음 수, 서브에이전트 종류, 인자).
function label(n) {
  const g = glyphs();
  if (n.kind === 'prompt') {
    const head = `#${n.n}${n.start != null ? ` ${hms(n.start)}` : ''}`;
    return n.text ? `${head} ${n.text}` : `${head} ${t('trace.prompt')}`;
  }
  let s = n.kind === 'turn' ? t('trace.reply') : n.name;
  if (n.kind === 'agent' && n.agent) s += ` ${clean(n.agent)}`;
  if (n.count) s += ` ${g.times}${n.count}`;
  if (n.errors && n.count) s += ` ${t('trace.errors', { n: n.errors })}`;
  if (n.lost) s += ` ${t('trace.lost')}`;
  if (n.folded) s += ` ${t('trace.folded', { n: n.folded })}`;
  if (n.detail) s += `  ${clean(n.detail)}`;
  return s;
}

// 트리 줄들 (표 출력과 Markdown 코드 블록이 같이 쓴다). 오른쪽에 시간·토큰·비용 칸.
function treeLines(r, cols) {
  const W = Math.max(MIN_COLS, Math.min(cols > 0 ? cols : COLS, COLS));
  const g = glyphs();
  const R = [7, 7, 8];
  const left = W - R.reduce((a, n) => a + n + 1, 0);
  const row = (l, n) => `${pad(l, left)} ${pad(durText(n), R[0], 'right')} ${pad(n.tokens > 0 ? fmtTokens(Math.round(n.tokens)) : '-', R[1], 'right')} ${pad(costText(n), R[2], 'right')}`.trimEnd();
  const out = [`${pad('', left)} ${pad(t('trace.col.time'), R[0], 'right')} ${pad(t('trace.col.tokens'), R[1], 'right')} ${pad(t('trace.col.cost'), R[2], 'right')}`.trimEnd()];
  const draw = (nodes, prefix) => {
    nodes.forEach((n, i) => {
      const lastOne = i === nodes.length - 1;
      const mark = g[MARK[n.status]] ?? ' ';
      out.push(row(`${prefix}${lastOne ? g.memberLast : g.member}${mark} ${label(n)}`, n));
      const next = prefix + (lastOne ? ' '.repeat(width(g.memberLast)) : g.memberPipe);
      if (n.omitted) out.push(`${next}${g.member}${t('trace.omittedSteps', { n: n.omitted })}`);
      draw(n.children, next);
    });
  };
  for (const p of r.nodes) {
    out.push(row(`${g[MARK[p.status]] ?? ' '} ${label(p)}`, p));
    if (p.omitted) out.push(`${g.member}${t('trace.omittedSteps', { n: p.omitted })}`);
    draw(p.children, '');
  }
  return out;
}

function titleOf(r, meta) {
  return t('trace.title', { name: clean(meta.name ?? '-'), id: String(meta.id ?? '').slice(0, 8) });
}

function summaryOf(r) {
  // 끝이 시작과 같은 날이면 시:분만.
  const end = r.end == null ? '-' : mdhm(r.end).slice(0, 5) === mdhm(r.start).slice(0, 5) ? mdhm(r.end).slice(6) : mdhm(r.end);
  const span = r.start != null ? `${mdhm(r.start)} ~ ${end}` : '-';
  return t('trace.summary', { span, prompts: r.counts.prompts, tools: r.counts.tools, agents: r.counts.agents, tokens: fmtTokens(Math.round(r.tokens)), cost: costText(r) });
}

function notes(r) {
  const out = [];
  if (r.omitted) out.push(t('trace.omitted', { n: r.omitted }));
  out.push(t('trace.noteBasis'));
  if (r.unpriced) out.push(t('report.unpriced'));
  return out;
}

// 사람이 읽는 80열 텍스트. meta: { id, name }.
export function formatTrace(r, meta = {}, { cols = COLS } = {}) {
  const out = [titleOf(r, meta), summaryOf(r), ''];
  if (r.nodes.length) out.push(...treeLines(r, cols));
  else out.push(t('trace.empty'));
  out.push('', ...notes(r));
  return out.join('\n');
}

// Markdown: 제목·요약, 트리는 코드 블록 (기호와 칸이 그대로 맞게).
export function traceMarkdown(r, meta = {}) {
  const out = [`**${titleOf(r, meta).replace(/[\\`*_[\]<>#~!|]/g, '\\$&')}**`, '', `- ${summaryOf(r)}`, ''];
  if (r.nodes.length) out.push('```text', ...treeLines(r, COLS).map((l) => l.replace(/```/g, "'''")), '```');
  else out.push(t('trace.empty'));
  out.push('', ...notes(r).map((l) => `_${l}_`));
  return out.join('\n');
}

// --json 모양: 키는 영어, 시각은 ISO(모르면 null). detail·text 는 build 에 showArgs 를 줬을 때만 있다.
export function traceJson(r, version, meta = {}) {
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const conv = (n) => ({
    id: n.id,
    kind: n.kind,
    name: n.kind === 'prompt' ? `#${n.n}` : n.name,
    ...(n.kind === 'agent' ? { agent: n.agent ?? null } : {}),
    start: iso(n.start),
    end: iso(n.end),
    status: n.status,
    tokens: Math.round(n.tokens),
    cost: n.cost,
    ...(n.unpriced ? { unpriced: true } : {}),
    ...(n.count ? { count: n.count, errors: n.errors } : {}),
    ...(n.lost ? { lost: true } : {}),
    ...(n.folded ? { folded: n.folded } : {}),
    ...(n.omitted ? { omitted: n.omitted } : {}),
    ...(n.text != null ? { text: n.text } : {}),
    ...(n.detail != null ? { detail: clean(n.detail) } : {}),
    children: n.children.map(conv),
  });
  return {
    version,
    report: 'trace',
    tool: r.tool,
    session: { id: meta.id ?? null, name: meta.name ?? null },
    basis: 'api',
    start: iso(r.start),
    end: iso(r.end),
    tokens: Math.round(r.tokens),
    cost: r.cost,
    unpriced: r.unpriced,
    counts: r.counts,
    omitted: r.omitted,
    nodes: r.nodes.map(conv),
  };
}

// 여러 세션이 맞을 때 고를 수 있게 보이는 후보 줄.
export function candidatesText(list) {
  return list.map((c) => `  ${c.tool.padEnd(6)} ${c.id.slice(0, 8)}  ${c.mtime ? mdhm(c.mtime) : '-'}  ${truncate(clean(c.name ?? '-'), 40)}`).join('\n');
}

