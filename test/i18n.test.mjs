// 영어 화면 1/3: 언어 고르기, 문구 표, 영어 --help·--doctor·오류. 이 파일은 AITOP_LANG 고정 없이도(LANG=C) 돌아야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, LANGS, t, langOf, localeLang, pickLang, langOption, langValue, phaseText, getLang, setLang } from '../src/i18n.mjs';
import { statusText } from '../src/ui/table.mjs';
import { width } from '../src/text.mjs';
import { VIEWS, COMMON, keysText } from '../src/help.mjs';
import { readConfigFile, resolveConfig } from '../src/config.mjs';
import { toJson } from '../src/json.mjs';

const BIN = fileURLToPath(new URL('../bin/aitop.mjs', import.meta.url));
const HANGUL = /[ㄱ-ㆎ가-힣]/;
const vars = (v) => [...new Set([v, ...(typeof v === 'object' ? [v.long, v.short] : [])].filter((x) => typeof x === 'string').flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();

test('두 언어 표의 키가 같고, 같은 키는 같은 {변수} 를 쓴다', () => {
  assert.deepEqual(LANGS, ['ko', 'en']);
  const ko = Object.keys(STRINGS.ko).sort();
  const en = Object.keys(STRINGS.en).sort();
  assert.deepEqual(en, ko);
  for (const k of ko) {
    for (const lang of LANGS) {
      const v = STRINGS[lang][k];
      assert.ok(typeof v === 'string' || (v && typeof v.long === 'string'), `${lang} ${k}`);
    }
    assert.deepEqual(vars(STRINGS.en[k]), vars(STRINGS.ko[k]), k);
  }
});

test('영어 표에는 한글과 em dash 가 없다', () => {
  for (const [k, v] of Object.entries(STRINGS.en)) {
    const s = typeof v === 'string' ? v : `${v.long} ${v.short ?? ''}`;
    assert.doesNotMatch(s, HANGUL, k);
    assert.doesNotMatch(s, /\u2014/, k);
  }
});

test('t: 변수 채우기, 없는 변수는 그대로, 짧은 문구, 모르는 키', () => {
  assert.equal(t('cli.unknown', { opts: '--x' }, { lang: 'en' }), 'unknown option --x');
  assert.equal(t('cli.unknown', { opts: '--x' }, { lang: 'ko' }), '모르는 옵션 --x');
  assert.equal(t('cli.unknown', {}, { lang: 'en' }), 'unknown option {opts}');
  assert.equal(t('doctor.state.limited', null, { lang: 'en' }), 'partial support');
  assert.equal(t('doctor.state.limited', null, { lang: 'en', short: true }), 'partial');
  // 짧은 문구가 없으면 긴 문구
  assert.equal(t('doctor.state.limited', null, { lang: 'ko', short: true }), '일부 지원');
  assert.equal(t('no.such.key'), 'no.such.key');
  // 설정 예시의 { ... } 는 변수로 보지 않는다
  assert.match(t('help.usage', { logo: 'L', logPath: 'P', configPath: 'C', keys: 'K' }, { lang: 'en' }), /\{ "theme": "light"/);
});

test('로캘: ko 로 시작하면 ko, C·C.UTF-8·POSIX·en_US·없음은 en', () => {
  for (const l of ['ko', 'ko_KR', 'ko_KR.UTF-8', 'ko-KR', 'KO_kr.utf8']) assert.equal(langOf(l), 'ko', l);
  for (const l of ['C', 'C.UTF-8', 'POSIX', 'en_US.UTF-8', 'ja_JP.UTF-8', 'kok_IN', '', undefined]) assert.equal(langOf(l), 'en', String(l));
  assert.equal(localeLang({}), 'en');
  assert.equal(localeLang({ LANG: 'ko_KR.UTF-8' }), 'ko');
  assert.equal(localeLang({ LANG: 'ko_KR.UTF-8', LC_MESSAGES: 'C' }), 'en');
  assert.equal(localeLang({ LANG: 'C', LC_MESSAGES: 'ko_KR.UTF-8' }), 'ko');
  assert.equal(localeLang({ LANG: 'C', LC_MESSAGES: 'C', LC_ALL: 'ko_KR.UTF-8' }), 'ko');
  assert.equal(localeLang({ LANG: 'ko_KR.UTF-8', LC_ALL: 'C.UTF-8' }), 'en');
  // 빈 값은 없는 것으로 본다
  assert.equal(localeLang({ LANG: 'ko_KR.UTF-8', LC_ALL: '' }), 'ko');
});

test('언어 고르는 순서: --lang > AITOP_LANG > 설정 파일 > 로캘', () => {
  const env = { LANG: 'ko_KR.UTF-8' };
  assert.equal(pickLang({ env }), 'ko');
  assert.equal(pickLang({ env, file: 'en' }), 'en');
  assert.equal(pickLang({ env: { ...env, AITOP_LANG: 'ko' }, file: 'en' }), 'ko');
  assert.equal(pickLang({ env: { ...env, AITOP_LANG: 'en' }, file: 'ko' }), 'en');
  assert.equal(pickLang({ flag: 'ko', env: { LANG: 'C', AITOP_LANG: 'en' }, file: 'en' }), 'ko');
  assert.equal(pickLang({ flag: 'en', env: { AITOP_LANG: 'ko' } }), 'en');
  // 잘못된 AITOP_LANG 은 건너뛴다
  assert.equal(pickLang({ env: { AITOP_LANG: 'fr', LANG: 'ko_KR.UTF-8' } }), 'ko');
  assert.equal(pickLang({ env: {} }), 'en');
  assert.equal(langValue(' EN '), 'en');
  assert.equal(langValue('ko_KR'), undefined);
});

test('--lang 옵션: 두 모양, 뒤에 준 값, 빠진 값과 잘못된 값', () => {
  assert.deepEqual(langOption(['--once', '--lang', 'en', '--all']), { value: 'en', rest: ['--once', '--all'], error: null });
  assert.deepEqual(langOption(['--lang=ko', '--lang=en']).value, 'en');
  assert.deepEqual(langOption(['--lang']).error, ['opt.langMissing', {}]);
  assert.deepEqual(langOption(['--lang', '--once']), { value: undefined, rest: ['--once'], error: ['opt.langMissing', {}] });
  assert.deepEqual(langOption(['--lang', 'fr']).error, ['opt.langBad', { value: '"fr"' }]);
});

test('설정 lang: 출처(flag/env/file/default)와 잘못된 값', () => {
  const file = (values, problems = []) => ({ path: '/x/config.json', exists: true, values, problems });
  assert.deepEqual(resolveConfig({ env: { LANG: 'C.UTF-8' }, file: file({}) }).values.lang, { value: 'en', source: 'default' });
  assert.deepEqual(resolveConfig({ env: { LANG: 'ko_KR.UTF-8' }, file: file({}) }).values.lang, { value: 'ko', source: 'default' });
  assert.deepEqual(resolveConfig({ env: { LANG: 'C' }, file: file({ lang: 'ko' }) }).values.lang, { value: 'ko', source: 'file' });
  assert.deepEqual(resolveConfig({ env: { AITOP_LANG: 'en' }, file: file({ lang: 'ko' }) }).values.lang, { value: 'en', source: 'env' });
  assert.deepEqual(resolveConfig({ flags: { lang: 'ko' }, env: { AITOP_LANG: 'en' }, file: file({}) }).values.lang, { value: 'ko', source: 'flag' });
  const bad = resolveConfig({ env: { AITOP_LANG: 'fr' }, file: file({}) });
  assert.ok(bad.problems.some((p) => /AITOP_LANG/.test(p)));
  const dir = mkdtempSync(join(tmpdir(), 'aitop-lang-'));
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ lang: 'english' }));
  const f = readConfigFile(join(dir, 'c.json'));
  assert.equal(f.values.lang, undefined);
  assert.match(f.problems[0], /lang/);
});

