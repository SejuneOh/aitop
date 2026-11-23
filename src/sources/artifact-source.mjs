// 아티팩트 원본 찾기 (#307). 상세 패널 아티팩트 목록에서 Enter 로 볼 때만 부른다 (미리 읽거나 캐시에 쌓지 않는다).
// 순서: 1) 게시 결과의 path 에 있는 로컬 파일 2) 같은 세션(서브에이전트 포함) 기록에서 그 경로로 마지막에 Write 한 본문 3) 원본 없음.
// 기록 본문을 쓸 때 그 Write 뒤에 같은 경로의 Edit 이나 Artifact edits 가 있었으면 게시본과 다를 수 있다고 알린다.
// 경로는 기록의 게시 결과(toolUseResult.path, 없으면 게시 호출의 file_path)에서만 얻는다. 목록·캐시·--json 에는 경로를 두지 않는다.
// 보통은 기록을 읽던 tracker 가 메모리에 기억한 위치(경로, Write 결과 줄의 오프셋)만 읽고, 위치를 모를 때만 기록을 뒤에서 나눠 훑는다.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute } from 'node:path';
import { isPublish, pickArtifact } from './artifacts.mjs';
import { parseTs } from './common.mjs';
import { liveTracker } from './claude-tracker.mjs';

// 원본으로 읽는 최대 바이트. 넘으면 앞부분만 보이고 cut 을 켠다.
export const SOURCE_MAX = 2 * 1024 * 1024;

const PATH_MAX = 4096;
const okPath = (p) => typeof p === 'string' && p.length <= PATH_MAX && isAbsolute(p) && !/[\x00-\x1f\x7f]/.test(p);

// 바이트 앞부분을 글로. 잘린 자리의 반쪽 글자는 버린다.
function decode(buf) {
  const d = new StringDecoder('utf8');
  return d.write(buf);
}

// 로컬 파일 읽기: 일반 파일이고 심볼릭 링크가 아닐 때만. 실패하면 null (조용히 다음 출처로).
// lstat 와 open 사이에 링크로 바뀌는 것도 막는다 (O_NOFOLLOW 가 있는 OS 는 열 때 거절, 없으면 같은 파일인지 dev·ino 로 다시 본다).
export function readLocal(path, max = SOURCE_MAX) {
  if (!okPath(path)) return null;
  let fd;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const f = fstatSync(fd);
    if (!f.isFile() || f.dev !== st.dev || f.ino !== st.ino) return null;
    const n = Math.min(f.size, max);
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got);
      if (!r) break;
      got += r;
    }
    return { text: decode(buf.subarray(0, got)), cut: f.size > max, size: f.size };
  } catch {
    return null;
  } finally {
    if (fd != null)
      try {
        closeSync(fd);
      } catch {}
  }
}

// 기록을 한 줄씩 읽는다 (큰 기록도 통째로 올리지 않는다). want 에 걸리는 줄만 JSON 으로 푼다.
// 생성기라서 1MB 를 읽을 때마다 한 번 멈춘다(yield). 화면 쪽은 시간을 잘라 이어 돌려 키 입력과 그리기를 막지 않는다.
function* eachRecord(path, want, fn) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const d = new StringDecoder('utf8');
    const buf = Buffer.alloc(1 << 20);
    let rest = '';
    let pos = 0;
    const take = (l) => {
      if (!want(l)) return;
      try {
        fn(JSON.parse(l));
      } catch {}
    };
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      rest += d.write(buf.subarray(0, n));
      let start = 0;
      let i;
      while ((i = rest.indexOf('\n', start)) >= 0) {
        take(rest.slice(start, i));
        start = i + 1;
      }
      rest = rest.slice(start);
      yield n;
    }
    if (rest) take(rest);
  } catch {
  } finally {
    if (fd != null)
      try {
        closeSync(fd);
      } catch {}
  }
}

// JSON 안에 적힌 모양 (따옴표 없이).
const inJson = (s) => JSON.stringify(s).slice(1, -1);

