// 성능 기준 테스트 (#136): 고정 샘플로 aitop 의 첫 실행(빈 캐시)과 두 번째 실행(캐시 있음)의 시간·최대 메모리를 재고 기준을 넘으면 실패한다.
// 느려서 npm test 에는 넣지 않는다. 실행: npm run test:perf
//
// 기준 정하기 (BASE 아래 숫자는 측정값, 기준 = 측정값 x 배수 x AITOP_PERF_SCALE):
// - 측정 환경: WSL2 Linux 5.15, 12 코어, Node 24.11.1, 2026-11-18. 샘플은 sample.mjs 의 SAMPLE (아래 '샘플' 줄에 크기를 찍는다).
// - 시간은 node 시작을 포함한 벽시계 시간(ms), 메모리는 자식 프로세스의 process.resourceUsage().maxRSS (maxrss.mjs, MB).
// - 시간은 러너 편차(GitHub ubuntu 러너는 2 코어라 더 느릴 수 있다)를 보고 3배, 메모리는 기계 차이가 작아 1.75배로 둔다.
// - 러너가 유난히 느리면 AITOP_PERF_SCALE=2 처럼 모든 기준을 함께 늘린다. AITOP_PERF_TIME_X·AITOP_PERF_MEM_X 로 배수만 바꿀 수도 있다.
// - 샘플 규모(47MB)라 실데이터 수준의 절대 성능이 아니라 큰 상대 회귀만 잡는다.
// - 두 번째 실행은 1초 바닥 때문에 절대 기준만으로는 캐시가 통째로 무효화돼도(두 번째가 첫 실행 수준) 통과한다.
//   그래서 첫 실행 뒤 캐시 버전 폴더에 파일이 생겼는지, 두 번째 시간이 첫 실행의 CACHE_RATIO 배 이하인지도 본다.
// - 기능을 바꿔 정당하게 느려졌다면 BASE 를 새 측정값으로 고치고 이 주석의 날짜·환경도 고친다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSample, removeSample, SAMPLE } from './sample.mjs';

const BIN = fileURLToPath(new URL('../../bin/aitop.mjs', import.meta.url));
const WRAP = new URL('./maxrss.mjs', import.meta.url).href;

// 측정값 (ms, MB). 명령마다 { first: 빈 캐시, second: 캐시 있음 }. 3회 잰 값 중 큰 쪽을 반올림했다.
// 3회 측정 (ms / MB): json 첫 215·227·253 / 90·91·93, 둘째 113·117·120 / 72·74·74
//                    once 첫 239·266·273 / 97·99·105, 둘째 139·151·135 / 72·74·74
//                    daily 첫 526·502·488 / 137·155·143, 둘째 130·120·115 / 84·83·85
// 같은 기계 Node 22.22.2 3회: json 첫 231~247ms·88~90MB, once 첫 237~258ms·89~95MB, daily 첫 483~515ms·113~123MB, 둘째는 모두 113~143ms·65~72MB.
// Node 22 가 메모리를 덜 써서 기준은 Node 24 값으로 잡았다 (CI 는 Node 22 에서 돈다).
// 샘플은 파일 406개·46.9MB 로, 이슈의 실사용 측정(첫 실행 11.5초·358MB)보다 작다. 실데이터 규모가 아니라 회귀를 잡는 기준이다.
const BASE = {
  json: { first: { ms: 250, mb: 93 }, second: { ms: 120, mb: 74 } },
  once: { first: { ms: 270, mb: 105 }, second: { ms: 150, mb: 74 } },
  daily: { first: { ms: 520, mb: 155 }, second: { ms: 130, mb: 85 } },
};
const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const SCALE = num('AITOP_PERF_SCALE', 1);
const TIME_X = num('AITOP_PERF_TIME_X', 3) * SCALE;
const MEM_X = num('AITOP_PERF_MEM_X', 1.75) * SCALE;
// 수백 ms 측정값은 러너의 일시적인 멈춤에도 3배를 넘을 수 있으므로 시간 기준에 바닥(1초)을 둔다. 바닥도 AITOP_PERF_SCALE 을 따른다.
const MIN_MS = 1000 * SCALE;
const MIN_MB = 100 * SCALE;
// 두 번째 실행 시간 / 첫 실행 시간의 상한. 같은 기계 Node 22·24 각 3회 측정:
// - 캐시 있음: json 0.31~0.55, once 0.49~0.61, daily 0.24~0.29
// - 캐시 무효화를 흉내 낸 실행(OS 파일 캐시는 데워진 채 빈 aitop 캐시): 첫 실행의 0.89~1.25배 (첫 실행이 튄 1회만 0.66)
// json·once 는 둘째에도 node 시작·화면 만들기가 남아 비율이 높으므로 0.8, daily 는 0.5 로 둔다. AITOP_PERF_CACHE_X 로 함께 늘릴 수 있다.
const CACHE_X = num('AITOP_PERF_CACHE_X', 1);
const CACHE_RATIO = { json: 0.8 * CACHE_X, once: 0.8 * CACHE_X, daily: 0.5 * CACHE_X };

