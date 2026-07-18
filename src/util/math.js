// 通用数学工具。约定：世界坐标 y 向上，水面为 x/z 平面；
// 罗盘角 ψ：0 = 北(-z)，顺时针为正（东 = +x = 90°）。

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const KN = 0.514444; // 1 节 = 0.514444 m/s
export const MS2KN = 1 / KN;

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x) => clamp(x, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;

export function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// 把角度折到 (-π, π]
export function wrapPi(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

// 角度朝目标以最短路径逼近，限制每步变化量
export function turnTowards(a, target, maxStep) {
  const d = wrapPi(target - a);
  return a + clamp(d, -maxStep, maxStep);
}

// 指数平滑（帧率无关）：k 为每秒收敛速率
export function damp(cur, target, k, dt) {
  return lerp(cur, target, 1 - Math.exp(-k * dt));
}
export function dampAngle(cur, target, k, dt) {
  return cur + wrapPi(target - cur) * (1 - Math.exp(-k * dt));
}

// 罗盘角 -> 单位方向向量 (x,z)。heading 0 = -z（北）
export function headingToDir(psi) {
  return { x: Math.sin(psi), z: -Math.cos(psi) };
}
export function dirToHeading(x, z) {
  return Math.atan2(x, -z);
}

// 2D 向量小工具（{x,z} 平面）
export const v2 = {
  len: (x, z) => Math.hypot(x, z),
  dot: (ax, az, bx, bz) => ax * bx + az * bz,
};

// —— 确定性噪声（JS 侧，用于风场/阵风；GLSL 侧有等价实现）——
function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

// 值噪声，输出 [0,1]，C1 连续
export function valueNoise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

// 分形噪声 [0,1]
export function fbm2(x, z, octaves = 3) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

// 简易一维噪声（风向摆动等），输出 [-1,1]
export function noise1(t) {
  return valueNoise2(t, 17.31) * 2 - 1;
}

export function formatTime(sec) {
  if (!isFinite(sec)) return '--:--.-';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
