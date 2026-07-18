// 基本航行规则(简化版 RRS):
//  规则10 不同舷受风:左舷受风船让右舷受风船
//  规则11 同舷并列:上风船让下风船
//  规则12 同舷前后:后船让前船
// 发生碰撞时判责让行方并给予"减速处罚"(帆效率降低数秒);
// 另提供玩家让行预警(接近中的会遇且玩家为让行方时提示)。
// 返回/发出的 rule 均为 i18n key,由调用方翻译。

import { wrapPi } from '../util/math.js';

export const PENALTY_SECONDS = 8;   // 处罚时长
export const PENALTY_POWER = 0.45;  // 处罚期帆效率
const OVERLAP_LEN = 4.6;            // 前后错开超过一船长即为"前后关系"
const WARN_DIST = 30;               // 预警扫描半径 m

// 受风舷:twa > 0 = 风来自右舷(starboard tack)
export function tackOf(phys) {
  return (phys.out?.twaDeg ?? 0) >= 0 ? 'starboard' : 'port';
}

// a 是否完全处于 b 的正后方(以 b 的艏向为准)
export function isClearAstern(a, b) {
  const fx = Math.sin(b.psi), fz = -Math.cos(b.psi);
  return (a.x - b.x) * fx + (a.z - b.z) * fz < -OVERLAP_LEN;
}

export function isOverlapped(a, b) {
  return !isClearAstern(a, b) && !isClearAstern(b, a);
}

// 判定让行方。a/b 为 phys;返回 { give: 'a'|'b', rule }
export function giveWay(a, b, windFromPsi) {
  const ta = tackOf(a), tb = tackOf(b);
  if (ta !== tb) {
    return { give: ta === 'port' ? 'a' : 'b', rule: 'rules.portStb' };
  }
  if (isOverlapped(a, b)) {
    const ux = Math.sin(windFromPsi), uz = -Math.cos(windFromPsi); // 指向上风
    const d = (b.x - a.x) * ux + (b.z - a.z) * uz;
    return { give: d > 0 ? 'b' : 'a', rule: 'rules.windward' };
  }
  return { give: isClearAstern(a, b) ? 'a' : 'b', rule: 'rules.astern' };
}

function worldVel(p) {
  const s = Math.sin(p.psi), c = Math.cos(p.psi);
  return { x: p.u * s + p.v * c, z: -p.u * c + p.v * s };
}

export class RulesEngine {
  constructor(wind) {
    this.wind = wind;
    this.events = []; // { boat, other, rule }
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // 每帧:衰减处罚、应用帆效率、对本帧接触判责
  update(boats, contacts, dt) {
    for (const b of boats) {
      if ((b.penaltyT ?? 0) > 0) b.penaltyT = Math.max(0, b.penaltyT - dt);
      if ((b.ruleCooldown ?? 0) > 0) b.ruleCooldown -= dt;
      b.phys.powerScale = (b.penaltyT ?? 0) > 0 ? PENALTY_POWER : 1;
    }
    if (!contacts?.length) return;
    const windPsi = this.wind.currentFromPsi();
    for (const c of contacts) {
      const { give, rule } = giveWay(c.a.phys, c.b.phys, windPsi);
      const culprit = give === 'a' ? c.a : c.b;
      const other = give === 'a' ? c.b : c.a;
      if ((culprit.penaltyT ?? 0) > 0 || (culprit.ruleCooldown ?? 0) > 0) continue;
      culprit.penaltyT = PENALTY_SECONDS;
      culprit.ruleCooldown = PENALTY_SECONDS + 4;
      this.events.push({ boat: culprit, other, rule });
    }
  }

  // 玩家让行预警:返回 { rule, dist } 或 null
  warningFor(player, boats) {
    if (!player || player.phys.capsized) return null;
    const p = player.phys;
    const pv = worldVel(p);
    let best = null;
    for (const b of boats) {
      if (b === player || !b.phys || b.phys.capsized) continue;
      const q = b.phys;
      const dx = q.x - p.x, dz = q.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > WARN_DIST || dist < 1e-3) continue;
      const qv = worldVel(q);
      // 相对接近速度(>0 = 正在靠近)
      const closing = -((qv.x - pv.x) * dx + (qv.z - pv.z) * dz) / dist;
      if (closing < 0.4 && dist > 12) continue;
      const { give, rule } = giveWay(p, q, this.wind.currentFromPsi());
      if (give !== 'a') continue;
      if (!best || dist < best.dist) best = { rule, dist };
    }
    return best;
  }
}

// 供测试与调用方使用的角度工具透传
export { wrapPi };
