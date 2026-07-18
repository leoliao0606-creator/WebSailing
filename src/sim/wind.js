// 风场：基础风 + 顺风漂移的阵风团（值噪声）+ 慢速风向摆动。
// 任意位置/时刻可查询真风向量；阵风强度同时驱动水面暗斑渲染。

import { DEG, KN, headingToDir, noise1, valueNoise2, wrapPi } from '../util/math.js';
import { createSeededRandom } from './random.js';

export class WindField {
  constructor(seed) {
    this.baseFromPsi = 0;       // 基础风来向（罗盘角）
    this.baseSpeed = 12 * KN;   // m/s
    this.gustiness = 0.32;      // 阵风强度比例（±）
    this.shiftAmp = 7 * DEG;    // 风向摆动幅度
    this.shiftPeriod = 75;      // 摆动特征周期（秒）
    this.gustScale = 90;        // 阵风团空间尺度（米）
    this.time = 0;
    this.setSeed(seed);
  }

  setSeed(seed) {
    const random = seed === undefined ? Math.random : createSeededRandom(seed);
    this._seed = random() * 100;
    return this;
  }

  setBase(fromPsi, speedKn) {
    this.baseFromPsi = fromPsi;
    this.baseSpeed = Math.max(0.5, speedKn) * KN;
  }

  update(dt) {
    this.time += dt;
  }

  // 当前全局风向（含摆动，不含局部扰动）
  currentFromPsi() {
    const t = this.time / this.shiftPeriod;
    const osc = Math.sin(t * 2 * Math.PI) * 0.55 + noise1(t * 1.7 + this._seed) * 0.75;
    return wrapPi(this.baseFromPsi + this.shiftAmp * osc);
  }

  // 阵风系数 [0..~1.6]：1 为基准。位置采样，团块顺风漂移。
  gustFactor(x, z) {
    const psi = this.currentFromPsi();
    const d = headingToDir(psi); // 指向来风方向
    // 沿风向漂移：噪声坐标随时间往下风移动
    const drift = this.time * this.baseSpeed * 0.62;
    const gx = (x + d.x * drift) / this.gustScale;
    const gz = (z + d.z * drift) / this.gustScale;
    const n = valueNoise2(gx + this._seed, gz - this._seed) * 0.65 +
              valueNoise2(gx * 2.7 + 31.7, gz * 2.7) * 0.35;
    return 1 + this.gustiness * (n * 2 - 1);
  }

  // 局部风向扰动（阵风团带小角度偏转）
  localShift(x, z) {
    const s = valueNoise2(x / 140 + this.time * 0.05 + 50, z / 140 - this._seed);
    return (s * 2 - 1) * 4 * DEG;
  }

  // 查询某点真风：返回 { vx, vz, speed, fromPsi }（vx/vz 为空气流动方向向量）
  sample(x, z, out = {}) {
    const fromPsi = wrapPi(this.currentFromPsi() + this.localShift(x, z));
    const speed = this.baseSpeed * this.gustFactor(x, z);
    const d = headingToDir(fromPsi);
    out.vx = -d.x * speed; // 风从 fromPsi 吹来 => 空气朝反方向流动
    out.vz = -d.z * speed;
    out.speed = speed;
    out.fromPsi = fromPsi;
    return out;
  }
}
