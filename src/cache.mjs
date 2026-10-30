// 큰 세션 기록을 매번 처음부터 다시 읽지 않도록, 파일별로 "어디까지 읽었고 그때 합계가 얼마였는지"를
// ~/.cache/aitop 에 저장한다. 이 프로그램이 디스크에 쓰는 곳은 여기뿐이다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const VERSION = 2;
const DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'aitop', `v${VERSION}`);
const dirty = new Map();

const keyOf = (path) => createHash('sha1').update(path).digest('hex');

// 파일이 바뀌지 않고 뒤에만 붙었을 때(크기가 같거나 커졌고 inode 가 같을 때)만 캐시를 쓴다.
export function loadCache(path) {
  try {
    const c = JSON.parse(readFileSync(join(DIR, keyOf(path) + '.json'), 'utf8'));
    const st = statSync(path);
    if (c.path !== path || c.ino !== st.ino || st.size < c.offset) return null;
    return c;
  } catch {
    return null;
  }
}

export function markDirty(path, snapshot) {
  dirty.set(path, snapshot);
}

export function flushCache() {
  if (!dirty.size) return;
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  for (const [path, build] of dirty) {
    try {
      const data = build();
      if (!data) continue;
      const file = join(DIR, keyOf(path) + '.json');
      writeFileSync(file + '.tmp', JSON.stringify({ ...data, path, ino: statSync(path).ino }), { mode: 0o600 });
      renameSync(file + '.tmp', file);
    } catch {}
  }
  dirty.clear();
}
