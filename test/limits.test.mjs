// Claude 남은 사용 한도 (#332): --statusline 입력 검증·저장, 기본 줄, 사용자 명령 넘기기, 헤더·--json·--line·--doctor·도움말 표시.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

// 저장 파일 기본 위치가 빈 임시 캐시를 가리키게, 모듈을 불러오기 전에 정한다.
const root = mkdtempSync(join(tmpdir(), 'aitop-limits-'));
process.env.XDG_CACHE_HOME = join(root, 'cache');
after(() => rmSync(root, { recursive: true, force: true }));

const { LIMITS_FILE, freshLimits, limitsCheck, loadLimits, parseLimits, saveLimits, statusText, fmtLeft } = await import('../src/limits.mjs');
const { statusline, commandPlan } = await import('../src/statusline.mjs');
const { toJson, limitsJson } = await import('../src/json.mjs');
const { formatLine } = await import('../src/line.mjs');
const { toolStrip } = await import('../src/ui/table.mjs');
const { doctorText } = await import('../src/doctor.mjs');
const { settingsLine } = await import('../src/help.mjs');
const { getLang, setLang } = await import('../src/i18n.mjs');

const lang0 = getLang();
afterEach(() => setLang(lang0));
const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');

const NOW = Date.parse('2026-11-27T03:00:00Z');
const sec = (ms) => Math.floor(ms / 1000);
// 문서 예시 모양의 상태줄 입력. 저장하면 안 되는 필드를 함께 넣는다.
const sample = (over = {}) => ({
  hook_event_name: 'Status',
  session_id: 'secret-session-id-123',
  transcript_path: '/home/someone/.claude/projects/secret-project/abc.jsonl',
  cwd: '/home/someone/secret-project',
  model: { id: 'claude-opus-4-1', display_name: 'Opus' },
  workspace: { current_dir: '/home/someone/secret-project', project_dir: '/home/someone/secret-project' },
  version: '2.1.300',
  cost: { total_cost_usd: 0.01234, total_duration_ms: 45000 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: sec(NOW + 2 * 3600_000 + 10 * 60_000) },
    seven_day: { used_percentage: 41.2, resets_at: sec(NOW + 3 * 86_400_000) },
    spend_limit: { used_percentage: 62.8, resets_at: sec(NOW + 20 * 86_400_000), used_usd: 314.12, limit_usd: 500, period: 'monthly' },
  },
  ...over,
});
const fileIn = (name) => join(root, `${name}-${Math.random().toString(36).slice(2)}.json`);

test('parseLimits: 5시간·7일·지출 한도의 % 와 초기화 시각(ms)만 꺼낸다', () => {
  const l = parseLimits(sample());
  assert.deepEqual(Object.keys(l).sort(), ['fiveHour', 'sevenDay', 'spend']);
  assert.deepEqual(l.fiveHour, { pct: 23.5, resetsAt: sec(NOW + 2 * 3600_000 + 10 * 60_000) * 1000 });
  assert.equal(l.spend.pct, 62.8);
  assert.equal('used_usd' in l.spend, false);
});

test('parseLimits: 문자열·음수·100 넘는 %·이상한 시각은 받지 않는다. 맞는 창이 없으면 null', () => {
  const bad = (w) => parseLimits({ rate_limits: { five_hour: w } });
  const reset = sec(NOW + 3600_000);
  assert.equal(bad({ used_percentage: '23', resets_at: reset }), null);
  assert.equal(bad({ used_percentage: -1, resets_at: reset }), null);
  assert.equal(bad({ used_percentage: 200, resets_at: reset }), null);
  assert.equal(bad({ used_percentage: Number.NaN, resets_at: reset }), null);
  assert.equal(bad({ used_percentage: 20, resets_at: String(reset) }), null);
  assert.equal(bad({ used_percentage: 20, resets_at: reset * 1000 }), null, 'ms 로 온 시각은 단위가 틀렸다');
  assert.equal(bad({ used_percentage: 20 }), null);
  assert.equal(parseLimits({ model: { display_name: 'Opus' } }), null, '첫 응답 전에는 rate_limits 가 없다');
  assert.equal(parseLimits(null), null);
  assert.equal(parseLimits({ rate_limits: 'x' }), null);
  // 창 하나만 맞으면 그것만.
  assert.deepEqual(Object.keys(parseLimits({ rate_limits: { five_hour: { used_percentage: 200, resets_at: reset }, seven_day: { used_percentage: 0, resets_at: reset } } })), ['sevenDay']);
  // 지출 한도는 한도를 넘으면 100 을 넘을 수 있다 (문서).
  assert.equal(parseLimits({ rate_limits: { spend_limit: { used_percentage: 120, resets_at: reset } } }).spend.pct, 120);
});

