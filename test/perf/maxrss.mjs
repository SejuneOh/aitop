// 성능 테스트가 aitop 자식 프로세스에 --import 로 넣는 파일. 종료 직전 최대 메모리(maxRSS, KB)를 AITOP_PERF_OUT 파일에 쓴다.
// process.resourceUsage() 는 Linux·macOS·Windows 모두에서 maxRSS 를 KB 단위로 준다. process.exit 로 끝나도 'exit' 는 불린다.
import { writeFileSync } from 'node:fs';

const out = process.env.AITOP_PERF_OUT;
if (out) {
  process.on('exit', () => {
    try {
      writeFileSync(out, JSON.stringify({ maxRSS: process.resourceUsage().maxRSS }));
    } catch {}
  });
}
