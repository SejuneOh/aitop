// 실시간 화면의 애니메이션 타이머. 움직이는 표시가 있을 때만 ms 마다 onFrame 을 부르고, 없으면 멈춘다.
// sync() 는 화면을 그릴 때마다 불러 상태에 맞춰 타이머를 켜고 끈다. timers 는 테스트에서 바꿔 끼운다.
export function frameTimer({ animating, onFrame, ms = 120, timers = globalThis }) {
  let id = null;
  const stop = () => {
    if (id == null) return;
    timers.clearInterval(id);
    id = null;
  };
  const fire = () => {
    if (!animating()) return stop();
    onFrame();
  };
  return {
    sync() {
      if (!animating()) stop();
      else if (id == null) id = timers.setInterval(fire, ms);
    },
    stop,
    get running() {
      return id != null;
    },
  };
}
