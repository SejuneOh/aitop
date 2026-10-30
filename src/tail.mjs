// JSONL 파일을 청크 단위로 따라 읽는다. 한 번에 읽는 양을 budget 으로 제한해서, 큰 파일을 처음 읽을 때도
// 화면 갱신과 키 입력이 멈추지 않게 한다. 원본은 읽기 전용으로만 연다.
import { openSync, readSync, closeSync, statSync } from 'node:fs';

const CHUNK = 1 << 20;
const NL = 0x0a;

// 한 번의 갱신(틱) 동안 모든 파일이 나눠 쓰는 읽기 한도.
export function createBudget(bytes = Infinity) {
  return { left: bytes };
}

export class JsonlTail {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    // 아직 줄바꿈이 오지 않은 뒷부분. 청크 경계에서 한글 같은 여러 바이트 문자가 잘려도 깨지지 않게 바이트로 둔다.
    this.rest = Buffer.alloc(0);
    this.mtimeMs = 0;
    this.size = 0;
  }

  // 완성된 줄까지 읽은 위치. 캐시에 저장해 두고 다음 실행에서 여기서부터 읽는다.
  get lineOffset() {
    return this.offset - this.rest.length;
  }

  get done() {
    return this.offset >= this.size;
  }

  get progress() {
    return this.size ? Math.min(1, this.offset / this.size) : 1;
  }

  // 새로 붙은 줄을 onLine 으로 하나씩 넘긴다. 읽은 줄 수를 돌려준다.
  read(onLine, budget = createBudget()) {
    let st;
    try {
      st = statSync(this.path);
    } catch {
      return 0;
    }
    this.mtimeMs = st.mtimeMs;
    this.size = st.size;
    if (st.size < this.offset) {
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    if (st.size === this.offset || budget.left <= 0) return 0;

    let count = 0;
    const fd = openSync(this.path, 'r');
    const buf = Buffer.alloc(CHUNK);
    try {
      while (this.offset < st.size && budget.left > 0) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, st.size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        budget.left -= n;
        const data = this.rest.length ? Buffer.concat([this.rest, buf.subarray(0, n)]) : buf.subarray(0, n);
        const end = data.lastIndexOf(NL);
        if (end < 0) {
          this.rest = Buffer.from(data);
          continue;
        }
        this.rest = Buffer.from(data.subarray(end + 1));
        for (const line of data.toString('utf8', 0, end).split('\n')) {
          if (!line) continue;
          let x;
          try {
            x = JSON.parse(line);
          } catch {
            continue;
          }
          onLine(x);
          count++;
        }
      }
    } finally {
      closeSync(fd);
    }
    return count;
  }
}