test('키 안내의 짧은 이름은 모두 표에 있고, 영어 키 안내에는 한글이 없다', () => {
  const ids = new Set(Object.entries(STRINGS.ko).filter(([k]) => k.startsWith('key.')).map(([, v]) => v));
  for (const v of [...Object.values(VIEWS), COMMON]) for (const e of v.keys) assert.ok(ids.has(e[2]), e[2]);
  assert.doesNotMatch(keysText('en'), HANGUL);
  assert.match(keysText('en'), /^Keys: \/ search · /);
  assert.match(keysText('ko'), /^키: \/ 검색 · /);
});

test('--json 의 phaseKind 는 언어와 상관없는 상태 이름이고 phase 문구는 그대로다', () => {
  const data = { at: Date.now(), usage: null, sessions: [{ tool: 'claude', id: 'a', status: 'waiting', phase: { kind: 'waiting', args: { what: 'Bash' } }, members: [{ name: 'm', status: 'running', phase: { kind: 'tool', args: { what: 'Read' } } }, { name: 'n', status: 'done' }] }, { tool: 'codex', id: 'b', status: 'idle' }] };
  const j = toJson(data, '9.9.9');
  assert.equal(j.sessions[0].phase, '응답 대기 · Bash');
  assert.equal(j.sessions[0].phaseKind, 'waiting');
  assert.deepEqual(j.sessions[0].members.map((m) => [m.phase, m.phaseKind]), [['도구 실행 · Read', 'tool'], [null, null]]);
  assert.equal(j.sessions[1].phaseKind, null);
  // phaseKind 는 phase 바로 뒤에 둔다
  const keys = Object.keys(j.sessions[0]);
  assert.equal(keys[keys.indexOf('phase') + 1], 'phaseKind');
});

