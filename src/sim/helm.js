// 舵手辅助：定向舵 P-D 控制、自动调帆。供极曲线测试、游戏内辅助与 AI 共用。

import { DEG, clamp, wrapPi } from '../util/math.js';

// 朝目标艏向打舵（写入 ctl.rudder，+ = 右转）
export function steerTowards(phys, targetPsi, gain = 1) {
  const err = wrapPi(targetPsi - phys.psi);
  const cmd = gain * (err / (14 * DEG)) - phys.yawRate / (42 * DEG);
  phys.ctl.rudder = clamp(cmd, -1, 1);
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