test('saveLimits: 숫자·시각만 0600 파일에 원자적으로 저장하고, 다른 필드는 파일에 없다', () => {
  const file = fileIn('save');
  assert.equal(saveLimits(parseLimits(sample()), { file, now: NOW }), true);
  const raw = readFileSync(file, 'utf8');
  const got = JSON.parse(raw);
  assert.deepEqual(Object.keys(got).sort(), ['at', 'fiveHour', 'sevenDay', 'spend']);
  assert.equal(got.at, NOW);
  for (const s of ['secret', 'Opus', 'session', 'transcript', 'cost', '314', '500', 'monthly', 'cwd']) assert.equal(raw.includes(s), false, `${s} 는 저장하지 않는다`);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false, '임시 파일이 남지 않는다');
  // 같은 값이 30초 안에 다시 오면 쓰지 않고, 값이 바뀌면 쓴다.
  assert.equal(saveLimits(parseLimits(sample()), { file, now: NOW + 5_000 }), false);
  assert.equal(saveLimits({ ...parseLimits(sample()), fiveHour: { pct: 30, resetsAt: NOW + 3600_000 } }, { file, now: NOW + 6_000 }), true);
  assert.equal(loadLimits({ file }).fiveHour.pct, 30);
});

test('freshLimits: 초기화 시각이 지난 창은 빼고, 7일보다 오래된 저장값은 숨긴다', () => {
  const rec = { at: NOW, fiveHour: { pct: 10, resetsAt: NOW + 1000 }, sevenDay: { pct: 20, resetsAt: NOW + 86_400_000 } };
  assert.deepEqual(Object.keys(freshLimits(rec, NOW)), ['at', 'fiveHour', 'sevenDay']);
  assert.deepEqual(Object.keys(freshLimits(rec, NOW + 2000)), ['at', 'sevenDay']);
  assert.equal(freshLimits(rec, NOW + 86_400_000 + 1), null, '모든 창이 지났다');
  assert.equal(freshLimits({ ...rec, sevenDay: { pct: 20, resetsAt: NOW + 30 * 86_400_000 } }, NOW + 8 * 86_400_000), null, '7일 넘게 갱신이 없다');
  assert.equal(freshLimits({ ...rec, at: NOW + 60_000 }, NOW), null, '미래 시각');
  assert.equal(freshLimits(null, NOW), null);
});

test('loadLimits: 깨진 파일·손으로 고친 이상한 값은 버린다', () => {
  const file = fileIn('broken');
  writeFileSync(file, '{not json');
  assert.equal(loadLimits({ file }), null);
  writeFileSync(file, JSON.stringify({ at: NOW, fiveHour: { pct: '50', resetsAt: NOW + 1000 }, sevenDay: { pct: 20, resetsAt: NOW + 1000 } }));
  assert.deepEqual(Object.keys(loadLimits({ file })), ['at', 'sevenDay']);
  writeFileSync(file, JSON.stringify({ at: 'yesterday' }));
  assert.equal(loadLimits({ file }), null);
});

test('statusText: ASCII 기본 줄, 값이 없으면 빈 글', () => {
  assert.equal(statusText(parseLimits(sample()), NOW), '5h 24% (2h10m) | 7d 41% | spend 63%');
  assert.equal(statusText(null, NOW), '');
  assert.match(statusText(parseLimits(sample()), NOW), /^[\x20-\x7e]*$/);
  assert.equal(fmtLeft(45 * 60_000), '45m');
  assert.equal(fmtLeft(3 * 86_400_000 + 4 * 3600_000), '3d4h');
});

// statusline() 을 프로세스 안에서 돌린다. stdin 은 PassThrough, stdout·stderr 는 모아 둔다.
function sink() {
  const chunks = [];
  const w = new Writable({ write: (c, _e, cb) => (chunks.push(Buffer.from(c)), cb()) });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}
