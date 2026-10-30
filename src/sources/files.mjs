// 세션이 Edit/Write 도구로 고친 파일을 모은다. Claude 기록의 toolUseResult.structuredPatch 를 그대로 쓴다.
// Bash(sed, git checkout 등)로 바꾼 파일은 기록에 변경 내용이 없어 잡히지 않는다.
import { basename } from 'node:path';
import { mask, cleanLine } from '../text.mjs';
import { parseTs } from './common.mjs';

// log: 편집 한 번마다 { at, add, del, created }. 지시 탭에서 그 지시의 숫자만 다시 셀 때 쓴다 (turns.mjs).
export const FILE_LIMITS = { files: 60, hunksPerFile: 8, lineChars: 200, hunkLines: 300, lines: 1500, log: 200 };

// 비밀값이 들어 있을 만한 파일은 목록에는 보이되 변경 내용은 저장하지 않는다.
const SECRET_FILE = /^\.env(\.|$)|\.(pem|key|p12|pfx|jks|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)|^\.(npmrc|netrc|pgpass)$|secret|credential|api[._-]?key|private[._-]?key/i;

export function isSecretFile(path) {
  return SECRET_FILE.test(basename(path));
}

const clean = (s) => mask(cleanLine(s)).slice(0, FILE_LIMITS.lineChars);

function toHunk(h, at) {
  const lines = Array.isArray(h?.lines) ? h.lines : [];
  return {
    at,
    oldStart: h.oldStart ?? 0,
    oldLines: h.oldLines ?? 0,
    newStart: h.newStart ?? 0,
    newLines: h.newLines ?? 0,
    lines: lines.slice(0, FILE_LIMITS.hunkLines).map(clean),
    cut: Math.max(0, lines.length - FILE_LIMITS.hunkLines),
  };
}

const count = (lines, mark) => lines.reduce((a, l) => a + (typeof l === 'string' && l[0] === mark ? 1 : 0), 0);

// toolUseResult 한 건을 { path, created, add, del, hunks } 로 바꾼다. 편집 결과가 아니면 null.
export function readChange(r, at) {
  if (!r || typeof r !== 'object' || typeof r.filePath !== 'string') return null;
  const patch = Array.isArray(r.structuredPatch) ? r.structuredPatch.filter((h) => h && Array.isArray(h.lines)) : null;
  if (r.type === 'create' && typeof r.content === 'string') {
    // 새 파일은 diff 조각 없이 본문만 남으므로 본문을 + 줄로 보인다.
    const body = r.content.replace(/\n$/, '').split('\n');
    const hunk = toHunk({ oldStart: 0, oldLines: 0, newStart: 1, newLines: body.length, lines: body.map((l) => '+' + l) }, at);
    return { path: r.filePath, created: true, add: body.length, del: 0, hunks: [hunk] };
  }
  if (!patch) return null;
  const all = patch.flatMap((h) => h.lines);
  return { path: r.filePath, created: false, add: count(all, '+'), del: count(all, '-'), hunks: patch.map((h) => toHunk(h, at)) };
}

// files: 기록 하나의 파일 목록 (배열, 캐시에 그대로 저장된다).
export function addChange(files, r, timestamp) {
  const at = parseTs(timestamp);
  const c = readChange(r, at);
  if (!c) return;
  let f = files.find((x) => x.path === c.path);
  if (!f) files.push((f = { path: c.path, created: c.created, edits: 0, add: 0, del: 0, at, hidden: isSecretFile(c.path), dropped: 0, hunks: [], log: [] }));
  f.edits++;
  f.add += c.add;
  f.del += c.del;
  f.at = Math.max(f.at, at);
  f.log.push({ at, add: c.add, del: c.del, created: c.created });
  if (f.log.length > FILE_LIMITS.log) f.log.shift();
  if (f.hidden) return;
  f.hunks.push(...c.hunks);
  while (f.hunks.length > FILE_LIMITS.hunksPerFile) dropOldest(f);
  enforceLimits(files);
}

function dropOldest(f) {
  f.hunks.shift();
  f.dropped++;
}

// 파일 수와 저장하는 diff 줄 수에 상한을 둔다. 오래된 것부터 버리고, 줄 수 통계는 남긴다.
function enforceLimits(files) {
  files.sort((a, b) => b.at - a.at);
  if (files.length > FILE_LIMITS.files) files.length = FILE_LIMITS.files;
  let total = files.reduce((a, f) => a + f.hunks.reduce((b, h) => b + h.lines.length, 0), 0);
  while (total > FILE_LIMITS.lines) {
    let oldest = null;
    for (const f of files) if (f.hunks.length && (!oldest || f.hunks[0].at < oldest.hunks[0].at)) oldest = f;
    if (!oldest) break;
    total -= oldest.hunks[0].lines.length;
    dropOldest(oldest);
  }
}

// 메인과 서브에이전트의 파일 목록을 경로별로 합친다. 변경 조각마다 누가 고쳤는지 붙이고, 최근에 고친 파일이 앞에 온다.
// startedAt: 서브에이전트가 시작한 시각. 그 편집은 편집 시각이 아니라 이 시각으로 지시에 나눈다
// (백그라운드 서브에이전트가 다음 지시 뒤까지 일해도 자기를 부른 지시에 들어가게).
export function mergeFiles(sources) {
  const byPath = new Map();
  for (const { agent, files, startedAt } of sources) {
    const turnAt = (at) => startedAt ?? at;
    for (const f of files ?? []) {
      let m = byPath.get(f.path);
      if (!m) byPath.set(f.path, (m = { path: f.path, created: f.created, edits: 0, add: 0, del: 0, at: 0, hidden: f.hidden, dropped: 0, hunks: [], log: [], agents: [] }));
      m.created ||= f.created;
      m.edits += f.edits;
      m.add += f.add;
      m.del += f.del;
      m.at = Math.max(m.at, f.at);
      m.dropped += f.dropped;
      for (const e of f.log ?? []) m.log.push({ ...e, turnAt: turnAt(e.at) });
      if (!m.agents.includes(agent)) m.agents.push(agent);
      for (const h of f.hunks) m.hunks.push({ ...h, agent, turnAt: turnAt(h.at) });
    }
  }
  const out = [...byPath.values()];
  for (const f of out) f.hunks.sort((a, b) => b.at - a.at);
  return out.sort((a, b) => b.at - a.at);
}
