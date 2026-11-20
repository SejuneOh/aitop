// 기간 리포트 --by project 용: 기록 파일 하나가 어느 프로젝트(작업 폴더)의 것인지 찾는다.
// Claude 는 기록 앞부분 줄의 cwd (없으면 projects/ 아래 폴더 이름, Cowork 기록은 cowork 또는 고른 폴더), Codex 는 turn_context.cwd (없으면 session_meta.cwd),
// agy 는 conversation_summaries.db 의 workspace_uris (서브에이전트는 부모 대화의 것) 를 쓴다. 못 찾으면 null.
// agy 기록은 immutable 로 열어 -wal 에만 있는 막 생긴 대화는 아직 안 보이므로, 그 대화는 (unknown) 으로 나올 수 있다.
// 장부 캐시 모양은 그대로 두고, 리포트를 낼 때만 파일 앞부분을 조금 읽는다.
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { agyRoots, cwdOf } from './antigravity.mjs';
import { openReadOnly } from '../sqlite.mjs';
import { debugIo } from '../log.mjs';
import { claudeProjectRoots } from './dirs.mjs';
import { coworkProjectOf } from './cowork.mjs';

// 앞부분에서 cwd 를 찾을 때 읽는 최대 크기. Codex 의 첫 줄(session_meta)은 지침 글이 들어 있어 길 수 있다.
const HEAD_BYTES = 256 * 1024;
const heads = new Map();
// 앞부분을 읽는 버퍼. scanHead 는 동기 함수라 하나를 돌려 쓴다.
const BUF = Buffer.allocUnsafe(HEAD_BYTES);

// 파일 앞부분의 완성된 줄을 차례로 pick 에 넘긴다. pick 이 true 를 돌려주면 멈춘다.
// 대개 첫 몇 줄에 있으므로 CHUNK 씩 읽고, 찾으면 더 읽지 않는다.
const CHUNK = 16 * 1024;
function scanHead(path, pick) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = BUF;
    let len = 0;
    let done = 0;
    while (len < HEAD_BYTES) {
      const n = readSync(fd, buf, len, Math.min(CHUNK, HEAD_BYTES - len), len);
      if (n <= 0) break;
      len += n;
      const end = buf.lastIndexOf(10, len - 1);
      if (end < done) continue;
      for (const line of buf.toString('utf8', done, end).split('\n')) {
        let x;
        try {
          x = JSON.parse(line);
        } catch {
          continue;
        }
        if (pick(x)) return;
      }
      done = end + 1;
    }
  } catch (e) {
    debugIo('report', 'log head read failed', e, path);
  } finally {
    if (fd != null) closeSync(fd);
  }
}

// 같은 파일(inode)이면 다시 읽지 않는다.
function memo(path, find) {
  let ino = null;
  try {
    ino = statSync(path).ino;
  } catch {}
  const c = heads.get(path);
  if (c && c.ino === ino) return c.cwd;
  const cwd = find();
  heads.set(path, { ino, cwd });
  return cwd;
}

// Claude 기록 앞부분 줄의 cwd. 없으면 null.
export function claudeProject(path) {
  return memo(path, () => {
    let cwd = null;
    scanHead(path, (x) => typeof x?.cwd === 'string' && x.cwd && (cwd = x.cwd));
    return cwd;
  });
}

// Claude 가 projects/ 아래 폴더 이름을 만드는 방식: 영문·숫자 밖의 글자를 - 로 바꾼다.
export const encodeFolder = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// cwd 를 못 찾았을 때 쓰는 projects/ 바로 아래 폴더 이름. 작업 트리 꼴(--claude-worktrees-<이름>)이면 그 부분을 뗀다.
// root 를 주지 않으면 설정 폴더 전부의 projects/ 중 path 를 담은 것을 쓴다.
export function claudeFolder(path, root) {
  for (const r of root ? [root] : claudeProjectRoots()) {
    const rel = relative(r, path);
    const dir = rel.split(sep)[0];
    if (!dir || rel.startsWith('..') || isAbsolute(rel) || dir === rel) continue;
    return dir.replace(/--claude-worktrees-.*$/, '') || dir;
  }
  return null;
}

export function codexProject(path) {
  return memo(path, () => {
    let meta = null;
    let turn = null;
    scanHead(path, (x) => {
      const p = x?.payload;
      if (x?.type === 'session_meta' && typeof p?.cwd === 'string') meta ??= p.cwd;
      if (x?.type === 'turn_context' && typeof p?.cwd === 'string') turn = p.cwd;
      return turn != null;
    });
    return turn || meta || null;
  });
}

// 대화 id → 작업 폴더. 서브에이전트는 작업 폴더가 비어 있으면 부모를 따라 올라간다. 리포트 한 번에 한 번만 읽는다.
export function agyWorkspaces(root = agyRoots().map((r) => r.dir)) {
  return new Map([...agyConversations(root)].map(([id, c]) => [id, c.cwd]));
}

