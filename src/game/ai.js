// AI 舵手：与玩家完全相同的物理模型。
// 策略：迎风走 VMG 角 + layline 判断调向 + 脏风逃逸;顺风走换舷角 + 追浪偏置;
// 横风直航;起航冲向起航线有利端;罚转(rules.js turns 模式)满舵消罚。
// 阵风过载时松帆减横倾。skill 影响调帆精度、反应与战术开关。

import { DEG, clamp, wrapPi } from '../util/math.js';
import { steerTowards, autoSheet } from '../sim/helm.js';
import { createSeededRandom } from '../sim/random.js';

const UPWIND_TWA = 45 * DEG;    // 目标迎风角
const DOWNWIND_TWA = 152 * DEG; // 目标顺风换舷角

// 起航线有利端:把 pin->committee 连线与上风向做投影,
// 返回 [-1, +1]:+1 = pin 端完全上风(有利),-1 = 委员会端有利。
export function favoredLineEnd(windFromPsi, course) {
  const ux = Math.sin(windFromPsi), uz = -Math.cos(windFromPsi); // 指向上风
  const dx = course.pin.x - course.committee.x;
  const dz = course.pin.z - course.committee.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return 0;
  return clamp((dx * ux + dz * uz) / len, -1, 1);
}

// 脏风逃逸:持续处于风影(shadowF 低)且换舷冷却已过、不在绕标进近段时换舷。
export function shouldEscapeShadow(shadowF, shadowT, sinceManeuver, distToTarget) {
  return shadowF < 0.88 && shadowT > 2 && sinceManeuver > 8 && distToTarget > 60;
}

