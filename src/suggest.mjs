// 잘못 친 옵션에 가까운 옵션 하나를 고른다. 의존성 없이 짧은 편집 거리(이웃 글자 자리바꿈 포함)로 잰다.

// 삽입·삭제·바꾸기·이웃 두 글자 자리바꿈을 1 로 센 거리 (optimal string alignment).
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// 앞의 - 와 = 뒤 값을 떼고 비교한다. 거리 상한은 4글자 이하 1, 그보다 길면 2 (엉뚱한 제안을 막는다).
// 상한 안에서 가장 가까운 후보(같은 거리면 앞의 것)를 돌려주고, 없으면 null. 입력과 똑같은 후보는 제안하지 않는다.
export function suggest(word, candidates) {
  const core = (s) => s.replace(/^-+/, '').replace(/=.*$/, '').toLowerCase();
  const w = core(word);
  if (!w) return null;
  let best = null;
  let bestD = (w.length <= 4 ? 1 : 2) + 1;
  for (const c of candidates) {
    if (c === word) continue;
    const dist = editDistance(w, core(c));
    if (dist < bestD) [best, bestD] = [c, dist];
  }
  return best;
}
