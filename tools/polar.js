// 极曲线与物理自检脚本：node tools/polar.js [风速节]
// 1) 符号自检：横倾方向 / 侧滑方向 / 帆杠位置 / 舵效方向
// 2) 稳态极曲线：各真风角的收敛船速、VMG、横倾、侧滑、舵角
// 3) 场景测试：抢风调向、死区倒漂

import { BoatPhysics } from '../src/sim/boatPhysics.js';
import { WaveField } from '../src/sim/waves.js';
import { shadowFactorAt } from '../src/sim/windShadow.js';
import { steerTowards, autoSheet } from '../src/sim/helm.js';
import { DEG, KN, wrapPi } from '../src/util/math.js';

const TWS_KN = Number(process.argv[2] ?? 12);

// 恒定风（无阵风），风从北方来（fromPsi=0，风朝 +z 吹）
const wind = {
  sample(x, z, out = {}) {
    out.vx = 0;
    out.vz = TWS_KN * KN;
    out.speed = TWS_KN * KN;
    out.fromPsi = 0;
    return out;
  },
};

function makeBoat(headingDeg) {
  const b = new BoatPhysics();
  b.psi = headingDeg * DEG;
  const spd = 1.5;
  b.u = spd;
  b.ctl.autoHike = true;
  return b;
}

function simulate(boat, seconds, perStep) {
  const dt = 1 / 60;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    perStep?.(boat, i * dt);
    boat.step(wind, dt);
  }
}

// 与游戏内 autoTrim 辅助一致的调帆：横倾过载时松帆减功率（大风下才能持续航行）
function trimAssist(bt, alpha = 17) {
  const over = Math.abs(bt.out.heelDeg) - 24;
  autoSheet(bt, over > 0 ? Math.max(4, alpha - over * 1.1) : alpha);
}

