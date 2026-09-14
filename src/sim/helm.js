// 舵手辅助：定向舵 P-D 控制、自动调帆。供极曲线测试、游戏内辅助与 AI 共用。

import { DEG, clamp, wrapPi } from '../util/math.js';

// 朝目标艏向打舵（写入 ctl.rudder，+ = 右转）
export function steerTowards(phys, targetPsi, gain = 1) {
  const err = wrapPi(targetPsi - phys.psi);
  const cmd = clamp(gain * (err / (14 * DEG)) - phys.yawRate / (42 * DEG), -1, 1);
  // 倒航时水从艉向艏流过舵叶，舵效整个反向（见 boatPhysics 的 chordForFlow）。
  // 不跟着反打的话，大风调向一旦掉速到倒航，满舵会把船推回原来那一舷，于是
  // 永远卡在顶风点转不过去 —— 25 节以上必然发生，船会在死区里反复来回。
  // 反打是真实的脱困操作（玩家手动时 HUD 有倒航提示，靠自己反舵）。
  //
  // 用 u 做平滑过渡，而不是拿 out.sternway 硬切：u 会在零附近反复跨过阈值，
  // 硬切会让舵指令高频翻转。平滑过渡在 u≈0 时让舵回中，而那里舵本来就没效力。
  phys.ctl.rudder = cmd * clamp(phys.u / 0.25, -1, 1);
  return err;
}

// 自动调帆：把帆杠放到 |视风角| - α*，即攻角保持在最佳值附近
export function autoSheet(phys, alphaStarDeg = 17) {
  const p = phys.p;
  const awaAbs = Math.abs(phys.out.awaDeg);
  const boomWant = awaAbs - alphaStarDeg;
  const sheet = clamp((boomWant - p.boomMinDeg) / (p.boomMaxDeg - p.boomMinDeg), 0, 1);
  phys.ctl.sheet = sheet;
  return sheet;
}