// 영어 화면 2/3: 상태 문구는 소스가 kind·args 만 보내고 화면이 만든다.
// 소스마다 보내는 대표 상태. [phase, 예전 한국어 phase.text, 영어 긴 문구, 영어 짧은 문구(표 STATUS 칸)]
const PHASES = [
  [{ kind: 'ended' }, '종료', 'Ended', 'Ended'],
  [{ kind: 'done' }, '완료', 'Done', 'Done'],
  [{ kind: 'unseen' }, '완료 · 확인 전', 'Done · not checked', 'Done · new'],
  [{ kind: 'idle' }, '다음 지시 대기', 'Waiting for prompt', 'Idle'],
  [{ kind: 'idle', msg: 'starting' }, '시작 중', 'Starting', 'Starting'],
  [{ kind: 'idle', msg: 'firstInput' }, '첫 입력 대기', 'Waiting for first prompt', 'Idle'],
  [{ kind: 'idle', msg: 'geminiLimited' }, '실행 중 (세부 정보 미지원)', 'Running (no details yet)', 'Running'],
  [{ kind: 'idle', msg: 'agyOldNode' }, '실행 중 (세부 정보는 Node 22.15 이상)', 'Running (details need Node 22.15+)', 'Running'],
  [{ kind: 'waiting' }, '응답 대기', 'Waiting for you', 'Waiting'],
  [{ kind: 'waiting', args: { what: 'Bash' } }, '응답 대기 · Bash', 'Waiting for you · Bash', 'Bash'],
  [{ kind: 'waiting', args: { what: 'approve Bash', agents: 1 } }, '응답 대기 · approve Bash · 에이전트 1개 실행 중', 'Waiting for you · approve Bash · agents running 1', 'approve Bash · agents 1'],
  [{ kind: 'waiting', args: { agents: 2 } }, '응답 대기 · 에이전트 2개 실행 중', 'Waiting for you · agents running 2', 'agents 2'],
  [{ kind: 'tool', msg: 'shell' }, '쉘 명령 실행 중', 'Running shell command', 'Shell'],
  [{ kind: 'tool', args: { what: 'Grep' } }, '도구 실행 · Grep', 'Running tool · Grep', 'Tool · Grep'],
  [{ kind: 'tool', msg: 'toolUnknown' }, '도구 실행 · 도구', 'Running tool', 'Tool'],
  [{ kind: 'team', args: { n: 2 } }, '팀원 2명 작업 중', 'Team working · 2', 'Team · 2'],
  [{ kind: 'think' }, '생각 중', 'Thinking', 'Thinking'],
  [{ kind: 'think', msg: 'working' }, '작업 중', 'Working', 'Working'],
  [{ kind: 'think', msg: 'steps', args: { n: 12, agents: 1 } }, '작업 중 · 12단계 · 에이전트 1개 실행 중', 'Working · step 12 · agents running 1', 'Step 12 · agents 1'],
  [{ kind: 'think', msg: 'loading', args: { pct: 42 } }, '기록 읽는 중 42%', 'Reading log 42%', 'Loading 42%'],
  [{ kind: 'write' }, '답변 작성 중', 'Writing reply', 'Writing'],
];

