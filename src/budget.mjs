// 하루 예산(budgetDay): 오늘 비용에 최근 지출 속도 × 로컬 자정까지 남은 시간을 더해 오늘 끝의 비용을 어림한다.
// 예산은 화면의 비용 기준(c 키)과 상관없이 늘 API 정가 환산으로 본다. 그래서 화면과 --json 의 단계가 같다.
// 예상이 예산의 CAUTION 배 이상이면 'caution', 예산 이상이면 'warn'.

export const CAUTION = 0.8;
// 자정 뒤 이만큼이 지나기 전에는 속도를 믿지 않고 예상 = 오늘 비용.
export const MIN_TODAY_MS = 15 * 60_000;

// 지금부터 로컬 자정까지 남은 시간 (시간 단위).
export function hoursToMidnight(now = Date.now()) {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return Math.max(0, (midnight - now) / 3600_000);
}

export const levelOf = (projected, day) => (projected >= day ? 'warn' : projected >= day * CAUTION ? 'caution' : 'ok');

// usage: collect 의 사용량. recentToday 는 최근 1시간 중 오늘(로컬 자정 이후) 몫과 그 구간 길이(ms)다 (recentTodayOf).
// 속도 = 그 몫을 시간당으로 늘린 값. 값이 없거나, 아직 집계 중이거나, 자정 뒤 15분이 안 됐으면 예상 = 오늘 비용.
// 예산이 없거나 사용량이 없으면 null.
export function projectBudget(usage, day, { now = Date.now() } = {}) {
  if (!(typeof day === 'number' && day > 0) || !usage?.today) return null;
  const r = usage.loading == null && usage.recentToday?.ms >= MIN_TODAY_MS ? usage.recentToday : null;
  const spent = usage.today.cost ?? 0;
  const perHour = r ? (r.cost ?? 0) / (r.ms / 3600_000) : 0;
  const projected = spent + perHour * hoursToMidnight(now);
  const unknown = Boolean(usage.today.unknown || r?.unknown);
  return { day, spent, projected, unknown, level: levelOf(projected, day) };
}
