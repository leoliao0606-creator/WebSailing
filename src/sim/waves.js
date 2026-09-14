// Gerstner 波浪场：物理（CPU 采样）与渲染（GPU 顶点位移）共用同一组参数。
//
// 谱由两部分叠加：
//  - 本地风浪(wind sea)：波长与波幅随风速成长，方向围绕风向散布。波长越短方向散
//    得越开 —— 真实方向谱 cos^{2s}(θ/2) 里 s 随频率下降，碎浪几乎各向都有。
//  - 涌浪(swell)：远处风区传来的长周期低幅波，方向与本地风无关，小风时依然存在。
//    没有它，海面会完全跟着风转，风一小就成镜子。
//
// 每个分量带一个固定相位常数。否则所有分量在 t=0、原点处同时取 cos=1，叠成一个
// 恒定的超级波峰，海面会出现规律的搓板纹。相位取黄金角序列：完全确定（联机各端
// 必须一致），又分散得足够开。
//
// 波幅/波长对风速的响应有时间常数：风变大后浪要花几十秒才长起来（setConditions
// 传 grow:true 时启用；不传则立刻到位，供开局/换场景使用）。

import { DEG, clamp, headingToDir, lerp } from '../util/math.js';

const G = 9.81;

// 基准风况：下面所有相对量以 12 节为 1.0
const REF_KN = 12;
const REF_PEAK_LEN = 21;    // 基准风下风浪的峰值波长 m
const REF_PEAK_AMP = 0.128; // 基准风下风浪峰值分量的波幅 m
const SPREAD_DEG = 23;      // 方向散布基准角：分量偏角 = spread × 此角

// 本地风浪分量。lenRel/ampRel 相对峰值；spread 方向散布系数（绝对值越大散得越开，
// 大体与 lenRel 反相关 —— 长浪方向集中、碎浪方向发散）。
// 峰值附近特意放了三个波长只差 20% 上下、方向却差 20-40° 的分量：真实海面的
// 方向谱是连续的，用少数几个离散分量去凑，能量最强的两个波会拍出规则的交叉
// 条纹，从高处看像织物纹理。把峰值能量拆散到方向不同的多个分量上才能打碎它。
// 相邻分量的波长比也刻意避开整数比，免得叠出周期性的重复图案。
// 最短的三档波幅压得很低：它们在顶点层面只会和邻档拍出规则的菱形格子（真实
// 海面同一波长有连续的方向分布，不是一个方向一个波），而对船几乎没有物理
// 作用（深度衰减后在吃水处只剩两成轨道流速）。这个尺度的粗糙感由片元着色器
// 的法线噪声负责，那里是连续的随机场，不会出格子。
const WIND_WAVES = [
  { lenRel: 1.87, ampRel: 0.34, spread: -0.42, steep: 0.55, speedMul: 1.0 },
  { lenRel: 1.31, ampRel: 0.62, spread: 0.58, steep: 0.62, speedMul: 1.0 },
  { lenRel: 1.06, ampRel: 0.88, spread: -0.16, steep: 0.70, speedMul: 1.0 },
  { lenRel: 0.87, ampRel: 1.00, spread: 0.81, steep: 0.74, speedMul: 1.0 },
  { lenRel: 0.66, ampRel: 0.74, spread: -0.97, steep: 0.80, speedMul: 1.0 },
  { lenRel: 0.47, ampRel: 0.52, spread: 0.44, steep: 0.86, speedMul: 1.02 },
  { lenRel: 0.31, ampRel: 0.38, spread: -1.38, steep: 0.92, speedMul: 1.03 },
  { lenRel: 0.185, ampRel: 0.165, spread: 1.24, steep: 1.0, speedMul: 1.05 },
  { lenRel: 0.101, ampRel: 0.082, spread: -1.58, steep: 1.0, speedMul: 1.1 },
  { lenRel: 0.053, ampRel: 0.040, spread: 1.88, steep: 1.0, speedMul: 1.15 },
];

