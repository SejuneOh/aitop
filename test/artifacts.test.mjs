// Claude 아티팩트 목록과 링크 (#305).
// 가짜 기록에서 Artifact 게시(publish) 결과만 아티팩트별로 묶고, 서브에이전트 게시를 부모에 합치며,
// 링크는 https://claude.ai/ 주소만 OSC 8 로 감싸는지(NO_COLOR·파이프에서는 평문), 좁은 폭, --json, 저장하지 않는 값을 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const BIN = fileURLToPath(new URL('../bin/aitop.mjs', import.meta.url));
const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { CACHE_DIR, flushCache } = await import('../src/cache.mjs');
const { toJson } = await import('../src/json.mjs');
const { artifactLink, pickArtifact, mergeArtifacts, ARTIFACT_MAX } = await import('../src/sources/artifacts.mjs');
const { artifactBlock, artifactRow, rightColumn } = await import('../src/ui/detail.mjs');
const { line, segsWidth } = await import('../src/ui/draw.mjs');
const { hyperlinks, _setLinks } = await import('../src/ui/theme.mjs');
const { width } = await import('../src/text.mjs');

after(() => rmSync(dirname(fx.home), { recursive: true, force: true }));

const SECRET = {
  file: '/home/u/SECRET-FILE-PATH-305/page.html',
  edit: 'SECRET-EDIT-BODY-305',
  prompt: 'SECRET-PROMPT-305',
  resultPath: '/tmp/SECRET-RESULT-PATH-305.html',
  contract: 'SECRET-CONTRACT-305',
};
const URL_A = 'https://claude.ai/code/artifact/aaaa1111-2222-4333-8444-555566667777';
const URL_B = 'https://claude.ai/artifact/bbbb2222';
const at = (m) => new Date(Date.parse('2026-11-20T03:00:00Z') + m * 60_000).toISOString();

// Artifact 호출 줄과 그 결과 줄.
const call = (id, input, m) => ({ ...assistant(`m-${id}`, [{ type: 'tool_use', id, name: 'Artifact', input }], usage(10, 10)), timestamp: at(m) });
const result = (id, r, m, isError = false) => ({
  type: 'user',
  timestamp: at(m),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'error' : `Published ${r?.url ?? ''}`, ...(isError ? { is_error: true } : {}) }] },
  toolUseResult: r,
});
// 실제 기록 형식: version 은 '초-해시' 내부 문자열, 사람이 보는 버전 번호는 seq, audience 는 보통 'owner'.
const VERSION_STR = (seq) => `179420568${seq}-b57${seq}`;
const published = (artifactId, url, seq, extra = {}) => ({ url, title: extra.title ?? `제목 ${artifactId}`, version: VERSION_STR(seq), artifact_id: artifactId, path: SECRET.resultPath, owned: true, seq, audience: 'owner', contract: SECRET.contract, ...extra });

