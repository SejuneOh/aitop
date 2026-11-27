// 큰 세션 기록을 매번 처음부터 다시 읽지 않도록, 파일별로 "어디까지 읽었고 그때 합계가 얼마였는지"를
// ~/.cache/aitop 에 저장한다. 이 프로그램이 디스크에 쓰는 곳은 여기와 --debug 때의 디버그 로그(log.mjs)뿐이다.
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import { renameSync, RENAME_RETRIES } from './rename.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { appDir } from './paths.mjs';
import { createHash } from 'node:crypto';
import { PRICE_TAG } from './pricing.mjs';
import { debug, debugIo } from './log.mjs';

// 캐시 형식이 바뀌면 VERSION 을, 가격표가 바뀌면 PRICE_TAG 가 폴더 이름을 바꿔서 예전 캐시를 버린다.
// 14: 장부의 하루 합계에 모델별 몫(models)을 더하고, 날짜를 10일이 아니라 30일 남긴다 (#128).
// 15: 세션 기록 캐시에 Artifact 게시 목록(artifacts, artCalls)을 더한다 (#305). 이미 읽은 부분의 게시를 놓치지 않게 다시 읽는다.
// 16: 15 의 첫 판(3a1eb62)이 version 을 숫자로 잘못 읽어 남긴 캐시를 버린다. 그대로 두면 업데이트 뒤에도 아티팩트 버전이 null 로 읽힌다.
// 장부(ledger)만 형식이 바뀔 때는 VERSION 대신 장부의 kind 이름을 바꿔 장부만 다시 센다 (세션 화면 캐시는 그대로).
const VERSION = 16;
// Windows 는 XDG_CACHE_HOME 이 없으면 %LOCALAPPDATA%\aitop\cache (paths.mjs).
const ROOT = appDir('cache', { home: homedir() });
export const CACHE_ROOT = ROOT;
// claude -p 실행의 기억된 부모 (sources/claude.mjs knownParents). 버전 폴더 밖에 두고 removeOldDirs 가 지우지 않는다.
export const PARENTS_FILE = 'sdk-parents.json';
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
      // monthly.json(월별 보관함, monthly.mjs)과 깨져서 옆으로 옮긴 monthly.json.bad-* 도 사용자 기록이라 지우지 않는다.
      // sdk-parents.json(claude -p 실행의 기억된 부모)도 형식 버전과 상관없이 남긴다.
      // claude-limits.json(--statusline 이 저장한 Claude 한도, limits.mjs)도 남긴다. 오래된 값은 읽는 쪽이 숨긴다.
      if (d === NAME || d === 'summary.json' || d === 'claude-limits.json' || d === 'monthly.json' || d === PARENTS_FILE || d.startsWith('monthly.json.bad-')) continue;
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
  // 교체가 재시도 뒤에도 실패하면(권한 등 계속되는 오류) 이번 저장의 남은 파일은 재시도 없이 한 번만 해 본다.
  // 파일마다 재시도로 멈추는 시간이 쌓이지 않게 한다 (Windows, #198).
  let retries = RENAME_RETRIES;
  for (const [key, { path, build }] of dirty) {
    try {
      const data = build();
      if (!data) continue;
      const file = join(DIR, key + '.json');
      writeFileSync(file + '.tmp', JSON.stringify({ ...data, path, ino: statSync(path).ino }), { mode: 0o600 });
      try {
        renameSync(file + '.tmp', file, { retries });
      } catch (e) {
        retries = 0;
        throw e;
      }
    } catch (e) {
      debugIo('cache', 'cache write failed', e);
    }
  }
  dirty.clear();
}
