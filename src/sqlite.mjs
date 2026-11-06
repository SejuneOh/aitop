// Node 에 들어 있는 node:sqlite 를 쓸 수 있으면 돌려준다. 외부 라이브러리 없이 SQLite 기록을 읽기 위해서다.
// Node 22.13 이상(22.5~22.12 는 --experimental-sqlite 필요)에서만 있고, 없으면 null.
// 처음 불러올 때 나오는 ExperimentalWarning 은 화면을 깨뜨리므로 이 경고만 삼킨다.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

let sqlite;

export function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  sqlite = null;
  const get = process.getBuiltinModule;
  if (typeof get !== 'function') return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/sqlite/i.test(String(warning?.message ?? warning))) return;
    return emit.call(this, warning, ...rest);
  };
  try {
    sqlite = get('node:sqlite')?.DatabaseSync ? get('node:sqlite') : null;
  } catch {
    sqlite = null;
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

// 읽기 전용으로 연다. 읽기 전용 연결도 WAL 모드 DB 를 열면 옆에 -wal·-shm 을 만들고 닫을 때 지우지 못하므로,
// -wal 이 없으면(쓰는 쪽이 닫혀 있으면) immutable 로 열어 파일을 하나도 만들지 않는다.
// -wal 이 있으면 쓰는 쪽이 살아 있는 것이니 보통 읽기 전용으로 열어 최신 내용을 읽는다.
// immutable: 이번에 immutable 로 열었는지. 그동안 다른 쪽이 쓰기 시작했을 수 있어 부르는 쪽이 다시 확인한다.
export function openReadOnly(path) {
  const s = loadSqlite();
  if (!s) return null;
  const immutable = !existsSync(`${path}-wal`);
  const db = immutable ? new s.DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true }) : new s.DatabaseSync(path, { readOnly: true });
  db.immutable = immutable;
  return db;
}