function mainRows() {
  return [
    user('아티팩트 만들어줘'),
    // A: v1 게시 → v2 → edits 로 v3. 같은 artifact_id 로 묶인다.
    call('t1', { file_path: SECRET.file, icon: 'chart', description: 'd' }, 1),
    result('t1', published('art-A', URL_A, 1), 2),
    call('t2', { action: 'publish', file_path: SECRET.file }, 3),
    result('t2', published('art-A', URL_A, 2), 4),
    call('t3', { action: 'publish', file_path: SECRET.file, edits: [{ old_str: 'a', new_str: SECRET.edit }] }, 5),
    result('t3', published('art-A', URL_A, 3, { editsApplied: 1 }), 6),
    // 게시가 아닌 호출은 결과에 url·title 이 있어도 빼낸다.
    call('q1', { action: 'quickstart', intent: 'other' }, 7),
    result('q1', { url: 'https://claude.ai/artifact/quick', title: 'QUICKSTART-305' }, 7),
    call('r1', { action: 'read', url: URL_B, prompt: SECRET.prompt }, 8),
    result('r1', { url: URL_B, title: 'READ-305', version: VERSION_STR(9), seq: 9, artifact_id: 'art-R' }, 8),
    call('l1', { action: 'list', limit: 5 }, 8),
    result('l1', { artifacts: [{ url: URL_B, title: 'LIST-305' }] }, 8),
    // 오류 결과는 뺀다.
    call('e1', { file_path: SECRET.file }, 9),
    result('e1', published('art-E', 'https://claude.ai/artifact/err', 1, { title: 'ERROR-305' }), 9, true),
    // B: 공개, 버전 하나.
    call('t4', { title: 'B' }, 10),
    result('t4', published('art-B', URL_B, 1, { audience: 'org', title: '공개 노트' }), 11),
    // 허용 목록 밖 주소와 제어 문자를 넣은 제목·주소.
    call('x1', {}, 12),
    result('x1', { url: 'javascript:alert(1)', title: 'JS-305', artifact_id: 'art-JS', audience: 'public' }, 12),
    call('x2', {}, 13),
    result('x2', { url: 'https://claude.ai/x\x1b]8;;http://evil.example/\x07', title: 'inj\x1b[31mected\x07 title\u009b', version: '1794205685-b571', artifact_id: 'art-INJ', audience: 'owner' }, 13),
  ];
}

const SID = 'aaaaaaaa-0305-4000-8000-000000000001';
fx.session({ sessionId: SID, name: 'art', status: 'busy' });
const transcript = fx.transcript(SID, mainRows());
// 서브에이전트가 게시한 것 (같은 A 의 v4 와 새 C).
fx.subagent(SID, 'sub1', { agentType: 'general-purpose', description: '보고서', toolUseId: 'none' }, [
  call('s1', { file_path: SECRET.file }, 20),
  result('s1', published('art-A', URL_A, 4), 21),
  call('s2', {}, 22),
  result('s2', published('art-C', 'https://claude.ai/artifact/cccc', 1, { title: '서브 결과' }), 23),
]);

const collect = () => collectClaude({ showEnded: false, budget: createBudget() }).find((s) => s.id === SID);

test('게시 결과만 artifact_id 로 묶고 버전 범위·마지막 시각을 남긴다. 게시가 아닌 호출과 오류 결과는 뺀다', () => {
  const s = collect();
  const byTitle = new Map(s.artifacts.map((a) => [a.title, a]));
  const A = s.artifacts.find((a) => a.id === 'art-A');
  assert.equal(A.from, 1);
  assert.equal(A.to, 4, '서브에이전트의 v4 까지 합친다');
  assert.equal(A.url, URL_A);
  assert.equal(A.at, Date.parse(at(21)), '마지막 게시 시각 (updated 가 없으면 결과 줄 시각)');
  const B = byTitle.get('공개 노트');
  assert.deepEqual([B.from, B.to, B.audience, B.edits], [1, 1, 'org', false]);
  for (const t of ['QUICKSTART-305', 'READ-305', 'LIST-305', 'ERROR-305']) assert.ok(!byTitle.has(t), `${t} 는 빠진다`);
  assert.equal(s.artifacts.length, 5, 'A, B, C, JS, INJ');
  assert.deepEqual(s.artifacts.map((a) => a.at), [...s.artifacts.map((a) => a.at)].sort((x, y) => y - x), '최근 순');
});