async function runStatus(argv, input, { end = true, file = fileIn('sl') } = {}) {
  const stdin = new PassThrough();
  const stdout = sink();
  const stderr = sink();
  const p = statusline(argv, { stdin, stdout, stderr, file, now: () => NOW });
  if (input != null) stdin.write(input);
  if (end) stdin.end();
  const code = await p;
  return { code, out: stdout.text(), err: stderr.text(), file };
}

test('--statusline: 입력을 저장하고 기본 줄을 낸다. rate_limits 가 없으면 빈 줄이고 파일은 그대로 둔다', async () => {
  const r = await runStatus([], JSON.stringify(sample()));
  assert.equal(r.code, 0);
  assert.equal(r.out, '5h 24% (2h10m) | 7d 41% | spend 63%\n');
  assert.equal(loadLimits({ file: r.file }).sevenDay.pct, 41.2);
  const before = readFileSync(r.file, 'utf8');
  const none = await runStatus([], JSON.stringify({ model: { display_name: 'Opus' } }), { file: r.file });
  assert.equal(none.out, '\n');
  assert.equal(readFileSync(r.file, 'utf8'), before, '값이 없으면 지우지 않는다');
  const junk = await runStatus([], 'not json', { file: r.file });
  assert.equal(junk.code, 0);
  assert.equal(readFileSync(r.file, 'utf8'), before);
});

test('--statusline: stdin 이 1초 안에 끝나지 않으면 있는 만큼으로 진행한다', async () => {
  const t0 = Date.now();
  const r = await runStatus([], JSON.stringify(sample()), { end: false });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.out, '5h 24% (2h10m) | 7d 41% | spend 63%\n');
});

test('--statusline: -- 앞에 다른 인자가 있거나 -- 뒤가 비면 사용법 오류(2)', async () => {
  assert.equal((await runStatus(['--json'], '{}')).code, 2);
  assert.equal((await runStatus(['--'], '{}')).code, 2);
});

// 가짜 사용자 상태줄 명령: stdin 을 받아 바이트 수와 모델 이름을 내고, 인자로 받은 코드로 끝난다.
const script = join(root, 'fake-status.mjs');
writeFileSync(script, `let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{const j=JSON.parse(b);process.stdout.write('['+j.model.display_name+'] '+b.length+' '+process.argv.slice(2).join(',')+'\\n');process.exit(Number(process.env.FAKE_CODE||0))});`);
const slow = join(root, 'slow-status.mjs');
writeFileSync(slow, `process.stdout.write('partial');setTimeout(()=>{},10000);`);

test('--statusline -- 명령: 같은 stdin 을 넘겨 그 출력을 그대로 내고, 저장은 이미 했다', async () => {
  const input = JSON.stringify(sample());
  const r = await runStatus(['--', process.execPath, script, 'a b', 'c'], input);
  assert.equal(r.code, 0);
  assert.equal(r.out, `[Opus] ${input.length} a b,c\n`, '인자 배열은 셸 없이 그대로 넘어간다');
  assert.equal(loadLimits({ file: r.file }).fiveHour.pct, 23.5);
});

test('--statusline -- 명령: 종료 코드를 따른다', async () => {
  process.env.FAKE_CODE = '3';
  try {
    const r = await runStatus(['--', process.execPath, script], JSON.stringify(sample()));
    assert.equal(r.code, 3);
    assert.match(r.out, /^\[Opus\]/);
  } finally {
    delete process.env.FAKE_CODE;
  }
});

test('--statusline -- 공백 있는 인자 하나는 플랫폼 셸로 실행한다', async () => {
  assert.deepEqual(commandPlan(['npx ccstatusline']), { file: 'npx ccstatusline', args: [], shell: true });
  assert.deepEqual(commandPlan(['npx', 'ccstatusline']), { file: 'npx', args: ['ccstatusline'], shell: false });
  assert.deepEqual(commandPlan(['/usr/bin/status']), { file: '/usr/bin/status', args: [], shell: false });
  const input = JSON.stringify(sample());
  const r = await runStatus(['--', `"${process.execPath}" "${script}" x`], input);
  assert.equal(r.code, 0);
  assert.equal(r.out, `[Opus] ${input.length} x\n`);
});

