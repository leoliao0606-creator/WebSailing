// 船间碰撞:每条船近似为沿艏向的胶囊体(线段 + 半径),取代圆形碰撞。
// 解算给出位置分离、法向冲量(等质量均分)、接触点艏摇反馈与擦碰减速,
// 并返回接触列表供航行规则引擎判责。

import { clamp } from '../util/math.js';

export const HULL_HALF_LEN = 1.7;  // 胶囊线段半长 m(总长 ≈ 4.8m,含舵/艏斜坡余量)
export const HULL_RADIUS = 0.72;   // 胶囊半径 m(≈ 半船宽)
const RESTITUTION = 0.2;           // 碰撞恢复系数(玻璃钢船体的沉闷碰撞)
const YAW_KICK = 0.35;             // 接触力矩 -> 艏摇角速度增益(1/回转半径² 量级)

// 两条 2D 线段的最近点对(Ericson 标准算法)。
// 返回 { d, px, pz, qx, qz }:d 为最近距离,P 在 A 段上,Q 在 B 段上。
export function segSegClosest(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1x = bx - ax, d1z = bz - az;
  const d2x = dx - cx, d2z = dz - cz;
  const rx = ax - cx, rz = az - cz;
  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) {
    s = 0; t = 0;
  } else if (a <= 1e-9) {
    s = 0; t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1z * rz;
    if (e <= 1e-9) {
      t = 0; s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > 1e-9 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const px = ax + d1x * s, pz = az + d1z * s;
  const qx = cx + d2x * t, qz = cz + d2z * t;
  return { d: Math.hypot(qx - px, qz - pz), px, pz, qx, qz };
}

function worldVel(p) {
  const s = Math.sin(p.psi), c = Math.cos(p.psi);
  return { x: p.u * s + p.v * c, z: -p.u * c + p.v * s };
}

function setWorldVel(p, vx, vz) {
  const s = Math.sin(p.psi), c = Math.cos(p.psi);
  p.u = vx * s - vz * c;
  p.v = vx * c + vz * s;
}

// 解算一对船的胶囊碰撞;有接触时修改两船状态并返回接触信息,否则返回 null。
export function collidePair(A, B) {
  const fax = Math.sin(A.psi), faz = -Math.cos(A.psi);
  const fbx = Math.sin(B.psi), fbz = -Math.cos(B.psi);
  const seg = segSegClosest(
    A.x - fax * HULL_HALF_LEN, A.z - faz * HULL_HALF_LEN,
    A.x + fax * HULL_HALF_LEN, A.z + faz * HULL_HALF_LEN,
    B.x - fbx * HULL_HALF_LEN, B.z - fbz * HULL_HALF_LEN,
    B.x + fbx * HULL_HALF_LEN, B.z + fbz * HULL_HALF_LEN,
  );
  const minD = 2 * HULL_RADIUS;
  if (seg.d >= minD) return null;

  // 法线 A -> B;完全重叠时退化到中心连线或横向
  let nx, nz;
  if (seg.d > 1e-4) {
    nx = (seg.qx - seg.px) / seg.d;
    nz = (seg.qz - seg.pz) / seg.d;
  } else {
    const cd = Math.hypot(B.x - A.x, B.z - A.z);
    if (cd > 1e-4) { nx = (B.x - A.x) / cd; nz = (B.z - A.z) / cd; }
    else { nx = Math.cos(A.psi); nz = Math.sin(A.psi); }
  }

  const overlap = minD - seg.d;
  A.x -= nx * overlap * 0.5; A.z -= nz * overlap * 0.5;
  B.x += nx * overlap * 0.5; B.z += nz * overlap * 0.5;

  const va = worldVel(A), vb = worldVel(B);
  const relN = (vb.x - va.x) * nx + (vb.z - va.z) * nz;
  let closing = 0;
  if (relN < 0) {
    closing = -relN;
    // 等质量:法向闭合速度均分并带一点回弹
    const imp = closing * (1 + RESTITUTION) * 0.5;
    setWorldVel(A, va.x - nx * imp, va.z - nz * imp);
    setWorldVel(B, vb.x + nx * imp, vb.z + nz * imp);

    // 接触点不在重心时把船头/船尾"推开"(τ = r × F,体轴 x前 y右)
    const kick = (P, cx2, cz2, sgn) => {
      const s = Math.sin(P.psi), c = Math.cos(P.psi);
      const rbx = (cx2 - P.x) * s - (cz2 - P.z) * c;                  // 体轴前向力臂
      const rby = (cx2 - P.x) * c + (cz2 - P.z) * s;                  // 体轴右向力臂
      const Fbx = (sgn * nx) * s - (sgn * nz) * c;
      const Fby = (sgn * nx) * c + (sgn * nz) * s;
      P.yawRate += clamp((rbx * Fby - rby * Fbx) * imp * YAW_KICK, -0.9, 0.9);
    };
    kick(A, seg.px, seg.pz, -1);
    kick(B, seg.qx, seg.qz, 1);

    // 擦碰刮蹭减速
    A.u *= 0.985; B.u *= 0.985;
  }

  return {
    nx, nz, overlap, closing,
    px: (seg.px + seg.qx) * 0.5,
    pz: (seg.pz + seg.qz) * 0.5,
  };
}

// 全船队碰撞解算,返回接触列表 [{a, b, nx, nz, overlap, closing, px, pz}]
export function resolveBoatCollisions(boats) {
  const contacts = [];
  const reach = 2 * (HULL_HALF_LEN + HULL_RADIUS);
  for (let i = 0; i < boats.length; i++) {
    for (let j = i + 1; j < boats.length; j++) {
      const A = boats[i].phys, B = boats[j].phys;
      const dx = B.x - A.x, dz = B.z - A.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      const c = collidePair(A, B);
      if (c) contacts.push({ a: boats[i], b: boats[j], ...c });
    }
  }
  return contacts;
}
