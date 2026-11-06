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

// 늘 immutable 로 연다. 보통 읽기 전용 연결은 WAL 모드 DB 옆에 -wal·-shm 을 만들거나 고치고, 쓰는 쪽보다 늦게 닫히면
// 그 파일들이 지워지지 않고 남는다. immutable 은 파일을 하나도 만들거나 고치지 않는 대신 -wal 에 있는 최신 내용은 보지 않는다
// (쓰는 쪽이 본 파일에 합친 뒤에 보인다). 읽는 동안 다른 쪽이 쓰면 내용이 어긋날 수 있어, 부르는 쪽이 읽기 전후를 비교한다.
export function openReadOnly(path) {
  const s = loadSqlite();
  if (!s) return null;
  if (!existsSync(path)) throw new Error(`없음: ${path}`);
  return new s.DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
}