const toolUses = (x) => (x?.type === 'assistant' && Array.isArray(x.message?.content) ? x.message.content.filter((c) => c?.type === 'tool_use') : []);
const toolResults = (x) => (x?.type === 'user' && Array.isArray(x.message?.content) ? x.message.content.filter((c) => c?.type === 'tool_result') : []);

// 기록들에서 이 아티팩트(a.id)를 마지막으로 게시한 결과의 경로. 결과에 path 가 없으면 게시 호출의 file_path.
function* findPathSteps(logs, a) {
  const calls = new Map();
  let best = null;
  const raw = a?.id && !a.id.startsWith('h:') ? inJson(a.id) : null;
  for (const log of logs ?? []) {
    yield* eachRecord(
      log,
      (l) => l.includes('"Artifact"') || (l.includes('"toolUseResult"') && (!raw || l.includes(raw))),
      (x) => {
        for (const c of toolUses(x)) if (c.name === 'Artifact' && isPublish(c.input)) calls.set(c.id, c.input?.file_path);
        if (!x.toolUseResult) return;
        for (const p of toolResults(x)) {
          if (!calls.has(p.tool_use_id) || p.is_error) continue;
          const got = pickArtifact(x.toolUseResult, parseTs(x.timestamp));
          if (got?.id !== a.id) continue;
          const path = okPath(x.toolUseResult.path) ? x.toolUseResult.path : okPath(calls.get(p.tool_use_id)) ? calls.get(p.tool_use_id) : null;
          const at = parseTs(x.timestamp);
          if (path && (!best || at >= best.at)) best = { path, at };
        }
      },
    );
  }
  return best?.path ?? null;
}

// 기록들에서 path 로 마지막에 Write 한 본문과, 그 뒤에 같은 경로를 고친 일(Edit·Artifact edits)이 있었는지.
// 본문은 지금까지 본 마지막 것 하나만 들고 있는다.
function* findWriteSteps(logs, path, max = SOURCE_MAX) {
  let write = null;
  const edits = [];
  const esc = inJson(path);
  for (const log of logs ?? []) {
    yield* eachRecord(
      log,
      (l) => l.includes(esc) || l.includes(path),
      (x) => {
        const at = parseTs(x.timestamp);
        for (const c of toolUses(x)) if (c.name === 'Artifact' && isPublish(c.input) && c.input?.file_path === path && Array.isArray(c.input.edits) && c.input.edits.length) edits.push(at);
        const r = x.toolUseResult;
        if (x.type !== 'user' || !r || typeof r !== 'object' || r.filePath !== path) return;
        if (toolResults(x).some((p) => p.is_error)) return;
        if (typeof r.content === 'string' && (r.type === 'create' || r.type === 'update')) {
          if (!write || at >= write.at) write = { at, ...cap(r.content, max) };
        } else if (Array.isArray(r.structuredPatch)) edits.push(at);
      },
    );
  }
  if (!write) return null;
  return { text: write.text, cut: write.cut, changed: edits.some((at) => at > write.at) };
}

const cap = (text, max) => (text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false });
const none = (path) => ({ kind: 'none', path, text: '', cut: false, changed: false });

