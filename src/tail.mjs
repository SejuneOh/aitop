// JSONL 파일을 처음부터 한 번 읽고, 이후에는 새로 붙은 줄만 읽는다. 원본은 읽기 전용으로만 연다.
import { openSync, readSync, closeSync, statSync } from 'node:fs';

const CHUNK = 1 << 20;

export class JsonlTail {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    this.rest = '';
    this.mtimeMs = 0;
  }

  read() {
    let st;
    try {
      st = statSync(this.path);
    } catch {
      return [];
    }
    this.mtimeMs = st.mtimeMs;
    if (st.size < this.offset) {
      this.offset = 0;
      this.rest = '';
    }
    if (st.size === this.offset) return [];

    const fd = openSync(this.path, 'r');
    const buf = Buffer.alloc(CHUNK);
    let text = this.rest;
    try {
      while (this.offset < st.size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, st.size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        text += buf.toString('utf8', 0, n);
      }
    } finally {
      closeSync(fd);
    }

    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  }
}
