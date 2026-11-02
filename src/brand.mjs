// aitop 표식: 로고, 시작 화면 막대, 창·탭 아이콘, WezTerm 탭용 user var.
// AITOP_ICONS 로 고른다.
//   (없음)  로고 ⣠⣴⣾, 탭 아이콘은 Nerd Font 로봇(U+F06A9), WezTerm user var 를 내보낸다
//   plain   Nerd 아이콘과 user var 를 끈다. 탭 아이콘은 로고의 마지막 막대 ⣾
//   ascii   로고를 >_ai 로, 탭 아이콘 없음, user var 없음 (점자를 못 그리는 환경용)
// 로고의 점자 글자는 동아시아 폭이 N 이라 한글 터미널에서도 늘 1칸이다.

export function iconMode(env = process.env) {
  return env.AITOP_ICONS === 'plain' || env.AITOP_ICONS === 'ascii' ? env.AITOP_ICONS : 'full';
}

export function brand(mode = iconMode()) {
  if (mode === 'ascii') return { mode, logo: '>_ai', frames: ['>   ', '>_  ', '>_a ', '>_ai'], tab: '', userVars: false };
  return {
    mode,
    logo: '⣠⣴⣾',
    // 막대가 하나씩 차오른다. 폭은 늘 3칸.
    frames: ['⣀⣀⣀', '⣠⣀⣀', '⣠⣴⣀', '⣠⣴⣾'],
    tab: mode === 'plain' ? '⣾' : '\u{F06A9}',
    userVars: mode === 'full',
  };
}

export const BRAND = brand();

// WezTerm 탭 제목(format-tab-title)에서 pane.user_vars 로 읽는 값. 다른 터미널은 모르는 OSC 를 무시한다.
// counts 가 null 이면 값을 지운다 (aitop 을 끝낼 때).
export function userVarsSeq(counts) {
  const set = (name, value) => `\x1b]1337;SetUserVar=${name}=${Buffer.from(value).toString('base64')}\x07`;
  if (!counts) return set('aitop', '') + set('aitop_waiting', '') + set('aitop_unseen', '');
  return set('aitop', '1') + set('aitop_waiting', String(counts.waiting)) + set('aitop_unseen', String(counts.unseen));
}
