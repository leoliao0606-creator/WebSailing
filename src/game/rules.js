// 基本航行规则(简化版 RRS):
//  规则10 不同舷受风:左舷受风船让右舷受风船
//  规则11 同舷并列:上风船让下风船
//  规则12 同舷前后:后船让前船
//  规则31 触标:碰赛道标志(含起航线两端)受罚
// 处罚两种模式(设置可切):
//  'turns' 回转处罚(默认):碰撞判责 2 回转(RRS 44.2)、触标 1 回转(RRS 44.1),
//          未完成回转不得完赛(race.js 拦截);回转按连续净转向角累计满 360° 清一个。
//  'slow'  街机减速处罚:判责后帆效率降低数秒。
// 另提供玩家让行预警(接近中的会遇且玩家为让行方时提示)。
// 返回/发出的 rule 均为 i18n key,由调用方翻译。

import { wrapPi } from '../util/math.js';

export const PENALTY_SECONDS = 8;        // slow 模式处罚时长
export const PENALTY_POWER = 0.45;       // slow 模式处罚期帆效率
export const PENALTY_TURNS_CONTACT = 2;  // turns 模式:船间碰撞责任船回转数
export const PENALTY_TURNS_MARK = 1;     // turns 模式:触标回转数
const TURN_COMPLETE = Math.PI * 2 * 0.97; // 一个回转的净转角(留 3% 判定余量)
const TURN_RATE_GATE = 0.25;             // rad/s;低于此转率不计入回转(过滤正常航行)
const OVERLAP_LEN = 4.6;                 // 前后错开超过一船长即为"前后关系"
const WARN_DIST = 30;                    // 预警扫描半径 m

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
  constructor(wind, { mode = 'slow' } = {}) {
    this.wind = wind;
    this.mode = mode === 'turns' ? 'turns' : 'slow';
    this.events = []; // { boat, other, rule, kind: 'contact'|'mark'|'turnDone', turns }
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // 每帧:衰减处罚 / 累计回转、应用帆效率、对本帧接触与触标判责
  update(boats, contacts, dt, markContacts = []) {
    for (const b of boats) {
      if ((b.penaltyT ?? 0) > 0) b.penaltyT = Math.max(0, b.penaltyT - dt);
      if ((b.ruleCooldown ?? 0) > 0) b.ruleCooldown -= dt;
      b.phys.powerScale = (b.penaltyT ?? 0) > 0 ? PENALTY_POWER : 1;
      if (this.mode === 'turns') this.#trackTurns(b, dt);
    }
    if (contacts?.length) {
      const windPsi = this.wind.currentFromPsi();
      for (const c of contacts) {
        const { give, rule } = giveWay(c.a.phys, c.b.phys, windPsi);
        const culprit = give === 'a' ? c.a : c.b;
        const other = give === 'a' ? c.b : c.a;
        if (!this.#charge(culprit, PENALTY_TURNS_CONTACT)) continue;
        this.events.push({
          boat: culprit, other, rule, kind: 'contact', turns: culprit.penaltyTurns ?? 0,
        });
      }
    }
    if (markContacts?.length) {
      for (const c of markContacts) {
        if (!this.#charge(c.boat, PENALTY_TURNS_MARK)) continue;
        this.events.push({
          boat: c.boat, other: null, rule: 'rules.markTouch', kind: 'mark',
          turns: c.boat.penaltyTurns ?? 0,
        });
      }
    }
  }

  // 判责入账;冷却期或处罚未消化时不重复入账。返回是否入账。
  #charge(boat, turns) {
    if ((boat.ruleCooldown ?? 0) > 0) return false;
    if (this.mode === 'turns') {
      boat.penaltyTurns = (boat.penaltyTurns ?? 0) + turns;
      boat.ruleCooldown = 6;
    } else {
      if ((boat.penaltyT ?? 0) > 0) return false;
      boat.penaltyT = PENALTY_SECONDS;
      boat.ruleCooldown = PENALTY_SECONDS + 4;
    }
    return true;
  }

  // 回转累计:带符号净转角,反向转抵消;转率过低(正常航行)不计入。
  #trackTurns(b, dt) {
    const psi = b.phys.psi;
    const prev = b._rulesPrevPsi ?? psi;
    b._rulesPrevPsi = psi;
    if ((b.penaltyTurns ?? 0) <= 0) { b.turnAcc = 0; return; }
    if (b.phys.capsized || dt <= 0) return;
    const d = wrapPi(psi - prev);
    if (Math.abs(d / dt) < TURN_RATE_GATE) return;
    b.turnAcc = (b.turnAcc ?? 0) + d;
    if (Math.abs(b.turnAcc) >= TURN_COMPLETE) {
      b.penaltyTurns -= 1;
      b.turnAcc = 0;
      this.events.push({
        boat: b, other: null, rule: 'rules.turnDone', kind: 'turnDone', turns: b.penaltyTurns,
      });
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