// ---------- 1) 符号自检 ----------
console.log(`\n=== 符号自检（真风 ${TWS_KN}kn，来自北方）===`);
let ok = true;
function check(name, cond, detail) {
  console.log(`  [${cond ? '✓' : '✗'}] ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) ok = false;
}

{
  // 艏向 -55°（向西北偏西），风从北 => twa=+55 => 风从右舷（starboard tack）
  const b = makeBoat(-55);
  simulate(b, 25, (bt) => { steerTowards(bt, -55 * DEG); trimAssist(bt); });
  check('右舷来风时不向下风(右)倾', b.out.heelDeg < 0.5, `heel=${b.out.heelDeg.toFixed(1)}°（轻风时船员可完全配平）`);
  check('右舷来风时船员在右舷压舷', b.crewY > 0.1, `crewY=${b.crewY.toFixed(2)}m`);
  check('右舷来风时帆杠在左舷', b.boom < 0, `boom=${b.out.boomDeg.toFixed(1)}°`);
  check('右舷来风时向下风(左)侧滑', b.out.leewayDeg < 0, `leeway=${b.out.leewayDeg.toFixed(2)}°`);
  check('有前进速度', b.out.speedKn > 2, `${b.out.speedKn.toFixed(2)}kn`);
  // 对称性：镜像到左舷受风应得到镜像结果
  const b2 = makeBoat(55);
  simulate(b2, 25, (bt) => { steerTowards(bt, 55 * DEG); trimAssist(bt); });
  check('左舷受风速度对称', Math.abs(b2.out.speedKn - b.out.speedKn) < 0.15,
    `${b.out.speedKn.toFixed(2)} vs ${b2.out.speedKn.toFixed(2)}kn`);
  check('左舷受风横倾对称', Math.abs(b2.phi + b.phi) < 2 * DEG,
    `${b.out.heelDeg.toFixed(1)} vs ${b2.out.heelDeg.toFixed(1)}°`);
}
{
  // 舵效：+rudder 输入应右转（psi 增大）
  const b = makeBoat(-90);
  simulate(b, 12, (bt) => { steerTowards(bt, -90 * DEG); trimAssist(bt); });
  const psi0 = b.psi;
  b.ctl.rudder = 0.5;
  simulate(b, 2);
  check('正舵输入使船右转', wrapPi(b.psi - psi0) > 5 * DEG, `Δψ=${(wrapPi(b.psi - psi0) / DEG).toFixed(1)}°`);
}

// ---------- 2) 稳态极曲线 ----------
console.log(`\n=== 极曲线（真风 ${TWS_KN}kn）===`);
console.log('  TWA°   速度kn   VMG kn   横倾°   侧滑°   帆杠°   缭绳    舵°    Fr');
const rows = [];
for (let twa = 35; twa <= 180; twa += 5) {
  // 风从北(0°)：真风角 twa 对应艏向 = -twa（取右舷受风一侧, twa>0 风从右舷）
  const heading = -twa * DEG;
  const b = makeBoat(-twa);
  let avg = { spd: 0, vmg: 0, heel: 0, lee: 0, boom: 0, sheet: 0, rud: 0, fr: 0, n: 0 };
  const T = 55;
  simulate(b, T, (bt, t) => {
    steerTowards(bt, heading);
    trimAssist(bt, twa < 60 ? 18 : twa < 100 ? 17 : 15);
    if (t > T - 8) {
      avg.spd += bt.out.speedKn; avg.vmg += bt.out.vmgKn; avg.heel += Math.abs(bt.out.heelDeg);
      avg.lee += bt.out.leewayDeg; avg.boom += Math.abs(bt.out.boomDeg); avg.sheet += bt.sheet;
      avg.rud += bt.out.rudderDeg; avg.fr += bt.out.fr; avg.n++;
    }
  });
  for (const k of Object.keys(avg)) if (k !== 'n') avg[k] /= avg.n;
  rows.push({ twa, ...avg });
  console.log(
    `  ${String(twa).padStart(4)}  ${avg.spd.toFixed(2).padStart(6)}  ${avg.vmg.toFixed(2).padStart(7)}` +
    `  ${avg.heel.toFixed(1).padStart(6)}  ${avg.lee.toFixed(1).padStart(6)}  ${avg.boom.toFixed(0).padStart(6)}` +
    `  ${avg.sheet.toFixed(2).padStart(5)}  ${avg.rud.toFixed(1).padStart(5)}  ${avg.fr.toFixed(2).padStart(5)}`
  );
}

const bestUp = rows.reduce((a, r) => (r.vmg > a.vmg ? r : a));
const bestDn = rows.reduce((a, r) => (r.vmg < a.vmg ? r : a));
console.log(`\n  最佳迎风 VMG: TWA ${bestUp.twa}°  ${bestUp.vmg.toFixed(2)}kn (船速 ${bestUp.spd.toFixed(2)}kn)`);
console.log(`  最佳顺风 VMG: TWA ${bestDn.twa}°  ${(-bestDn.vmg).toFixed(2)}kn (船速 ${bestDn.spd.toFixed(2)}kn)`);

// ---------- 3) 场景测试 ----------
console.log('\n=== 场景：抢风调向 (45° -> -45°) ===');
{
  const b = makeBoat(-45);
  simulate(b, 40, (bt) => { steerTowards(bt, -45 * DEG); trimAssist(bt, 18); });
  const v0 = b.out.speedKn;
  let minV = v0, tDone = -1;
  const dt = 1 / 60;
  for (let t = 0; t < 20; t += dt) {
    steerTowards(b, 45 * DEG);
    trimAssist(b, 18);
    b.step(wind, dt);
    minV = Math.min(minV, b.out.speedKn);
    if (tDone < 0 && Math.abs(wrapPi(b.psi - 45 * DEG)) < 5 * DEG) tDone = t;
  }
  simulate(b, 25, (bt) => { steerTowards(bt, 45 * DEG); trimAssist(bt, 18); });
  console.log(`  进入速度 ${v0.toFixed(2)}kn -> 转向完成 ${tDone.toFixed(1)}s，谷值 ${minV.toFixed(2)}kn，恢复后 ${b.out.speedKn.toFixed(2)}kn`);
  check('调向完成', tDone > 0 && tDone < 15, `${tDone.toFixed(1)}s`);
  check('调向后恢复速度', b.out.speedKn > v0 * 0.9);
  check('调向有真实掉速', minV < v0 * 0.85, `谷值 ${(minV / v0 * 100).toFixed(0)}%`);
  // 谷值下限只在中低风约束：大风里转慢了确实会近乎停住
  if (TWS_KN <= 14) check('中低风调向谷值合理(>20%)', minV > v0 * 0.2, `${(minV / v0 * 100).toFixed(0)}%`);
}

console.log('\n=== 场景：顶风死区 ===');
{
  const b = makeBoat(-45);
  simulate(b, 30, (bt) => { steerTowards(bt, -45 * DEG); trimAssist(bt, 18); });
  simulate(b, 25, (bt) => { steerTowards(bt, 0); bt.ctl.sheet = 0; });
  console.log(`  顶风 25s 后：速度 ${b.out.speedKn.toFixed(2)}kn  u=${b.u.toFixed(2)}m/s  inIrons=${b.out.inIrons}  sternway=${b.out.sternway}`);
  check('顶风失速（死区）', Math.abs(b.u) < 0.8, `u=${b.u.toFixed(2)}`);
}

console.log('\n=== 场景：波浪中的航行（对照平水）===');
{
  // 与游戏一致：波况随风速缩放。波浪顺风传播（风从北 => 波往 +z）。
  const runCase = (twa, useWaves) => {
    const waves = new WaveField();
    waves.setConditions(0, TWS_KN);
    const b = makeBoat(-twa);
    const dt = 1 / 60;
    let sum = 0, n = 0, maxV = 0, minV = 99, maxHeel = 0;
    for (let t = 0; t < 100; t += dt) {
      steerTowards(b, -twa * DEG);
      trimAssist(b, twa < 60 ? 18 : twa < 100 ? 17 : 15);
      if (useWaves) waves.update(dt);
      b.step(wind, dt, useWaves ? waves : null);
      if (t > 40) {
        sum += b.out.speedKn; n++;
        maxV = Math.max(maxV, b.out.speedKn);
        minV = Math.min(minV, b.out.speedKn);
        if (!b.capsized) maxHeel = Math.max(maxHeel, Math.abs(b.phi) / DEG);
      }
    }
    const finite = Number.isFinite(b.x + b.z + b.u + b.v + b.phi + b.psi);
    return { avg: sum / n, max: maxV, min: minV, maxHeel, finite };
  };
  const upF = runCase(45, false), upW = runCase(45, true);
  const dnF = runCase(150, false), dnW = runCase(150, true);
  const bmW = runCase(90, true);
  console.log(`  迎风45°:  平水 ${upF.avg.toFixed(2)}kn -> 带浪 ${upW.avg.toFixed(2)}kn (波动 ${upW.min.toFixed(2)}~${upW.max.toFixed(2)})`);
  console.log(`  顺风150°: 平水 ${dnF.avg.toFixed(2)}kn -> 带浪 ${dnW.avg.toFixed(2)}kn (波动 ${dnW.min.toFixed(2)}~${dnW.max.toFixed(2)})`);
  check('顺风可追浪冲浪（峰值明显高于平水）', dnW.max > dnF.max * 1.06, `峰值 ${dnW.max.toFixed(2)} vs 平水 ${dnF.max.toFixed(2)}kn`);
  check('顺风带浪被动均速损失有限（主动追浪才有净收益）', dnW.avg > dnF.avg * 0.88, `${dnW.avg.toFixed(2)} vs ${dnF.avg.toFixed(2)}kn`);
  if (upF.avg > 2) {
    check('迎风顶浪近似中性', upW.avg > upF.avg * 0.85 && upW.avg < upF.avg * 1.08, `${upW.avg.toFixed(2)} vs ${upF.avg.toFixed(2)}kn`);
  }
  check('波浪中数值稳定无发散', upW.finite && dnW.finite && dnW.max < 25);
  // 浪致横摇(cRollWave):横风带浪应有可感横倾且有界(压舷辅助下不至失控)
  console.log(`  横风90°带浪最大横倾 ${bmW.maxHeel.toFixed(1)}°`);
  check('横风带浪横摇有界', bmW.finite && bmW.maxHeel > 3 && bmW.maxHeel < 60, `${bmW.maxHeel.toFixed(1)}°`);
}

console.log('\n=== 风影几何自检 ===');
{
  // 一条船在原点，风从北来（fromPsi=0）=> 风影伸向 +z（下风）
  const fleet = [{ phys: { x: 0, z: 0, capsized: false } }];
  const at = (x, z) => shadowFactorAt(x, z, 0, fleet);
  console.log(`  下风8m ${at(0, 8).toFixed(2)}  下风25m ${at(0, 25).toFixed(2)}  上风8m ${at(0, -8).toFixed(2)}  旁侧12m ${at(12, 8).toFixed(2)}`);
  check('正下风处明显减风', at(0, 8) < 0.75, `${at(0, 8).toFixed(2)}`);
  check('风影随距离衰减', at(0, 25) > at(0, 8) && at(0, 45) === 1);
  check('上风与远旁侧不受影响', at(0, -8) === 1 && at(12, 8) > 0.97);
  check('风影左右对称', Math.abs(at(3, 12) - at(-3, 12)) < 1e-9);
  const capsized = [{ phys: { x: 0, z: 0, capsized: true } }];
  check('翻船的帆不挡风', shadowFactorAt(0, 8, 0, capsized) === 1);
}

console.log(ok ? '\n全部自检通过 ✓\n' : '\n存在自检失败 ✗\n');
process.exit(ok ? 0 : 1);