// 涌浪分量：绝对波长/波幅（不随本地风成长），方向偏角相对涌浪来向。
const SWELL_WAVES = [
  { len: 71, amp: 0.082, off: 0, steep: 0.48, speedMul: 1.0 },
  { len: 45, amp: 0.048, off: 22 * DEG, steep: 0.55, speedMul: 1.0 },
];

export const WAVE_COUNT = WIND_WAVES.length + SWELL_WAVES.length;
export const WAVE_STRIDE = 7; // 每个波打包进 uniform 的浮点数个数：dx,dz,k,w,amp,q,ph

// 固定相位常数（黄金角 2.39996 rad 递推，均匀铺满 0..2π）
const PHASES = Array.from({ length: WAVE_COUNT }, (_, i) => (i * 2.399963229728653) % (Math.PI * 2));

// 涌浪来向相对风来向的默认夹角：涌浪来自"别处的天气"，与本地风不同向
const SWELL_OFF_DEFAULT = -37 * DEG;

// 波场对风速变化的响应时间常数（秒）
const GROWTH_TAU = 9;

export class WaveField {
  constructor() {
    // 每个波：dx,dz(传播方向), k(波数), w(角频率), amp(波幅), q(Gerstner 尖度), ph(相位)
    this.waves = Array.from({ length: WAVE_COUNT }, () => ({
      dx: 0, dz: 1, k: 1, w: 1, amp: 0, q: 0, ph: 0,
    }));
    this.time = 0;
    // 成长状态：当前值朝 target 追随（grow 模式下）
    this.peakLen = REF_PEAK_LEN;
    this.peakAmp = REF_PEAK_AMP;
    this.swellScale = 1;
    this.target = { peakLen: REF_PEAK_LEN, peakAmp: REF_PEAK_AMP, swellScale: 1 };
    this.windPsi = 0;
    this.swellPsi = SWELL_OFF_DEFAULT;
    this.setConditions(0, REF_KN);
  }

  // windFromPsi: 风来向罗盘角；windKn: 风速（节）
  // opts.swellFromPsi: 涌浪来向（省略时取风来向偏 SWELL_OFF_DEFAULT）
  // opts.grow: true 时波高/波长从当前值渐变到新风况；默认 false = 立刻到位
  setConditions(windFromPsi, windKn, opts = {}) {
    const r = Math.max(0.5, windKn) / REF_KN;
    // 峰值波长随风速成长。真实充分成长海况 ∝ U²，近岸有限风区要平缓些，取 1.35 次方。
    this.target.peakLen = REF_PEAK_LEN * clamp(Math.pow(r, 1.35), 0.34, 2.7);
    // 峰值波幅 ∝ U^1.55（与波长的比值即波陡度，随风速缓慢增加）
    this.target.peakAmp = REF_PEAK_AMP * Math.min(2.45, Math.pow(r, 1.55));
    // 涌浪基本不受本地风影响，只轻微跟随
    this.target.swellScale = 0.78 + 0.22 * Math.min(1.6, r);
    this.windPsi = windFromPsi;
    this.swellPsi = opts.swellFromPsi ?? (windFromPsi + SWELL_OFF_DEFAULT);
    if (!opts.grow) {
      this.peakLen = this.target.peakLen;
      this.peakAmp = this.target.peakAmp;
      this.swellScale = this.target.swellScale;
    }
    this._rebuild();
  }

  update(dt) {
    this.time += dt;
    const t = this.target;
    if (this.peakAmp === t.peakAmp && this.peakLen === t.peakLen) return;
    if (Math.abs(this.peakAmp - t.peakAmp) < 1e-4 && Math.abs(this.peakLen - t.peakLen) < 0.01) {
      // 指数追随永远到不了目标，够近就吸附（1 cm 的波长差看不出来），
      // 免得每帧都白重建一遍波参数
      this.peakAmp = t.peakAmp;
      this.peakLen = t.peakLen;
      this.swellScale = t.swellScale;
    } else {
      const k = 1 - Math.exp(-dt / GROWTH_TAU);
      this.peakLen = lerp(this.peakLen, t.peakLen, k);
      this.peakAmp = lerp(this.peakAmp, t.peakAmp, k);
      this.swellScale = lerp(this.swellScale, t.swellScale, k);
    }
    this._rebuild();
  }