test('버전 번호는 seq 로 읽고, version 내부 문자열은 저장·비교·표시하지 않는다. seq 가 없으면 버전을 뺀다', () => {
  const s = collect();
  const A = s.artifacts.find((a) => a.id === 'art-A');
  assert.deepEqual([A.from, A.to], [1, 4]);
  for (const id of ['art-JS', 'art-INJ']) {
    const a = s.artifacts.find((x) => x.id === id);
    assert.deepEqual([a.from, a.to], [null, null], `${id}: seq 가 없다`);
    const text = artifactRow(a, 100).map((x) => x.t).join('');
    assert.doesNotMatch(text, /· v|v\?|v-|null|undefined/, text);
  }
  assert.match(artifactRow(A, 100).map((x) => x.t).join(''), /· v1→v4 ·/);
  flushCache();
  const caches = readdirSync(CACHE_DIR).map((f) => readFileSync(join(CACHE_DIR, f), 'utf8')).filter((c) => c.includes('"artifacts"'));
  const json = JSON.stringify(toJson({ sessions: [s], errors: [], at: Date.now() }, 'test').sessions[0].artifacts);
  for (const out of [json, JSON.stringify(caches.map((c) => JSON.parse(c).artifacts))]) assert.doesNotMatch(out, /179420568|b57\d/);
});

test('공유 범위: org 는 조직 공유, public 은 공개, owner 는 표시 없음. --json 은 원래 값', () => {
  const s = collect();
  const row = (id) => artifactRow(s.artifacts.find((a) => a.id === id), 120).map((x) => x.t).join('');
  assert.match(row('art-B'), /· 조직 공유$/);
  assert.doesNotMatch(row('art-B'), /공개$/);
  assert.match(row('art-JS'), /· 공개$/);
  assert.doesNotMatch(row('art-A'), /공개|조직|owner/);
  const j = toJson({ sessions: [s], errors: [], at: Date.now() }, 'test').sessions[0].artifacts;
  assert.deepEqual(j.map((a) => a.audience).sort(), ['org', 'owner', 'owner', 'owner', 'public']);
});

test('서브에이전트가 게시한 아티팩트도 부모 세션 목록에 들어간다', () => {
  const s = collect();
  const C = s.artifacts.find((a) => a.id === 'art-C');
  assert.equal(C?.title, '서브 결과');
});

test('edits 로 게시한 마지막 판은 바로 수정으로 남는다', () => {
  // 메인만 보면 A 의 마지막 게시(v3)는 edits 였다. 서브에이전트 v4 는 edits 가 아니다.
  const main = collect().artifacts.find((a) => a.id === 'art-A');
  assert.equal(main.edits, false, '합친 뒤에는 마지막 게시(서브 v4) 기준');
  const a = pickArtifact(published('x', URL_A, 3), Date.now(), true);
  assert.equal(a.edits, true);
});

test('링크 허용 목록: https://claude.ai/ 주소만, 제어 문자를 넣은 값은 링크로 쓰지 않는다', () => {
  assert.equal(artifactLink(URL_A), URL_A);
  for (const bad of ['javascript:alert(1)', 'http://claude.ai/x', 'http://evil.example/', 'https://claude.ai.evil.example/x', 'https://evil.example/https://claude.ai/', 'https://claude.ai/x\x1b]8;;http://evil/\x07', 'https://claude.ai/a b', 'https://claude.ai/"onclick', null, 42]) {
    assert.equal(artifactLink(bad), null, String(bad));
  }
  const s = collect();
  const js = s.artifacts.find((a) => a.id === 'art-JS');
  const inj = s.artifacts.find((a) => a.id === 'art-INJ');
  assert.equal(js.url, null);
  assert.equal(inj.url, null, '제어 문자를 지워 통과시키지 않는다');
  assert.equal(inj.title, 'inj[31mected title');
  assert.doesNotMatch(JSON.stringify(s.artifacts), /[\x00-\x1f\x7f-\x9f]/);
});