// 대화 id → { cwd, title, root }. root: 부모를 끝까지 따라간 맨 위 대화 id (서브에이전트를 그 세션에 묶을 때 쓴다).
// title 은 agy 가 붙인 대화 제목 (세션 리포트의 '그 밖 이름').
// root: 기록 폴더 하나 또는 목록 (CLI 폴더와 앱 폴더, #303). 같은 대화 id 가 여러 폴더에 있으면 앞 폴더 것을 쓴다.
export function agyConversations(root = agyRoots().map((r) => r.dir)) {
  if (Array.isArray(root)) {
    const all = new Map();
    for (const dir of root) for (const [id, c] of agyConversations(dir)) if (!all.has(id)) all.set(id, c);
    return all;
  }
  const out = new Map();
  let db;
  try {
    db = openReadOnly(join(root, 'conversation_summaries.db'));
    if (!db) return out;
    // title 열은 예전 기록에 없을 수 있어 * 로 읽는다.
    const rows = db.prepare('select * from conversation_summaries').all().map((r) => ({ id: r.conversation_id, parent: r.parent_conversation_id, ws: r.workspace_uris, title: r.title }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      let cur = r;
      let cwd = cwdOf(cur.ws);
      for (let i = 0; !cwd && cur?.parent && i < 10; i++) {
        cur = byId.get(cur.parent);
        cwd = cur ? cwdOf(cur.ws) : null;
      }
      let top = r;
      for (let i = 0; top.parent && byId.has(top.parent) && i < 10; i++) top = byId.get(top.parent);
      out.set(r.id, { cwd, title: typeof r.title === 'string' && r.title ? r.title : null, root: top.id });
    }
  } catch (e) {
    debugIo('report', 'agy workspaces read failed', e);
  } finally {
    db?.close();
  }
  return out;
}

// Claude Code 가 만든 작업 트리(<저장소>/.claude/worktrees/<이름>) 는 저장소 하나로 본다.
// 에이전트마다 작업 트리가 생겨 그대로 두면 열이 수십 개로 갈라진다.
export function projectRoot(cwd) {
  if (!cwd) return null;
  const m = /^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/.exec(cwd);
  return m ? m[1] : cwd;
}

// books: collectDaily 의 [{ tool, path, days }]. 각 장부에 project(작업 폴더 경로 또는 null)를 붙여 돌려준다.
// Claude 기록에서 cwd 를 못 찾으면 폴더 이름을 쓰되, 같은 폴더 이름이 되는 경로를 다른 기록에서 찾았으면 그 경로로 묶는다.
export function attachProjects(books, root) {
  let agy = null;
  const folder = new Map();
  const out = books.map((b) => {
    let project = null;
    let fallback = null;
    if (b.path) {
      if (b.tool === 'claude') {
        // Claude Desktop Cowork 기록은 기록 안의 cwd(VM·outputs 폴더) 대신 cowork 또는 사용자가 고른 폴더로 묶는다 (#313).
        project = coworkProjectOf(b.path) ?? claudeProject(b.path);
        if (!project) fallback = claudeFolder(b.path, root);
      } else if (b.tool === 'codex') project = codexProject(b.path);
      else if (b.tool === 'agy') project = (agy ??= agyWorkspaces()).get(basename(b.path, '.db')) ?? null;
    }
    project = projectRoot(project);
    // 한 폴더 이름에 서로 다른 경로가 둘 이상 모이면(/a/b-c 와 /a/b/c, 한글 이름 등) 어느 쪽인지 모르니 묶지 않는다 (false).
    if (project) {
      const k = encodeFolder(project);
      const had = folder.get(k);
      folder.set(k, had === undefined || had === project ? project : false);
    }
    return { ...b, project: project ?? fallback, fallback: Boolean(fallback) };
  });
  return out.map(({ fallback, ...b }) => (fallback ? { ...b, project: folder.get(b.project) || b.project } : b));
}

// 작업 폴더 경로들 → 짧은 이름. 마지막 폴더 이름을 쓰고, 이름이 겹치면 겹치지 않을 때까지 앞 폴더를 붙인다 (dev/aitop).
export function projectLabels(paths) {
  const segs = new Map();
  for (const p of paths) segs.set(p, String(p).split(/[\\/]+/).filter(Boolean));
  const out = new Map();
  let todo = [...segs.keys()];
  for (let n = 1; todo.length; n++) {
    const name = (p) => segs.get(p).slice(-n).join('/') || p;
    const count = new Map();
    for (const p of segs.keys()) if (!out.has(p)) count.set(name(p), (count.get(name(p)) ?? 0) + 1);
    // 모든 경로가 다 쓰였는데도 겹치면(같은 경로를 다르게 쓴 것) 전체 경로를 쓴다.
    const last = todo.every((p) => segs.get(p).length <= n);
    for (const p of todo) if (count.get(name(p)) === 1 || last) out.set(p, last && count.get(name(p)) > 1 ? p : name(p));
    todo = todo.filter((p) => !out.has(p));
  }
  return out;
}
