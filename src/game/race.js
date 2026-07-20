// 绕标赛：迎尾风赛道（起航线 -> 上风标 -> 下风标 ×2 -> 冲线）。
// 含起航倒计时、抢航（OCS）判定、分段计时、本地最佳成绩。

import * as THREE from 'three';
import { DEG, formatTime, headingToDir, wrapPi } from '../util/math.js';
import { createBuoy, createCommitteeBoat } from '../render/terrain.js';
import { t } from '../i18n.js';

export const MARK_RADIUS = 16; // 绕标判定半径 m(与水面判定圈所见一致)

export class RaceCourse {
  // 沿起赛时风向搭建赛道
  constructor(scene, waveField, windFromPsi, center = { x: 0, z: 0 }) {
    this.scene = scene;
    this.waveField = waveField;
    this.center = center;
    this.windPsi = windFromPsi;
    const up = headingToDir(windFromPsi);           // 指向上风
    const right = { x: -up.z, z: up.x };            // 起航线方向

    const half = 42;
    this.pin = { x: center.x - right.x * half, z: center.z - right.z * half };
    this.committee = { x: center.x + right.x * half, z: center.z + right.z * half };
    this.lineMid = { x: center.x, z: center.z };

    const beat = 380;
    this.marks = [
      { x: center.x + up.x * beat, z: center.z + up.z * beat, nameKey: 'race.mark.wind' },
      { x: center.x - up.x * 60, z: center.z - up.z * 60, nameKey: 'race.mark.lee' },
    ];

    // 航段序列（label 存 key，显示时翻译）：起航 -> 1上 -> 2下 -> 1上 -> 2下 -> 冲线
    this.legs = [
      { type: 'start', key: 'race.leg.start' },
      { type: 'mark', mark: 0, key: 'race.leg.up', lap: 1 },
      { type: 'mark', mark: 1, key: 'race.leg.dn', lap: 1 },
      { type: 'mark', mark: 0, key: 'race.leg.up', lap: 2 },
      { type: 'mark', mark: 1, key: 'race.leg.dn', lap: 2 },
      { type: 'finish', key: 'race.leg.finish' },
    ];
    // —— 碰撞障碍(供 sim/collision.js resolveObstacleCollisions)——
    // 触碰任何一个都算触标(RRS 31);委员会船沿其朝向(艏指上风)为线段
    this.obstacles = [
      { kind: 'pin', type: 'circle', x: this.pin.x, z: this.pin.z, r: 0.6 },
      {
        kind: 'committee',
        type: 'segment',
        ax: this.committee.x - up.x * 2.6, az: this.committee.z - up.z * 2.6,
        bx: this.committee.x + up.x * 2.6, bz: this.committee.z + up.z * 2.6,
        r: 1.0,
      },
      ...this.marks.map((m, i) => ({ kind: 'mark', mark: i, type: 'circle', x: m.x, z: m.z, r: 0.75 })),
    ];

    // —— 视觉 ——
    this.objects = [];
    const pinBuoy = createBuoy(0xe8642c, true);
    pinBuoy.position.set(this.pin.x, 0, this.pin.z);
    const cb = createCommitteeBoat();
    cb.position.set(this.committee.x, 0, this.committee.z);
    cb.rotation.y = -windFromPsi;
    this.objects.push(pinBuoy, cb);
    for (const m of this.marks.slice(0, 2)) {
      const b = createBuoy(0xffa321, true);
      b.scale.setScalar(1.5);
      b.position.set(m.x, 0, m.z);
      this.objects.push(b);
    }
    for (const o of this.objects) scene.add(o);

    // —— 当前目标高亮:标记 = 判定圈(半径与判定一致) + 光柱;起终点线 = 两端小圈 ——
    this.highlight = [];
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd35c, transparent: true, opacity: 0.45,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false, fog: false,
    });
    const ringGeo = new THREE.RingGeometry(MARK_RADIUS - 1.4, MARK_RADIUS, 64);
    ringGeo.rotateX(-Math.PI / 2);
    this.markRing = new THREE.Mesh(ringGeo, this.ringMat);
    this.markRing.renderOrder = 4;
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xffd35c, transparent: true, opacity: 0.13,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.1, 30, 12, 1, true), this.beamMat);
    this.beam.renderOrder = 4;
    this.lineRingMat = new THREE.MeshBasicMaterial({
      color: 0x7fe0a8, transparent: true, opacity: 0.45,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false, fog: false,
    });
    const endGeo = new THREE.RingGeometry(4.2, 5.4, 48);
    endGeo.rotateX(-Math.PI / 2);
    this.lineRingA = new THREE.Mesh(endGeo, this.lineRingMat);
    this.lineRingB = new THREE.Mesh(endGeo, this.lineRingMat);
    this.lineRingA.renderOrder = 4;
    this.lineRingB.renderOrder = 4;
    this.highlight.push(this.markRing, this.beam, this.lineRingA, this.lineRingB);
    for (const o of this.highlight) {
      o.visible = false;
      o.position.y = 0.12;
      scene.add(o);
    }
  }

  // 当前目标高亮:target = {type:'mark', mark} | {type:'line'} | null
  setActiveTarget(target) {
    const isMark = target?.type === 'mark';
    const isLine = target?.type === 'line';
    this.markRing.visible = this.beam.visible = isMark;
    this.lineRingA.visible = this.lineRingB.visible = isLine;
    if (isMark) {
      const m = this.marks[target.mark];
      this.markRing.position.set(m.x, 0.12, m.z);
      this.beam.position.set(m.x, 15, m.z);
    } else if (isLine) {
      this.lineRingA.position.set(this.pin.x, 0.12, this.pin.z);
      this.lineRingB.position.set(this.committee.x, 0.12, this.committee.z);
    }
  }

  legLabel(leg) {
    return t(leg.key, { n: leg.lap ?? '' });
  }

  // 浮标随浪起伏 + 目标高亮呼吸脉冲
  update(time) {
    for (const o of this.objects) {
      const w = this.waveField.sample(o.position.x, o.position.z);
      o.position.y = w.y;
      o.rotation.x = -w.nz * 0.4;
      o.rotation.z = w.nx * 0.4;
    }
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.6);
    this.ringMat.opacity = 0.3 + 0.25 * pulse;
    this.lineRingMat.opacity = 0.3 + 0.25 * pulse;
    this.beamMat.opacity = 0.09 + 0.06 * pulse;
  }

  // 点在起航线的上风侧？
  isUpwindOfLine(x, z) {
    const up = headingToDir(this.windPsi);
    return (x - this.lineMid.x) * up.x + (z - this.lineMid.z) * up.z > 0;
  }

  // 线段 (x0,z0)->(x1,z1) 是否横穿起航线段
  crossesLine(x0, z0, x1, z1) {
    const p = this.pin, q = this.committee;
    const d = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    const A = { x: x0, z: z0 }, B = { x: x1, z: z1 };
    return d(p, q, A) * d(p, q, B) < 0 && d(A, B, p) * d(A, B, q) < 0;
  }

  dispose() {
    for (const o of this.objects) this.scene.remove(o);
    for (const o of this.highlight) this.scene.remove(o);
  }
}

