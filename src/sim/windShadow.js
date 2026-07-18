// 船对船风影（dirty air）：上风船的帆在下风侧投出一条逐渐展宽、逐渐衰减的乱流带。
// 处在别人风影里 = 视风变小 => 帆力下降，竞速时的抢风/盖风战术由此而来。

export const SHADOW_LEN = 42;    // 风影长度 m（约 7 倍桅高）
export const SHADOW_PEAK = 0.42; // 紧贴下风时的最大风速损失比例

// 采样点 (x,z) 处受 boats（排除 exclude）遮挡后的风速系数 [minF..1]
export function shadowFactorAt(x, z, fromPsi, boats, exclude = null) {
  let f = 1;
  const dwx = -Math.sin(fromPsi); // 下风方向（风吹去的方向）
  const dwz = Math.cos(fromPsi);
  for (const b of boats) {
    if (b === exclude) continue;
    const p = b.phys;
    if (!p || p.capsized) continue; // 翻船的帆躺在水面，不挡风
    const rx = x - p.x, rz = z - p.z;
    const along = rx * dwx + rz * dwz;      // 在其下风多远
    if (along < 1 || along > SHADOW_LEN) continue;
    const lat = -rx * dwz + rz * dwx;       // 横向偏离风影中轴
    const halfW = 2.4 + along * 0.15;       // 乱流带随距离展宽
    const g = Math.exp(-(lat * lat) / (halfW * halfW));
    f -= SHADOW_PEAK * (1 - along / SHADOW_LEN) * g;
  }
  return Math.max(0.4, f);
}

// 风场代理：包在 WindField 外面，sample() 结果叠加当前船队的风影。
// 用法：每帧把 boats 指向船队，逐船设置 exclude 后再 update 该船。
export class ShadowedWind {
  constructor(base) {
    this.base = base;
    this.boats = [];
    this.exclude = null;
  }

  sample(x, z, out = {}) {
    const w = this.base.sample(x, z, out);
    const f = shadowFactorAt(x, z, w.fromPsi, this.boats, this.exclude);
    if (f < 1) {
      w.vx *= f;
      w.vz *= f;
      w.speed *= f;
    }
    return w;
  }

  // 透传 AI/HUD 会用到的只读接口
  get baseFromPsi() { return this.base.baseFromPsi; }
  get baseSpeed() { return this.base.baseSpeed; }
  currentFromPsi() { return this.base.currentFromPsi(); }
  gustFactor(x, z) { return this.base.gustFactor(x, z); }
}
