// 幽灵船：计时赛刷新个人最佳时录制玩家轨迹，之后的比赛中半透明回放。
// 轨迹存在"赛道坐标系"（起航线中点为原点、上风为轴）里 ——
// 每场比赛风向不同、赛道整体旋转，幽灵照样对得上标。

import { clamp, lerp, wrapPi } from '../util/math.js';
import { createBoatVisual } from '../render/boatModel.js';
import { t } from '../i18n.js';

const REC_HZ = 5; // 采样率；10 分钟赛程 ≈ 3000 帧 ≈ 150KB localStorage

function courseFrame(course) {
  const up = { x: Math.sin(course.windPsi), z: -Math.cos(course.windPsi) };
  return {
    up,
    rt: { x: -up.z, z: up.x },
    cx: course.center.x,
    cz: course.center.z,
    psi: course.windPsi,
  };
}

export class GhostRecorder {
  constructor(course) {
    this.frame = courseFrame(course);
    this.samples = [];
    this._nextT = 0;
  }

  // t: 比赛时钟（起航枪 = 0），只在 racing 阶段调用
  record(t, phys) {
    if (t < this._nextT) return;
    this._nextT = t + 1 / REC_HZ;
    const f = this.frame;
    const dx = phys.x - f.cx, dz = phys.z - f.cz;
    const r2 = (v) => Math.round(v * 100) / 100;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    this.samples.push([
      r2(t),
      r2(dx * f.up.x + dz * f.up.z),      // 上风向距离
      r2(dx * f.rt.x + dz * f.rt.z),      // 右侧向距离
      r3(wrapPi(phys.psi - f.psi)),       // 相对赛道轴的艏向
      r3(phys.phi),
      r3(phys.boom),
      r2(phys.crewY),
    ]);
  }
}

const key = (windKn, ai) => `windchaser.ghost.${windKn}.${ai}`;

export function saveGhost(windKn, ai, recorder, finishT) {
  try {
    localStorage.setItem(key(windKn, ai),
      JSON.stringify({ v: 1, t: finishT, s: recorder.samples }));
  } catch { /* localStorage 配额满：放弃保存，不影响比赛 */ }
}

export function loadGhost(windKn, ai) {
  try {
    const d = JSON.parse(localStorage.getItem(key(windKn, ai)) || 'null');
    return d && d.v === 1 && Array.isArray(d.s) && d.s.length > 10 ? d : null;
  } catch {
    return null;
  }
}

export class GhostBoat {
  constructor(scene, course, data) {
    this.scene = scene;
    this.frame = courseFrame(course);
    this.samples = data.s;
    this.finishT = data.t;
    this.visual = createBoatVisual({ hullColor: 0x9fc3d8, sailNumber: t('ghost.sail'), accent: '#5f7f96' });
    this.visual.group.traverse((o) => {
      if (o.isMesh || o.isLine) {
        o.castShadow = false;
        o.receiveShadow = false;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.transparent = true;
          m.opacity = 0.32;
          m.depthWrite = false;
        }
      }
    });
    this.visual.group.visible = false;
    scene.add(this.visual.group);
    this._i = 0;
    // 喂给 visual.update 的桩物理状态（幽灵不参与任何物理/碰撞/风影）
    this._stub = {
      x: 0, z: 0, psi: 0, phi: 0, boom: 0, rudder: 0, sheet: 0.6, board: 1,
      u: 0, crewY: 0, capsized: false, p: { hikeMax: 0.88 },
      out: { planing: 0, luff: 0, awaDeg: 0 },
    };
    this.x = 0; this.z = 0; this.psi = 0; // 供小地图
  }

  // t: 当前比赛时钟
  update(t, waveField, time, dt) {
    const s = this.samples;
    if (t < s[0][0] || t > this.finishT + 3) {
      this.visual.group.visible = false;
      return;
    }
    this.visual.group.visible = true;
    while (this._i < s.length - 2 && s[this._i + 1][0] <= t) this._i++;
    const a = s[this._i];
    const b = s[Math.min(this._i + 1, s.length - 1)];
    const k = clamp((t - a[0]) / Math.max(1e-3, b[0] - a[0]), 0, 1);

    const f = this.frame;
    const cu = lerp(a[1], b[1], k);
    const cr = lerp(a[2], b[2], k);
    const st = this._stub;
    st.x = f.cx + f.up.x * cu + f.rt.x * cr;
    st.z = f.cz + f.up.z * cu + f.rt.z * cr;
    st.psi = wrapPi(f.psi + a[3] + wrapPi(b[3] - a[3]) * k);
    st.phi = lerp(a[4], b[4], k);
    st.boom = a[5] + wrapPi(b[5] - a[5]) * k;
    st.crewY = lerp(a[6], b[6], k);
    st.sheet = clamp(Math.abs(st.boom) / 1.35, 0.05, 1); // 帆形扭转的近似输入
    this.x = st.x; this.z = st.z; this.psi = st.psi;
    this.visual.update(st, waveField, time, dt);
  }

  dispose() {
    this.scene.remove(this.visual.group);
  }
}
