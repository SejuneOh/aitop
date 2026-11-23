// 아티팩트 원본을 터미널에서 보기 (#307).
// 원본 찾기 순서(로컬 파일 → 기록의 마지막 Write 본문 → 원본 없음), 심볼릭 링크·폴더·큰 파일, Write 뒤 Edit·edits 경고,
// html 을 글로 바꾸기(script·style 제거, 표, 목록, 엔티티, data URI 크기, 제어 문자, 깨진 html), 키 이동(v·Enter·Esc), 좁은 폭을 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArtifactSource, readLocal, SOURCE_MAX } from '../src/sources/artifact-source.mjs';
import { htmlToBlocks, mdToBlocks, renderBlocks, artifactScreen, fmtBytes } from '../src/ui/artifact-view.mjs';
import { onKey, fixFocus, KEY } from '../src/keys.mjs';
import { render } from '../src/ui.mjs';
import { helpContext, keysLine } from '../src/help.mjs';
import { width } from '../src/text.mjs';
import { segsWidth } from '../src/ui/draw.mjs';

const dir = mkdtempSync(join(tmpdir(), 'aitop-307-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const ts = (m) => new Date(Date.parse('2026-11-20T03:00:00Z') + m * 60_000).toISOString();
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// 기록 줄: 도구 호출과 결과.
const call = (id, name, input, m) => ({ type: 'assistant', timestamp: ts(m), message: { id: `m-${id}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, r, m) => ({ type: 'user', timestamp: ts(m), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: r });
const publish = (id, path, seq, m, input = {}) => [call(id, 'Artifact', { file_path: path, ...input }, m), result(id, { url: 'https://claude.ai/artifact/abc307', title: '보고서', artifact_id: 'art-307', path, seq, version: `1-${seq}` }, m + 1)];
const write = (id, path, content, m, type = 'create') => [call(id, 'Write', { file_path: path, content }, m), result(id, { type, filePath: path, content, structuredPatch: [] }, m + 1)];
const edit = (id, path, m) => [call(id, 'Edit', { file_path: path, old_string: 'a', new_string: 'b' }, m), result(id, { filePath: path, oldString: 'a', newString: 'b', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }, m + 1)];

const ART = { id: 'art-307', title: '보고서', url: 'https://claude.ai/artifact/abc307', from: 1, to: 2, at: Date.now(), audience: 'owner', edits: false };

function logFile(name, rows) {
  const p = join(dir, name);
  writeFileSync(p, jsonl(rows));
  return p;
}

test('출처 순서: 로컬 파일이 있으면 그것을 읽는다', () => {
  const html = join(dir, 'local.html');
  writeFileSync(html, '<h1>로컬 본문</h1>');
  const log = logFile('a.jsonl', [...write('w1', html, '<h1>기록 본문</h1>', 1), ...publish('p1', html, 1, 3)]);
  const d = loadArtifactSource({ logs: [log] }, ART);
  assert.equal(d.kind, 'local');
  assert.equal(d.path, html);
  assert.match(d.text, /로컬 본문/);
  assert.equal(d.changed, false);
});

test('출처 순서: 로컬 파일이 지워졌으면 같은 세션 기록에서 게시 전 마지막 Write 본문 (서브에이전트 기록 포함)', () => {
  const html = join(dir, 'gone.html');
  const main = logFile('b.jsonl', [...write('w1', html, '<p>첫 본문</p>', 1), ...publish('p1', html, 1, 3)]);
  const sub = logFile('b-sub.jsonl', [...write('w2', html, '<p>마지막 본문</p>', 2, 'update')]);
  const d = loadArtifactSource({ logs: [main, sub] }, ART);
  assert.equal(d.kind, 'record');
  assert.match(d.text, /마지막 본문/);
  assert.equal(d.changed, false);
});

test('출처 순서: 파일도 Write 본문도 없으면 원본 없음', () => {
  const html = join(dir, 'nothing.html');
  const log = logFile('c.jsonl', publish('p1', html, 1, 1));
  const d = loadArtifactSource({ logs: [log] }, ART);
  assert.equal(d.kind, 'none');
  assert.equal(d.path, html);
  // 기록 자체가 없거나 다른 아티팩트만 있으면 경로도 모른다.
  assert.equal(loadArtifactSource({ logs: [join(dir, 'no-such.jsonl')] }, ART).kind, 'none');
  assert.equal(loadArtifactSource({ logs: [log] }, { ...ART, id: 'other' }).path, null);
});

test('Write 뒤에 같은 경로의 Edit 이나 Artifact edits 가 있었으면 게시본과 다를 수 있다고 알린다', () => {
  const html = join(dir, 'edited.html');
  const viaEdit = logFile('d1.jsonl', [...write('w1', html, '<p>x</p>', 1), ...edit('e1', html, 3), ...publish('p1', html, 1, 5)]);
  assert.equal(loadArtifactSource({ logs: [viaEdit] }, ART).changed, true);
  const viaEdits = logFile('d2.jsonl', [...write('w1', html, '<p>x</p>', 1), ...publish('p1', html, 1, 3), ...publish('p2', html, 2, 5, { action: 'publish', edits: [{ old_str: 'x', new_str: 'y' }] })]);
  const d = loadArtifactSource({ logs: [viaEdits] }, ART);
  assert.equal(d.kind, 'record');
  assert.equal(d.changed, true);
  // Edit 이 Write 보다 앞이면 경고하지 않는다.
  const before = logFile('d3.jsonl', [...edit('e1', html, 1), ...write('w1', html, '<p>x</p>', 3), ...publish('p1', html, 1, 5)]);
  assert.equal(loadArtifactSource({ logs: [before] }, ART).changed, false);
});

test('로컬 파일: 심볼릭 링크와 폴더는 읽지 않고 기록 본문으로 넘어간다', { skip: process.platform === 'win32' && 'Windows 는 심볼릭 링크 권한이 없을 수 있다' }, () => {
  const target = join(dir, 'secret.txt');
  writeFileSync(target, 'SECRET-TARGET-307');
  const link = join(dir, 'link.html');
  symlinkSync(target, link);
  assert.equal(readLocal(link), null);
  const log = logFile('e.jsonl', [...write('w1', link, '<p>기록에서 온 본문</p>', 1), ...publish('p1', link, 1, 3)]);
  const d = loadArtifactSource({ logs: [log] }, ART);
  assert.equal(d.kind, 'record');
  assert.doesNotMatch(d.text, /SECRET-TARGET/);
});

test('로컬 파일: 폴더·상대 경로는 읽지 않는다', () => {
  const folder = join(dir, 'folder.html');
  mkdirSync(folder);
  assert.equal(readLocal(folder), null);
  assert.equal(readLocal('relative/page.html'), null);
  const log = logFile('f.jsonl', publish('p1', folder, 1, 1));
  assert.equal(loadArtifactSource({ logs: [log] }, ART).kind, 'none');
});

test('로컬 파일: 상한보다 크면 앞부분만 읽고 잘렸다고 표시한다', () => {
  const big = join(dir, 'big.html');
  writeFileSync(big, Buffer.alloc(SOURCE_MAX + 1000, 'a'));
  const r = readLocal(big);
  assert.equal(r.cut, true);
  assert.equal(r.text.length, SOURCE_MAX);
  const small = readLocal(big, 10);
  assert.equal(small.text, 'aaaaaaaaaa');
  const doc = { kind: 'local', path: big, text: '<p>x</p>', cut: true, changed: false };
  const out = artifactScreen(doc, ART, 100, 20, {}).map(strip).join('\n');
  assert.match(out, /앞 2\.0MB만/);
});

test('html → 글: script·style·template·주석은 버리고 제목·문단·목록·표·코드·인용을 남긴다', () => {
  const html = `<!doctype html><html><head><title>문서 제목</title><style>body{color:red}</style><script>alert("SCRIPT-307")</script></head>
  <body><!-- COMMENT-307 --><template><p>TEMPLATE-307</p></template>
  <h1>큰 제목</h1><p>첫 <b>문단</b> &amp; 엔티티 &lt;tag&gt; &#x41;&#66; &nbsp;끝</p>
  <ul><li>하나</li><li>둘<ol><li>안쪽</li></ol></li></ul>
  <table><tr><th>이름</th><th>값</th></tr><tr><td>가</td><td>1</td></tr><tr><td>나나나</td><td>22</td></tr></table>
  <pre><code>const a = 1;
  if (a) b();</code></pre>
  <blockquote><p>인용 글</p></blockquote>
  <p><a href="https://claude.ai/artifact/x1">클로드</a> <a href="https://example.com/page">바깥</a> <a href="javascript:alert(1)">나쁜</a></p>
  </body></html>`;
  const doc = htmlToBlocks(html);
  assert.equal(doc.title, '문서 제목');
  const lines = renderBlocks(doc.blocks, 60).map((l) => l.map((x) => x.t).join(''));
  const text = lines.join('\n');
  for (const bad of ['SCRIPT-307', 'COMMENT-307', 'TEMPLATE-307', 'color:red', 'javascript']) assert.ok(!text.includes(bad), bad);
  assert.match(text, /^# 큰 제목$/m);
  assert.match(text, /첫 문단 & 엔티티 <tag> AB +끝/);
  assert.match(text, /^• 하나$/m);
  assert.match(text, /^• 둘$/m);
  assert.match(text, /^ {2}1\. 안쪽$/m);
  // 표: 칸 너비를 맞추고 머리 아래 가로줄.
  assert.match(text, /^이름 {3}│ 값$/m);
  assert.match(text, /^─+$/m);
  assert.match(text, /^나나나 │ 22$/m);
  assert.match(text, /│ const a = 1;/);
  assert.match(text, /│ 인용 글/);
  // claude.ai 링크는 글만(그리는 곳이 OSC 8 로 감싼다), 그 밖의 https 는 주소를 붙이고, https 가 아니면 글만.
  assert.match(text, /클로드 바깥 <https:\/\/example\.com\/page> 나쁜/);
  const claude = doc.blocks.flatMap((b) => b.runs ?? []).find((r) => r.t === '클로드');
  assert.equal(claude.link, 'https://claude.ai/artifact/x1');
  assert.ok(!doc.blocks.flatMap((b) => b.runs ?? []).some((r) => r.link && !r.link.startsWith('https://claude.ai/')));
});

test('html → 글: data URI 이미지는 크기만, 제어 문자·ESC 주입은 지운다', () => {
  const b64 = Buffer.alloc(120 * 1024, 1).toString('base64');
  const html = `<p>그림 <img src="data:image/png;base64,${b64}"> 끝</p><p>나쁜\x1b[31m빨강\x1b]8;;https://evil\x07 &#27;[2J &#x9b;1m 글</p><p><img src="https://x.test/a.png" alt="설명"></p>`;
  const lines = renderBlocks(htmlToBlocks(html).blocks, 80).map((l) => l.map((x) => x.t).join(''));
  const text = lines.join('\n');
  assert.match(text, /그림 \[이미지 120KB\] 끝/);
  assert.ok(!text.includes(b64.slice(0, 40)));
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text), '제어 문자가 남지 않는다');
  assert.match(text, /\[이미지: 설명\]/);
  assert.equal(fmtBytes(1536), '1.5KB');
});

test('html → 글: 닫히지 않은 태그·깨진 html 도 멈추지 않고 글을 남긴다', () => {
  for (const html of ['<p>열린 문단<b>굵게', '<table><tr><td>칸', '<script>끝없는 스크립트', '<pre>코드', '<!-- 끝없는 주석', '< 3 > 2 <a href="x', '<ul><li>a<li>b</ul></li></ol>']) {
    const doc = htmlToBlocks(html);
    const lines = renderBlocks(doc.blocks, 40);
    assert.ok(Array.isArray(lines));
  }
  const text = renderBlocks(htmlToBlocks('<p>열린 문단<b>굵게').blocks, 40).map((l) => l.map((x) => x.t).join('')).join('\n');
  assert.match(text, /열린 문단굵게/);
  assert.equal(renderBlocks(htmlToBlocks('<script>끝없는 스크립트').blocks, 40).length, 0);
  assert.match(renderBlocks(htmlToBlocks('< 3 > 2').blocks, 40)[0].map((x) => x.t).join(''), /< 3 > 2/);
});

test('md → 글: 제목·목록·코드 블록·표', () => {
  const doc = mdToBlocks('# 제목\n\n문단 **굵게** `code`\n\n- 하나\n  - 안쪽\n\n```\nx = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  const text = renderBlocks(doc.blocks, 60).map((l) => l.map((x) => x.t).join('')).join('\n');
  assert.equal(doc.title, '제목');
  assert.match(text, /^# 제목$/m);
  assert.match(text, /문단 굵게 code/);
  assert.match(text, /^• 하나$/m);
  assert.match(text, /^ {2}• 안쪽$/m);
  assert.match(text, /│ x = 1/);
  assert.match(text, /^a │ b$/m);
});

// ── 키와 화면 ──
const HTML = `<h1>제목 하나</h1>${Array.from({ length: 80 }, (_, i) => `<p>문단 ${i + 1} 한글과 English 가 섞인 긴 글입니다 ${'가나다 '.repeat(6)}</p>`).join('')}`;
const arts = [ART, { ...ART, id: 'art-2', title: '두 번째', from: 1, to: 1 }];
const session = (extra = {}) => ({ tool: 'claude', id: 's1', name: 'demo', cwd: '/work/demo', status: 'busy', live: true, phase: { kind: 'think' }, updatedAt: Date.now(), tokens: { total: 10 }, context: {}, members: [], events: [], files: [], artifacts: arts, logs: [], ...extra });
const mkView = (s = session(), extra = {}) => ({ data: { sessions: [s], usage: null, errors: [], at: Date.now() }, selectedId: s.id, showDetail: true, frame: 0, focus: null, ...extra });

test('키: v 로 아티팩트 목록, ↑↓ 로 고르고 Enter 로 원본, Esc 로 한 단계씩 돌아온다', () => {
  const view = mkView();
  const opened = [];
  const act = { loadArtifact: (s, a) => (opened.push(a.id), { kind: 'local', path: '/tmp/x.html', text: HTML, cut: false, changed: false }), quit() {}, move() {}, refresh() {} };
  onKey(view, 'v', act);
  assert.equal(view.focus, 'artifacts');
  assert.equal(view.artifactId, 'art-307');
  assert.equal(helpContext(view), 'artifacts');
  onKey(view, KEY.down, act);
  assert.equal(view.artifactId, 'art-2');
  onKey(view, KEY.up, act);
  onKey(view, KEY.enter, act);
  assert.deepEqual(opened, ['art-307'], '원본은 Enter 때만 찾는다');
  assert.equal(view.focus, 'artifact');
  // 원본 화면은 모달: 세션 이동·정렬 키는 먹지 않는다.
  onKey(view, 's', act);
  assert.equal(view.sort, undefined);
  onKey(view, KEY.pageDown, act);
  assert.ok(view.artScroll > 0);
  onKey(view, KEY.home, act);
  assert.equal(view.artScroll, 0);
  onKey(view, KEY.end, act);
  render(view, 100, 30);
  assert.ok(Number.isFinite(view.artScroll) && view.artScroll > 0, '끝은 그릴 때 본문 길이에 맞춘다');
  onKey(view, ']', act);
  assert.equal(view.artifactId, 'art-2');
  assert.deepEqual(opened, ['art-307', 'art-2']);
  onKey(view, KEY.esc, act);
  assert.equal(view.focus, 'artifacts');
  assert.equal(view.artDoc, null);
  onKey(view, KEY.esc, act);
  assert.equal(view.focus, null);
  // 아티팩트가 없는 세션에서는 v 가 아무것도 하지 않는다.
  const empty = mkView(session({ artifacts: [] }));
  onKey(empty, 'v', act);
  assert.equal(empty.focus, null);
});

test('목록 초점: 고른 줄에 ▸, 가로줄 끝 v 안내는 목록 밖에서만, 갱신 뒤 사라진 아티팩트는 첫 것으로', () => {
  const view = mkView();
  let out = render(view, 120, 34).map(strip).join('\n');
  assert.match(out, /── 아티팩트 2 ─+ v ─/);
  assert.match(out, /v\s+아티팩트/);
  onKey(view, 'v', {});
  onKey(view, KEY.down, {});
  out = render(view, 120, 34).map(strip).join('\n');
  assert.match(out, /▸두 번째/);
  assert.doesNotMatch(out, /── 아티팩트 2 ─+ v ─/);
  assert.match(out, /⏎\s+원본 보기/);
  view.data.sessions[0].artifacts = [ART];
  fixFocus(view);
  assert.equal(view.artifactId, 'art-307');
  view.data.sessions[0].artifacts = [];
  fixFocus(view);
  assert.equal(view.focus, null);
});

test('원본 화면: 머리에 제목 · 버전 · 출처 · 경고, 좁은 폭·한글 폭에서도 줄이 넘치지 않는다', () => {
  for (const [W, H] of [[120, 30], [80, 24], [60, 20], [40, 16]]) {
    const view = mkView(session(), { focus: 'artifact', artifactId: 'art-307', artDoc: { kind: 'record', path: '/tmp/aitop/보고서.html', text: HTML, cut: false, changed: true }, artScroll: 0 });
    const lines = render(view, W, H);
    assert.equal(lines.length, H);
    for (const l of lines) assert.equal(width(strip(l)), W, `${W}열`);
    const out = lines.map(strip).join('\n');
    assert.match(out, /보고서/);
    assert.match(out, /기록 본문/);
    assert.match(out, /게시본과 다를 수 있음/);
    assert.match(out, /# 제목 하나/);
    if (W >= 80) assert.match(out, /보고서 · v2 · 기록 본문 · ! 게시본과 다를 수 있음/);
    assert.match(out, /Esc\s+목록으로/);
  }
  const none = mkView(session(), { focus: 'artifact', artifactId: 'art-307', artDoc: { kind: 'none', path: null, text: '', cut: false, changed: false } });
  assert.match(render(none, 80, 20).map(strip).join('\n'), /원본 없음 \(임시 파일이 지워졌고/);
});

test('원본 화면: NO_COLOR 와 같은 평문에서도 글이 그대로 읽히고, 링크는 claude.ai 만 OSC 8', async () => {
  const { _setLinks } = await import('../src/ui/theme.mjs');
  const prev = _setLinks(true);
  try {
    const html = '<p><a href="https://claude.ai/artifact/x1">클로드</a> <a href="https://example.com/">바깥</a></p>';
    const view = mkView(session(), { focus: 'artifact', artifactId: 'art-307', artDoc: { kind: 'local', path: '/tmp/a.html', text: html, cut: false, changed: false } });
    const raw = render(view, 100, 20).join('\n');
    const links = [...raw.matchAll(/\x1b\]8;;([^\x1b]*)\x1b\\/g)].map((m) => m[1]).filter(Boolean);
    assert.deepEqual(links, ['https://claude.ai/artifact/x1']);
  } finally {
    _setLinks(prev);
  }
});

test('도움말·키 줄에 새 화면과 키가 있다', () => {
  assert.match(keysLine('detail'), /v 아티팩트/);
  assert.match(keysLine('artifacts'), /Enter 원본 보기/);
  assert.match(keysLine('artifact'), /Home\/End 처음·끝/);
  assert.match(keysLine('artifact', 'en'), /Home\/End top\/bottom/);
  assert.ok(segsWidth([{ t: keysLine('artifact') }]) > 0);
});

test('html → 글: 닫히지 않은 <b 가 많은 2MB 입력도 길이에 비례해 끝난다 (따옴표 안의 > 는 태그 끝이 아니다)', () => {
  for (const html of ['x<b '.repeat(500_000), '<b "'.repeat(500_000) + '>', '<!x'.repeat(600_000), '<title>'.repeat(280_000), 'a<'.repeat(1_000_000)]) {
    const started = performance.now();
    htmlToBlocks(html);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${html.slice(0, 4)}… ${html.length}자 ${ms.toFixed(0)}ms`);
  }
  const text = renderBlocks(htmlToBlocks('<p title="a>b">글</p><p>x <b 열린 태그 <i "끝').blocks, 40).map((l) => l.map((x) => x.t).join('')).join('\n');
  assert.match(text, /^글$/m);
  assert.match(text, /x <b 열린 태그/);
});
