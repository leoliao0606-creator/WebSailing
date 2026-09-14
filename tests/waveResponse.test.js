// 波浪场与船体垂向响应的回归：波谱结构、深度衰减、升沉/纵摇动力学，
// 以及"顶浪掉速、顺浪冲浪"这一组符号关系。
//
// 这些测试守的是几个很容易在调参时被改坏、但改坏了也不会报错的性质：
// 波相位、涌浪的存在、浸没率的尺度、以及浪对船速影响的方向。

import assert from 'node:assert/strict';
import test from 'node:test';

import { BoatPhysics } from '../src/sim/boatPhysics.js';
import { WaveField, WAVE_COUNT, WAVE_STRIDE } from '../src/sim/waves.js';
import { WindField } from '../src/sim/wind.js';

const DEG = Math.PI / 180;

// 无风环境：把波浪的作用从帆力里隔离出来
function calmAir() {
  const wind = new WindField('wave-response');
  wind.setBase(0, 0.001);
  wind.gustiness = 0;
  wind.shiftAmp = 0;
  wind.localShift = () => 0;
  return wind;
}

// —— 波浪场本身 ——

test('各分量带不同相位:原点不再是所有波的公共波峰', () => {
  const wf = new WaveField();
  wf.setConditions(0, 12);
  const phases = wf.waves.map((w) => w.ph);
  assert.equal(new Set(phases.map((p) => p.toFixed(6))).size, WAVE_COUNT,
    '每个分量应有各自的相位常数');
  // 相位全为 0 时原点的波高等于所有波幅之和（所有 cos 同时取 1）。
  // 那会让海面出现一个固定图案的"超级波峰"沿波向扫过，看起来像搓板。
  wf.time = 0;
  const y0 = Math.abs(wf.sample(0, 0).y);
  const ampSum = wf.waves.reduce((a, w) => a + w.amp, 0);
  assert.ok(y0 < ampSum * 0.6,
    `原点波高 ${y0.toFixed(3)} 应远小于波幅和 ${ampSum.toFixed(3)}`);
});

test('涌浪在几乎无风时依然存在,且方向与本地风不同', () => {
  const wf = new WaveField();
  wf.setConditions(0, 0.5);
  const amps = wf.waves.map((w) => w.amp).filter((a) => a > 0.02);
  assert.ok(amps.length >= 2, '小风下仍应有涌浪分量撑住海面');
  // 全部分量的传播方向不应挤在风向一侧
  const dirs = wf.waves.map((w) => Math.atan2(w.dx, -w.dz));
  const spread = Math.max(...dirs) - Math.min(...dirs);
  assert.ok(spread > 60 * DEG, `波向散布 ${(spread / DEG).toFixed(0)}° 应足够宽`);
});

test('波长与波幅随风速成长', () => {
  const wf = new WaveField();
  wf.setConditions(0, 8);
  const mild = { len: wf.peakLen, amp: wf.peakAmp };
  wf.setConditions(0, 22);
  assert.ok(wf.peakLen > mild.len * 1.8, '大风的峰值波长应显著更长');
  assert.ok(wf.peakAmp > mild.amp * 1.8, '大风的峰值波幅应显著更大');
});

test('grow 模式下波高渐变而非瞬变', () => {
  const wf = new WaveField();
  wf.setConditions(0, 6);
  const before = wf.peakAmp;
  wf.setConditions(0, 24, { grow: true });
  assert.equal(wf.peakAmp, before, '刚切换时波高不应跳变');
  for (let t = 0; t < 3; t += 1 / 60) wf.update(1 / 60);
  assert.ok(wf.peakAmp > before, '3 秒后应长起来一些');
  assert.ok(wf.peakAmp < wf.target.peakAmp, '但还远未到位');
  for (let t = 0; t < 90; t += 1 / 60) wf.update(1 / 60);
  assert.ok(Math.abs(wf.peakAmp - wf.target.peakAmp) < 1e-6, '足够久之后应吸附到目标');
});

test('轨道流速随深度衰减,短波衰减得比长波狠得多', () => {
  const wf = new WaveField();
  wf.setConditions(0, 14);
  // 只留一个长波
  const keep = (idx) => {
    const saved = wf.waves.map((w) => w.amp);
    wf.waves.forEach((w, i) => { if (i !== idx) w.amp = 0; });
    return () => wf.waves.forEach((w, i) => { w.amp = saved[i]; });
  };
  const speedAt = (idx, depth) => {
    const restore = keep(idx);
    let peak = 0;
    for (let t = 0; t < 12; t += 0.05) {
      wf.time = t;
      const o = wf.sample(0, 0, {}, depth);
      peak = Math.max(peak, Math.hypot(o.vx, o.vz));
    }
    restore();
    return peak;
  };
  const longIdx = wf.waves.reduce((best, w, i, a) => (w.k < a[best].k ? i : best), 0);
  const shortIdx = wf.waves.reduce((best, w, i, a) => (w.k > a[best].k ? i : best), 0);
  const longRatio = speedAt(longIdx, 0.24) / speedAt(longIdx, 0);
  const shortRatio = speedAt(shortIdx, 0.24) / speedAt(shortIdx, 0);
  assert.ok(longRatio > 0.9, `长浪在 0.24 m 深处几乎不衰减,实测 ${longRatio.toFixed(2)}`);
  assert.ok(shortRatio < longRatio * 0.6,
    `短浪应衰减得多得多,实测短 ${shortRatio.toFixed(2)} vs 长 ${longRatio.toFixed(2)}`);
});