test('OSC 8: 링크를 켜면 허용된 주소만 감싸고, 폭은 링크 없는 줄과 같다', () => {
  const s = collect();
  const prev = _setLinks(true);
  try {
    const rows = artifactBlock(s, 100, 10).map((r) => line(r, 100));
    const all = rows.join('\n');
    const targets = [...all.matchAll(/\x1b\]8;;([^\x1b\x07]*)\x1b\\/g)].map((m) => m[1]).filter(Boolean);
    assert.ok(targets.includes(URL_A) && targets.includes(URL_B));
    for (const u of targets) assert.ok(u.startsWith('https://claude.ai/'), u);
    assert.doesNotMatch(all, /javascript:|evil/);
    const strip = (x) => x.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;]*m/g, '');
    for (const r of rows) assert.equal(width(strip(r)), 100);
    _setLinks(false);
    const off = artifactBlock(s, 100, 10).map((r) => line(r, 100)).join('\n');
    assert.doesNotMatch(off, /\x1b\]8;/);
    assert.equal(strip(off), strip(all));
  } finally {
    _setLinks(prev);
  }
});

test('링크 켜기: NO_COLOR·터미널 아님(파이프)이면 끄고, 알려진 터미널·tmux 에서 켠다', () => {
  assert.equal(hyperlinks({ NO_COLOR: '1', WT_SESSION: 'x' }, true), false);
  assert.equal(hyperlinks({ WT_SESSION: 'x' }, false), false, '파이프·파일');
  assert.equal(hyperlinks({ FORCE_HYPERLINK: '1' }, false), false, '파이프에서는 강제해도 평문');
  assert.equal(hyperlinks({ FORCE_HYPERLINK: '1' }, true), true);
  assert.equal(hyperlinks({ FORCE_HYPERLINK: '0', WT_SESSION: 'x' }, true), false);
  assert.equal(hyperlinks({ TMUX: '/tmp/tmux-1/default,1,0', TERM: 'tmux-256color' }, true), true);
  assert.equal(hyperlinks({ STY: '1.pts', TERM: 'screen' }, true), false);
  assert.equal(hyperlinks({ TERM: 'dumb', WT_SESSION: 'x' }, true), false);
  assert.equal(hyperlinks({ TERM: 'xterm-256color' }, true), false, '모르는 터미널은 평문');
  assert.equal(hyperlinks({ TERM_PROGRAM: 'WezTerm' }, true), true);
});

test('좁은 폭·한글 제목: 줄이 폭을 넘지 않고, 짧은 링크와 제목은 남는다', () => {
  const a = { id: 'k', title: '분기 매출 대시보드 아주 긴 한글 제목입니다', url: URL_A, from: 1, to: 3, at: Date.now(), audience: 'public', edits: true };
  for (const w of [24, 30, 40, 60, 80]) {
    const r = artifactRow(a, w);
    assert.ok(segsWidth(r) <= w, `${w}: ${segsWidth(r)}`);
    assert.match(r.map((x) => x.t).join(''), /분기/);
  }
  const wide = artifactRow(a, 120).map((x) => x.t).join('');
  assert.match(wide, /v1→v3/);
  assert.match(wide, /바로 수정/);
  assert.match(wide, /공개/);
  assert.match(artifactRow(a, 40).map((x) => x.t).join(''), /claude\.ai\/…/);
});

test('자리가 모자라면 최근 몇 줄과 +N, 아래 구획(최근 활동)은 밀려나지 않는다', () => {
  const s = { ...collect(), files: [] };
  const R = rightColumn(s, 70, 10, {});
  assert.match(R[0].map((x) => x.t).join(''), /아티팩트 5/);
  assert.match(R[0].map((x) => x.t).join(''), /\+2/, '10줄이면 아티팩트 3개 + 머리, 나머지는 +2');
  assert.ok(R.some((r) => r.map((x) => x.t).join('').includes('최근 활동')));
  assert.ok(R.length <= 10);
  // 아주 낮으면 구획을 그리지 않는다.
  assert.ok(!rightColumn(s, 70, 6, {}).some((r) => r.map((x) => x.t).join('').includes('── 아티팩트')));
  // 아티팩트가 없으면 구획도 없다.
  assert.ok(!rightColumn({ ...s, artifacts: [] }, 70, 20, {}).some((r) => r.map((x) => x.t).join('').includes('── 아티팩트')));
});

