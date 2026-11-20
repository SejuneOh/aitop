// Antigravity(agy CLI·데스크톱 앱) 기록을 흉내 내는 도우미. antigravity.test.mjs 와 agy-app.test.mjs 가 함께 쓴다.
// 이 파일은 src/sources/antigravity.mjs 를 불러오지 않는다 (불러오면 테스트가 환경 변수를 정하기 전에 기록 폴더가 정해진다).
import { join } from 'node:path';
import { loadSqlite } from '../src/sqlite.mjs';

// antigravity.mjs 의 STEP 과 같은 값.
export const STEP = { PROMPT: 14, REPLY: 15, TOOL: 132 };
const sqlite = () => loadSqlite();

// ---- protobuf 만들기 ----
export const varint = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
export const num = (f, v) => Buffer.concat([varint(f * 8), varint(v)]);
export const bytes = (f, v) => {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
  return Buffer.concat([varint(f * 8 + 2), varint(b.length), b]);
};
// 실제 기록과 같은 모양: 1 → { 3 모델 번호, 17 → 2 → 사용량, 19 모델 이름, 20 {1 이름, 2 값} 목록 }, 앞뒤에 상관없는 필드.
// step 을 주면 20 목록에 last_step_index 로 넣는다.
export const kv = (k, v) => bytes(20, Buffer.concat([bytes(1, k), bytes(2, v)]));
export function generation({ model = 'gemini-4-argon', input = 0, output = 0, cacheRead = 0, cacheWrite = 0, step } = {}) {
  const usage = Buffer.concat([num(1, 1417), num(2, input), num(3, output), ...(cacheWrite ? [num(4, cacheWrite)] : []), num(5, cacheRead), num(6, 3), bytes(7, 'bot-x'), num(9, 1), num(10, Math.max(0, output - 1))]);
  const tail = [bytes(20, 'tool'), kv('trajectory_id', 'x'), ...(step != null ? [kv('last_step_index', String(step))] : []), kv('model_enum', 'M')];
  const gen = Buffer.concat([num(3, 1319), bytes(4, 'x'.repeat(30)), bytes(17, bytes(2, usage)), bytes(19, model), ...tail]);
  return Buffer.concat([bytes(2, '4'), bytes(4, 'uuid'), bytes(8, bytes(214280, 'cfg')), bytes(1, gen)]);
}

export function makeConversation(root, id, gens) {
  const db = new (sqlite().DatabaseSync)(join(root, 'conversations', `${id}.db`));
  db.exec('create table if not exists gen_metadata (idx integer primary key, data blob, size integer not null default 0)');
  const ins = db.prepare('insert into gen_metadata (idx, data) values (?, ?)');
  const start = db.prepare('select coalesce(max(idx), -1) + 1 n from gen_metadata').get().n;
  gens.forEach((g, i) => ins.run(start + i, generation(g)));
  db.close();
}

// steps 한 줄. 실제 기록과 같은 모양: 1 종류, 4 상태, 5 메타 {1 만든 시각, 4 도구 호출}, 19 사용자 입력, 20 답변, 140 도구 결과.
export const T0 = Date.UTC(2026, 10, 6, 2, 0, 0);
export const stamp = (ms) => Buffer.concat([num(1, Math.floor(ms / 1000)), num(2, (ms % 1000) * 1e6 + 123)]);
const call = (name, args) => Buffer.concat([bytes(1, 'call_1'), bytes(2, name), bytes(3, JSON.stringify(args)), bytes(7, Buffer.from([1, 0xc8, 0x3d, 0x6b]))]);
const meta = (at, tool) => Buffer.concat([bytes(1, stamp(at)), num(3, 2), ...(tool ? [bytes(4, call(...tool))] : []), num(11, 1319), bytes(12, 'uuid'), bytes(35, 'hash')]);
export function step({ type, status = 3, at = T0, text, tool }) {
  const parts = [num(1, type), num(4, status), bytes(5, meta(at, type === STEP.TOOL ? tool : null))];
  if (type === STEP.PROMPT) parts.push(bytes(19, Buffer.concat([bytes(2, text), bytes(3, `\n${text}`), bytes(4, '')])));
  if (type === STEP.REPLY) parts.push(bytes(20, Buffer.concat([...(text ? [bytes(1, text)] : []), bytes(3, '**Thinking**'), bytes(6, 'bot-x'), ...(tool ? [bytes(7, call(...tool))] : []), num(12, 2)])));
  if (type === STEP.TOOL) parts.push(bytes(140, bytes(1, Buffer.concat([bytes(1, 'Path'), bytes(2, '/x')]))));
  return Buffer.concat(parts);
}
export const prompt = (text, at) => ({ type: STEP.PROMPT, text, at });
export const reply = (text, tool, at) => ({ type: STEP.REPLY, text, tool, at });
export const toolStep = (tool, status = 3, at) => ({ type: STEP.TOOL, tool, status, at });

export function makeSteps(root, id, steps) {
  const db = new (sqlite().DatabaseSync)(join(root, 'conversations', `${id}.db`));
  db.exec(`create table if not exists steps (idx integer, step_type integer not null default 0, status integer not null default 0, has_subtrajectory numeric not null default false,
    metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer not null default 0, primary key (idx))`);
  const ins = db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)');
  const start = db.prepare('select coalesce(max(idx), -1) + 1 n from steps').get().n;
  steps.forEach((s, i) => ins.run(start + i, s.type, s.status ?? 3, Buffer.isBuffer(s.raw) ? s.raw : step(s)));
  db.close();
}

export function setStep(root, id, idx, s) {
  const db = new (sqlite().DatabaseSync)(join(root, 'conversations', `${id}.db`));
  db.prepare('update steps set status = ?, step_payload = ? where idx = ?').run(s.status ?? 3, step(s), idx);
  db.close();
}

export const kinds = (g) => g.events.map((e) => `${e.kind}:${e.text}`);

export function makeSummaries(root, rows) {
  const db = new (sqlite().DatabaseSync)(join(root, 'conversation_summaries.db'));
  db.exec(`drop table if exists conversation_summaries;
    create table conversation_summaries (conversation_id text primary key, title text not null default '', step_count integer not null default 0,
      last_modified_time datetime not null, workspace_uris text not null, status text not null default '', agent_name text not null default '',
      parent_conversation_id text not null default '', nesting_depth integer not null default 0, not_fully_idle numeric not null default false,
      killed numeric not null default false)`);
  const ins = db.prepare('insert into conversation_summaries values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.title ?? '', r.steps ?? 1, r.modified, JSON.stringify(r.ws ?? []), r.status ?? 'CASCADE_RUN_STATUS_IDLE', r.agent ?? '', r.parent ?? '', r.parent ? 1 : 0, r.busy ? 1 : 0, 0);
  db.close();
}

export const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00:00');
