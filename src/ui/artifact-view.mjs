// 아티팩트 원본 보기 (#307): html·md 를 터미널 글자로 바꿔 전체 화면에 스크롤해 보인다.
// html 은 실행하지 않는다. <script>·<style>·<template>·주석은 버리고 제목·문단·목록·표·pre/code·인용·링크 글만 남긴다.
// 모든 글은 stripControl·mask 를 지나고, 링크는 #305 처럼 https://claude.ai/ 주소만 OSC 8 로 감싼다(draw.mjs line).
// 그 밖의 https 주소는 글 뒤에 흐린 글자로 붙이고, https 가 아닌 주소는 버린다.
import { mask, pad, stripControl, truncate, truncateLeft, width } from '../text.mjs';
import { artifactLink } from '../sources/artifacts.mjs';
import { PALETTE } from './theme.mjs';
import { box, segsWidth, tilde } from './draw.mjs';
import { glyphs } from './glyphs.mjs';
import { t as tr } from '../i18n.mjs';

// ── 글 정리 ──
const clean = (s) => mask(stripControl(String(s ?? '').replace(/\t/g, '  ')));

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '\u2014', ndash: '\u2013', middot: '·', bull: '•', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', rarr: '→', larr: '←', uarr: '↑', darr: '↓', times: '×', divide: '÷', deg: '°', plusmn: '±', le: '≤', ge: '≥', ne: '≠', check: '✓', cross: '✗', star: '☆', starf: '★', zwj: '', zwnj: '', shy: '' };

// 엔티티 풀기. 제어 문자가 되는 숫자 엔티티(&#27; 등)는 뒤의 clean 이 지운다. 없는 이름은 그대로 둔다.
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});?/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
    }
    const v = NAMED[e.toLowerCase()];
    return v == null ? m : v;
  });
}

// 크기 글: 1536 → 1.5KB, 120000 → 117KB
export function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${n < 10 * 1024 ? (n / 1024).toFixed(1) : Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// data URI 의 본문 크기(바이트, 대략).
function dataSize(src) {
  const comma = src.indexOf(',');
  if (comma < 0) return 0;
  const body = src.slice(comma + 1).replace(/\s+/g, '');
  return /;base64$/i.test(src.slice(0, comma)) ? Math.floor((body.replace(/=+$/, '').length * 3) / 4) : body.length;
}

// 링크 주소: https 만. 쓸 수 있는 ASCII 글자만 있고 길이 상한 안일 때.
const HTTPS = /^https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const httpsOnly = (href) => {
  const h = String(href ?? '').trim();
  return h.length <= 300 && HTTPS.test(h) ? h : null;
};

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

// ── 블록 ──
// { kind: 'h', level, runs } | { kind: 'p', runs, quote, list? } | { kind: 'li', depth, mark, runs, quote } | { kind: 'pre', text, quote }
// | { kind: 'table', rows: [{ head, cells: [string] }] } | { kind: 'hr' }
// runs: [{ t, bold, italic, code, link }]

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'details', 'summary', 'form', 'fieldset', 'legend', 'address', 'center', 'body', 'html', 'caption']);
const DROP = ['script', 'style', 'template', 'noscript', 'svg', 'math', 'head', 'object', 'iframe', 'canvas'];