test('--json 의 phase 는 화면 언어와 상관없이 예전과 같은 한국어 문구다', () => {
  const before = getLang();
  try {
    for (const lang of LANGS) {
      setLang(lang);
      const sessions = PHASES.map(([phase], i) => ({ tool: 'claude', id: `s${i}`, status: 'busy', phase, members: [{ name: 'm', status: 'busy', phase }] }));
      const j = toJson({ at: Date.now(), usage: null, sessions }, '9.9.9');
      assert.deepEqual(j.sessions.map((s) => s.phase), PHASES.map((p) => p[1]), lang);
      assert.deepEqual(j.sessions.map((s) => s.members[0].phase), PHASES.map((p) => p[1]), `${lang} 팀원`);
      assert.deepEqual(j.sessions.map((s) => s.phaseKind), PHASES.map((p) => p[0].kind), `${lang} phaseKind`);
    }
  } finally {
    setLang(before);
  }
});

test('상태 문구: 한국어 표 STATUS 칸은 응답 대기 접두어만 떼고, 영어는 긴·짧은 문구가 있다', () => {
  for (const [phase, ko, long, short] of PHASES) {
    const name = JSON.stringify(phase);
    assert.equal(phaseText(phase, { lang: 'ko' }), ko, name);
    assert.equal(phaseText(phase, { lang: 'ko', short: true }), phase.kind === 'waiting' && ko !== '응답 대기' ? ko.replace(/^응답 대기 · /, '') : ko, name);
    assert.equal(phaseText(phase, { lang: 'en' }), long, name);
    assert.equal(phaseText(phase, { lang: 'en', short: true }), short, name);
    assert.ok(width(short) <= width(long), `${name} 짧은 문구가 더 길다`);
  }
  assert.equal(phaseText(undefined), '');
  assert.equal(phaseText({}), '');
});

test('표의 STATUS 칸과 상세 창의 상태 문구는 화면 언어를 따른다', () => {
  const before = getLang();
  try {
    setLang('en');
    assert.equal(statusText({ kind: 'waiting', args: { what: 'Bash' } }), 'Bash');
    assert.equal(statusText({ kind: 'idle' }), 'Idle');
    setLang('ko');
    assert.equal(statusText({ kind: 'idle' }), '다음 지시 대기');
  } finally {
    setLang(before);
  }
});

// 실제 bin. 언어 관련 환경 변수를 지우고 원하는 것만 넣는다. 설정 파일은 빈 임시 폴더.
const xdg = mkdtempSync(join(tmpdir(), 'aitop-i18n-'));
const run = (args, extra = {}) => {
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, ...extra };
  for (const k of ['AITOP_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) if (!(k in extra)) delete env[k];
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 20_000 });
};

