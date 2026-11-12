// 큰 세션 기록을 매번 처음부터 다시 읽지 않도록, 파일별로 "어디까지 읽었고 그때 합계가 얼마였는지"를
// ~/.cache/aitop 에 저장한다. 이 프로그램이 디스크에 쓰는 곳은 여기와 --debug 때의 디버그 로그(log.mjs)뿐이다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { PRICE_TAG } from './pricing.mjs';
import { debug, debugIo } from './log.mjs';

// 캐시 형식이 바뀌면 VERSION 을, 가격표가 바뀌면 PRICE_TAG 가 폴더 이름을 바꿔서 예전 캐시를 버린다.
// 14: 장부의 하루 합계에 모델별 몫(models)을 더하고, 날짜를 10일이 아니라 30일 남긴다 (#128).
const VERSION = 14;
const ROOT = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'aitop');
export const CACHE_ROOT = ROOT;
const NAME = `v${VERSION}-${PRICE_TAG}`;
const DIR = join(ROOT, NAME);
export const CACHE_DIR = DIR;
const dirty = new Map();
let cleaned = false;

// 다른 버전의 aitop 이 같이 쓰고 있을 수 있으니, 같은 형식의 다른 폴더는 일주일 넘게 손대지 않았을 때만 지운다.
const STALE_DIR_MS = 7 * 24 * 3600 * 1000;

function removeOldDirs() {
  cleaned = true;
  try {
    for (const d of readdirSync(ROOT)) {
      // summary.json(--line 용 요약, summary.mjs)은 버전 폴더 밖에 두고 여기서 지우지 않는다. 남은 임시 파일은 일주일 뒤 지운다.
      if (d === NAME || d === 'summary.json') continue;
      const p = join(ROOT, d);
      // 이 버전보다 낮은 형식(v2, v6-… 등)은 더 이상 어떤 버전도 쓰지 않으므로 바로 지운다.
      const ver = Number(/^v(\d+)(?:-|$)/.exec(d)?.[1]);
      if (ver < VERSION || Date.now() - statSync(p).mtimeMs > STALE_DIR_MS) rmSync(p, { recursive: true, force: true });
    }
  } catch (e) {
    debugIo('cache', 'old cache cleanup failed', e);
  }
}

// kind: 같은 기록 파일을 다른 용도로 읽는 tracker 가 각자 캐시를 갖도록 구분한다 (예: 세션 화면용, 날짜별 사용량용).
const keyOf = (path, kind) => createHash('sha1').update(`${kind}\0${path}`).digest('hex');

// 파일이 바뀌지 않고 뒤에만 붙었을 때(크기가 같거나 커졌고 inode 가 같을 때)만 캐시를 쓴다.
export function loadCache(path, kind = '') {
  try {
    const c = JSON.parse(readFileSync(join(DIR, keyOf(path, kind) + '.json'), 'utf8'));
    const st = statSync(path);
    if (c.path !== path || c.ino !== st.ino || st.size < c.offset) return null;
    return c;
  } catch (e) {
    debugIo('cache', 'cache load failed', e);
    return null;
  }
}

export function markDirty(path, snapshot, kind = '') {
  dirty.set(keyOf(path, kind), { path, build: snapshot });
}

export function flushCache() {
  if (!dirty.size) return;
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
  } catch (e) {
    debug('cache', 'cache folder create failed', e);
    return;
  }
  if (!cleaned) removeOldDirs();
  for (const [key, { path, build }] of dirty) {
    try {
      const data = build();
      if (!data) continue;
      const file = join(DIR, key + '.json');
      writeFileSync(file + '.tmp', JSON.stringify({ ...data, path, ino: statSync(path).ino }), { mode: 0o600 });
      renameSync(file + '.tmp', file);
    } catch (e) {
      debugIo('cache', 'cache write failed', e);
    }
  }
  dirty.clear();
}