export class RaceManager {
  constructor(course, boats, countdown = 45) {
    this.course = course;
    this.boats = boats;
    this.t = -countdown;
    this.state = 'prestart';
    this.results = [];
    this.entries = new Map();
    for (const b of boats) {
      this.entries.set(b, { leg: 0, ocs: false, splits: [], finished: false, finishT: 0, prevX: b.phys.x, prevZ: b.phys.z });
    }
    this.events = []; // {msg, forPlayer}
  }

  emit(msg) { this.events.push(msg); }
  takeEvents() { const e = this.events; this.events = []; return e; }

  captureState() {
    const seen = new Set();
    const entries = this.boats.map((boat) => {
      const boatId = boat?.boatId;
      if (typeof boatId !== 'string' || boatId.length === 0) {
        throw new TypeError('every race boat requires a non-empty boatId');
      }
      if (seen.has(boatId)) throw new TypeError(`duplicate race boatId ${boatId}`);
      seen.add(boatId);
      const entry = this.entries.get(boat);
      if (!entry) throw new TypeError(`race entry is missing boatId ${boatId}`);
      return {
        boatId,
        leg: entry.leg,
        ocs: entry.ocs,
        splits: [...entry.splits],
        finished: entry.finished,
        finishT: entry.finishT,
        prevX: entry.prevX,
        prevZ: entry.prevZ,
      };
    });
    return {
      state: this.state,
      t: this.t,
      entries,
      results: this.results.map((result) => ({
        boatId: result.boat?.boatId ?? result.boatId,
        time: result.time,
      })),
    };
  }

