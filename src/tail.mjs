// JSONL 파일을 청크 단위로 따라 읽는다. 한 번에 읽는 양을 budget 으로 제한해서, 큰 파일을 처음 읽을 때도
// 화면 갱신과 키 입력이 멈추지 않게 한다. 원본은 읽기 전용으로만 연다.
import { openSync, readSync, closeSync, statSync } from 'node:fs';

const CHUNK = 1 << 20;
const NL = 0x0a;

// 한 번의 갱신(틱) 동안 모든 파일이 나눠 쓰는 읽기 한도. 바이트와 시간(ms) 중 먼저 닿는 쪽에서 멈춘다.
// 한도 때문에 덜 읽은 파일이 있으면 exhausted 가 true 가 되어, 부르는 쪽이 곧바로 이어 읽을 수 있다.
// 시간 한도는 이번 틱에 한 청크라도 읽은 뒤부터 본다. 파일 목록·세션 정보 읽기 같은 고정 작업이 한도를 넘어도 매 틱 조금씩은 앞으로 간다.
export function createBudget(bytes = Infinity, ms = Infinity) {
  return { left: bytes, deadline: Number.isFinite(ms) ? Date.now() + ms : Infinity, exhausted: false, read: 0 };
}

const outOf = (budget) => budget.left <= 0 || (budget.read > 0 && Date.now() >= (budget.deadline ?? Infinity));

export class JsonlTail {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    // 아직 줄바꿈이 오지 않은 뒷부분 조각들. 청크 경계에서 한글 같은 여러 바이트 문자가 잘려도 깨지지 않게 바이트로 두고,
    // 아주 긴 줄도 조각을 모아 두었다가 줄바꿈이 올 때 한 번만 합친다.
    this.rest = [];
    this.restLength = 0;
    this.mtimeMs = 0;
    this.size = 0;
  }

  // 완성된 줄까지 읽은 위치. 캐시에 저장해 두고 다음 실행에서 여기서부터 읽는다.
  get lineOffset() {
    return this.offset - this.restLength;
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
    // 파일이 줄었으면(새로 쓰임) 처음부터 다시 읽는다. 누적값을 들고 있는 쪽은 onReset 에서 비워야 두 번 더하지 않는다.
    if (st.size < this.offset) {
      this.offset = 0;
      this.rest = [];
      this.restLength = 0;
      this.onReset?.();
    }
    if (st.size === this.offset) return 0;
    if (outOf(budget)) {
      budget.exhausted = true;
      return 0;
    }

    let count = 0;
    const fd = openSync(this.path, 'r');
    const buf = Buffer.alloc(CHUNK);
    try {
      while (this.offset < st.size) {
        if (outOf(budget)) {
          budget.exhausted = true;
          break;
        }
        const n = readSync(fd, buf, 0, Math.min(CHUNK, st.size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        budget.left -= n;
        budget.read = (budget.read ?? 0) + n;
        const chunk = buf.subarray(0, n);
        const end = chunk.lastIndexOf(NL);
        if (end < 0) {
          this.rest.push(Buffer.from(chunk));
          this.restLength += n;
          continue;
        }
        const data = this.restLength ? Buffer.concat([...this.rest, chunk.subarray(0, end)]) : chunk.subarray(0, end);
        this.rest = end + 1 < n ? [Buffer.from(chunk.subarray(end + 1))] : [];
        this.restLength = n - end - 1;
        for (const line of data.toString('utf8').split('\n')) {
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
