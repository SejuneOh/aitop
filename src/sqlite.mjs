// Node 에 들어 있는 node:sqlite 를 쓸 수 있으면 돌려준다. 외부 라이브러리 없이 SQLite 기록을 읽기 위해서다.
// Node 22.13 이상(22.5~22.12 는 --experimental-sqlite 필요)에서만 있고, 없으면 null.
// 처음 불러올 때 나오는 ExperimentalWarning 은 화면을 깨뜨리므로 이 경고만 삼킨다.
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

// 읽기 전용으로 연다. 쓰는 쪽(agy)이 WAL 모드여도 최신 내용을 읽는다.
export function openReadOnly(path) {
  const s = loadSqlite();
  if (!s) return null;
  return new s.DatabaseSync(path, { readOnly: true });
}
