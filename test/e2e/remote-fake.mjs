// --remote e2e 용 가짜 원격 (#308). AITOP_REMOTE_FAKE 로 이 스크립트를 주면 aitop 이 ssh·wsl.exe 대신
// node remote-fake.mjs <ssh|wsl> <대상> aitop --json --no-remote 로 부른다. 대상 이름으로 흉내 낼 일을 고른다.
// 셸을 거치지 않으므로 Windows 에서도 같다.
import { appendFileSync } from 'node:fs';

const [kind, target, ...rest] = process.argv.slice(2);
// 불렸는지와 pid 를 남긴다 (끝낼 때 자식을 죽이는지, --doctor 가 접속하지 않는지 확인용).
if (process.env.AITOP_REMOTE_FAKE_MARK) appendFileSync(process.env.AITOP_REMOTE_FAKE_MARK, `${target} ${process.pid}\n`);
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const session = (id, extra = {}) => ({
  tool: 'claude',
  id,
  name: `원격 ${id}`,
  project: 'remote-proj',
  cwd: "/srv/it's here",
  branch: 'main',
  model: 'claude-opus-4-5',
  kind: 'interactive',
  live: true,
  status: 'idle',
  phase: '다음 지시 대기',
  phaseKind: 'idle',
  startedAt: iso(now - 600_000),
  updatedAt: iso(now - 5_000),
  tokens: { total: 1500, input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 },
  cost: 0.5,
  costNoCache: 0.4,
  context: { used: 1000, window: 200000 },
  files: [{ path: '/srv/app/a.mjs', created: false, edits: 2, writtenLines: 3, deletedLines: 1, updatedAt: iso(now - 30_000), agents: [] }],
  artifacts: [{ title: '원격 문서', url: 'https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000001', versionFrom: 1, versionTo: 2, updatedAt: iso(now - 20_000), audience: 'owner', viaEdits: false }],
  members: [],
  // 받는 쪽이 버려야 하는 필드.
  resumeCmd: 'rm -rf /',
  waitDetail: 'secret',
  pid: 4242,
  ...extra,
});

const out = (obj) => process.stdout.write(JSON.stringify(obj));

switch (target) {
  case 'slow':
    setTimeout(() => {}, 60_000);
    break;
  case 'broken':
    process.stdout.write('{"version": "0.40.0", "sessions": [');
    break;
  case 'missing':
    process.stderr.write('sh: aitop: command not found\n');
    process.exit(127);
    break;
  case 'old':
    process.stderr.write('aitop: unknown option --no-remote\n');
    process.exit(2);
    break;
  case 'noschema':
    out({ version: '0.39.0', sessions: [] });
    break;
  case 'newer':
    out({ version: '9.0.0', schema: 99, sessions: [] });
    break;
  default:
    // 받은 인자를 세션 이름에 남겨 argv 모양을 확인할 수 있게 한다.
    out({
      version: '0.41.0',
      schema: 1,
      usage: { today: { cost: 999 } },
      sessions: [
        session('11111111-1111-4111-8111-111111111111', { name: `args ${kind} ${target} ${rest.join(' ')}` }),
        session('22222222-2222-4222-8222-222222222222', { name: 'waiting\x1b[31m red', status: 'waiting', phase: '응답 대기 · Bash', phaseKind: 'waiting', waitingFor: 'Bash' }),
      ],
    });
}