test('--statusline -- 명령: 2초를 넘기면 끄고 그때까지의 출력과 124 로 끝난다. 없는 명령은 127', async () => {
  const t0 = Date.now();
  const r = await runStatus(['--', process.execPath, slow], JSON.stringify(sample()));
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.code, 124);
  assert.equal(r.out, 'partial');
  assert.equal(loadLimits({ file: r.file }).fiveHour.pct, 23.5, '시간을 넘겨도 저장은 됐다');
  const miss = await runStatus(['--', join(root, 'no-such-command')], '{}');
  assert.equal(miss.code, 127);
});

// 화면·--json·--line 에 넘기는 저장값 (collect 의 limits 와 같은 모양).
const rec = (five, week, at = NOW) => ({ at, fiveHour: { pct: five, resetsAt: NOW + 2 * 3600_000 }, sevenDay: { pct: week, resetsAt: NOW + 3 * 86_400_000 } });

test('--json: limits.claude 에 사용 % 와 ISO 초기화 시각, 만료되면 null', () => {
  const data = { sessions: [], usage: null, errors: [], at: NOW, limits: rec(23.5, 41.2) };
  const j = toJson(data, '0.0.0');
  assert.deepEqual(j.limits, { claude: { fiveHour: { usedPercent: 23.5, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() }, sevenDay: { usedPercent: 41.2, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() }, at: new Date(NOW).toISOString() } });
  assert.deepEqual(toJson({ ...data, limits: null }).limits, { claude: null });
  assert.equal(limitsJson(rec(1, 2, NOW - 8 * 86_400_000), NOW), null, '7일 넘게 갱신 없음');
  assert.equal(limitsJson(rec(1, 2), NOW + 4 * 86_400_000), null, '두 창 모두 초기화 시각이 지났다');
  assert.equal(limitsJson({ ...rec(1, 2), spend: { pct: 120, resetsAt: NOW + 1000 } }, NOW).spend.usedPercent, 120);
});