test('--json: 세션별 artifacts 에 제목·주소(허용 목록)·버전 범위·시각·공개·바로 수정만', () => {
  const data = { sessions: [collect()], errors: [], at: Date.now() };
  const j = toJson(data, 'test').sessions[0];
  const A = j.artifacts.find((a) => a.versionFrom === 1 && a.versionTo === 4);
  assert.deepEqual(Object.keys(A).sort(), ['audience', 'title', 'updatedAt', 'url', 'versionFrom', 'versionTo', 'viaEdits']);
  assert.equal(A.url, URL_A);
  assert.equal(A.updatedAt, at(21).replace(/\.\d+Z$/, '.000Z'));
  assert.equal(j.artifacts.find((a) => a.title === 'JS-305').url, null);
});

test('저장하지 않는 값(file_path·edits 내용·prompt·결과의 path 등)은 캐시·화면·--json 어디에도 없다', () => {
  const s = collect();
  flushCache();
  // 기록 캐시에서 이번에 더한 칸(artifacts, artCalls)만 본다. 도구 호출 한 줄 요약(events)은 예전부터 있던 칸이다.
  const caches = readdirSync(CACHE_DIR).map((f) => JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf8'))).filter((c) => 'artifacts' in c);
  assert.ok(caches.length >= 2, '메인과 서브에이전트 기록 캐시');
  const cached = JSON.stringify(caches.map((c) => [c.artifacts, c.artCalls]));
  assert.match(cached, /art-A/, '캐시에 아티팩트 목록이 있다');
  for (const c of caches) for (const a of c.artifacts) assert.deepEqual(Object.keys(a).sort(), ['at', 'audience', 'edits', 'from', 'id', 'title', 'to', 'url']);
  const json = toJson({ sessions: [s], errors: [], at: Date.now() }, 'test').sessions[0].artifacts;
  const out = [cached, JSON.stringify(json), JSON.stringify(s.artifacts)].join('\n');
  for (const v of Object.values(SECRET)) assert.ok(!out.includes(v), v);
  assert.ok(!/"(owned|seq|contract|editsApplied|liveSubscription)"/.test(JSON.stringify(s.artifacts)));
  assert.ok(transcript);
});

test('목록은 ARTIFACT_MAX 개까지, 최근 것을 남긴다', () => {
  const many = Array.from({ length: ARTIFACT_MAX + 5 }, (_, i) => ({ id: `i${i}`, title: `t${i}`, url: null, from: 1, to: 1, at: i, audience: null, edits: false }));
  const m = mergeArtifacts([many]);
  assert.equal(m.length, ARTIFACT_MAX);
  assert.equal(m[0].id, `i${ARTIFACT_MAX + 4}`);
});

test('파이프로 받는 --once 는 링크 없이 평문으로 아티팩트를 보인다 (FORCE_COLOR·FORCE_HYPERLINK 여도)', () => {
  for (const extra of [{}, { FORCE_COLOR: '1', FORCE_HYPERLINK: '1' }, { NO_COLOR: '1', FORCE_HYPERLINK: '1' }]) {
    const env = { ...process.env, COLUMNS: '120', LINES: '60', AITOP_LANG: 'ko', ...extra };
    for (const k of ['NO_COLOR', 'FORCE_COLOR', 'FORCE_HYPERLINK']) if (!(k in extra)) delete env[k];
    const r = spawnSync(process.execPath, [BIN, '--once'], { env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /\x1b\]8;/);
    r.stdout = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(r.stdout, /아티팩트 5/);
    assert.match(r.stdout, /제목 art-A · v1→v4/);
    assert.match(r.stdout, /── 아티팩트 5 ─+ \+1 ─/, '120열 60줄이면 4개와 +1');
    assert.doesNotMatch(r.stdout, /\x1b\]8;/);
  }
});