test('LANG=C 이면 --help 는 영어다', () => {
  const r = run(['--help'], { LANG: 'C' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /aitop --once {5}print the current state once and exit/);
  assert.match(r.stdout, /aitop --lang ko\|en/);
  assert.match(r.stdout, /Keys: \/ search/);
  assert.doesNotMatch(r.stdout, HANGUL);
});

test('언어 환경 변수가 하나도 없으면 영어, C.UTF-8 도 영어', () => {
  assert.doesNotMatch(run(['--help']).stdout, HANGUL);
  assert.doesNotMatch(run(['--help'], { LANG: 'C.UTF-8' }).stdout, HANGUL);
  assert.doesNotMatch(run(['--help'], { LANG: 'POSIX' }).stdout, HANGUL);
});

test('LANG=C 의 --doctor 는 영어다', () => {
  const r = run(['--doctor'], { LANG: 'C' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /setup check/);
  assert.match(r.stdout, /config not found/);
  assert.doesNotMatch(r.stdout, HANGUL);
});

test('LANG=C 의 모르는 옵션 오류는 영어다', () => {
  const r = run(['--nope'], { LANG: 'C' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^aitop: unknown option --nope\n\n/);
  assert.doesNotMatch(r.stderr, HANGUL);
  const b = run(['--budget-day', 'abc'], { LANG: 'C' });
  assert.equal(b.status, 2);
  assert.equal(b.stderr, 'aitop: bad --budget-day value "abc" (a number above 0)\n');
  const l = run(['--lang', 'fr'], { LANG: 'C' });
  assert.equal(l.status, 2);
  assert.equal(l.stderr, 'aitop: bad --lang value "fr" (ko or en)\n');
});

test('bin 의 언어 순서: --lang > AITOP_LANG > 설정 파일 > LC_ALL > LC_MESSAGES > LANG', () => {
  const ko = (r) => /실시간 화면/.test(r.stdout);
  assert.ok(ko(run(['--help'], { LANG: 'ko_KR.UTF-8' })));
  assert.ok(!ko(run(['--help'], { LANG: 'ko_KR.UTF-8', LC_MESSAGES: 'C' })));
  assert.ok(ko(run(['--help'], { LANG: 'C', LC_MESSAGES: 'ko_KR.UTF-8' })));
  assert.ok(!ko(run(['--help'], { LANG: 'ko_KR.UTF-8', LC_ALL: 'C.UTF-8' })));
  assert.ok(ko(run(['--help'], { LANG: 'C', AITOP_LANG: 'ko' })));
  assert.ok(!ko(run(['--help'], { LANG: 'ko_KR.UTF-8', AITOP_LANG: 'en' })));
  assert.ok(ko(run(['--help', '--lang', 'ko'], { LANG: 'C', AITOP_LANG: 'en' })));
  assert.ok(!ko(run(['--lang=en', '--help'], { AITOP_LANG: 'ko' })));
  // 설정 파일 lang 은 로캘보다 앞, AITOP_LANG 보다 뒤
  const dir = mkdtempSync(join(tmpdir(), 'aitop-i18n-file-'));
  mkdirSync(join(dir, 'aitop'));
  writeFileSync(join(dir, 'aitop', 'config.json'), JSON.stringify({ lang: 'ko', nope: 1 }));
  assert.ok(ko(run(['--help'], { LANG: 'C', XDG_CONFIG_HOME: dir })));
  assert.ok(!ko(run(['--help'], { LANG: 'C', XDG_CONFIG_HOME: dir, AITOP_LANG: 'en' })));
  // 영어로 고르면 설정 파일 문제도 영어로 보인다
  const p = run(['--print-config'], { LANG: 'C', XDG_CONFIG_HOME: dir, AITOP_LANG: 'en' });
  assert.match(p.stdout, /^Config file: /);
  assert.match(p.stdout, /lang +"en" +env/);
  assert.match(p.stdout, /! ignoring unknown key "nope"/);
  assert.doesNotMatch(p.stdout, HANGUL);
  const k = run(['--print-config'], { LANG: 'C', XDG_CONFIG_HOME: dir });
  assert.match(k.stdout, /lang +"ko" +file/);
  assert.match(k.stdout, /! 모르는 키 "nope" 는 무시합니다/);
});