  applyState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError('race snapshot must be an object');
    }
    const allowed = new Set(['state', 't', 'entries', 'results']);
    for (const key of Reflect.ownKeys(snapshot)) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        throw new TypeError(`race snapshot contains unknown field ${String(key)}`);
      }
    }
    if (!['prestart', 'racing', 'finished'].includes(snapshot.state)) {
      throw new TypeError('race state must be prestart, racing, or finished');
    }
    if (!Number.isFinite(snapshot.t)) throw new TypeError('race time must be finite');
    if (!Array.isArray(snapshot.entries) || !Array.isArray(snapshot.results)) {
      throw new TypeError('race entries and results must be arrays');
    }

    const boatsById = new Map();
    for (const boat of this.boats) {
      if (typeof boat?.boatId !== 'string' || boat.boatId.length === 0) {
        throw new TypeError('every race boat requires a non-empty boatId');
      }
      if (boatsById.has(boat.boatId)) throw new TypeError(`duplicate race boatId ${boat.boatId}`);
      boatsById.set(boat.boatId, boat);
    }
    if (snapshot.entries.length !== boatsById.size) {
      throw new TypeError('race snapshot must contain one entry for every boat');
    }

    const entryIds = new Set();
    const nextEntries = snapshot.entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError(`race entry ${index} must be an object`);
      }
      const fields = new Set([
        'boatId', 'leg', 'ocs', 'splits', 'finished', 'finishT', 'prevX', 'prevZ',
      ]);
      for (const key of Reflect.ownKeys(entry)) {
        if (typeof key !== 'string' || !fields.has(key)) {
          throw new TypeError(`race entry contains unknown field ${String(key)}`);
        }
      }
      const boat = boatsById.get(entry.boatId);
      if (!boat) throw new TypeError(`race entry references unknown boatId ${entry.boatId}`);
      if (entryIds.has(entry.boatId)) throw new TypeError(`duplicate race entry ${entry.boatId}`);
      entryIds.add(entry.boatId);
      if (!Number.isSafeInteger(entry.leg) || entry.leg < 0) {
        throw new TypeError('race entry leg must be a non-negative integer');
      }
      if (typeof entry.ocs !== 'boolean' || typeof entry.finished !== 'boolean') {
        throw new TypeError('race entry flags must be Boolean');
      }
      if (!Array.isArray(entry.splits) || !entry.splits.every(Number.isFinite)) {
        throw new TypeError('race entry splits must contain finite numbers');
      }
      for (const field of ['finishT', 'prevX', 'prevZ']) {
        if (!Number.isFinite(entry[field])) throw new TypeError(`race entry ${field} must be finite`);
      }
      return {
        boat,
        value: {
          leg: entry.leg,
          ocs: entry.ocs,
          splits: [...entry.splits],
          finished: entry.finished,
          finishT: entry.finishT,
          prevX: entry.prevX,
          prevZ: entry.prevZ,
        },
      };
    });
    if (entryIds.size !== boatsById.size) {
      throw new TypeError('race snapshot is missing an entry for every boat');
    }

    const resultIds = new Set();
    const nextResults = snapshot.results.map((result) => {
      const boat = boatsById.get(result?.boatId);
      if (!boat) throw new TypeError(`race result references unknown boatId ${result?.boatId}`);
      if (resultIds.has(result.boatId)) throw new TypeError(`duplicate race result ${result.boatId}`);
      if (!Number.isFinite(result.time)) throw new TypeError('race result time must be finite');
      resultIds.add(result.boatId);
      return { boat, time: result.time };
    });

    this.state = snapshot.state;
    this.t = snapshot.t;
    for (const { boat, value } of nextEntries) {
      const current = this.entries.get(boat);
      if (current) Object.assign(current, value);
      else this.entries.set(boat, value);
    }
    for (const boat of [...this.entries.keys()]) {
      if (!this.boats.includes(boat)) this.entries.delete(boat);
    }
    this.results = nextResults;
    this.events = [];
    return this.captureState();
  }

  update(dt) {
    this.t += dt;
    const c = this.course;
    if (this.state === 'prestart' && this.t >= 0) {
      this.state = 'racing';
      this.emit(t('race.msg.start'));
    }

    for (const b of this.boats) {
      const e = this.entries.get(b);
      if (e.finished) continue;
      const p = b.phys;
      const crossed = c.crossesLine(e.prevX, e.prevZ, p.x, p.z);
      const nowUp = c.isUpwindOfLine(p.x, p.z);

      if (this.state === 'prestart') {
        if (nowUp) {
          if (!e.ocs) {
            e.ocs = true;
            if (b.isPlayer) this.emit(t('race.msg.ocs'));
          }
        } else e.ocs = false;
      } else if (e.leg === 0) {
        // 等待正式起航
        if (e.ocs) {
          if (!nowUp) { e.ocs = false; if (b.isPlayer) this.emit(t('race.msg.back')); }
        } else if (crossed && nowUp) {
          e.leg = 1;
          e.legStartT = this.t;
          if (b.isPlayer) this.emit(t('race.msg.started'));
        }
      } else {
        const leg = c.legs[e.leg];
        if (leg.type === 'mark') {
          const m = c.marks[leg.mark];
          if (Math.hypot(p.x - m.x, p.z - m.z) < MARK_RADIUS) {
            e.splits.push(this.t);
            e.leg++;
            if (b.isPlayer) this.emit(t('race.msg.rounded', { mark: t(m.nameKey), next: c.legLabel(c.legs[e.leg]) }));
          }
        } else if (leg.type === 'finish') {
          // 终点须自下风侧向上风穿越(与起航同向);反向穿线不算完赛。
          // 未完成的回转处罚(rules.js turns 模式)拦截完赛(RRS 44.2)。
          if (crossed && nowUp && (b.penaltyTurns ?? 0) > 0) {
            if (b.isPlayer) this.emit(t('race.msg.penaltyBlocked'));
          } else if (crossed && nowUp) {
            e.finished = true;
            e.finishT = this.t;
            this.results.push({ boat: b, time: this.t });
            this.emit(t('race.msg.finished', {
              name: b.displayName ?? t(b.nameKey),
              t: formatTime(this.t),
            }));
          }
        }
      }
      e.prevX = p.x;
      e.prevZ = p.z;
    }

    if (this.boats.every((b) => this.entries.get(b).finished)) this.state = 'finished';
  }

  // 给赛道高亮:某船当前目标的类型({type:'mark',mark}|{type:'line'}|null)
  activeTargetFor(boat) {
    const e = this.entries.get(boat);
    if (!e || e.finished) return null;
    if (this.state === 'prestart' || e.leg === 0) return { type: 'line' };
    const leg = this.course.legs[e.leg];
    if (leg.type === 'mark') return { type: 'mark', mark: leg.mark };
    return { type: 'line' };
  }

  // 给 AI/小地图：某船当前目标点
  targetFor(boat) {
    const e = this.entries.get(boat);
    if (!e || e.finished) return null;
    const c = this.course;
    if (this.state === 'prestart' || e.leg === 0) {
      return { x: c.lineMid.x, z: c.lineMid.z };
    }
    const leg = c.legs[e.leg];
    if (leg.type === 'mark') return c.marks[leg.mark];
    return { x: c.lineMid.x, z: c.lineMid.z };
  }

  playerStatus(boat) {
    const e = this.entries.get(boat);
    const c = this.course;
    if (this.state === 'prestart') {
      const s = Math.max(0, -this.t);
      return { phase: 'countdown', text: t('race.st.count', { s: s.toFixed(0) }) + (e.ocs ? ` · <span class="ocs">${t('race.st.ocs')}</span>` : '') };
    }
    if (e.finished) return { phase: 'done', text: t('race.st.done', { t: formatTime(e.finishT) }) };
    if (e.leg === 0) {
      return { phase: 'start', text: `${t('race.st.start')}${e.ocs ? ` <span class="ocs">${t('race.st.backFirst')}</span>` : ''} · ${formatTime(this.t)}` };
    }
    const leg = c.legs[e.leg];
    const pos = this.standings().indexOf(boat) + 1;
    const posTxt = this.boats.length > 1 ? ` · ${t('race.st.pos', { n: pos })}` : '';
    const tgt = this.targetFor(boat);
    const distTxt = tgt
      ? ` · ${t('race.st.dist', { d: Math.hypot(boat.phys.x - tgt.x, boat.phys.z - tgt.z).toFixed(0) })}`
      : '';
    return { phase: 'racing', text: `${c.legLabel(leg)}${distTxt} · ${formatTime(this.t)}${posTxt}` };
  }

  // 简易名次：按航段进度 + 距目标距离
  standings() {
    const c = this.course;
    return [...this.boats].sort((a, b) => {
      const ea = this.entries.get(a), eb = this.entries.get(b);
      if (ea.finished && eb.finished) return ea.finishT - eb.finishT;
      if (ea.finished) return -1;
      if (eb.finished) return 1;
      if (ea.leg !== eb.leg) return eb.leg - ea.leg;
      const ta = this.targetFor(a), tb = this.targetFor(b);
      const da = ta ? Math.hypot(a.phys.x - ta.x, a.phys.z - ta.z) : 0;
      const db = tb ? Math.hypot(b.phys.x - tb.x, b.phys.z - tb.z) : 0;
      return da - db;
    });
  }
}

// 本地最佳成绩
export function loadBest(windKn, ai) {
  const v = localStorage.getItem(`windchaser.best.${windKn}.${ai}`);
  return v ? Number(v) : null;
}
export function saveBest(windKn, ai, t) {
  const cur = loadBest(windKn, ai);
  if (cur === null || t < cur) {
    localStorage.setItem(`windchaser.best.${windKn}.${ai}`, String(t));
    return true;
  }
  return false;
}
