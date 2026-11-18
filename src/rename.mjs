// 파일 교체(rename). Windows 는 대상 파일을 다른 프로세스(백신, 함께 도는 --line)가 잠깐 잡고 있으면
// EPERM·EBUSY·EACCES 로 실패하므로 짧게 쉬었다가 다시 해 본다. 그 밖의 OS 는 예전처럼 한 번만 부른다.
import { renameSync as fsRename } from 'node:fs';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const RENAME_RETRIES = 3;
export const RENAME_WAIT_MS = 50;

// 동기로 ms 만큼 쉰다. 쓰는 곳이 모두 동기 함수라 이벤트 루프를 넘기지 않는다.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// from 을 to 로 바꾼다. 실패하면 마지막 오류를 그대로 던진다.
// platform·rename·sleep 은 테스트에서 바꿔 끼운다.
export function renameSync(from, to, { platform = process.platform, rename = fsRename, sleep = pause, retries = RENAME_RETRIES, waitMs = RENAME_WAIT_MS } = {}) {
  for (let i = 0; ; i++) {
    try {
      return rename(from, to);
    } catch (e) {
      if (platform !== 'win32' || i >= retries || !RETRY_CODES.has(e?.code)) throw e;
      sleep(waitMs);
    }
  }
}