const sample = makeSample();
after(() => removeSample(sample));
console.log(`# 샘플: 파일 ${sample.files}개, ${(sample.bytes / 1024 / 1024).toFixed(1)}MB (Claude 세션 ${SAMPLE.claudeSessions}, 서브에이전트 ${Math.ceil(SAMPLE.claudeSessions / SAMPLE.subagentEvery) * 2}, Codex ${SAMPLE.codexSessions}, ${SAMPLE.days}일)`);
console.log(`# 배수: 시간 x${TIME_X}, 메모리 x${MEM_X} (AITOP_PERF_SCALE=${SCALE})`);

function run(args, cache) {
  const out = join(cache, `rss-${process.hrtime.bigint()}.json`);
  const env = { ...sample.env, XDG_CACHE_HOME: cache, AITOP_PERF_OUT: out };
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ['--import', WRAP, BIN, ...args], { env, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const ms = Math.round(performance.now() - t0);
  assert.equal(r.status, 0, `aitop ${args.join(' ')} status=${r.status} error=${r.error?.message ?? ''}\n${r.stderr}`);
  const mb = Math.round(JSON.parse(readFileSync(out, 'utf8')).maxRSS / 1024);
  return { ms, mb, stdout: r.stdout };
}

function cacheFilesIn(cache) {
  try {
    const root = join(cache, 'aitop');
    return readdirSync(root)
      .filter((d) => /^v\d+-/.test(d))
      .reduce((n, d) => n + readdirSync(join(root, d), { recursive: true }).length, 0);
  } catch {
    return 0;
  }
}

const CASES = [
  ['json', ['--json'], (s) => assert.ok(JSON.parse(s).sessions.some((x) => x.tool === 'claude'))],
  ['once', ['--once'], (s) => assert.match(s, /perf/)],
  ['daily', ['--report', 'daily'], (s) => assert.match(s, /^Daily usage, last 30 days/)],
];

for (const [name, args, check] of CASES) {
  test(`aitop ${args.join(' ')}: 첫 실행(빈 캐시)과 두 번째 실행의 시간·최대 메모리가 기준 안이다`, () => {
    const cache = mkdtempSync(join(sample.root, `cache-${name}-`));
    const first = run(args, cache);
    // 캐시 버전 폴더(XDG_CACHE_HOME/aitop/v<형식>-<가격표>)에 파일이 생겼는지
    const cacheFiles = cacheFilesIn(cache);
    const got = { first, second: run(args, cache) };
    check(got.first.stdout);
    const fails = [];
    if (cacheFiles === 0) fails.push(`첫 실행 뒤 ${join(cache, 'aitop')} 의 버전 폴더에 캐시 파일이 없다`);
    const ratio = got.second.ms / got.first.ms;
    console.log(`# ${name} cache: 파일 ${cacheFiles}개 · 둘째/첫 ${got.second.ms}/${got.first.ms}ms = ${ratio.toFixed(2)} (기준 ${CACHE_RATIO[name]})`);
    if (ratio > CACHE_RATIO[name]) fails.push(`두 번째 ${got.second.ms}ms 가 첫 실행 ${got.first.ms}ms 의 ${ratio.toFixed(2)}배 > ${CACHE_RATIO[name]}배 (캐시가 듣지 않는다)`);
    for (const k of ['first', 'second']) {
      const base = BASE[name][k];
      const limMs = Math.max(MIN_MS, Math.round(base.ms * TIME_X));
      const limMb = Math.max(MIN_MB, Math.round(base.mb * MEM_X));
      const { ms, mb } = got[k];
      // 실패해도 측정값이 CI 로그에 남도록 늘 찍는다.
      console.log(`# ${name} ${k}: ${ms}ms (기준 ${limMs}, 측정 ${base.ms}) · maxRSS ${mb}MB (기준 ${limMb}, 측정 ${base.mb})`);
      if (ms > limMs) fails.push(`${k} 시간 ${ms}ms > ${limMs}ms`);
      if (mb > limMb) fails.push(`${k} 메모리 ${mb}MB > ${limMb}MB`);
    }
    assert.deepEqual(fails, [], `aitop ${args.join(' ')} 기준 초과: ${fails.join(', ')}`);
  });
}
