// 升力体模型：帆（有拱度软翼）与水下附体（稳向板/舵叶，对称薄翼）。
// 所有攻角以弧度计。系数曲线为分段平滑的经验拟合，可调。

import { DEG, clamp, lerp, smoothstep } from '../util/math.js';

export const RHO_AIR = 1.225;
export const RHO_WATER = 1025;

// ---------- 帆：有拱度单桅主帆 ----------
// 软帆换舷时拱度自动翻面 => 模型对左右攻角对称（升力变号，阻力不变）。
// |α| 很小时帆成形不了（抖动，无升力）；失速后过渡到平板阻力特性；
// |α|>90°（以背风行驶，流从帆尾缘先到）效率打折。
export function sailCoeffs(alpha) {
  const s = Math.sign(alpha) || 1;
  const a = Math.abs(alpha);
  const aDeg = a / DEG;
  const ramp = smoothstep(1.5, 8, aDeg); // 抖动 -> 吃风成形
  const clPre = 1.52 * Math.pow(Math.sin((Math.PI / 2) * Math.min(1, aDeg / 24)), 1.1) * ramp;
  const cdPre = 0.05 + 0.1 * Math.pow(aDeg / 24, 2) * ramp + 0.02;
  const sinA = Math.sin(a);
  const clPost = Math.max(0, 1.15 * Math.sin(2 * a));
  const cdPost = 0.05 + 1.85 * sinA * sinA;
  const blend = smoothstep(26, 44, aDeg);
  let cl = lerp(clPre, clPost, blend);
  let cd = Math.max(0.05, lerp(cdPre, cdPost, blend));
  if (aDeg > 95) { cl *= 0.7; cd *= 0.85; } // 尾缘先受流
  return { cl: s * cl, cd };
}

// 帆抖动（luffing）程度 [0..1]：攻角不足时帆无法成形
export function sailLuff(alpha) {
  return 1 - smoothstep(2 * DEG, 9 * DEG, Math.abs(alpha));
}

// ---------- 对称水下翼（稳向板 / 舵叶）----------
// 薄翼 + 有限展弦比修正；超过失速角后升力骤降（出弯横漂的来源）。
export function foilCoeffs(alpha, aspect = 3.5, stallDeg = 16) {
  const s = Math.sign(alpha) || 1;
  const a = Math.abs(alpha);
  const aDeg = a / DEG;
  const slope = (2 * Math.PI) / (1 + 2 / aspect); // 每弧度
  let cl, cd;
  if (aDeg <= stallDeg) {
    cl = slope * a;
    cd = 0.009 + (cl * cl) / (Math.PI * aspect * 0.85);
  } else {
    // 失速：过渡到平板
    const clStall = 0.95 * Math.sin(2 * a);
    const clMax = slope * stallDeg * DEG;
    const blend = smoothstep(stallDeg, stallDeg + 12, aDeg);
    cl = lerp(clMax * 0.92, Math.abs(clStall), blend);
    cd = 0.009 + (clMax * clMax) / (Math.PI * aspect * 0.85) + 1.6 * Math.pow(Math.sin(a), 2) * blend;
  }
  return { cl: s * cl, cd };
}

// 通用 2D 翼受力：在船体坐标系 (x=前, y=右) 内计算。
// flow: 来流向量（水/空气相对翼的运动）; chordAngle: 弦线相对船艏方向的角度（右偏为正）
// 返回 { fx, fy, alpha }。升力方向约定：攻角为正（来流打在右舷侧）时升力指向左。
export function foilForce2D(flowX, flowY, chordAngle, area, rho, coeffFn) {
  const V2 = flowX * flowX + flowY * flowY;
  if (V2 < 1e-6) return { fx: 0, fy: 0, alpha: 0 };
  const V = Math.sqrt(V2);
  const wx = flowX / V, wy = flowY / V; // 来流方向单位向量
  // 攻角：来流相对弦线的角度。弦线朝向 chordAngle，来流应大致从 -弦向 打来。
  const flowAng = Math.atan2(flowY, flowX);
  let alpha = flowAng - (chordAngle + Math.PI);
  // wrap 到 (-π, π]
  alpha = Math.atan2(Math.sin(alpha), Math.cos(alpha));
  const { cl, cd } = coeffFn(alpha);
  const q = 0.5 * rho * area * V2;
  // 阻力沿来流方向；升力垂直来流。alpha>0（来流偏向右舷打来）=> 升力朝左(-y 侧)。
  // 垂直方向：rot90ccw(w) = (-wy, wx)。验证：flow=(-1, ε>0)（正攻角）=> cl>0，
  // 升力应有 -y 分量：cl * (-wy, wx) = cl*(-ε, -1) ✓ 指向 -y。
  const fx = q * (cd * wx + cl * -wy);
  const fy = q * (cd * wy + cl * wx);
  return { fx, fy, alpha };
}