export function htmlToBlocks(html) {
  let src = String(html ?? '');
  let title = null;
  const tm = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(src);
  if (tm) title = clean(decodeEntities(tm[1])).replace(/\s+/g, ' ').trim() || null;
  // 주석·CDATA 와 실행·숨김 내용을 통째로 버린다. 닫는 태그가 없으면 끝까지 버린다.
  src = src.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '').replace(/<![^>]*>/g, '');
  for (const tag of DROP) src = src.replace(new RegExp(`<${tag}\\b[^>]*?\\/>|<${tag}\\b[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi'), '');

  const blocks = [];
  let runs = [];
  let kind = 'p';
  let level = 0;
  let liMark = '';
  let liDepth = 0;
  const lists = [];
  let quote = 0;
  let bold = 0;
  let italic = 0;
  let code = 0;
  let link = null;
  let linkText = '';
  let pre = null;
  let table = null;
  let cell = null;

  const push = (t, extra = {}) => {
    if (cell) {
      cell.text += t;
      return;
    }
    runs.push({ t, bold: bold > 0, italic: italic > 0, code: code > 0, ...(link ? { link } : {}), ...extra });
  };
  const flush = () => {
    const text = runs.map((r) => r.t).join('');
    if (text.trim()) {
      if (kind === 'h') blocks.push({ kind: 'h', level, runs });
      else if (kind === 'li') blocks.push({ kind: 'li', depth: liDepth, mark: liMark, runs, quote });
      else blocks.push({ kind: 'p', runs, quote });
      // 같은 항목 안에서 이어지는 글은 표시 없이 들여 쓴다.
      if (kind === 'li') liMark = '';
    }
    runs = [];
    if (kind === 'h') kind = 'p';
  };

  const TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|(<)/g;
  let m;
  while ((m = TOKEN.exec(src))) {
    const [, close, rawName, attrs = '', text, lt] = m;
    if (text != null || lt != null) {
      const s = decodeEntities(text ?? lt);
      if (pre) pre.text += s;
      else push(s.replace(/\s+/g, ' '));
      if (link) linkText += s;
      continue;
    }
    const name = rawName.toLowerCase();
    if (pre && name !== 'pre') {
      if (name === 'br') pre.text += '\n';
      continue;
    }
    if (name === 'pre') {
      if (!close) {
        flush();
        pre = { text: '' };
      } else if (pre) {
        blocks.push({ kind: 'pre', text: pre.text.replace(/^\n/, '').replace(/\s+$/, ''), quote });
        pre = null;
      }
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      flush();
      if (!close) {
        kind = 'h';
        level = Number(name[1]);
      }
      continue;
    }
    if (name === 'table') {
      if (!close && !table) {
        flush();
        table = { rows: [] };
      } else if (close && table) {
        if (cell) table.rows.at(-1)?.cells.push(cell.text);
        cell = null;
        const rows = table.rows.map((r) => ({ head: r.head, cells: r.cells.map((c) => clean(c).replace(/\s+/g, ' ').trim()) })).filter((r) => r.cells.some(Boolean));
        if (rows.length) blocks.push({ kind: 'table', rows });
        table = null;
      }
      continue;
    }
    if (table) {
      if (name === 'tr' && !close) {
        if (cell) table.rows.at(-1)?.cells.push(cell.text);
        cell = null;
        table.rows.push({ head: false, cells: [] });
      } else if ((name === 'td' || name === 'th') && !close) {
        if (!table.rows.length) table.rows.push({ head: false, cells: [] });
        if (cell) table.rows.at(-1).cells.push(cell.text);
        cell = { text: '' };
        if (name === 'th') table.rows.at(-1).head = true;
      } else if ((name === 'td' || name === 'th') && close && cell) {
        table.rows.at(-1).cells.push(cell.text);
        cell = null;
      } else if (name === 'br' || name === 'p' || name === 'li') {
        if (cell) cell.text += ' ';
      } else if (name === 'img' && cell) cell.text += imgText(attrs);
      continue;
    }
    if (name === 'ul' || name === 'ol') {
      flush();
      const start = Number(attr(attrs, 'start'));
      if (!close) lists.push({ ordered: name === 'ol', n: Number.isInteger(start) && start > 0 ? start - 1 : 0 });
      else lists.pop();
      kind = lists.length ? kind : 'p';
      liDepth = Math.max(1, lists.length);
      continue;
    }
    if (name === 'li') {
      flush();
      if (!close) {
        const l = lists.at(-1) ?? { ordered: false, n: 0 };
        l.n++;
        kind = 'li';
        liDepth = Math.max(1, lists.length);
        liMark = l.ordered ? `${l.n}.` : glyphs().event;
      } else kind = lists.length ? 'li' : 'p';
      continue;
    }
    if (name === 'blockquote') {
      flush();
      quote = Math.max(0, quote + (close ? -1 : 1));
      continue;
    }
    if (name === 'hr') {
      flush();
      blocks.push({ kind: 'hr' });
      continue;
    }
    if (name === 'br') {
      push('\n');
      continue;
    }
    if (BLOCK.has(name) || name === 'tr') {
      flush();
      continue;
    }
    if (name === 'b' || name === 'strong') bold += close ? -1 : 1;
    else if (name === 'i' || name === 'em') italic += close ? -1 : 1;
    else if (name === 'code' || name === 'kbd' || name === 'samp') code += close ? -1 : 1;
    else if (name === 'a') {
      if (!close) {
        link = { href: httpsOnly(attr(attrs, 'href')) };
        linkText = '';
      } else if (link) {
        // claude.ai 가 아닌 https 주소는 글과 다를 때만 글 뒤에 붙인다.
        const href = link.href;
        link = null;
        if (href && !artifactLink(href) && linkText.trim() !== href) push(` <${href}>`, { url: true });
      }
    } else if (name === 'img') push(imgText(attrs));
    bold = Math.max(0, bold);
    italic = Math.max(0, italic);
    code = Math.max(0, code);
  }
  if (pre) blocks.push({ kind: 'pre', text: pre.text.replace(/\s+$/, ''), quote });
  if (table) {
    if (cell) table.rows.at(-1)?.cells.push(cell.text);
    const rows = table.rows.map((r) => ({ head: r.head, cells: r.cells.map((c) => clean(c).replace(/\s+/g, ' ').trim()) })).filter((r) => r.cells.some(Boolean));
    if (rows.length) blocks.push({ kind: 'table', rows });
  }
  flush();
  return { title, blocks: blocks.map(cleanBlock) };
}

function imgText(attrs) {
  const src = attr(attrs, 'src') ?? '';
  if (/^data:/i.test(src.trim())) return ` ${tr('art.image', { size: fmtBytes(dataSize(src.trim())) })} `;
  const alt = (attr(attrs, 'alt') ?? '').trim();
  return alt ? ` ${tr('art.imageAlt', { alt })} ` : '';
}

// 글 조각마다 제어 문자 지우기·비밀값 가리기. 링크는 { href } 에서 주소(허용 목록을 지난 것)만 남긴다.
function cleanBlock(b) {
  if (b.runs) b.runs = b.runs.map((r) => ({ ...r, t: clean(r.t), link: r.link?.href && artifactLink(r.link.href) ? r.link.href : undefined }));
  if (b.kind === 'pre') b.text = clean(b.text);
  return b;
}

// ── md (간단히): 제목·목록·코드 블록·인용·표·굵게·코드·링크 ──
function mdInline(s) {
  const runs = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ t: s.slice(last, m.index) });
    if (m[1] != null) runs.push({ t: m[1], bold: true });
    else if (m[2] != null) runs.push({ t: m[2], code: true });
    else {
      const href = httpsOnly(m[4]);
      runs.push({ t: m[3], ...(href ? { link: { href } } : {}) });
      if (href && !artifactLink(href) && m[3] !== href) runs.push({ t: ` <${href}>`, url: true });
    }
    last = re.lastIndex;
  }
  if (last < s.length) runs.push({ t: s.slice(last) });
  return runs;
}

export function mdToBlocks(md) {
  const blocks = [];
  let title = null;
  let para = [];
  let fence = null;
  let table = null;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: 'p', runs: mdInline(para.join(' ')), quote: 0 });
    para = [];
  };
  const flushTable = () => {
    if (table?.length) blocks.push({ kind: 'table', rows: table });
    table = null;
  };
  for (const raw of String(md ?? '').split(/\r?\n/)) {
    if (fence) {
      if (/^\s*(```|~~~)/.test(raw)) {
        blocks.push({ kind: 'pre', text: fence.join('\n'), quote: 0 });
        fence = null;
      } else fence.push(raw);
      continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      flushPara();
      flushTable();
      fence = [];
      continue;
    }
    const l = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(l)) {
      flushPara();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(l) && l.includes('-')) {
        if (table?.length) table[0].head = true;
        continue;
      }
      (table ??= []).push({ head: false, cells: l.trim().slice(1, -1).split('|').map((c) => c.trim()) });
      continue;
    }
    flushTable();
    let m;
    if (!l.trim()) flushPara();
    else if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) {
      flushPara();
      if (!title && m[1].length === 1) title = m[2].trim();
      blocks.push({ kind: 'h', level: m[1].length, runs: mdInline(m[2]) });
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l))) {
      flushPara();
      const depth = 1 + Math.floor(m[1].replace(/\t/g, '    ').length / 2);
      blocks.push({ kind: 'li', depth, mark: /\d/.test(m[2]) ? m[2] : glyphs().event, runs: mdInline(m[3]), quote: 0 });
    } else if ((m = /^\s*>\s?(.*)$/.exec(l))) {
      flushPara();
      blocks.push({ kind: 'p', runs: mdInline(m[1]), quote: 1 });
    } else if (/^\s*([-*_]\s*){3,}$/.test(l)) {
      flushPara();
      blocks.push({ kind: 'hr' });
    } else para.push(l.trim());
  }
  if (fence) blocks.push({ kind: 'pre', text: fence.join('\n'), quote: 0 });
  flushPara();
  flushTable();
  for (const b of blocks) if (b.kind === 'table') b.rows = b.rows.map((r) => ({ ...r, cells: r.cells.map((c) => clean(c)) }));
  return { title: title && clean(title), blocks: blocks.map(cleanBlock) };
}

