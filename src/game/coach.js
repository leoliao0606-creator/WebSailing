// 新手教练:根据当前风况给出"最佳缭绳/稳向板"参考值与一条最优先的操作提示。
// 只读物理状态,不写入任何控制;HUD 负责显示,i18n key 由调用方翻译。

import { DEG, clamp, wrapPi } from '../util/math.js';

// 最佳缭绳(与 AI/autoSheet 同一公式,不写入控制):
// 帆杠角 = |视风角| - 最佳攻角;过载(横倾大)时自动减攻角
export function optimalSheet(phys, alphaStarDeg = 15) {
  const p = phys.p;
  const over = Math.abs(phys.out.heelDeg) - 24;
  const alpha = over > 0 ? Math.max(4, alphaStarDeg - over * 1.1) : alphaStarDeg;
  const boomWant = Math.abs(phys.out.awaDeg) - alpha;
  return clamp((boomWant - p.boomMinDeg) / (p.boomMaxDeg - p.boomMinDeg), 0, 1);
}

// 最佳稳向板:迎风全放下(1),横风渐收,深顺风收至 35%
export function optimalBoard(twaDeg) {
  const a = Math.abs(twaDeg);
  if (a <= 95) return 1;
  if (a >= 135) return 0.35;
  return 1 - ((a - 95) / 40) * 0.65;
}

// 返回 { sheetOpt, boardOpt, hint, good }。target 为当前赛道目标点(可 null)。
export function coachAdvice(phys, target = null) {
  const o = phys.out;
  if (phys.capsized) return { sheetOpt: 1, boardOpt: 1, hint: null, good: false };

  const sheetOpt = optimalSheet(phys);
  const boardOpt = optimalBoard(o.twaDeg);
  const dSheet = phys.sheet - sheetOpt;   // >0 帆放得比最佳更开
  const dBoard = phys.board - boardOpt;   // >0 板放得比最佳更深
  const twaAbs = Math.abs(o.twaDeg);

  let hint = null;
  if (o.inIrons) hint = 'coach.irons';
  else if (Math.abs(o.heelDeg) > 32) hint = 'coach.overpower';
  else if (dSheet > 0.16) hint = 'coach.sheetIn';
  else if (dSheet < -0.16) hint = 'coach.sheetOut';
  else if (dBoard < -0.28) hint = 'coach.boardDown';
  else if (dBoard > 0.28) hint = 'coach.boardUp';
  else if (target) {
    const bearing = Math.atan2(target.x - phys.x, -(target.z - phys.z));
    const windFrom = wrapPi(phys.psi + o.twaDeg * DEG);
    const bearTwa = Math.abs(wrapPi(bearing - windFrom)); // 目标方位的真风角
    if (bearTwa < 40 * DEG) {
      // 目标在上风:走 VMG 角(约 45°)
      if (twaAbs < 36) hint = 'coach.pinch';
      else if (twaAbs > 60) hint = 'coach.vmgUp';
    } else if (bearTwa > 150 * DEG && twaAbs > 172) {
      hint = 'coach.deadRun';
    }
  }

  const good = !hint && o.luff < 0.3 && o.speedKn > 2;
  return { sheetOpt, boardOpt, hint: hint ?? (good ? 'coach.good' : null), good };
}
