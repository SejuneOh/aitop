// 아티팩트 원본을 빨리 열기 (#307): 기록을 읽는 tracker 가 메모리에 기억한 위치(경로, Write 결과 줄의 오프셋)만 읽고 기록을 다시 훑지 않는지,
// 기억한 줄이 바뀌면(기록이 다시 쓰임) 훑어서 다시 찾는지, 위치를 모르면 '찾는 중…' 을 먼저 보이고 뒤에서 나눠 훑는지, 큰 기록에서 열기 시간을 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { makeClaudeHome } from './fixture.mjs';

const fx = makeClaudeHome();
const { ClaudeTracker } = await import('../src/sources/claude-tracker.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { loadArtifactSource, quickSource, openArtifactSource } = await import('../src/sources/artifact-source.mjs');
const { onKey, KEY } = await import('../src/keys.mjs');
const { CACHE_DIR, flushCache } = await import('../src/cache.mjs');

after(() => rmSync(dirname(fx.home), { recursive: true, force: true }));

const ts = (m) => new Date(Date.parse('2026-11-20T03:00:00Z') + m * 60_000).toISOString();
const call = (id, name, input, m) => ({ type: 'assistant', timestamp: ts(m), message: { id: `m-${id}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, r, m) => ({ type: 'user', timestamp: ts(m), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: r });
// 20MB 쯤 되는 큰 기록을 흉내 내는 채움 줄.
const filler = (n, m) => Array.from({ length: n }, (_, i) => ({ type: 'system', timestamp: ts(m), content: `pad-${i}-${'x'.repeat(10_000)}` }));
const HTML = join(dirname(fx.home), 'gone', 'report.html');
const BODY = '<h1>기록 본문 307</h1><p>빠르게 연다</p>';
const ART = { id: 'art-fast', title: '빠른 보고서' };

function rows({ edit = false } = {}) {
  return [
    call('w1', 'Write', { file_path: HTML, content: BODY }, 1),
    result('w1', { type: 'create', filePath: HTML, content: BODY, structuredPatch: [] }, 2),
    ...filler(2000, 3),
    call('p1', 'Artifact', { file_path: HTML }, 4),
    result('p1', { url: 'https://claude.ai/artifact/fast307', title: '빠른 보고서', artifact_id: 'art-fast', path: HTML, seq: 1 }, 5),
    ...(edit ? [call('p2', 'Artifact', { action: 'publish', file_path: HTML, edits: [{ old_str: 'a', new_str: 'b' }] }, 6), result('p2', { url: 'https://claude.ai/artifact/fast307', artifact_id: 'art-fast', path: HTML, seq: 2 }, 7)] : []),
  ];
}

function tracked(sid, opts) {
  const log = fx.transcript(sid, rows(opts));
  const t = new ClaudeTracker(log);
  while (t.update(createBudget())) {}
  return { log, t };
}

// node:fs 의 readSync 로 읽은 바이트를 센다 (ESM 이름 가져오기에도 걸리게 syncBuiltinESMExports).
function countReads(fn) {
  const orig = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => {
    const n = orig(...args);
    bytes += n;
    return n;
  };
  syncBuiltinESMExports();
  try {
    return { value: fn(), bytes };
  } finally {
    fs.readSync = orig;
    syncBuiltinESMExports();
  }
}

test('위치를 기억하면 열 때 기록을 다시 훑지 않고 그 줄만 읽는다 (20MB 기록)', () => {
  const { log, t } = tracked('fast-1');
  assert.ok(fs.statSync(log).size > 20 * 1000 * 1000, '20MB 넘는 가짜 기록');
  assert.ok(t.artPaths.has('art-fast'));
  assert.equal(t.writes.get(HTML).length > 0, true);
  const started = performance.now();
  const { value: doc, bytes } = countReads(() => loadArtifactSource({ logs: [log] }, ART));
  const ms = performance.now() - started;
  assert.equal(doc.kind, 'record');
  assert.equal(doc.text, BODY);
  assert.equal(doc.changed, false);
  assert.ok(bytes < 64 * 1024, `읽은 바이트 ${bytes}`);
  assert.ok(ms < 300, `열기 ${ms.toFixed(0)}ms`);
  // 본문은 메모리에 들지 않고 위치만 든다.
  assert.ok(!JSON.stringify([...t.writes]).includes('기록 본문 307'));
});

test('기억한 위치는 캐시 파일에 쓰지 않는다', () => {
  tracked('fast-cache');
  flushCache();
  const all = fs.readdirSync(CACHE_DIR).map((f) => fs.readFileSync(join(CACHE_DIR, f), 'utf8')).join('\n');
  assert.ok(all.includes('art-fast'), '아티팩트 목록은 캐시에 있다');
  for (const k of ['artPaths', 'writes', 'edited', 'artFiles', 'srcFrom']) assert.ok(!all.includes(`"${k}"`), k);
  // 경로는 예전부터 있던 도구 한 줄 요약(events)에만 있고, 아티팩트 칸에는 없다.
  const arts = JSON.stringify(fs.readdirSync(CACHE_DIR).map((f) => JSON.parse(fs.readFileSync(join(CACHE_DIR, f), 'utf8'))).map((c) => [c.artifacts, c.artCalls]));
  assert.ok(!arts.includes('report.html'));
});

test('Write 뒤 Artifact edits 는 기억한 위치에서도 게시본과 다를 수 있다고 알린다', () => {
  const { log } = tracked('fast-edit', { edit: true });
  const doc = quickSource({ logs: [log] }, ART);
  assert.equal(doc.kind, 'record');
  assert.equal(doc.changed, true);
});

test('오프셋이 가리키는 줄이 바뀌었으면(기록이 다시 쓰임) 기억한 위치를 버리고 훑어서 다시 찾는다', () => {
  const { log } = tracked('fast-2');
  // tracker 는 그대로 두고 기록 앞에 줄을 끼워 다시 쓴다. 기억한 오프셋은 다른 줄을 가리킨다.
  const text = fs.readFileSync(log, 'utf8');
  writeFileSync(log, JSON.stringify({ type: 'system', timestamp: ts(0), content: 'inserted line shifts offsets' }) + '\n' + text);
  assert.equal(quickSource({ logs: [log] }, ART), null);
  const doc = loadArtifactSource({ logs: [log] }, ART);
  assert.equal(doc.kind, 'record');
  assert.equal(doc.text, BODY);
});

test('위치를 모르면(이 기록을 읽는 tracker 가 없음) 먼저 찾는 중을 보이고, 뒤에서 나눠 훑은 뒤 바꾼다', async () => {
  const { log } = tracked('fast-3');
  // tracker 가 모르는 같은 내용의 기록 (캐시에서 이어 읽어 앞부분을 모르는 경우와 같다).
  const copy = join(dirname(log), 'copy-untracked.jsonl');
  copyFileSync(log, copy);
  const s = { tool: 'claude', id: 'S', name: 'demo', cwd: '/work/demo', status: 'busy', live: true, phase: { kind: 'think' }, updatedAt: Date.now(), tokens: { total: 1 }, context: {}, members: [], events: [], files: [], artifacts: [ART], logs: [copy] };
  const view = { data: { sessions: [s], usage: null, errors: [], at: Date.now() }, selectedId: 'S', showDetail: true, frame: 0, focus: null };
  let redraws = 0;
  const done = new Promise((resolve) => {
    const act = {
      redraw() {
        redraws++;
        resolve();
      },
    };
    onKey(view, 'v', act);
    const started = performance.now();
    onKey(view, KEY.enter, act);
    const ms = performance.now() - started;
    assert.equal(view.focus, 'artifact');
    assert.equal(view.artDoc.kind, 'loading', '먼저 찾는 중');
    assert.ok(ms < 200, `Enter 가 막지 않는다 (${ms.toFixed(0)}ms)`);
  });
  await done;
  assert.equal(redraws, 1);
  assert.equal(view.artDoc.kind, 'record');
  assert.equal(view.artDoc.text, BODY);
});

test('훑는 동안 다른 곳으로 가면 그만두고 화면을 바꾸지 않는다', async () => {
  const { log } = tracked('fast-4');
  const copy = join(dirname(log), 'copy-cancel.jsonl');
  copyFileSync(log, copy);
  let finished = false;
  let stop = false;
  const doc = openArtifactSource({ logs: [copy] }, ART, { cancelled: () => stop, done: () => (finished = true) });
  assert.equal(doc, null);
  stop = true;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(finished, false);
});

// 상한(1024)을 넘는 다른 경로 기록으로 앞쪽 기억을 밀어낸다.
const others = (kind, n, m) =>
  Array.from({ length: n }, (_, i) => {
    const p = join(dirname(fx.home), 'many', `f${i}.txt`);
    return kind === 'write'
      ? [call(`ow${i}`, 'Write', { file_path: p, content: 'x' }, m), result(`ow${i}`, { type: 'create', filePath: p, content: 'x', structuredPatch: [] }, m)]
      : [call(`oe${i}`, 'Edit', { file_path: p }, m), result(`oe${i}`, { filePath: p, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }, m)];
  }).flat();
const publishRows = [call('p1', 'Artifact', { file_path: HTML }, 40), result('p1', { url: 'https://claude.ai/artifact/fast307', title: '빠른 보고서', artifact_id: 'art-fast', path: HTML, seq: 1 }, 41)];
const writeHtml = [call('w1', 'Write', { file_path: HTML, content: BODY }, 1), result('w1', { type: 'create', filePath: HTML, content: BODY, structuredPatch: [] }, 2)];

function readAll(log) {
  const t = new ClaudeTracker(log);
  while (t.update(createBudget())) {}
  return t;
}

test('상한을 넘겨 Write 기억이 밀려나면 원본 없음으로 답하지 않고 훑기로 넘긴다', () => {
  const log = fx.transcript('fast-lost-w', [...writeHtml, ...others('write', 1100, 3), ...publishRows]);
  const t = readAll(log);
  assert.equal(t.srcLost, true);
  assert.equal(quickSource({ logs: [log] }, ART), null);
  const doc = loadArtifactSource({ logs: [log] }, ART);
  assert.equal(doc.kind, 'record');
  assert.equal(doc.text, BODY);
});

test('상한을 넘겨 고친 기록(edited)이 밀려나면 고친 적 없음을 믿지 않고 훑어서 경고를 찾는다', () => {
  const editHtml = [call('e1', 'Edit', { file_path: HTML }, 3), result('e1', { filePath: HTML, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }, 3)];
  const log = fx.transcript('fast-lost-e', [...writeHtml, ...editHtml, ...others('edit', 1100, 4), ...publishRows]);
  const t = readAll(log);
  assert.equal(t.srcLost, true);
  assert.equal(t.edited.has(HTML), false, 'HTML 의 고친 시각은 밀려났다');
  assert.equal(quickSource({ logs: [log] }, ART), null);
  const doc = loadArtifactSource({ logs: [log] }, ART);
  assert.equal(doc.kind, 'record');
  assert.equal(doc.changed, true);
});

// ── 게시 시각을 보는 '게시본과 다를 수 있음' (#307 리뷰) ──
// 빠른 경로(기억한 위치)와 훑기 결과가 같은지 함께 본다. 훑기는 tracker 가 모르는 복사본 기록으로 돌린다.
const wr = (id, path, content, m) => [call(id, 'Write', { file_path: path, content }, m), result(id, { type: 'update', filePath: path, content, structuredPatch: [] }, m)];
const ed = (id, path, m) => [call(id, 'Edit', { file_path: path }, m), result(id, { filePath: path, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }, m)];
const pub = (id, path, m) => [call(id, 'Artifact', { file_path: path }, m), result(id, { url: 'https://claude.ai/artifact/fast307', title: '빠른 보고서', artifact_id: 'art-fast', path, seq: 1 }, m)];

function both(sid, list) {
  const log = fx.transcript(sid, list);
  readAll(log);
  const copy = join(dirname(log), `${sid}-scan.jsonl`);
  copyFileSync(log, copy);
  return { quick: quickSource({ logs: [log] }, ART), scan: loadArtifactSource({ logs: [copy] }, ART), all: loadArtifactSource({ logs: [log] }, ART) };
}
const pick = (d) => d && { kind: d.kind, text: d.kind === 'record' ? d.text : undefined, changed: d.changed };

test('기록 본문: Write(A) → 게시 → Write(B) 면 게시 전 본문 A 와 게시본과 다를 수 있음 (빠른 경로·훑기 같음)', () => {
  const { quick, scan } = both('pub-1', [...wr('w1', HTML, 'A-본문', 1), ...pub('p1', HTML, 2), ...wr('w2', HTML, 'B-본문', 3)]);
  assert.deepEqual(pick(scan), { kind: 'record', text: 'A-본문', changed: true });
  assert.deepEqual(pick(quick), pick(scan));
});

test('기록 본문: Write(A) → 게시 → Edit 이면 다를 수 있음, 게시 뒤 아무것도 없으면 같음', () => {
  const e = both('pub-2', [...wr('w1', HTML, 'A-본문', 1), ...pub('p1', HTML, 2), ...ed('e1', HTML, 3)]);
  assert.deepEqual(pick(e.scan), { kind: 'record', text: 'A-본문', changed: true });
  assert.deepEqual(pick(e.quick), pick(e.scan));
  const n = both('pub-3', [...wr('w1', HTML, 'A-본문', 1), ...pub('p1', HTML, 2)]);
  assert.deepEqual(pick(n.scan), { kind: 'record', text: 'A-본문', changed: false });
  assert.deepEqual(pick(n.quick), pick(n.scan));
});

test('기록 본문: 게시 전 Write 가 없고 게시 뒤 Write 만 있으면 그 본문을 쓰되 다를 수 있음', () => {
  const { quick, scan, all } = both('pub-4', [...pub('p1', HTML, 1), ...wr('w1', HTML, 'B-본문', 2)]);
  assert.deepEqual(pick(scan), { kind: 'record', text: 'B-본문', changed: true });
  // 빠른 경로는 게시 전 Write 를 모르므로 훑기로 넘긴다. 최종 결과는 같다.
  assert.equal(quick, null);
  assert.deepEqual(pick(all), pick(scan));
});

test('로컬 파일: 마지막 게시 뒤 같은 경로의 Write·Edit 가 있으면 다를 수 있음, 없으면 같음', () => {
  const LOCAL = join(dirname(fx.home), 'local-report.html');
  writeFileSync(LOCAL, '<p>로컬</p>');
  const cases = [
    ['loc-1', [...wr('w1', LOCAL, 'A', 1), ...pub('p1', LOCAL, 2), ...wr('w2', LOCAL, 'B', 3)], true],
    ['loc-2', [...wr('w1', LOCAL, 'A', 1), ...pub('p1', LOCAL, 2), ...ed('e1', LOCAL, 3)], true],
    ['loc-3', [...wr('w1', LOCAL, 'A', 1), ...ed('e1', LOCAL, 2), ...pub('p1', LOCAL, 3)], false],
  ];
  for (const [sid, list, changed] of cases) {
    const { quick, scan } = both(sid, list);
    assert.deepEqual(pick(scan), { kind: 'local', text: undefined, changed }, sid);
    assert.deepEqual(pick(quick), pick(scan), sid);
  }
});

test('게시 결과를 받으면 게시 호출의 file_path 기억을 지운다 (게시가 많아도 상한에 걸리지 않는다)', () => {
  const list = Array.from({ length: 1100 }, (_, i) => pub(`pp${i}`, HTML, 1)).flat();
  const log = fx.transcript('many-pub', list);
  const t = readAll(log);
  assert.equal(t.artFiles.size, 0);
  assert.equal(t.srcLost, false);
});

test('경로 키: Windows 는 구분자와 대소문자를 맞추고, 다른 OS 는 그대로', async () => {
  const { pathKey } = await import('../src/sources/artifacts.mjs');
  assert.equal(pathKey('C:/Users/Dev/Report.HTML', 'win32'), pathKey('c:\\users\\dev\\report.html', 'win32'));
  assert.equal(pathKey('C:\\a\\.\\b\\x.html', 'win32'), pathKey('c:\\a\\b\\X.html', 'win32'));
  assert.notEqual(pathKey('/tmp/A.html', 'linux'), pathKey('/tmp/a.html', 'linux'));
  assert.equal(pathKey('/tmp/a.html', 'darwin'), '/tmp/a.html');
  assert.equal(pathKey(null, 'win32'), null);
});
