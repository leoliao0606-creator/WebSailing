// Gerstner 波浪场：物理（CPU 采样）与渲染（GPU 顶点位移）共用同一组参数。
// 波幅随风速缩放；波向围绕风向散布。

import { DEG, headingToDir } from '../util/math.js';

const G = 9.81;

// 基础波组（方向为相对风向的偏角）。amp 在 12kn 基准风下的波幅（米）。
const BASE_WAVES = [
  { amp: 0.16, len: 21.0, off: -24 * DEG, steep: 0.7, speedMul: 1.0 },
  { amp: 0.11, len: 13.0, off: 17 * DEG, steep: 0.8, speedMul: 1.0 },
  { amp: 0.055, len: 6.5, off: -38 * DEG, steep: 0.9, speedMul: 1.0 },
  { amp: 0.035, len: 3.6, off: 31 * DEG, steep: 1.0, speedMul: 1.05 },
  { amp: 0.02, len: 1.9, off: -9 * DEG, steep: 1.0, speedMul: 1.1 },
  { amp: 0.012, len: 1.05, off: 44 * DEG, steep: 1.0, speedMul: 1.15 },
];

export const WAVE_COUNT = BASE_WAVES.length;

export class WaveField {
  constructor() {
    // 每个波：dirX, dirZ, k(波数), omega, amp, steepQ
    this.waves = BASE_WAVES.map(() => ({ dx: 0, dz: 1, k: 1, w: 1, amp: 0, q: 0 }));
    this.time = 0;
    this.setConditions(0, 12);
  }

  // windFromPsi: 风来向罗盘角；windKn: 风速（节）
  setConditions(windFromPsi, windKn) {
    // 波幅随风速平方缩放（限制在合理范围），弱风时波长也略缩短
    const s = Math.min(2.6, Math.pow(windKn / 12, 1.6));
    const lenMul = 0.55 + 0.45 * Math.min(1.8, windKn / 12);
    for (let i = 0; i < BASE_WAVES.length; i++) {
      const b = BASE_WAVES[i];
      const w = this.waves[i];
      const travelPsi = windFromPsi + Math.PI + b.off; // 波浪顺风传播
      const d = headingToDir(travelPsi);
      const len = b.len * lenMul;
      w.dx = d.x;
      w.dz = d.z;
      w.k = (2 * Math.PI) / len;
      w.w = Math.sqrt(G * w.k) * b.speedMul; // 深水色散关系
      w.amp = b.amp * s;
      // Gerstner 尖度 Q，防止自相交：Q*k*A < 1
      w.q = Math.min(b.steep, 0.75 / (w.k * Math.max(w.amp, 1e-4) * WAVE_COUNT));
    }
  }

  update(dt) {
    this.time += dt;
  }

  // 采样波面：返回 {y, nx, ny, nz, vy, vx, vz}（高度、法线、垂向速度、水平轨道流速）。
  // vx/vz 为深水波表面水质点的轨道速度（波峰处顺波传播方向，波谷处反向）——
  // 船体水动力以此为参照系即可自然涌现冲浪/顶浪减速。
  // Gerstner 有水平位移：先用不动点迭代反解源点，使结果与 GPU 渲染面一致。
  sample(x, z, out = {}) {
    const t = this.time;
    let sx = x, sz = z;
    for (let it = 0; it < 2; it++) {
      let ox = 0, oz = 0;
      for (const w of this.waves) {
        const ph = w.k * (w.dx * sx + w.dz * sz) - w.w * t;
        const c = Math.cos(ph);
        ox += w.q * w.amp * w.dx * c;
        oz += w.q * w.amp * w.dz * c;
      }
      sx = x - ox;
      sz = z - oz;
    }
    let y = 0, dydx = 0, dydz = 0, vy = 0, vx = 0, vz = 0;
    for (const w of this.waves) {
      const ph = w.k * (w.dx * sx + w.dz * sz) - w.w * t;
      const c = Math.cos(ph), s = Math.sin(ph);
      y += w.amp * c;
      const d = -w.amp * w.k * s;
      dydx += d * w.dx;
      dydz += d * w.dz;
      vy += w.amp * w.w * s;
      // 轨道速度与波高同相（线性深水理论：|v|=Aω）
      const ov = w.amp * w.w * c;
      vx += ov * w.dx;
      vz += ov * w.dz;
    }
    out.y = y;
    out.vy = vy;
    out.vx = vx;
    out.vz = vz;
    const inv = 1 / Math.hypot(dydx, 1, dydz);
    out.nx = -dydx * inv;
    out.ny = inv;
    out.nz = -dydz * inv;
    return out;
  }

  // 打包成着色器 uniform 数组（与 water.js 中 GLSL 的解包顺序一致）
  packUniforms(target) {
    // target: Float32Array(WAVE_COUNT * 6): dx,dz,k,w,amp,q
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const o = i * 6;
      target[o] = w.dx;
      target[o + 1] = w.dz;
      target[o + 2] = w.k;
      target[o + 3] = w.w;
      target[o + 4] = w.amp;
      target[o + 5] = w.q;
    }
    return target;
  }
}
