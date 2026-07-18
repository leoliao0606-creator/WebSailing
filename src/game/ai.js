// AI 舵手：与玩家完全相同的物理模型。
// 策略：迎风走 VMG 角 + layline 判断调向；顺风走换舷角；横风直航。
// 阵风过载时松帆减横倾。skill 影响调帆精度与反应。

import { DEG, clamp, wrapPi } from '../util/math.js';
import { steerTowards, autoSheet } from '../sim/helm.js';
import { createSeededRandom } from '../sim/random.js';

const UPWIND_TWA = 45 * DEG;    // 目标迎风角
const DOWNWIND_TWA = 152 * DEG; // 目标顺风换舷角

export class AIHelm {
  constructor(boat, skill = 1, seed) {
    this.boat = boat;
    this.skill = skill;
    this.lastManeuverT = 0;
    this.alphaStar = 15 + (1 - skill) * 5;
    this.setSeed(seed);
  }

  setSeed(seed) {
    const random = seed === undefined ? Math.random : createSeededRandom(seed);
    this.tackSide = random() > 0.5 ? 1 : -1; // +1 = 风从右舷
    this.noiseT = random() * 100;
    return this;
  }

  // target: {x,z} 下一个目标点；t 当前时间
  update(wind, target, t, dt) {
    const p = this.boat.phys;
    const w = wind.sample(p.x, p.z);
    if (p.capsized) { p.ctl.righting = true; return; }
    p.ctl.righting = false;
    p.ctl.autoHike = true;

    if (!target) { this._holdStation(w, t); return; }

    const dx = target.x - p.x, dz = target.z - p.z;
    const distToTarget = Math.hypot(dx, dz);
    const bearing = Math.atan2(dx, -dz); // 罗盘角
    const bearingTwa = wrapPi(bearing - w.fromPsi); // 目标方位相对风向（=需要航行的真风角）

    let targetHeading;
    const absBT = Math.abs(bearingTwa);

    if (absBT < UPWIND_TWA + 6 * DEG) {
      // —— 迎风段：走 Z 字 ——
      const tackTwa = UPWIND_TWA + 3 * DEG;
      const headA = wrapPi(w.fromPsi + this.tackSide * tackTwa);
      // layline 判断：另一舷的航向能否直达目标（留 6° 余量）
      const otherHeading = wrapPi(w.fromPsi - this.tackSide * tackTwa);
      const fetch = Math.abs(wrapPi(bearing - otherHeading)) < 6 * DEG * this.skill;
      const sinceManeuver = t - this.lastManeuverT;
      if (fetch && sinceManeuver > 12 && distToTarget > 30) {
        this.tackSide *= -1;
        this.lastManeuverT = t;
      }
      // 快到目标时若本舷直达就直冲
      if (Math.abs(wrapPi(bearing - headA)) < 4 * DEG || distToTarget < 25) {
        targetHeading = Math.abs(wrapPi(bearing - w.fromPsi)) > 38 * DEG ? bearing : headA;
      } else {
        targetHeading = wrapPi(w.fromPsi + this.tackSide * tackTwa);
      }
    } else if (absBT > DOWNWIND_TWA) {
      // —— 顺风段：换舷角航行 ——
      const gybeTwa = DOWNWIND_TWA;
      const otherHeading = wrapPi(w.fromPsi + Math.PI - this.tackSide * (Math.PI - gybeTwa));
      const fetch = Math.abs(wrapPi(bearing - otherHeading)) < 8 * DEG;
      if (fetch && t - this.lastManeuverT > 10 && distToTarget > 40) {
        this.tackSide *= -1;
        this.lastManeuverT = t;
      }
      if (distToTarget < 35) targetHeading = bearing;
      else targetHeading = wrapPi(w.fromPsi + Math.PI - this.tackSide * (Math.PI - gybeTwa));
    } else {
      // —— 横风直航（微绕标余量）——
      targetHeading = bearing;
      this.tackSide = wrapPi(bearing - w.fromPsi) > 0 ? 1 : -1;
    }

    // 转向 & 调帆
    steerTowards(p, targetHeading, 0.8 + this.skill * 0.3);
    let alpha = this.alphaStar;
    // 过载减横倾（大风生存术）
    const over = Math.abs(p.out.heelDeg) - 24;
    if (over > 0) alpha = Math.max(4, alpha - over * 1.1);
    autoSheet(p, alpha);
    // 顺风稳向板收一半
    p.ctl.board = Math.abs(p.out.twaDeg) > 120 ? 0.35 : 1;
  }

  // 起航前：在指定点附近松帆滞留
  holdNear(wind, slot, t, timeToStart) {
    const p = this.boat.phys;
    if (p.capsized) { p.ctl.righting = true; return; }
    const w = wind.sample(p.x, p.z);
    const dx = slot.x - p.x, dz = slot.z - p.z;
    const dist = Math.hypot(dx, dz);

    // 最后阶段：全速冲线
    if (timeToStart < 7 - this.skill * 2.5) {
      this.update(wind, slot.lineTarget ?? slot, t, 0);
      return;
    }
    if (dist > 14) {
      const bearing = Math.atan2(dx, -dz);
      steerTowards(p, bearing, 0.8);
      autoSheet(p, 12);
      // 别顶死风
      const twaTo = Math.abs(wrapPi(bearing - w.fromPsi));
      if (twaTo < 40 * DEG) steerTowards(p, wrapPi(w.fromPsi + (wrapPi(bearing - w.fromPsi) >= 0 ? 1 : -1) * 50 * DEG), 0.8);
    } else {
      // 滞留：横风顶帆慢漂
      const holdHeading = wrapPi(w.fromPsi + (this.tackSide || 1) * 80 * DEG);
      steerTowards(p, holdHeading, 0.5);
      p.ctl.sheet = 0.92; // 近乎空帆
    }
  }

  _holdStation(w, t) {
    const p = this.boat.phys;
    const holdHeading = wrapPi(w.fromPsi + 90 * DEG);
    steerTowards(p, holdHeading, 0.5);
    p.ctl.sheet = 0.9;
  }
}