test('packUniforms 打包的步长与 GLSL 解包一致', () => {
  const wf = new WaveField();
  const buf = new Float32Array(WAVE_COUNT * WAVE_STRIDE);
  wf.packUniforms(buf);
  for (let i = 0; i < WAVE_COUNT; i++) {
    const w = wf.waves[i];
    assert.equal(buf[i * WAVE_STRIDE + 2], Math.fround(w.k));
    assert.equal(buf[i * WAVE_STRIDE + 6], Math.fround(w.ph));
  }
});

// —— 浮体垂向动力学 ——

test('平水时垂向状态回到平衡位,并标记为非波浪驱动', () => {
  const phys = new BoatPhysics();
  phys.wave.heaveY = 1.4;
  phys.wave.theta = 0.3;
  for (let t = 0; t < 6; t += 1 / 60) phys.stepBuoyancy(null, 1 / 60);
  assert.equal(phys.wave.active, false, '没有波浪场时不应驱动渲染姿态');
  assert.ok(Math.abs(phys.wave.theta) < 1e-3, '纵摇应归零');
  const d0 = phys.mass / (1025 * phys.p.awp);
  assert.ok(Math.abs(phys.wave.heaveY + d0) < 0.01, '升沉应回到平衡吃水');
  assert.equal(phys.wave.immersion, 1, '平水时浸没率为满');
});

test('浪里垂向状态长时间有界,纵摇不会卡在姿态上限', () => {
  const wind = calmAir();
  const waves = new WaveField();
  waves.setConditions(0, 22);
  const phys = new BoatPhysics();
  phys.psi = 20 * DEG;
  phys.u = 4;
  let pitchMax = 0, heaveMax = 0, atLimit = 0, n = 0;
  for (let t = 0; t < 120; t += 1 / 60) {
    waves.update(1 / 60);
    phys.step(wind, 1 / 60, waves);
    assert.ok(Number.isFinite(phys.wave.heaveY) && Number.isFinite(phys.wave.theta),
      `t=${t.toFixed(1)} 时垂向状态发散`);
    if (t > 20) {
      n++;
      pitchMax = Math.max(pitchMax, Math.abs(phys.wave.theta));
      heaveMax = Math.max(heaveMax, Math.abs(phys.wave.heaveY));
      if (Math.abs(phys.wave.theta) > 0.49) atLimit++;
    }
  }
  assert.ok(pitchMax > 2 * DEG, `大浪里应看得出纵摇,实测峰值 ${(pitchMax / DEG).toFixed(1)}°`);
  assert.ok(pitchMax < 35 * DEG, `纵摇峰值 ${(pitchMax / DEG).toFixed(1)}° 过大`);
  assert.ok(heaveMax < 3, `升沉幅度 ${heaveMax.toFixed(2)} m 过大`);
  // 任何常量抬艏力矩都会让船"抬艏→前半船离水→恢复力矩消失"一路顶到上限卡住。
  assert.ok(atLimit / n < 0.02,
    `纵摇贴在上限的时间占比 ${(atLimit / n * 100).toFixed(1)}% 说明姿态被顶死了`);
});

test('船沿浪面起伏:升沉跟着波面走,但不是贴在上面', () => {
  const wind = calmAir();
  const waves = new WaveField();
  waves.setConditions(0, 16);
  const phys = new BoatPhysics();
  phys.psi = 90 * DEG;
  let sumAbsDiff = 0, sumAbsWave = 0, n = 0;
  for (let t = 0; t < 60; t += 1 / 60) {
    waves.update(1 / 60);
    phys.step(wind, 1 / 60, waves);
    if (t > 15) {
      const wy = waves.sample(phys.x, phys.z).y;
      sumAbsDiff += Math.abs(phys.wave.heaveY - wy);
      sumAbsWave += Math.abs(wy);
      n++;
    }
  }
  const follow = 1 - sumAbsDiff / sumAbsWave;
  assert.ok(follow > 0.3, `船应大体跟着浪面起伏,实测跟随度 ${follow.toFixed(2)}`);
  assert.ok(follow < 0.97,
    `船不该是贴在浪面上的贴纸(跟随度 ${follow.toFixed(2)})——短于船长的碎浪应被各站平均掉`);
});

