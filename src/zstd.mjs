// Codex 압축 rollout(rollout-*.jsonl.zst) 을 읽는 데 쓰는 이름 규칙과 zstd 해제 (#330).
//
// Codex CLI(openai/codex codex-rs/rollout/src/compression.rs, 2026-11-27 확인)는 시작할 때(그리고 RPC 로) 백그라운드 작업을
// 띄워 sessions/ 와 archived_sessions/ 아래의 '식은' rollout 을 zstd(레벨 3)로 압축해 같은 이름 + ".zst" 로 바꿔 둔다.
//   - 식은 기록: 수정 시각이 7일(MIN_ROLLOUT_AGE) 넘게 지난 rollout-*.jsonl. 압축 중에 바뀌면 건너뛴다.
//   - 실행 표지 파일(rollout-compression.lock)로 너무 잦은 실행을 막고(6시간), 한 번에 최대 5시간·동시 2개까지 돈다.
//   - 압축본에는 원본의 권한과 수정 시각을 그대로 옮긴 뒤 원본 .jsonl 을 지운다. 그래서 .zst 의 수정 시각도 7일 넘게 지난 값이다.
//   - 세션을 다시 이어 쓰면(resume) .jsonl 로 풀어 놓고(materialize) .zst 를 지운다. 둘이 함께 있으면 Codex 도 .jsonl 을 읽는다.
// 그래서 압축 기록은 끝난 기록이다. 실행 중 판정에는 쓰지 않고, 한 번 다 읽으면 바뀔 때(크기·수정 시각)까지 다시 풀지 않는다.
//
// node:zlib 의 zstd(zstdDecompressSync 등)는 Node v23.8.0 과 v22.15.0 에 들어왔다 (nodejs.org/api/zlib.html, Stability 1 Experimental).
// 그보다 낮은 Node(예: 22.13)에서는 압축 기록을 건너뛰고 --doctor 에 알린다.
import * as zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { debugIo } from './log.mjs';

export const ZST_SUFFIX = '.zst';
// 풀었을 때의 크기 상한. 넘는 기록은 건너뛴다 (한 번에 메모리에 올려 읽으므로).
export const ZST_MAX_BYTES = 256 * 1024 * 1024;

let decompress = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;

export const zstdAvailable = () => typeof decompress === 'function';
export const isZst = (p) => String(p).endsWith('.jsonl' + ZST_SUFFIX);
// rollout-*.jsonl 또는 rollout-*.jsonl.zst 이름인지.
export const isRolloutName = (n) => n.startsWith('rollout-') && (n.endsWith('.jsonl') || n.endsWith('.jsonl' + ZST_SUFFIX));
// 압축 이름이면 .zst 를 뗀 이름 (같은 기록을 하나로 셀 때 쓰는 키).
export const plainName = (n) => (isZst(n) ? n.slice(0, -ZST_SUFFIX.length) : n);

// 한 폴더의 이름 목록에서 rollout 만 고르고, 같은 이름의 .jsonl 이 있는 .jsonl.zst 는 뺀다 (살아 있는 .jsonl 쪽을 읽는다).
export function rolloutNames(names) {
  const set = new Set(names);
  return names.filter((n) => isRolloutName(n) && !(isZst(n) && set.has(plainName(n))));
}

// 압축 기록을 풀어 Buffer 로. zstd 가 없으면 { skip: 'nozstd' }, 상한을 넘으면 { skip: 'toolarge' }, 읽기·해제 실패는 { skip: 'error' }.
export function inflateZst(path, max = ZST_MAX_BYTES) {
  if (!zstdAvailable()) return { skip: 'nozstd' };
  try {
    return { data: decompress(readFileSync(path), { maxOutputLength: max }) };
  } catch (e) {
    debugIo('zstd', 'rollout decompress failed', e, path);
    return { skip: e?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError ? 'toolarge' : 'error' };
  }
}

// 테스트용: zstd 해제 함수를 바꿔 끼운다 (null 이면 zstd 없는 Node 처럼).
export const _test = {
  setDecompress: (fn) => (decompress = fn),
  reset: () => (decompress = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null),
};