// 顺风追浪转向偏置(rad):上浪背(surf>0,m/s²)向正顺风压低延长冲浪,
// 减速面(surf<0)抬头保速;新手 AI(skill<0.8)不启用。
export function surfSteerBias(surf, skill) {
  if (skill < 0.8) return 0;
  if (surf > 0.15) return Math.min((surf - 0.15) * 40, 10) * DEG;
  if (surf < -0.08) return Math.max((surf + 0.08) * 55, -8) * DEG;
  return 0;
}

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
    this.shadowT = 0;      // 连续处于脏风的时长 s
    this.surfBiasSm = 0;   // 追浪偏置平滑值 rad
    return this;
  }

  // target: {x,z} 下一个目标点；t 当前时间
  update(wind, target, t, dt) {
    const p = this.boat.phys;
    const w = wind.sample(p.x, p.z);
    if (p.capsized) { p.ctl.righting = true; return; }
    p.ctl.righting = false;
    p.ctl.autoHike = true;

    // 罚转执行:满舵向落帆侧回转直到清罚(rules.js 按净转角累计)
    if ((this.boat.penaltyTurns ?? 0) > 0) {
      p.ctl.rudder = -Math.sign(p.out?.twaDeg || 1);
      autoSheet(p, 20);
      p.ctl.board = 1;
      return;
    }

    // 脏风计时(shadowF 由 main.js 每帧写入)
    this.shadowT = (this.boat.shadowF ?? 1) < 0.88 ? (this.shadowT ?? 0) + (dt || 0) : 0;

    if (!target) { this._holdStation(w, t); return; }

    const dx = target.x - p.x, dz = target.z - p.z;
    const distToTarget = Math.hypot(dx, dz);
    const bearing = Math.atan2(dx, -dz); // 罗盘角
    const bearingTwa = wrapPi(bearing - w.fromPsi); // 目标方位相对风向（=需要航行的真风角）

    let targetHeading;
    const absBT = Math.abs(bearingTwa);

    if (absBT < UPWIND_TWA + 6 * DEG) {
      // —— 迎风段：沿走廊短抢风 ——
      const tackTwa = UPWIND_TWA + 3 * DEG;
      const headA = wrapPi(w.fromPsi + this.tackSide * tackTwa);
      // layline 判断：另一舷的航向能否直达目标（留 6° 余量）
      const otherHeading = wrapPi(w.fromPsi - this.tackSide * tackTwa);
      const fetch = Math.abs(wrapPi(bearing - otherHeading)) < 6 * DEG * this.skill;
      // 走廊:偏离“过标迎风轴”超过阈值就抢回中线一侧。没有这条,AI 只在够到
      // layline 时才换舷 —— 长迎风腿的 layline 在几百米外,会一路冲到角落“跑飞”。
      // 阈值随剩余距离收窄:远处宽松多蛇行,近标自然过渡到 layline 进近。
      const perpX = Math.cos(w.fromPsi), perpZ = Math.sin(w.fromPsi); // 迎风轴法向(起航线方向)
      const lateral = (p.x - target.x) * perpX + (p.z - target.z) * perpZ;
      const corridor = clamp(distToTarget * 0.25, 28, 62);
      const latV1 = Math.sin(w.fromPsi + tackTwa) * perpX - Math.cos(w.fromPsi + tackTwa) * perpZ;
      const corridorTack = -Math.sign(lateral || 1) * Math.sign(latV1 || 1); // 把船带回中线的舷
      const strayed = Math.abs(lateral) > corridor && this.tackSide !== corridorTack;
      const sinceManeuver = t - this.lastManeuverT;
      if ((fetch || strayed) && sinceManeuver > 9 && distToTarget > 30) {
        this.tackSide = (strayed && !fetch) ? corridorTack : -this.tackSide;
        this.lastManeuverT = t;
      } else if (this.skill >= 0.8
        && shouldEscapeShadow(this.boat.shadowF ?? 1, this.shadowT, sinceManeuver, distToTarget)) {
        // 被盖住了:提前换舷抢清风
        this.tackSide *= -1;
        this.lastManeuverT = t;
        this.shadowT = 0;
      }
      // 快到目标时若本舷直达就直冲
      if (Math.abs(wrapPi(bearing - headA)) < 4 * DEG || distToTarget < 25) {
        targetHeading = Math.abs(wrapPi(bearing - w.fromPsi)) > 38 * DEG ? bearing : headA;
      } else {
        targetHeading = wrapPi(w.fromPsi + this.tackSide * tackTwa);
      }
    } else if (absBT > DOWNWIND_TWA) {
      // —— 顺风段：换舷角航行 + 追浪偏置 ——
      const bias = surfSteerBias(p.out?.surf ?? 0, this.skill);
      const rate = 0.6; // rad/s 一阶平滑防舵抖
      this.surfBiasSm += clamp(bias - this.surfBiasSm, -rate * (dt || 0), rate * (dt || 0));
      const gybeTwa = clamp(DOWNWIND_TWA + this.surfBiasSm, 120 * DEG, 176 * DEG);
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

    // 最后阶段：全速冲线,冲线目标沿线向有利端平移(留出两端障碍余量)
    if (timeToStart < 7 - this.skill * 2.5) {
      let target = slot.lineTarget ?? slot;
      const c = this.course;
      if (c && slot.lineTarget) {
        const favored = favoredLineEnd(w.fromPsi, c);
        const lx = c.committee.x - c.pin.x, lz = c.committee.z - c.pin.z;
        const len = Math.hypot(lx, lz) || 1;
        const ux = lx / len, uz = lz / len; // pin -> committee
        const s0 = (target.x - c.pin.x) * ux + (target.z - c.pin.z) * uz;
        // favored>0 = pin 端有利 → 向 pin 方向(s 减小)平移
        const s1 = clamp(s0 - favored * (8 + 18 * this.skill), 12, len - 12);
        target = { x: target.x + ux * (s1 - s0), z: target.z + uz * (s1 - s0) };
      }
      this.update(wind, target, t, 0);
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
    // 无目标(已完赛/收帆):顶风放帆缓缓停住,别一路横漂到天边去
    steerTowards(p, w.fromPsi, 0.5);
    p.ctl.sheet = 1;
    p.ctl.board = 1;
  }
}
