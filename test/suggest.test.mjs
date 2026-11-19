// 모르는 옵션: 가까운 옵션 제안 한 줄과 --help 안내만 내고 2 로 끝난다 (#291).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editDistance, suggest } from '../src/suggest.mjs';

const BIN = fileURLToPath(new URL('../bin/aitop.mjs', import.meta.url));

test('editDistance 는 삽입·삭제·바꾸기·이웃 자리바꿈을 1 로 센다', () => {
  assert.equal(editDistance('notify', 'notify'), 0);
  assert.equal(editDistance('notfy', 'notify'), 1);
  assert.equal(editDistance('lnie', 'line'), 1);
  assert.equal(editDistance('al', 'all'), 1);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('suggest 는 상한 안의 가장 가까운 옵션만 고르고, 멀면 null', () => {
  const opts = ['--all', '--notify', '--no-notify', '--once', '--json', '--line', '--line-width', '--theme'];
  assert.equal(suggest('--notfy', opts), '--notify');
  assert.equal(suggest('--onec', opts), '--once');
  assert.equal(suggest('-notify', opts), '--notify');
  assert.equal(suggest('--jsno', opts), '--json');
  assert.equal(suggest('--line-widht=40', opts), '--line-width');
  assert.equal(suggest('--NOTIFY', opts), '--notify');
  assert.equal(suggest('--zzzzzz', opts), null);
  assert.equal(suggest('--x', opts), null, '짧은 글자는 엉뚱한 제안을 하지 않는다');
  assert.equal(suggest('--', opts), null);
  assert.equal(suggest('blue', ['light', 'dark']), null);
  assert.equal(suggest('lihgt', ['light', 'dark']), 'light');
});

const run = (args, lang) => {
  const root = mkdtempSync(join(tmpdir(), 'aitop-suggest-'));
  try {
    const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), AITOP_AGY_HOME: join(root, 'agy'), AITOP_LANG: lang };
    for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) delete env[k];
    return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('aitop --notfy 는 제안 한 줄과 --help 안내만 내고 도움말 전체는 내지 않는다', () => {
  const ko = run(['--notfy'], 'ko');
  assert.equal(ko.status, 2);
  assert.equal(ko.stderr, 'aitop: 알 수 없는 옵션 --notfy (혹시 --notify?)\naitop: 전체 옵션은 aitop --help\n');
  assert.equal(ko.stdout, '');
  const en = run(['--notfy'], 'en');
  assert.equal(en.status, 2);
  assert.equal(en.stderr, 'aitop: unknown option --notfy (did you mean --notify?)\naitop: all options: aitop --help\n');
});

test('가까운 옵션이 없으면 제안 없이, 여럿이면 쉼표로 한 줄에', () => {
  const r = run(['--zzzzzz', '--onec'], 'ko');
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'aitop: 알 수 없는 옵션 --zzzzzz, --onec (혹시 --once?)\naitop: 전체 옵션은 aitop --help\n');
});

test('--theme 잘못된 값도 같은 방식: 가까우면 제안, 아니면 허용 값', () => {
  const near = run(['--theme', 'lihgt'], 'ko');
  assert.equal(near.status, 2);
  assert.equal(near.stderr, 'aitop: 알 수 없는 옵션 --theme lihgt (혹시 --theme light?)\naitop: 전체 옵션은 aitop --help\n');
  const far = run(['--theme=blue'], 'en');
  assert.equal(far.status, 2);
  assert.equal(far.stderr, 'aitop: unknown option --theme blue (light or dark)\naitop: all options: aitop --help\n');
});