// 给恒定体轴推力，测稳态速度：把帆和舵的反馈排除掉，只看浪对纵向的净作用
function towSpeed({ headingDeg, windKn, thrustN, waves = true, seconds = 110 }) {
  const wind = calmAir();
  const wf = waves ? new WaveField() : null;
  wf?.setConditions(0, windKn);
  const phys = new BoatPhysics();
  phys.p.windageArea = 0;
  phys.powerScale = 0;
  phys.psi = headingDeg * DEG;
  phys.u = 2;
  phys.ctl.autoHike = false;
  phys.ctl.hike = 0;
  const base = phys._substep.bind(phys);
  phys._substep = (w, h) => {
    base(w, h);
    phys.u += (thrustN / (phys.mass * phys.p.kSurgeAdd)) * h;
  };
  const dt = 1 / 60;
  let sum = 0, n = 0;
  for (let t = 0; t < seconds; t += dt) {
    wf?.update(dt);
    // 只留纵向自由度，转向和横摇不参与
    phys.psi = headingDeg * DEG;
    phys.yawRate = 0;
    phys.phi = 0;
    phys.phiRate = 0;
    phys.step(wind, dt, wf);
    if (t > 45) { sum += phys.u; n++; }
  }
  return sum / n;
}

test('顶浪掉速、顺浪冲浪提速(浪向南传播,艏向 0°=顶浪)', () => {
  const thrustN = 150;
  const flat = towSpeed({ headingDeg: 0, windKn: 15, thrustN, waves: false });
  const head = towSpeed({ headingDeg: 0, windKn: 15, thrustN });
  const following = towSpeed({ headingDeg: 180, windKn: 15, thrustN });
  assert.ok(head < flat * 0.97,
    `顶浪应比平水慢:顶浪 ${head.toFixed(2)} vs 平水 ${flat.toFixed(2)} m/s`);
  assert.ok(following > flat * 1.03,
    `顺浪应被浪推着走:顺浪 ${following.toFixed(2)} vs 平水 ${flat.toFixed(2)} m/s`);
  assert.ok(following > head * 1.05,
    `顺浪应明显快于顶浪:${following.toFixed(3)} vs ${head.toFixed(3)} m/s`);
});

test('顶浪时艏部起落远比顺浪剧烈(波浪增阻的来源)', () => {
  const wind = calmAir();
  const measure = (headingDeg) => {
    const waves = new WaveField();
    waves.setConditions(0, 15);
    const phys = new BoatPhysics();
    phys.p.windageArea = 0;
    phys.powerScale = 0;
    phys.psi = headingDeg * DEG;
    phys.u = 2.5;
    let sum = 0, n = 0;
    for (let t = 0; t < 80; t += 1 / 60) {
      waves.update(1 / 60);
      phys.psi = headingDeg * DEG;
      phys.yawRate = 0;
      phys.u = 2.5; // 钉住船速，只比较遭遇浪的剧烈程度
      phys.step(wind, 1 / 60, waves);
      if (t > 25) { sum += phys.wave.bowRate * phys.wave.bowRate; n++; }
    }
    return sum / n;
  };
  const head = measure(0);
  const following = measure(180);
  assert.ok(head > following * 3,
    `同样船速下顶浪的艏部起落应远大于顺浪:${head.toFixed(3)} vs ${following.toFixed(3)}`);
});

test('冲上浪顶离水时舵效下降,落回水里恢复', () => {
  const phys = new BoatPhysics();
  const wind = calmAir();
  const waves = new WaveField();
  waves.setConditions(0, 20);
  phys.psi = 150 * DEG;
  phys.u = 5;
  phys.ctl.rudder = 0.8;
  let minImm = 1, maxImm = 0;
  for (let t = 0; t < 90; t += 1 / 60) {
    waves.update(1 / 60);
    phys.step(wind, 1 / 60, waves);
    if (t > 20) {
      minImm = Math.min(minImm, phys.wave.immersion);
      maxImm = Math.max(maxImm, phys.wave.immersion);
    }
  }
  assert.ok(maxImm > 0.95, '大部分时间船应正常吃水');
  assert.ok(minImm < 0.8, '大浪里应出现船体明显抬离水面的时刻');
  assert.ok(phys.out.airborne >= 0 && phys.out.airborne <= 1, '腾空程度应是 0..1');
});

test('平水航行完全不受新增的波浪项影响', () => {
  const wind = new WindField('flat-check');
  wind.setBase(0, 15 * 0.514444);
  wind.gustiness = 0;
  wind.shiftAmp = 0;
  wind.localShift = () => 0;
  const run = () => {
    const phys = new BoatPhysics();
    phys.psi = 90 * DEG;
    phys.u = 3;
    phys.ctl.sheet = 0.35;
    for (let t = 0; t < 40; t += 1 / 60) phys.step(wind, 1 / 60, null);
    return phys.speed;
  };
  const a = run();
  // 平水路径走 FLAT_WAVE：浸没率恒为 1、艏部起落恒为 0，各项波浪修正都应恰好为零
  assert.ok(a > 1, '平水应能正常航行');
  const phys = new BoatPhysics();
  phys.step(wind, 1 / 60, null);
  assert.equal(phys.out.airborne, 0);
  assert.equal(phys.out.slamSpeed, 0);
  assert.equal(phys.wave.bowRate, 0);
});
