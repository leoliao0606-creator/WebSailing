// 船只实体：物理 + 视觉 + 尾流特效 + 事件检测（调向/换舷/翻船）+ 岛屿碰撞。

import { DEG, clamp, wrapPi } from '../util/math.js';
import { BoatPhysics } from '../sim/boatPhysics.js';
import { autoSheet } from '../sim/helm.js';
import { createBoatVisual } from '../render/boatModel.js';
import { BoatEffects } from '../render/effects.js';

let nextLocalBoatId = 1;

function optionalId(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

export function resolveBoatIdentity(opts = {}) {
  const playerId = optionalId(opts.playerId, 'playerId');
  const boatId = optionalId(opts.boatId, 'boatId')
    ?? playerId
    ?? `local-boat-${nextLocalBoatId++}`;
  const isLocal = opts.isLocal === undefined ? !!opts.isPlayer : !!opts.isLocal;
  return { boatId, playerId, isLocal, isPlayer: isLocal };
}

export class Boat {
  constructor(scene, waveField, opts = {}) {
    this.phys = new BoatPhysics();
    this.visual = createBoatVisual(opts);
    scene.add(this.visual.group);
    this.effects = new BoatEffects(scene, waveField);
    this.waveField = waveField;
    this.scene = scene;
    Object.assign(this, resolveBoatIdentity(opts));
    // isPlayer 继续作为 HUD / 教学中原有的本地玩家判断。
    this.displayName = typeof opts.nickname === 'string'
      ? opts.nickname
      : (typeof opts.displayName === 'string' ? opts.displayName : null);
    this.nameKey = opts.nameKey ?? 'name.player'; // 显示时经 t() 翻译

    // 玩家控制的中间状态
    this.rudderCmd = 0;
    this.hikeLevel = 0;
    this.manualSheetAt = -99;

    // 航行规则处罚状态(rules.js 读写)
    this.penaltyT = 0;
    this.ruleCooldown = 0;

    // 事件计数（教学/音效用）
    this.events = { tacks: 0, gybes: 0, capsizes: 0 };
    this._prevTwaSign = 0;
    this._prevBoomSign = 0;
    this._prevCapsized = false;
    this._prevPos = { x: 0, z: 0 };
  }

  place(x, z, psi, speed = 0) {
    const p = this.phys;
    p.x = x; p.z = z; p.psi = psi;
    p.u = speed; p.v = 0;
    p.yawRate = 0; p.phi = 0; p.phiRate = 0;
    p.capsized = false;
    p.sheet = p.ctl.sheet = 1;
    p.board = p.ctl.board = 1;
    p.powerScale = 1;
    this.penaltyT = 0;
    this.ruleCooldown = 0;
    this._prevPos = { x, z };
  }

  // 兼容离线键盘输入；联机路径可直接应用同一种可序列化意图。
  applyInput(input, settings, dt, time) {
    this.applyControlIntent(input.controlIntent(), settings, dt, time);
  }

  // 控制意图 -> 控制量
  applyControlIntent(intent, settings, dt, time) {
    const p = this.phys;
    const ctl = p.ctl;

    // 舵：按住渐进，松开回中
    const want = (intent.steerRight ? 1 : 0) - (intent.steerLeft ? 1 : 0);
    const rate = want !== 0 ? 2.6 : 3.4;
    this.rudderCmd += clamp(want - this.rudderCmd, -rate * dt, rate * dt);
    if (want === 0 && Math.abs(this.rudderCmd) < 0.04) this.rudderCmd = 0;
    ctl.rudder = this.rudderCmd;

    // 缭绳
    const sheetDir = (intent.sheetOut ? 1 : 0) - (intent.sheetIn ? 1 : 0);
    if (sheetDir !== 0) {
      ctl.sheet = clamp(ctl.sheet + sheetDir * 0.5 * dt, 0, 1);
      this.manualSheetAt = time;
    } else if (settings.autoTrim && time - this.manualSheetAt > 2.5) {
      // 辅助调帆：过载时松帆减横倾（与 AI 同款生存逻辑）
      const over = Math.abs(p.out.heelDeg) - 24;
      autoSheet(p, over > 0 ? Math.max(4, 16 - over * 1.1) : 16);
    }

    // 压舷（相对：q 向外压，e 收进来）
    const hikeDir = (intent.hikeOut ? 1 : 0) - (intent.hikeIn ? 1 : 0);
    ctl.autoHike = settings.autoHike;
    if (settings.autoHike) {
      const side = p.crewY >= 0 ? 1 : -1;
      ctl.hike = hikeDir * side * 0.9;
    } else {
      this.hikeLevel = clamp(this.hikeLevel + hikeDir * 1.4 * dt * (p.crewY >= 0 ? 1 : -1), -1, 1);
      if (Math.abs(p.out.heelDeg) < 1 && hikeDir === 0) this.hikeLevel *= 1 - dt * 0.3;
      ctl.hike = this.hikeLevel;
    }

    // 稳向板
    const boardDir = (intent.boardDown ? 1 : 0) - (intent.boardUp ? 1 : 0);
    if (boardDir !== 0) ctl.board = clamp(ctl.board + boardDir * 0.6 * dt, 0, 1);

    // 翻船扶正
    ctl.righting = !!intent.righting;
  }

  simulate(wind, dt, time, islands = null, audio = null) {
    const p = this.phys;
    this._prevPos.x = p.x;
    this._prevPos.z = p.z;
    p.step(wind, dt, this.waveField);

    if (islands) this._collideIslands(islands);

    // —— 事件检测 ——
    const twa = p.out.twaDeg;
    const twaSign = Math.abs(twa) < 90 && Math.abs(twa) > 2 ? Math.sign(twa) : 0;
    if (twaSign !== 0 && this._prevTwaSign !== 0 && twaSign !== this._prevTwaSign) {
      this.events.tacks++;
      this.lastTackAt = time;
    }
    if (twaSign !== 0) this._prevTwaSign = twaSign;

    const boomSign = Math.abs(p.boom) > 8 * DEG ? Math.sign(p.boom) : 0;
    if (boomSign !== 0 && this._prevBoomSign !== 0 && boomSign !== this._prevBoomSign) {
      if (Math.abs(twa) > 110) {
        this.events.gybes++;
        this.lastGybeAt = time;
        if (audio && this.isPlayer) audio.gybeThunk();
      }
    }
    if (boomSign !== 0) this._prevBoomSign = boomSign;

    if (p.capsized && !this._prevCapsized) {
      this.events.capsizes++;
      if (audio && this.isPlayer) audio.splash();
    }
    this._prevCapsized = p.capsized;

  }

  // 联机远端船只只消费权威快照并渲染，不在 guest 上推进物理。
  render(time, dt) {
    this.visual.update(this.phys, this.waveField, time, dt);
    this.effects.update(this.phys, dt);
  }

  // 兼容原离线调用路径。
  update(wind, dt, time, islands = null, audio = null) {
    this.simulate(wind, dt, time, islands, audio);
    this.render(time, dt);
  }

  _collideIslands(islands) {
    const p = this.phys;
    for (const isl of islands) {
      const dx = p.x - isl.x, dz = p.z - isl.z;
      const d = Math.hypot(dx, dz);
      const min = isl.r + 2.5;
      if (d < min && d > 1e-3) {
        const nx = dx / d, nz = dz / d;
        p.x = isl.x + nx * min;
        p.z = isl.z + nz * min;
        // 去除指向岛屿的速度分量（体轴 -> 世界 -> 体轴）
        const sinP = Math.sin(p.psi), cosP = Math.cos(p.psi);
        let vx = p.u * sinP + p.v * cosP;
        let vz = -p.u * cosP + p.v * sinP;
        const into = vx * -nx + vz * -nz;
        if (into > 0) {
          vx += nx * into;
          vz += nz * into;
          p.u = (vx * sinP - vz * cosP) * 0.55;
          p.v = (vx * cosP + vz * sinP) * 0.55;
          this.grounded = true;
        }
      }
    }
  }

  dispose() {
    this.scene.remove(this.visual.group);
    this.effects.dispose();
  }
}
