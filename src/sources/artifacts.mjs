// Claude 기록의 Artifact 도구 게시 결과 (#305). 상세 패널 아티팩트 구획과 --json 의 artifacts 가 쓴다.
// 게시(publish, action 이 없으면 publish) 호출과 짝이 되는 결과 줄의 toolUseResult 에서 몇 값만 꺼낸다.
// 입력의 file_path·edits 내용·prompt 와 결과의 나머지 값(path 등)은 담지 않는다.
import { createHash } from 'node:crypto';
import { mask, stripControl } from '../text.mjs';

// 세션마다 남기는 아티팩트 수 (마지막 게시가 최근인 것부터).
export const ARTIFACT_MAX = 20;
// 짝을 기다리는 게시 호출 수 상한. 결과가 오지 않은 호출이 쌓이지 않게 한다.
export const ARTIFACT_CALLS_MAX = 16;

const TITLE_MAX = 120;
const URL_MAX = 300;
const ID_MAX = 80;
const AUDIENCE_MAX = 24;

// 링크로 내보내는 주소: https://claude.ai/ 로 시작하고 URL 에 쓰는 ASCII 글자만 있는 것.
const SAFE_URL = /^https:\/\/claude\.ai\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/;

const str = (v, max) => (typeof v === 'string' ? stripControl(v).replace(/\s+/g, ' ').trim().slice(0, max) || null : null);

// 게시 호출인지. action 이 없으면 게시다.
export const isPublish = (input) => input?.action == null || input.action === 'publish';

// 허용 목록을 지난 링크 주소, 아니면 null. 기록에서 온 값이라 화면·--json 에 내기 전에 늘 여기를 지난다.
export function artifactLink(url) {
  return typeof url === 'string' && url.length <= URL_MAX && SAFE_URL.test(url) ? url : null;
}

// 공유 범위 표시: 'org' 는 조직 공유, 'public'·'anyone' 은 공개, 그 밖('owner' 등)은 표시하지 않는다.
// 화면은 이 이름을 i18n 키로 바꾸고, --json 의 audience 는 기록의 원래 값을 그대로 낸다.
export function audienceKind(audience) {
  const a = String(audience ?? '').toLowerCase();
  if (a === 'org') return 'org';
  if (a === 'public' || a === 'anyone') return 'public';
  return null;
}

function timeOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

// 결과 한 건 → 저장할 값. id 도 주소도 없으면 null.
export function pickArtifact(r, at, edits) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  // 주소는 원래 값이 허용 목록을 지날 때만 담는다. 제어 문자를 지워서 통과하게 만들지 않는다.
  const url = artifactLink(r.url);
  // 허용 목록 밖 주소는 묶는 데만 쓰고 값은 남기지 않는다 (해시).
  const id = str(r.artifact_id, ID_MAX) ?? url ?? (typeof r.url === 'string' && r.url ? `h:${createHash('sha1').update(r.url).digest('hex').slice(0, 16)}` : null);
  if (!id) return null;
  // 사람이 보는 버전 번호는 seq (1, 2, …) 다. version 은 '1794205685-b571' 같은 내부 문자열이라 읽지 않는다.
  const v = Number.isInteger(r.seq) && r.seq > 0 ? r.seq : null;
  const title = str(r.title, TITLE_MAX);
  // 제목은 화면 공유 때 새지 않게 비밀값처럼 보이는 글을 가린다.
  return { id, title: title && mask(title), url, from: v, to: v, at: timeOf(r.updated) ?? at, audience: str(r.audience, AUDIENCE_MAX), edits: Boolean(edits) };
}

// 같은 아티팩트(id)면 버전 범위를 넓히고 제목·주소·공개·바로 수정은 마지막 게시 것을 쓴다.
function fold(map, a) {
  const m = map.get(a.id);
  if (!m) return map.set(a.id, { ...a });
  const min = (x, y) => (x == null ? y : y == null ? x : Math.min(x, y));
  const max = (x, y) => (x == null ? y : y == null ? x : Math.max(x, y));
  const late = a.at >= m.at ? a : m;
  map.set(a.id, { id: a.id, title: late.title ?? m.title ?? a.title, url: late.url ?? m.url ?? a.url, from: min(m.from, a.from), to: max(m.to, a.to), at: Math.max(m.at, a.at), audience: late.audience ?? null, edits: late.edits });
}

const newest = (map) => [...map.values()].sort((a, b) => b.at - a.at).slice(0, ARTIFACT_MAX);

// list 에 한 건을 더한 새 목록 (최근 순, ARTIFACT_MAX 개까지).
export function addArtifact(list, a) {
  const map = new Map((list ?? []).map((x) => [x.id, x]));
  fold(map, a);
  return newest(map);
}

// 메인과 서브에이전트(또는 붙은 claude -p 실행)의 목록을 합친다.
export function mergeArtifacts(lists) {
  const map = new Map();
  for (const list of lists) for (const a of list ?? []) fold(map, a);
  return newest(map);
}