  _rebuild() {
    const nWind = WIND_WAVES.length;
    for (let i = 0; i < WAVE_COUNT; i++) {
      const w = this.waves[i];
      let len, amp, travelPsi, steep, speedMul;
      if (i < nWind) {
        const b = WIND_WAVES[i];
        len = this.peakLen * b.lenRel;
        amp = this.peakAmp * b.ampRel;
        travelPsi = this.windPsi + Math.PI + b.spread * SPREAD_DEG * DEG; // 波浪顺风传播
        steep = b.steep;
        speedMul = b.speedMul;
      } else {
        const b = SWELL_WAVES[i - nWind];
        len = b.len;
        amp = b.amp * this.swellScale;
        travelPsi = this.swellPsi + Math.PI + b.off;
        steep = b.steep;
        speedMul = b.speedMul;
      }
      const d = headingToDir(travelPsi);
      w.dx = d.x;
      w.dz = d.z;
      w.k = (2 * Math.PI) / len;
      w.w = Math.sqrt(G * w.k) * speedMul; // 深水色散关系
      w.amp = amp;
      w.ph = PHASES[i];
      // Gerstner 尖度 Q，防止波面自相交：Q*k*A < 1
      w.q = Math.min(steep, 0.72 / (w.k * Math.max(amp, 1e-4) * WAVE_COUNT));
    }
  }

  // 采样波面：返回 {y, nx, ny, nz, vy, vx, vz}（高度、法线、垂向速度、水平轨道流速）。
  // depth: 采样点在水面以下的深度（米）。深水波的水质点轨道半径随深度按 e^{-k·depth}
  // 衰减 —— 碎浪在船体吃水处几乎没有流速，长浪几乎不衰减，这决定了哪些浪真能推船。
  // 高度与法线是表面量，不受 depth 影响。
  // Gerstner 有水平位移：先用不动点迭代反解源点，使结果与 GPU 渲染面一致。
  sample(x, z, out = {}, depth = 0) {
    const t = this.time;
    let sx = x, sz = z;
    for (let it = 0; it < 2; it++) {
      let ox = 0, oz = 0;
      for (const w of this.waves) {
        const ph = w.k * (w.dx * sx + w.dz * sz) - w.w * t + w.ph;
        const c = Math.cos(ph);
        ox += w.q * w.amp * w.dx * c;
        oz += w.q * w.amp * w.dz * c;
      }
      sx = x - ox;
      sz = z - oz;
    }
    let y = 0, dydx = 0, dydz = 0, vy = 0, vx = 0, vz = 0;
    for (const w of this.waves) {
      const ph = w.k * (w.dx * sx + w.dz * sz) - w.w * t + w.ph;
      const c = Math.cos(ph), s = Math.sin(ph);
      y += w.amp * c;
      const d = -w.amp * w.k * s;
      dydx += d * w.dx;
      dydz += d * w.dz;
      // 轨道速度与波高同相（线性深水理论：|v|=Aω），随深度指数衰减
      const decay = depth > 0 ? Math.exp(-w.k * depth) : 1;
      vy += w.amp * w.w * s * decay;
      const ov = w.amp * w.w * c * decay;
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
    // target: Float32Array(WAVE_COUNT * WAVE_STRIDE): dx,dz,k,w,amp,q,ph
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const o = i * WAVE_STRIDE;
      target[o] = w.dx;
      target[o + 1] = w.dz;
      target[o + 2] = w.k;
      target[o + 3] = w.w;
      target[o + 4] = w.amp;
      target[o + 5] = w.q;
      target[o + 6] = w.ph;
    }
    return target;
  }
}