// 생성기를 끝까지 돌린 값.
function run(gen) {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

export const findPath = (logs, a) => run(findPathSteps(logs, a));
export const findWrite = (logs, path, max) => run(findWriteSteps(logs, path, max));

// 기록을 훑어 찾기 (기억한 위치가 없을 때).
function* scanSteps(s, a) {
  const logs = s?.logs ?? [];
  const path = yield* findPathSteps(logs, a);
  if (!path) return none(null);
  const local = readLocal(path);
  if (local) return { kind: 'local', path, text: local.text, cut: local.cut, changed: false };
  const w = yield* findWriteSteps(logs, path);
  if (w) return { kind: 'record', path, text: w.text, cut: w.cut, changed: w.changed };
  return none(path);
}

// 기억한 위치의 Write 결과 줄 하나만 읽는다. 그 자리에 같은 경로의 Write 결과가 없으면(기록이 다시 쓰임) null.
export const LINE_MAX = 64 * 1024 * 1024;
export function readWriteAt(log, offset, length, path, max = SOURCE_MAX) {
  if (!Number.isFinite(offset) || !(length > 0) || length > LINE_MAX) return null;
  let fd;
  try {
    fd = openSync(log, 'r');
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const r = readSync(fd, buf, got, length - got, offset + got);
      if (!r) break;
      got += r;
    }
    if (got < length) return null;
    const x = JSON.parse(buf.toString('utf8'));
    const r = x?.toolUseResult;
    if (x?.type !== 'user' || r?.filePath !== path || typeof r.content !== 'string' || (r.type !== 'create' && r.type !== 'update')) return null;
    return cap(r.content, max);
  } catch {
    return null;
  } finally {
    if (fd != null)
      try {
        closeSync(fd);
      } catch {}
  }
}

// 기록을 읽는 tracker 가 기억한 위치로 찾는다 (claude-tracker.mjs noteSource). 훑지 않는다.
// 모르면 null: tracker 가 없거나, 캐시에서 이어 읽어 앞부분을 모르는데 거기서 찾지 못했거나, 기억한 줄이 바뀌었을 때.
export function quickSource(s, a, find = liveTracker) {
  const ts = (s?.logs ?? []).map((p) => find(p));
  if (!ts.length || ts.some((t) => !t)) return null;
  // 모든 기록을 처음부터 읽었으면 못 찾은 것도 답이다. 캐시에서 이어 읽은 기록이 있으면 앞부분에 있을 수 있다.
  const complete = ts.every((t) => t.srcFrom === 0);
  let hit = null;
  for (const t of ts) {
    const p = t.artPaths?.get(a?.id);
    if (p && okPath(p.path) && (!hit || p.at >= hit.at)) hit = p;
  }
  if (!hit) return complete ? none(null) : null;
  const local = readLocal(hit.path);
  if (local) return { kind: 'local', path: hit.path, text: local.text, cut: local.cut, changed: false };
  let w = null;
  for (const t of ts) {
    const x = t.writes?.get(hit.path);
    if (x && (!w || x.at >= w.at)) w = { ...x, log: t.path };
  }
  if (!w) return complete ? none(hit.path) : null;
  const body = readWriteAt(w.log, w.offset, w.length, hit.path);
  if (!body) return null;
  const lastEdit = Math.max(-Infinity, ...ts.map((t) => t.edited?.get(hit.path) ?? -Infinity));
  return { kind: 'record', path: hit.path, text: body.text, cut: body.cut, changed: lastEdit > w.at };
}

// 원본 찾기 (기다리는 판). s.logs: 세션 기록 경로 (메인과 서브에이전트, claude.mjs sessionTotals).
// 돌려주는 값: { kind: 'local'|'record'|'none', path, text, cut, changed }
export function loadArtifactSource(s, a) {
  return quickSource(s, a) ?? run(scanSteps(s, a));
}

// 화면용: 기억한 위치로 바로 찾으면 그 값을, 아니면 null 을 돌려주고 기록 훑기를 뒤에서 시간을 잘라 돌린다.
// 한 번에 slice ms 만 돌고 다음 이벤트 루프로 넘긴다. cancelled() 가 참이면 그만둔다. 끝나면 done(doc).
export function openArtifactSource(s, a, { done, cancelled = () => false, slice = 30 } = {}) {
  const quick = quickSource(s, a);
  if (quick) return quick;
  const gen = scanSteps(s, a);
  const step = () => {
    if (cancelled()) {
      gen.return();
      return;
    }
    const until = Date.now() + slice;
    for (;;) {
      const r = gen.next();
      if (r.done) return done?.(r.value);
      if (Date.now() >= until) break;
    }
    setImmediate(step);
  };
  setImmediate(step);
  return null;
}