test('--line: 한도가 있으면 끝에 5h23% 7d41%, 폭이 모자라면 5h 만, 더 모자라면 뺀다. 80%·95% 는 tmux 주의·경고색', () => {
  const f = (limits, o = {}) => formatLine({ today: 1.5, limits: freshLimits(limits, NOW) }, { now: NOW, ...o });
  assert.equal(f(rec(23.4, 41.2)), '$1.50 5h23% 7d41%');
  assert.equal(f(rec(23.4, 41.2), { width: 12 }), '$1.50 5h23%');
  assert.equal(f(rec(23.4, 41.2), { width: 6 }), '$1.50');
  assert.equal(f(null), '$1.50');
  assert.equal(formatLine({ limits: freshLimits(rec(5, 6), NOW) }, { now: NOW }), 'aitop idle 5h5% 7d6%', '한도만 있어도 쉬는 중은 그대로 보인다');
  assert.equal(f(rec(23, 41, NOW - 8 * 86_400_000)), '$1.50', '오래된 값은 숨긴다');
  assert.match(f(rec(85, 10), { mode: 'tmux' }), /#\[fg=colour214\]5h85% 7d10%#\[default\]$/);
  assert.match(f(rec(10, 96), { mode: 'tmux' }), /#\[fg=colour203\]5h10% 7d96%#\[default\]$/);
  assert.match(f(rec(10, 20), { mode: 'tmux' }), /#\[fg=colour250\]5h10% 7d20%#\[default\]$/);
});

const check = (tool, state, lastAt, running = 0) => ({ tool, state, path: `~/.${tool}`, records: lastAt ? 3 : 0, lastAt, running, readable: null, hint: null });
const checks = { claude: check('claude', 'ok', NOW), codex: check('codex', 'ok', NOW), gemini: check('gemini', 'ok', NOW) };
const S = (tool) => ({ tool, id: tool, live: true, updatedAt: NOW, tokens: { total: 1000 } });
const stripView = (limits, W = 100) => strip(toolStrip({ data: { sessions: [S('claude'), S('codex')], usage: null, errors: [], at: NOW, tools: { tools: checks }, limits } }, W));

test('헤더 도구 줄: Claude 옆에 5h·7d 사용 %, 좁으면 토큰 수 다음에 한도를 접는다, 만료되면 숨긴다', () => {
  setLang('ko');
  assert.match(stripView(rec(23, 41)), /^ ▍claude 1 · 1\.0k · 5h 23% · 7d 41%  ▍codex 1 · 1\.0k  gemini\s*$/);
  const mid = stripView(rec(23, 41), 48);
  assert.match(mid, /^ ▍claude 1 · 5h 23% · 7d 41%  ▍codex 1  gemini\s*$/, mid);
  const narrow = stripView(rec(23, 41), 30);
  assert.doesNotMatch(narrow, /5h/);
  assert.match(narrow, /claude 1/);
  assert.doesNotMatch(stripView(rec(23, 41, NOW - 8 * 86_400_000)), /5h/);
  // 한도가 없으면 예전과 같다.
  assert.match(stripView(null), /^ ▍claude 1 · 1\.0k  ▍codex 1 · 1\.0k  gemini\s*$/);
});

test('헤더 도구 줄: 80% 이상은 주의색, 95% 이상은 경고색 (예산 색과 같다)', async () => {
  const { BUDGET_COLOR } = await import('../src/ui/theme.mjs');
  const { line } = await import('../src/ui/draw.mjs');
  // 같은 글을 그 색으로 그린 조각이 도구 줄 안에 그대로 들어 있는지 본다 (색 코드 모양은 draw.mjs 를 따른다).
  const painted = (text, fg) => line([{ t: text, fg, bold: true }], text.length).replace(/\x1b\[0m$/, '').replace(/^\x1b\[0m/, '');
  const raw = toolStrip({ data: { sessions: [S('claude')], usage: null, errors: [], at: NOW, tools: { tools: checks }, limits: rec(85, 97) } }, 100);
  assert.ok(raw.includes(painted('85%', BUDGET_COLOR.caution)), '85% 는 주의색');
  assert.ok(raw.includes(painted('97%', BUDGET_COLOR.warn)), '97% 는 경고색');
  assert.match(strip(raw), /5h 85% · 7d 97%/);
});

test('--doctor: 상태줄 연결됨과 마지막 갱신, 없으면 넣는 방법 (ko·en)', () => {
  const base = { platform: 'linux', processes: true, tools: {} };
  const file = fileIn('doctor');
  assert.match(doctorText({ ...base, limits: limitsCheck({ file, now: NOW }) }, '0', NOW, 'ko'), /○ Claude 한도  상태줄 연결 안 됨\n.*statusLine\.command.*aitop --statusline/);
  saveLimits(parseLimits(sample()), { file, now: NOW - 3 * 60_000 });
  const c = limitsCheck({ file, now: NOW });
  assert.deepEqual({ connected: c.connected, at: c.at, fiveHour: c.fiveHour, sevenDay: c.sevenDay }, { connected: true, at: new Date(NOW - 3 * 60_000).toISOString(), fiveHour: 23.5, sevenDay: 41.2 });
  assert.match(doctorText({ ...base, limits: c }, '0', NOW, 'ko'), /✓ Claude 한도  상태줄 연결됨 · 마지막 갱신 3분 전 · 5시간 24% · 7일 41%/);
  assert.match(doctorText({ ...base, limits: c }, '0', NOW, 'en'), /✓ Claude limits  status line connected · last update 3m ago · 5h 24% · 7d 41%/);
  assert.doesNotMatch(doctorText(base, '0', NOW, 'ko'), /Claude 한도/, 'limits 를 주지 않으면 줄이 없다');
});

test('? 도움말 지금 설정: Claude 한도 연결됨/안 됨', () => {
  const s = { budgetDay: null, notify: false, debug: false };
  assert.match(settingsLine({ ...s, limitsAt: NOW - 120_000, now: NOW }, 'ko'), /Claude 한도 상태줄 연결됨 \(2분 전 갱신\)$/);
  assert.match(settingsLine({ ...s, limitsAt: null }, 'en'), /Claude limits status line not connected$/);
  assert.doesNotMatch(settingsLine(s, 'ko'), /Claude/, 'limitsAt 을 주지 않으면 예전과 같다');
});

test('저장 파일은 캐시 루트(summary.json 옆)의 claude-limits.json 이다', async () => {
  const { CACHE_ROOT } = await import('../src/cache.mjs');
  assert.equal(LIMITS_FILE, join(CACHE_ROOT, 'claude-limits.json'));
  assert.ok(LIMITS_FILE.startsWith(process.env.XDG_CACHE_HOME));
});
