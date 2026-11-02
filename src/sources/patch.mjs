// Codex apply_patch 본문을 파일별 변경으로 바꾼다. 결과는 Claude 의 toolUseResult 와 같은 모양이라 files.mjs addChange 에 그대로 넘긴다.
//   *** Begin Patch
//   *** Update File: src/a.mjs      (*** Move to: src/b.mjs 가 뒤따를 수 있다)
//   @@ function foo                  (문맥. 줄 번호는 없다)
//    그대로인 줄 / -지운 줄 / +쓴 줄
//   *** Add File: src/new.mjs       (+ 줄이 본문)
//   *** Delete File: src/old.mjs
//   *** End Patch
import { isAbsolute, join } from 'node:path';

// 글 안에서 패치 부분만 꺼낸다 (예전 shell 호출은 명령 인자 안에 들어 있다).
export function extractPatch(text) {
  const s = String(text ?? '');
  const a = s.indexOf('*** Begin Patch');
  if (a < 0) return null;
  const b = s.indexOf('*** End Patch', a);
  return s.slice(a, b < 0 ? undefined : b + '*** End Patch'.length);
}

export function parsePatch(text, cwd) {
  const patch = extractPatch(text);
  if (!patch) return [];
  const abs = (p) => (isAbsolute(p) || !cwd ? p : join(cwd, p));
  const out = [];
  let cur = null;
  let hunk = null;
  const startHunk = (context) => {
    hunk = { unnumbered: true, context, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [] };
    cur.structuredPatch.push(hunk);
  };
  for (const line of patch.split('\n')) {
    let m;
    if ((m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line))) {
      const path = abs(m[2].trim());
      cur = m[1] === 'Add' ? { type: 'create', filePath: path, body: [] } : m[1] === 'Delete' ? { type: 'delete', filePath: path } : { filePath: path, structuredPatch: [] };
      hunk = null;
      out.push(cur);
    } else if ((m = /^\*\*\* Move to: (.+)$/.exec(line)) && cur) {
      cur.filePath = abs(m[1].trim());
    } else if (line.startsWith('***')) {
      continue;
    } else if (cur?.type === 'create') {
      if (line.startsWith('+')) cur.body.push(line.slice(1));
    } else if (cur?.structuredPatch) {
      if (line.startsWith('@@')) startHunk(line.slice(2).trim());
      else if (/^[ +-]/.test(line)) {
        if (!hunk) startHunk('');
        hunk.lines.push(line);
        if (line[0] !== '+') hunk.oldLines++;
        if (line[0] !== '-') hunk.newLines++;
      }
    }
  }
  for (const c of out) {
    if (c.type === 'create') {
      c.content = c.body.join('\n');
      delete c.body;
    }
  }
  return out;
}

// apply_patch 결과가 성공인지. JSON 결과는 exit_code, 글 결과는 실패 문구로 본다. 모르면 성공으로 본다.
export function patchSucceeded(output) {
  const s = String(output ?? '');
  try {
    const o = JSON.parse(s);
    const code = o?.metadata?.exit_code;
    if (typeof code === 'number') return code === 0;
    return patchSucceeded(o?.output ?? '');
  } catch {
    return !/^\s*(error|failed|apply_patch verification failed|invalid patch)/i.test(s);
  }
}
