// 浪致横摇回归：横浪明显摇船、顶浪远小于横浪、长时间数值有界。
// 用确定性 WaveField，静漂船（帆效清零）隔离波浪响应。

import assert from 'node:assert/strict';
import test from 'node:test';

import { BoatPhysics } from '../src/sim/boatPhysics.js';
import { WaveField } from '../src/sim/waves.js';
import { WindField } from '../src/sim/wind.js';

const DEG = Math.PI / 180;

// 恒定风：WindField 默认用 Math.random 播种，而这个种子会同时驱动风向摆动
// （shiftAmp）和随位置变化的局部偏转（localShift），两者都不受 gustiness 约束。
// 本文件比较的是「艏向相对波向」，风向自己在漂会把结论污染成随机数：实测
// 顶浪/横浪比值会在 0.35–0.93 之间乱跳，跨过 0.85 的判据。这里把风彻底钉死。
function steadyWind(windKn) {
  const wind = new WindField('wave-roll');
  wind.setBase(0, windKn);
  wind.gustiness = 0;
  wind.shiftAmp = 0;
  wind.localShift = () => 0;
  return wind;
}

// 静漂：帆力清零（powerScale=0）、缭绳放空、稳向板放下、不压舷，采样 phi 振荡
function driftRollAmplitude({ windKn, headingDeg, seconds = 60 }) {
  const wind = steadyWind(windKn);
  const waves = new WaveField();
  waves.setConditions(0, windKn);
  const phys = new BoatPhysics();
  phys.psi = headingDeg * DEG;
  phys.powerScale = 0; // 无帆力，只留风阻/水动力/波浪
  phys.ctl.sheet = 1;
  phys.ctl.board = 1;
  phys.ctl.autoHike = false;
  phys.ctl.hike = 0;

  const dt = 1 / 60;
  let maxAbs = 0;
  let finite = true;
  let minImmersion = 1;
  let maxSlope = 0;
  for (let t = 0; t < seconds; t += dt) {
    waves.update(dt);
    phys.step(wind, dt, waves);
    phys.psi = headingDeg * DEG; // 锁定艏向，隔离横摇响应
    phys.yawRate = 0;
    if (!Number.isFinite(phys.phi) || !Number.isFinite(phys.u)) { finite = false; break; }
    if (t > 10) {
      maxAbs = Math.max(maxAbs, Math.abs(phys.phi)); // 跳过初始瞬态
      minImmersion = Math.min(minImmersion, phys.wave.immersion);
      // 船位处波面沿南北向的坡度。艏向 90°(朝东)时它就是船的横向坡度，
      // 也就是浮力回复力矩想把船摆平到的那个角度 —— 横摇的物理参照。
      const o = waves.sample(phys.x, phys.z);
      maxSlope = Math.max(maxSlope, Math.abs(Math.atan2(o.nz, o.ny)));
    }
  }
  return { maxDeg: maxAbs / DEG, finite, minImmersion, maxSlopeDeg: maxSlope / DEG };
}

test('15kn 横浪静漂:横摇明显(>3°)且 60 秒内有界(<45°)', () => {
  // 风从北来,波浪向南传播;艏向东(90°)= 横浪
  const r = driftRollAmplitude({ windKn: 15, headingDeg: 90 });
  assert.ok(r.finite, '数值应有界');
  assert.ok(r.maxDeg > 3, `横浪摇幅应可感,实测 ${r.maxDeg.toFixed(1)}°`);
  assert.ok(r.maxDeg < 45, `横浪摇幅不应失控,实测 ${r.maxDeg.toFixed(1)}°`);
});

test('顶浪横摇小于横浪(波组围绕风向散布,顶浪仍有侧向分量)', () => {
  const beam = driftRollAmplitude({ windKn: 15, headingDeg: 90 });
  const head = driftRollAmplitude({ windKn: 15, headingDeg: 0 });
  assert.ok(head.finite && beam.finite);
  assert.ok(head.maxDeg < beam.maxDeg * 0.85,
    `顶浪 ${head.maxDeg.toFixed(1)}° 应小于横浪 ${beam.maxDeg.toFixed(1)}°`);
});

test('25kn 大浪:横摇与波面坡度同量级,不会被甩出水面再砸回来放大', () => {
  const r = driftRollAmplitude({ windKn: 25, headingDeg: 90 });
  assert.ok(r.finite);
  assert.ok(r.maxDeg < 80, `不应仅因波浪翻船,实测 ${r.maxDeg.toFixed(1)}°`);
  // 长浪里小艇是跟着浪面倾斜走的,横摇应当与波面横向坡度同量级。
  // 这里不再断言「25 节一定比 12 节摇得更凶」:这个波谱里 peakAmp 和 peakLen
  // 一起长,陡度几乎不随风速变(真实充分成长海况也是如此),25 节的浪反而更长
  // 更缓、离横摇固有周期 2.3 s 更远,共振更弱。原来 25 节摇得更凶,是因为升沉
  // 阻尼在船离水后仍然生效,船沉不下去、被浪甩在上面再砸回来 —— 那是数值假象。
  assert.ok(r.maxDeg > r.maxSlopeDeg * 0.3,
    `横摇 ${r.maxDeg.toFixed(1)}° 远小于波面坡度 ${r.maxSlopeDeg.toFixed(1)}°,船对浪没反应了`);
  assert.ok(r.maxDeg < r.maxSlopeDeg * 2.5,
    `横摇 ${r.maxDeg.toFixed(1)}° 远超波面坡度 ${r.maxSlopeDeg.toFixed(1)}°,多半又在腾空砸水`);
});

test('静漂的船不会被浪甩出水面:升沉阻尼必须随浸没率消失', () => {
  // 回归:阻尼原来无条件施加,腾空时受力只剩「-重力 - 水阻尼」,船收敛到
  // 一个 0.5 m/s 的终端下沉速度,比浪顶落下去还慢,于是整条船被留在空中,
  // 浸没率一连几秒归零 —— 船体阻力全消失、舵效只剩 45%,大风调向死在顶风点。
  for (const windKn of [12, 25]) {
    const r = driftRollAmplitude({ windKn, headingDeg: 90 });
    assert.ok(r.minImmersion > 0.15,
      `${windKn} 节静漂时浸没率掉到 ${r.minImmersion.toFixed(2)},船被甩离了水面`);
  }
});