// 원본 종류: 경로 끝이 .md·.markdown 이면 md, .html·.htm 이거나 html 처럼 생겼으면 html, 아니면 글 그대로(pre).
export function docKind(path, text) {
  if (/\.(md|markdown)$/i.test(path ?? '')) return 'md';
  if (/\.html?$/i.test(path ?? '') || /^\s*(<!doctype html|<html|<head|<body|<div|<p[\s>])/i.test(text ?? '')) return 'html';
  return 'text';
}

export function parseDoc(path, text) {
  const k = docKind(path, text);
  if (k === 'html') return htmlToBlocks(text);
  if (k === 'md') return mdToBlocks(text);
  return { title: null, blocks: [{ kind: 'pre', text: clean(text), quote: 0 }] };
}

// ── 그리기 ──
const runSeg = (r) => ({
  t: r.t,
  fg: r.url ? PALETTE.info : r.code ? PALETTE.tool : r.link ? PALETTE.info : PALETTE.text,
  ...(r.bold ? { bold: true } : {}),
  ...(r.italic ? { italic: true } : {}),
  ...(r.link ? { link: r.link, underline: true } : {}),
});

// 글자 단위로 폭 w 에 맞게 자른다 (한글 2칸).
function chunks(s, w) {
  const out = [];
  let cur = '';
  for (const ch of s) {
    if (cur && width(cur + ch) > w) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

// 조각들을 폭 w 로 감싼다. 띄어쓰기에서 끊고, 긴 낱말은 글자 단위로. '\n' 은 줄을 바꾼다.
export function wrapRuns(runs, w) {
  w = Math.max(1, w);
  const lines = [[]];
  let used = 0;
  const add = (seg) => {
    const last = lines.at(-1);
    const prev = last.at(-1);
    if (prev && prev.fg === seg.fg && prev.bold === seg.bold && prev.italic === seg.italic && prev.link === seg.link) prev.t += seg.t;
    else last.push(seg);
    used += width(seg.t);
  };
  const br = () => {
    const last = lines.at(-1);
    if (last.length) last[last.length - 1].t = last.at(-1).t.trimEnd();
    lines.push([]);
    used = 0;
  };
  for (const r of runs) {
    const seg = runSeg(r);
    for (const part of r.t.split(/(\n| +)/)) {
      if (!part) continue;
      if (part === '\n') {
        br();
        continue;
      }
      if (/^ +$/.test(part)) {
        // 이어진 공백은 하나로 (조각 경계에서 겹치는 것도).
        if (used > 0 && used < w && !/ $/.test(lines.at(-1).at(-1)?.t ?? '')) add({ ...seg, t: ' ' });
        continue;
      }
      const pw = width(part);
      if (used + pw > w && used > 0) br();
      if (pw <= w) add({ ...seg, t: part });
      else
        for (const c of chunks(part, w)) {
          if (used > 0) br();
          add({ ...seg, t: c });
        }
    }
  }
  while (lines.length > 1 && !lines.at(-1).length) lines.pop();
  return lines.map((l) => l.filter((x) => x.t));
}

function tableLines(rows, w, sep) {
  const n = Math.max(...rows.map((r) => r.cells.length));
  const cols = Array.from({ length: n }, (_, i) => Math.max(1, ...rows.map((r) => width(r.cells[i] ?? ''))));
  const gap = width(sep);
  const total = () => cols.reduce((a, b) => a + b, 0) + gap * (n - 1);
  // 넘치면 가장 넓은 칸부터 줄인다 (칸마다 4칸까지).
  while (total() > w) {
    const i = cols.indexOf(Math.max(...cols));
    if (cols[i] <= 4) break;
    cols[i]--;
  }
  const out = [];
  if (total() > w) {
    // 칸이 너무 많으면 한 행을 ' · ' 로 이어 감싼다.
    for (const r of rows) for (const l of wrapRuns([{ t: r.cells.join(' · '), bold: r.head }], w)) out.push(l);
    return out;
  }
  rows.forEach((r, k) => {
    const segs = [];
    cols.forEach((cw, i) => {
      if (i) segs.push({ t: sep, fg: PALETTE.line });
      segs.push({ t: pad(r.cells[i] ?? '', cw), fg: PALETTE.text, ...(r.head ? { bold: true } : {}) });
    });
    out.push(segs);
    if (r.head && k === 0) out.push([{ t: cols.map((cw) => glyphs().rule.repeat(cw)).join(glyphs().rule.repeat(gap)), fg: PALETTE.line }]);
  });
  return out;
}

// 블록 → 화면 줄 [segs]. 블록 사이에 빈 줄 하나.
export function renderBlocks(blocks, w) {
  const out = [];
  const bar = glyphs().edge.normal.v;
  const gapBefore = () => {
    if (out.length && out.at(-1).length) out.push([]);
  };
  for (const b of blocks) {
    const qPre = b.quote ? [{ t: `${bar} `.repeat(b.quote), fg: PALETTE.muted }] : [];
    const qw = segsWidth(qPre);
    if (b.kind === 'h') {
      gapBefore();
      const head = { t: '#'.repeat(b.level) + ' ', fg: PALETTE.brand, bold: true };
      const lines = wrapRuns(b.runs.map((r) => ({ ...r, bold: true })), w - width(head.t));
      lines.forEach((l, i) => out.push([i ? { t: ' '.repeat(width(head.t)) } : head, ...l.map((x) => ({ ...x, fg: x.link ? x.fg : PALETTE.brand }))]));
      out.push([]);
    } else if (b.kind === 'p') {
      const lines = wrapRuns(b.runs, w - qw);
      const prev = out.at(-1);
      if (prev && prev.length && !prev.isLi) out.push([]);
      for (const l of lines) out.push([...qPre, ...l]);
    } else if (b.kind === 'li') {
      const ind = '  '.repeat(Math.max(0, b.depth - 1));
      const mark = b.mark ? `${b.mark} ` : '';
      const head = ind + (mark || '  ');
      const lines = wrapRuns(b.runs, w - qw - width(head));
      lines.forEach((l, i) => {
        const row = [...qPre, { t: i ? ' '.repeat(width(head)) : ind, fg: PALETTE.muted }, ...(i ? [] : [{ t: mark || '  ', fg: PALETTE.brand }]), ...l];
        row.isLi = true;
        out.push(row);
      });
    } else if (b.kind === 'pre') {
      gapBefore();
      for (const raw of b.text.split('\n')) for (const c of chunks(raw, Math.max(1, w - qw - 2))) out.push([...qPre, { t: `${bar} `, fg: PALETTE.faint }, { t: c, fg: PALETTE.tool }]);
      out.push([]);
    } else if (b.kind === 'table') {
      gapBefore();
      out.push(...tableLines(b.rows, w, ` ${bar} `));
      out.push([]);
    } else if (b.kind === 'hr') {
      gapBefore();
      out.push([{ t: glyphs().rule.repeat(Math.max(1, w)), fg: PALETTE.line }]);
      out.push([]);
    }
  }
  while (out.length && !out.at(-1).length) out.pop();
  while (out.length && !out[0].length) out.shift();
  return out;
}

// 원본 하나를 폭 w 의 줄들로. 같은 원본·폭이면 다시 만들지 않는다 (doc 에 붙여 둔다).
export function docLines(doc, w) {
  if (doc.lines && doc.linesW === w) return doc.lines;
  if (!doc.parsed) doc.parsed = doc.kind === 'none' || doc.kind === 'loading' ? { title: null, blocks: [] } : parseDoc(doc.path, doc.text);
  if (doc.kind === 'loading') return [[{ t: tr('art.loading'), fg: PALETTE.info, italic: true }]];
  const lines = doc.kind === 'none' ? [[{ t: tr('art.noneNote'), fg: PALETTE.info, italic: true }]] : renderBlocks(doc.parsed.blocks, w);
  doc.lines = lines.length ? lines : [[{ t: tr('art.empty'), fg: PALETTE.info, italic: true }]];
  doc.linesW = w;
  return doc.lines;
}

const SOURCE_KEY = { local: 'art.srcLocal', record: 'art.srcRecord', none: 'art.srcNone', loading: 'art.srcLoading' };

// 머리 두 줄: 제목 · v3 · 출처 · 경고 / 경로. 좁으면 경고 → 버전 순으로 줄이고 제목은 잘라 남긴다.
export function headLines(doc, a, w, pos) {
  const sep = { t: ' · ', fg: PALETTE.info };
  const title = a?.title || doc.parsed?.title || '-';
  const ver = a?.to != null ? `v${a.to}` : null;
  const src = { t: tr(SOURCE_KEY[doc.kind] ?? 'art.srcNone'), fg: doc.kind === 'none' ? PALETTE.alert : doc.kind === 'record' ? PALETTE.waiting : PALETTE.busy, bold: true };
  const warns = [doc.changed && { t: `! ${tr('art.mayDiffer')}`, fg: PALETTE.waiting, bold: true }, doc.cut && { t: tr('art.cut', { n: fmtBytes(2 * 1024 * 1024) }), fg: PALETTE.waiting }].filter(Boolean);
  const tail = (k) => [...(k < 2 && ver ? [sep, { t: ver, fg: PALETTE.muted }] : []), sep, src, ...(k < 1 ? warns.flatMap((x) => [sep, x]) : [])];
  const meta = pos ? [{ t: `  ${pos}`, fg: PALETTE.info }] : [];
  let k = 0;
  while (k < 2 && w - segsWidth([...tail(k), ...meta]) < Math.min(12, width(title))) k++;
  const rest = [...tail(k), ...meta];
  const first = [{ t: truncate(title, Math.max(1, w - segsWidth(rest))), fg: PALETTE.text, bold: true }, ...rest];
  const lines = [first];
  // 경고가 첫 줄에서 빠졌으면 둘째 줄로 내린다.
  if (k >= 1 && warns.length) lines.push(warns.flatMap((x, i) => (i ? [sep, x] : [x])));
  if (doc.path) lines.push([{ t: truncateLeft(tilde(doc.path), w), fg: PALETTE.muted }]);
  return lines;
}

// 전체 화면: 상자(W×H) 안에 머리, 가로줄, 본문. 스크롤 위치는 여기서 본문 길이에 맞춰 다시 맞춘다.
export function artifactScreen(doc, a, W, H, view) {
  const inner = Math.max(1, W - 4);
  const body = docLines(doc, inner);
  const rows = Math.max(1, H - 2);
  // 머리 줄 수를 먼저 정한 뒤 본문 쪽수를 센다.
  const head0 = headLines(doc, a, inner, '');
  const page = Math.max(1, rows - head0.length - 1);
  view.artPage = Math.max(1, page - 1);
  const max = Math.max(0, body.length - page);
  if (view.artScroll === Infinity) view.artScroll = max;
  const top = Math.min(Math.max(0, view.artScroll ?? 0), max);
  view.artScroll = top;
  const pos = body.length > page ? `${Math.round(((top + page) / body.length) * 100)}%` : '';
  const head = headLines(doc, a, inner, pos);
  const lines = [...head, [{ t: glyphs().rule.repeat(inner), fg: PALETTE.brand }], ...body.slice(top, top + page)];
  const title = [{ t: tr('view.artifact'), fg: PALETTE.brand, bold: true }];
  return box(title, W, H, null, lines.slice(0, rows), 0, PALETTE.brand, true);
}
