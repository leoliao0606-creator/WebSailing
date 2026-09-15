// 稳向板帆船 6 自由度动力学：前进(surge)/横漂(sway)/艏摇(yaw)/横摇(roll)
// + 升沉(heave)/纵摇(pitch)。后两个由分段浮力驱动，见 stepBuoyancy。
// 船体坐标系：x=艏向前，y=右舷。横倾 φ>0 = 右舷下沉。罗盘角顺时针为正。
//
// 物理来源一览：
//  - 帆：有拱度翼型升阻力（失速/抖动），帆杠受缭绳限制自然摆到下风
//  - 稳向板/舵叶：有限展弦比对称翼，失速角 ~16°（低速大侧滑时横漂）
//  - 船体：黏性 + 兴波阻力（Froude 峰），高速滑行减阻
//  - 横摇：帆侧力 × 力臂 vs 船员压舷 + 船型稳性（大角度崩溃 → 翻船）
//  - 升沉/纵摇：沿船长 5 站的水线面浮力，船有自己的惯性和固有周期，不是贴在浪面上
//  - 顶浪掉速、冲上浪顶后腾空砸水、碎浪被船长平均掉，全部由上一条自然涌现
//  - 表观风、艏摇诱导流、倒车流动（失速进入死区后会倒漂）全部自然涌现

import { DEG, KN, clamp, lerp, smoothstep, wrapPi } from '../util/math.js';
import { RHO_AIR, RHO_WATER, sailCoeffs, sailLuff, foilCoeffs, foilForce2D } from './foils.js';

const G = 9.81;

// ILCA(Laser) 级单人稳向板参数
// 主风浪分量相对峰值波长的比例、主涌浪波长 m —— 与 waves.js 的 WIND_WAVES /
// SWELL_WAVES 里波幅最大的那一档保持一致。音效只需要「浪多久来一个」这一个尺度，
// 不必把全部 12 个分量都算一遍。
const PEAK_LEN_REL = 0.87;
const SWELL_LEN = 71;

// 遭遇频率(encounter frequency)：船每秒迎面撞上几个波峰，单位赫兹。
// 深水波相速 c = √(gλ/2π)，波自身频率 f = c/λ = √(g/(2πλ))。
// 船的世界速度 V 在波传播方向 t 上的分量记作 V·t，则
//   f_e = | f − (V·t)/λ |
// 顶浪时 V·t < 0，两项相加 → 浪来得又急又密；顺浪追着波跑时 V·t → c，
// f_e → 0 → 一个浪能骑很久，这就是滑浪。
function encounterHz(len, travelPsi, vw) {
  const lam = Math.max(1, len);
  const tx = Math.sin(travelPsi), tz = -Math.cos(travelPsi);
  return Math.abs(waveOwnHz(lam) - (vw.x * tx + vw.z * tz) / lam);
}

// 波自身的频率 Hz（与船无关）：岸边拍浪的节奏只由海况决定，船开多快都一样。
function waveOwnHz(len) {
  return Math.sqrt(G / (2 * Math.PI * Math.max(1, len)));
}

export const BOAT = {
  lwl: 4.06,            // 水线长 m
  massHull: 82,         // 船体+索具 kg
  massCrew: 78,         // 船员 kg
  sailArea: 7.06,       // m²
  hCE: 2.05,            // 帆压力中心高度（重心以上）m
  mastX: 1.28,          // 桅杆纵向位置（重心前）m
  ceAlongBoom: 1.16,    // 压力中心距桅杆沿帆杠距离 m
  boomMinDeg: 4,        // 缭绳收满时帆杠角
  boomMaxDeg: 88,       // 缭绳放尽时帆杠角
  boardArea: 0.32,      // 稳向板面积 m²
  boardAspect: 4.2,
  boardX: 0.18,         // 稳向板纵向位置 m
  boardDepth: 0.55,     // 板压力中心深度 m
  skegArea: 0.10,       // 船体龙骨线等效侧向面积（板收起时仍存在）
  rudderArea: 0.13,
  rudderAspect: 3.4,
  rudderX: -1.98,
  rudderDepth: 0.38,
  maxRudderDeg: 28,
  hikeMax: 0.88,        // 船员最大压舷横距 m
  crewSpeed: 1.35,      // 船员移动速度 m/s
  gmEff: 0.5,           // 船型初稳性等效 GM m
  stabFadeA: 38,        // 稳性开始衰减角°
  stabFadeB: 78,        // 稳性归零角°（超过即翻）
  Iz: 265,              // 艏摇转动惯量（含附加）kg·m²
  Ix: 105,              // 横摇转动惯量 kg·m²
  kSurgeAdd: 1.12,      // 前进有效惯性系数（船 + 随船加速的那部分水）。小艇纵向附加质量
                        // 约为排水量的 5~15%；取 1.12 让换舷时带得动动量穿过无动力区。
  kSwayAdd: 1.4,
  cViscous: 3.9,        // 黏性阻力 N/(m/s)²
  cWave: 4.4,           // 兴波阻力系数
  cPlane: 9.6,          // 滑行段阻力系数
  cAstern: 68,          // 倒航形状阻力 N/(m/s)²：方形船尾正面破水，是钝体而非
                        // 流线型。按船尾水线宽 ~1.2 m × 吃水 0.13 m、钝体 CD≈0.9 估。
  cSway: 320,           // 横向船体阻力 N/(m/s)²
  cYawDampL: 85,        // 船壳剩余艏摇阻尼；稳向板和舵已单独计算转动诱导阻力
  cYawDampQ: 300,       // 艏摇二次阻尼 N·m/(rad/s)²。按船体侧面沿船长积分估算：
                        // τ = 2∫₀^2.03 ½ρ·CD·draft·(ωx)²·x dx，取 CD≈0.5、吃水 0.13 m
                        // 得 ≈280。原来的 520 把板和舵的转动阻力又算了一遍。
  cRollDampL: 70,
  cRollDampQ: 260,
  cHeelYaw: 110,        // 横倾诱导艏摇 N·m/(rad·(m/s)²)：船横倾后浸没水线变得不对称，
                        // 把船头推向上风。这是「不扶舵就自己朝上风偏、倾得越狠偏得越快」
                        // 的主项，也是 broach 的来源（右倾→左转力矩）。
                        // 正比于 φ·u|u|，所以调向掉速到接近停船时它自然消失，
                        // 不会像只按帆力算的 cRigHeelYaw 那样把船锁在顶风区。
  cRigHeelYaw: 0.5,     // 横倾抢风力矩的有效力臂占 hCE 的比例（见 _substep 中的推导）
  windageArea: 1.1,     // 船体+船员受风面积 m²
  rudderRateDeg: 85,    // 舵机速率 °/s
  boomRateDeg: 150,     // 帆杠摆动速率 °/s
  sheetRate: 0.55,      // 缭绳收放速率 (0..1)/s
  boardRate: 0.6,
  capsizeDeg: 80,       // 判定翻船角
  rightingTime: 3.0,    // 按住扶正到位所需秒数
  capsizeRestDeg: 93,   // 翻船后平躺的姿态角°（帆平铺水面）
  rightedDeg: 20,       // 扶正结束时的姿态角°：人刚爬回船上，船还带着一点余倾
  cOrbital: 0.85,       // 波浪轨道流速对水动力的耦合系数（深度衰减已由 orbitalDepth 承担）
  cSurf: 1.0,           // 浪面坡度推力增益（冲浪/顶浪的来源）
  cSurfRelief: 0.5,     // 冲浪时船体卸载：自身波系叠加浪面，兴波阻力下降比例
  cRollWave: 0.45,       // 浪面横向坡度 -> 横摇力矩增益（浮力回复趋向浪面法线；大浪摇船与横浪翻船风险的来源）
  cRunHeel: 95,          // 正顺风上风侧横倾力矩（N·m@全深顺风）：平衡舵感/减摇的真实技巧，也是 death-roll 的种子
  runHeelDeg: 8,         // 自动压舷在正顺风时目标的上风微倾角（°）
  // —— 垂向（浮体）动力学 ——
  lwlHalf: 2.03,        // 半水线长 m：浮力站位沿船长的分布范围
  awp: 3.45,            // 水线面积 m²；浮力刚度 = ρ·g·Awp ≈ 34.7 kN/m
  submMax: 0.22,        // 浸没深度的软饱和上限 m（线性浮力在深浸没时会严重高估）
  kHeaveAdd: 1.55,      // 升沉附加质量系数 → 固有周期 ~0.53 s
  Iy: 175,              // 纵摇转动惯量 kg·m²（回转半径 ~0.26 倍船长）
  kPitchAdd: 2.6,       // 纵摇附加惯量系数（小艇纵摇要带动大量水）→ 固有周期 ~0.60 s
  draft: 0.13,          // 船体吃水 m（不含稳向板）：浸没率以它为尺度
  cHeaveDamp: 2640,     // 升沉阻尼 N·s/m（阻尼比 ~0.45）
  cHeaveDampQ: 900,     // 升沉二次阻尼 N/(m/s)²：大幅运动时才显著，压住砸水回弹
  cPitchDamp: 3990,     // 纵摇阻尼 N·m·s/rad（阻尼比 ~0.40）
  cPitchDampQ: 3200,    // 纵摇二次阻尼 N·m/(rad/s)²：压住大浪里的纵摇发散
  cSlam: 55,            // 艏部埋首增阻 N/(m·(m/s)²)：埋进浪里那部分船体的正面阻力
  cAddRes: 115,         // 波浪增阻 N/(m/s)²：艏部相对水面上下越猛，辐射掉的波能越多
  orbitalDepth: 0.24,   // 轨道流速的等效作用深度 m（船体吃水与稳向板的加权）
};

// 浮力站位：沿船长从艏(+1)到艉(-1)，乘 lwlHalf 得到体轴纵向坐标。
const STATIONS = [1.0, 0.5, 0.0, -0.5, -1.0];
// 各站的水线面占比（中部宽、两端窄，艉略宽于艏），已归一化到和为 1。
// Σ wᵢ·sᵢ² 决定纵摇刚度，这组权重给出 ≈3.9 m⁴ 的水线面纵向惯性矩，与实船相当。
const STATION_W = [0.105, 0.2375, 0.2875, 0.25, 0.12];

// 平水环境（不传波浪场时使用）
const FLAT_WAVE = { ovx: 0, ovz: 0, ax: 0, az: 0, immersion: 1, bowExcess: 0, bowRate: 0 };

// 来流从弦尾方向打来（倒航）时把弦参考翻 180°，使对称翼在反向流中给出正确反号的
// 升力 —— 否则 foilForce2D 在 ~160° 反流区落入失速拟合，侧力不反号，倒航舵不会反打。
// 对称翼翻弦不改变物理（同一块板的另一面），阻力沿来流方向不受影响。
function chordForFlow(chord, flowX, flowY) {
  return (flowX * Math.cos(chord) + flowY * Math.sin(chord) > 0) ? chord + Math.PI : chord;
}

export class BoatPhysics {
  constructor(params = BOAT) {
    this.p = { ...params };
    // —— 状态 ——
    this.x = 0; this.z = 0;        // 位置
    this.psi = 0;                  // 艏向（罗盘角）
    this.u = 0; this.v = 0;        // 体轴速度：前进/右横
    this.yawRate = 0;
    this.phi = 0;                  // 横倾
    this.phiRate = 0;
    this.boom = 0;                 // 帆杠实际角（+右舷）
    this._boomSettled = false;     // 首帧让帆杠瞬间落位，见 _substep
    this.rudder = 0;               // 舵角（弦向角，+鼻朝右）
    this.sheet = 1;                // 缭绳 0=收满 1=放尽
    this.board = 1;                // 稳向板 1=全放下
    this.crewY = 0;                // 船员横向位置（+右舷）
    this.current = { vx: 0, vz: 0 }; // 环境水流（世界系 m/s）：整片水体的平移，默认静水
    this.capsized = false;
    this.rightProgress = 0;
    this.powerScale = 1;           // 帆效率外部缩放(航行规则处罚等),1 = 正常
    // —— 垂向（浮体）状态，由 stepBuoyancy 推进 ——
    this.wave = {
      active: false,   // 是否正被波浪场驱动（渲染层据此决定用物理姿态还是回退近似）
      heaveY: -this.mass / (RHO_WATER * this.p.awp), // 船体基准面相对静水面的高度 m
      heaveRate: 0,
      theta: 0,        // 纵摇角 rad（+ = 艏抬）
      thetaRate: 0,
      immersion: 1,    // 平均浸没率 0..1（1 = 正常吃水，0 = 整条船离开水面）
      bowExcess: 0,    // 艏站超出平衡吃水的浸没深度 m（顶浪增阻用）
      slamSpeed: 0,    // 砸水强度：艏部浸没变深的速度 m/s（音效/浪花用）
      bowRate: 0,      // 艏站相对水面的垂向速度 m/s（有符号，波浪增阻用）
      ovx: 0, ovz: 0,  // 波浪轨道流速（世界系，已按等效深度衰减，全船加权平均）
      ax: 0, az: 0,    // 浪面坡度产生的水平加速度（世界系，全船加权平均）
      encounterHz: 0,  // 主风浪的遭遇频率 Hz（音效节奏用）
      swellHz: 0,      // 主涌浪的遭遇频率 Hz
      waveHz: 0,       // 主风浪自身的频率 Hz（不含船速，拍岸节奏用）
    };
    // —— 控制输入 ——
    this.ctl = { rudder: 0, sheet: 1, board: 1, hike: 0, autoHike: true, righting: false, autoTrim: false };
    // —— 诊断输出（HUD/AI/教学读取）——
    this.out = {
      awaDeg: 0, awsKn: 0, twaDeg: 0, twsKn: 0, boomDeg: 0, alphaDeg: 0, luff: 1,
      heelDeg: 0, speedKn: 0, vmgKn: 0, leewayDeg: 0, fr: 0, planing: 0,
      driveN: 0, sideN: 0, rudderDeg: 0, inIrons: false, sternway: false,
      sailYawNm: 0, heelYawNm: 0, rudderYawNm: 0, yawDampingNm: 0,
      surf: 0, // 浪面坡度沿艏向的推进加速度 m/s²（+ = 正在被浪推，HUD 冲浪提示）
      currentKn: 0, currentSetDeg: 0, // 环境水流速度（节）与去向罗盘角（HUD 潮流指示）
      pitchDeg: 0,   // 纵摇角（+ = 艏抬）
      airborne: 0,   // 腾空程度 0..1（1 = 船体完全离开水面，舵效大幅下降）
      slamSpeed: 0,  // 艏部砸水强度 m/s
      encounterHz: 0, swellHz: 0, // 迎面遇到风浪 / 涌浪的频率 Hz（音效节奏用）
      waveHz: 0,     // 风浪自身的频率 Hz（不含船速）
    };
  }

  get speed() { return Math.hypot(this.u, this.v); }
  get mass() { return this.p.massHull + this.p.massCrew; }

  // 世界速度向量
  worldVel(out = {}) {
    const s = Math.sin(this.psi), c = Math.cos(this.psi);
    // f=(s,-c), r=(c,s)
    out.x = this.u * s + this.v * c;
    out.z = -this.u * c + this.v * s;
    return out;
  }

  // 主步进。wind: WindField；waves: WaveField（可选，平水时省略）；dt 内部再细分。
  step(wind, dt, waves = null) {
    // 波浪环境（轨道流速、浪面坡度、浸没率）随垂向动力学一起在 stepBuoyancy 里算出
    this.stepBuoyancy(waves, dt);
    const SUB = 1 / 120;
    let t = dt;
    while (t > 1e-6) {
      const h = Math.min(SUB, t);
      this._substep(wind, h);
      t -= h;
    }
  }


  // —— 浮体垂向动力学：升沉(heave) + 纵摇(pitch) ——
  // 沿船长取 5 个站位采样波面，每站按线性化水线面浮力 ρ·g·Awp·wᵢ·浸没深度 给出
  // 垂向力：合力驱动升沉，对重心的力矩驱动纵摇。顺带算出全船平均的轨道流速与
  // 浪面坡度，供 _substep 的水动力使用。
  //
  // 与"把船贴在浪面上"的关键差别是船有自己的惯性和固有周期（升沉 ~0.53 s、
  // 纵摇 ~0.60 s），于是：
  //  - 短于船长的碎浪在各站之间相互抵消，船跨过去而不跟着抖；
  //  - 冲上浪顶后各站浸没归零 → 浮力消失 → 腾空 → 落回砸水；
  //  - 顶浪时艏站埋得深，超出平衡吃水的部分正对来流 → 额外阻力 → 顶浪掉速。
  //
  // 和 step() 分开，是因为联机的远端船只走渲染路径、不推进物理，但一样要在浪里
  // 起伏：boat.js 会对本帧没跑过 step 的船补调本方法（见 Boat.render）。
  stepBuoyancy(waves, dt) {
    const p = this.p;
    const b = this.wave;
    const d0 = this.mass / (RHO_WATER * p.awp); // 平衡浸没深度 m（总浮力 = 重力）
    const h = Math.min(Math.max(dt, 0), 0.25);  // 掉帧时不让垂向积分跨过固有周期
    if (!waves) {
      // 平水：垂向状态松弛回平衡位，并告诉渲染层不要用物理姿态
      const k = 1 - Math.exp(-h * 6);
      b.heaveY = lerp(b.heaveY, -d0, k);
      b.theta = lerp(b.theta, 0, k);
      b.heaveRate *= 1 - k;
      b.thetaRate *= 1 - k;
      b.immersion = 1;
      b.bowExcess = b.slamSpeed = 0;
      b.ovx = b.ovz = b.ax = b.az = 0;
      b.encounterHz = b.swellHz = b.waveHz = 0;
      b.active = false;
      return;
    }

    // —— 波面采样：每帧一次就够（一帧内船的位移和波面的变化都远小于波长）——
    const fwdX = Math.sin(this.psi), fwdZ = -Math.cos(this.psi);
    const st = this._stations ??= STATIONS.map(() => ({ s: 0, y: 0, out: {} }));
    let ovx = 0, ovz = 0, ax = 0, az = 0;
    for (let i = 0; i < STATIONS.length; i++) {
      const s = STATIONS[i] * p.lwlHalf;
      // 轨道流速按等效作用深度衰减：碎浪在吃水处已经没剩多少，长浪几乎不衰减
      const o = waves.sample(this.x + fwdX * s, this.z + fwdZ * s, st[i].out, p.orbitalDepth);
      const wgt = STATION_W[i];
      st[i].s = s;
      st[i].y = o.y;
      ovx += o.vx * wgt;
      ovz += o.vz * wgt;
      // 浪面坡度产生的沿坡向下水平加速度：a = -g·∇y = g·(nx,nz)/ny
      ax += G * (o.nx / o.ny) * wgt;
      az += G * (o.nz / o.ny) * wgt;
    }
    b.ovx = ovx; b.ovz = ovz; b.ax = ax; b.az = az;
    // 音效节奏用的两个遭遇频率。波浪顺风传播，所以传播方位角 = 来向 + π。
    const vw = this.worldVel(this._vwEnc ??= {});
    b.encounterHz = encounterHz(waves.peakLen * PEAK_LEN_REL, waves.windPsi + Math.PI, vw);
    b.swellHz = encounterHz(SWELL_LEN, waves.swellPsi + Math.PI, vw);
    b.waveHz = waveOwnHz(waves.peakLen * PEAK_LEN_REL);
    b.active = true;

    // —— 刚度与惯量 ——
    const kBuoy = RHO_WATER * G * p.awp;   // 单位浸没深度的总浮力 N/m
    const mEff = this.mass * p.kHeaveAdd;
    const iEff = p.Iy * p.kPitchAdd;
    // 注：滑行抬艏不在这里加力矩。抬艏会让前半船离水，纵摇恢复力矩随之消失
    // （刚度崩溃），任何常量抬艏力矩都会把姿态一路顶到上限卡死。真实的滑行抬艏
    // 是船底只有后半段贴水的几何姿态，不是力偶，所以放在渲染层做偏置。
    const weight = this.mass * G;
    const submMax = p.submMax;

    const SUB = 1 / 120;
    let t = h;
    let submBow = b.bowExcess + d0;
    while (t > 1e-6) {
      const dtx = Math.min(SUB, t);
      t -= dtx;
      let fz = -weight;
      let tau = 0;
      let rawAvg = 0;
      const sinT = Math.sin(b.theta);
      for (let i = 0; i < STATIONS.length; i++) {
        const s = st[i].s;
        const hull = b.heaveY + s * sinT;    // 该站船体基准面的高度
        const raw = st[i].y - hull;          // 水面高出基准面的量 = 浸没深度
        // 软饱和：线性水线面浮力在深浸没时严重高估（船体是尖的，甲板以上没有型宽）
        const subm = raw <= 0 ? 0 : submMax * (1 - Math.exp(-raw / submMax));
        const f = kBuoy * STATION_W[i] * subm;
        fz += f;
        tau += f * s;                        // s>0(艏)浸没深 → 抬艏力矩
        rawAvg += raw * STATION_W[i];
        if (i === 0) submBow = subm;
      }
      fz -= p.cHeaveDamp * b.heaveRate + p.cHeaveDampQ * b.heaveRate * Math.abs(b.heaveRate);
      tau -= p.cPitchDamp * b.thetaRate + p.cPitchDampQ * b.thetaRate * Math.abs(b.thetaRate);
      b.heaveRate += (fz / mEff) * dtx;
      b.thetaRate += (tau / iEff) * dtx;
      b.heaveY += b.heaveRate * dtx;
      const th = b.theta + b.thetaRate * dtx;
      // 撞到姿态上限时把角速度一并吃掉，否则会贴着上限来回抽
      if (th > 0.5) { b.theta = 0.5; b.thetaRate = Math.min(b.thetaRate, 0); }
      else if (th < -0.5) { b.theta = -0.5; b.thetaRate = Math.max(b.thetaRate, 0); }
      else b.theta = th;
      // 浸没率以船体真实吃水为尺度，而不是线性化浮力那 4.5 cm 的等效浸没深度：
      // 基准面齐平波面就算全浸，要整整浮起一个吃水才算完全离水。用等效浸没深度
      // 做尺度会把"稍微跟不上浪面"误判成腾空，船体阻力被大片抹掉，结果浪里反而
      // 比平水跑得快。
      b.immersion = clamp((rawAvg + p.draft) / p.draft, 0, 1);
    }
    // 防漂移兜底：船体不可能离开中站波面几米远
    const yRef = st[2].y;
    if (b.heaveY > yRef + 2.5) { b.heaveY = yRef + 2.5; b.heaveRate = Math.min(b.heaveRate, 0); }
    if (b.heaveY < yRef - 2.5) { b.heaveY = yRef - 2.5; b.heaveRate = Math.max(b.heaveRate, 0); }

    const bowExcess = Math.max(0, submBow - d0);
    // 砸水强度 = 艏部浸没变深的速度，入水瞬间最大（音效与浪花取用）
    b.slamSpeed = Math.max(0, (bowExcess - b.bowExcess) / Math.max(h, 1e-4));
    b.bowExcess = bowExcess;
    // 艏站相对水面的垂向速度（有符号）：顶浪时船与浪相向而行，遭遇频率高、
    // 艏部剧烈起落；顺浪时船跟着浪走，这个量小得多。波浪增阻按它的平方计。
    const rawBow = st[0].y - (b.heaveY + st[0].s * Math.sin(b.theta));
    b.bowRate = (rawBow - (this._rawBowPrev ?? rawBow)) / Math.max(h, 1e-4);
    this._rawBowPrev = rawBow;
  }

  _substep(wind, dt) {
    const p = this.p;
    const ctl = this.ctl;

    // —— 控制量的物理速率限制 ——
    const rudTarget = -clamp(ctl.rudder, -1, 1) * p.maxRudderDeg * DEG; // +输入 = 右转 → 舵鼻向左
    const rudStep = p.rudderRateDeg * DEG * dt;
    this.rudder += clamp(rudTarget - this.rudder, -rudStep, rudStep);
    this.sheet += clamp(clamp(ctl.sheet, 0, 1) - this.sheet, -p.sheetRate * dt, p.sheetRate * dt);
    this.board += clamp(clamp(ctl.board, 0, 1) - this.board, -p.boardRate * dt, p.boardRate * dt);

    // —— 环境 ——
    const w = wind.sample(this.x, this.z);
    const sinP = Math.sin(this.psi), cosP = Math.cos(this.psi);
    // 世界 -> 体轴（x前 y右）
    const toBodyX = (wx, wz) => wx * sinP - wz * cosP;
    const toBodyY = (wx, wz) => wx * cosP + wz * sinP;

    // 表观风（体轴）：真风 - 船速
    const velWX = this.u * sinP + this.v * cosP;
    const velWZ = -this.u * cosP + this.v * sinP;
    const awX = toBodyX(w.vx - velWX, w.vz - velWZ);
    const awY = toBodyY(w.vx - velWX, w.vz - velWZ);
    const aws = Math.hypot(awX, awY);
    // 视风来向角（相对艏向，+ = 来自右舷）
    const awa = Math.atan2(-awY, -awX);
    const twa = wrapPi(w.fromPsi - this.psi);

    // —— 帆杠动力学：受风自然摆向下风，受缭绳限制 ——
    const boomMax = lerp(p.boomMinDeg, p.boomMaxDeg, this.sheet) * DEG;
    let vane = wrapPi(-awa);
    const boomSide = Math.sign(this.boom || 1);
    // 正顺风附近的换舷滞回：容许一定程度的"以背风行驶"，风角越过 ~20° 才发生换舷（gybe）
    if (Math.sign(vane) !== boomSide && Math.abs(awa) > 160 * DEG) {
      vane = boomSide * Math.abs(vane);
    }
    let boomTarget = clamp(vane, -boomMax, boomMax);
    if (this.capsized) boomTarget = boomSide * boomMax;
    // 首帧让帆杠瞬间落位，不受摆动速率限制。新建或 place() 重置的船缭绳是放尽的
    // (sheet=1)，帆杠却还留在中线(boom=0) —— 这个组合在真实里不存在，缭绳一放
    // 帆杠立刻就被风吹到下风侧。让它按 150°/s 慢慢摆出去的话，横风起步的头半秒
    // 帆的攻角接近 90°(帆面几乎正对风)，侧力是正常吃风时的好几倍：25 节出生
    // 横倾会冲到 51°，30 节直接在 1.2 秒内翻船 —— 玩家什么都没做就翻了。
    const boomStep = this._boomSettled ? p.boomRateDeg * DEG * dt : Math.PI * 2;
    this._boomSettled = true;
    this.boom += clamp(boomTarget - this.boom, -boomStep, boomStep);

    // —— 力累加（体轴）——
    let Fx = 0, Fy = 0, tauYaw = 0, tauRoll = 0;
    let sailYaw = 0, rudderYaw = 0, rigHeelYaw = 0;

    // 帆（翻船后帆平躺水面，不产生气动力）
    let alphaSail = 0, luff = 1;
    if (!this.capsized && aws > 0.05) {
      const heelEff = Math.pow(Math.cos(this.phi), 1.4); // 横倾使有效帆面积/攻角下降
      const chordAngle = -this.boom; // 弦“鼻”方向 = 帆杠反向
      const f = foilForce2D(awX, awY, chordAngle, p.sailArea * heelEff * this.powerScale, RHO_AIR, sailCoeffs);
      alphaSail = f.alpha;
      luff = sailLuff(f.alpha);
      // 压力中心位置（帆杠摆出时外移，顺风时驱动力偏舷 → 拱头力矩）
      const ceX = p.mastX - Math.cos(this.boom) * p.ceAlongBoom;
      const ceY = Math.sin(this.boom) * p.ceAlongBoom * Math.cos(this.phi);
      Fx += f.fx; Fy += f.fy;
      sailYaw = ceX * f.fy - ceY * f.fx;
      tauYaw += sailYaw;
      // 横倾诱导抢风舵：桅杆随船倾倒，帆压力中心在水平面内横移 hCE·sin(φ) 到低舷，
      // 而抵抗它的船体阻力仍在中线附近，两者构成一个力偶。右倾 → 推力偏右舷 →
      // 船头被推向左（上风）。这就是横倾越大舵越“抢风”的来源，也是不用舵、
      // 只靠压舷改变倾角就能转向的原理。
      // 力臂打 cRigHeelYaw 折：全额 hCE 是侧向力（升力）的压力中心高度，而驱动
      // 分量沿桅杆的分布重心更低——三角帆下半部弦长大、出力占比高。
      rigHeelYaw = -p.cRigHeelYaw * p.hCE * Math.sin(this.phi) * f.fx;
      tauYaw += rigHeelYaw;
      tauRoll += f.fy * p.hCE * Math.cos(this.phi);
      // 帆抖动的寄生阻力已含在 CD 里
    }

    // 船体/船员受风（漂移、死区倒漂的推手）
    {
      const q = 0.5 * RHO_AIR * p.windageArea * 0.9;
      Fx += q * aws * awX * (this.capsized ? 2.2 : 1);
      Fy += q * aws * awY * (this.capsized ? 2.2 : 1);
    }

    // —— 波浪环境：水体本身在动（轨道流速），船沿浪面还受坡度推力 ——
    const wv = this.wave.active ? this.wave : FLAT_WAVE;
    // 浸没率：冲上浪顶后船体离开水面，一切水动力随之消失 —— 这就是腾空时舵一点不
    // 咬水、落回来才重新有反应的原因。稳向板和舵叶深插在水下（0.55 / 0.38 m），
    // 船体离水时它们大半还在水里，所以衰减得比船体轻得多。
    const imm = wv.immersion;
    const immFoil = 0.45 + 0.55 * imm;
    // 船体阻力只在真正整船腾空时才消失，不随浸没率线性缩放：顶浪时船在浪里
    // 颠簸，平均浸没率会掉到 0.7 上下，但湿表面积其实不减反增（艏部埋进浪里）。
    // 按平均浸没率打折会让"颠簸"变成减阻，顶浪反而比平水跑得快。
    const immHull = smoothstep(0.02, 0.35, imm);
    // 水动力参照系 = 波浪轨道流速（吃水处衰减）+ 环境水流（整片水体平移，不衰减）。
    // 船位积分的是对地速度 u/v，故稳态下船会随水流漂移；表观风仍用对地速度（空气不随水动）。
    const cur = this.current;
    const owX = toBodyX(wv.ovx, wv.ovz) * p.cOrbital + toBodyX(cur.vx, cur.vz);
    const owY = toBodyY(wv.ovx, wv.ovz) * p.cOrbital + toBodyY(cur.vx, cur.vz);
    const ru = this.u - owX; // 相对水体的体轴速度（一切水动力的参照系）
    const rv = this.v - owY;
    let surfAcc = 0;
    let waveRollAcc = 0; // 浪面横向坡度加速度(未乘 cSurf),供横摇力矩
    {
      // 坡度推力本质是浮力的水平分量，船离水时它一起消失
      const sax = toBodyX(wv.ax, wv.az) * p.cSurf * imm;
      const say = toBodyY(wv.ax, wv.az) * p.cSurf * imm;
      surfAcc = sax;
      waveRollAcc = toBodyY(wv.ax, wv.az) * imm;
      Fx += this.mass * sax;
      Fy += this.mass * say * 0.5; // 横向坡度推力打折：横摇-横漂耦合未建模
    }

    // —— 水动力 ——
    const boardArea = p.skegArea + p.boardArea * this.board;
    const boardAspect = 0.8 + p.boardAspect * this.board;
    // 稳向板（含艏摇诱导流）
    {
      const flowX = -ru;
      const flowY = -(rv + this.yawRate * p.boardX);
      const f = foilForce2D(flowX, flowY, chordForFlow(0, flowX, flowY), boardArea * immFoil, RHO_WATER,
        (a) => foilCoeffs(a, boardAspect, 16));
      Fx += f.fx; Fy += f.fy;
      tauYaw += p.boardX * f.fy;
      tauRoll += f.fy * -(p.boardDepth * this.board + 0.08);
    }
    // 舵叶（倒航时来流从艉打来，翻弦参考使舵效自然反向 —— 死区脱困的“反舵”）
    if (!this.capsized) {
      const flowX = -ru;
      const flowY = -(rv + this.yawRate * p.rudderX);
      const f = foilForce2D(flowX, flowY, chordForFlow(this.rudder, flowX, flowY), p.rudderArea * immFoil, RHO_WATER,
        (a) => foilCoeffs(a, p.rudderAspect, 24));
      Fx += f.fx; Fy += f.fy;
      rudderYaw = p.rudderX * f.fy;
      tauYaw += rudderYaw;
      tauRoll += f.fy * -p.rudderDepth;
    }

    // 船体阻力：黏性 + 兴波（Froude 峰）+ 滑行减阻 + 横倾附加阻力
    const fr = Math.abs(ru) / Math.sqrt(G * p.lwl);
    const plane = smoothstep(0.5, 0.8, fr);
    {
      // 兴波阻力：Froude≈0.44 处的钟形峰（排水航行的"墙"）；滑行后过渡到平底滑水阻力
      // 正在被浪推（冲浪）且已接近墙区时船体卸载，兴波阻力下降 —— 追浪跃上滑行的关键。
      // 用 Fr 门控：迎风低速的浪背小推力不触发，避免顶浪反而提速。
      const surfK = clamp(surfAcc / 0.5, 0, 1) * smoothstep(0.34, 0.48, fr);
      const bell = 4.8 * Math.exp(-Math.pow((fr - 0.44) / 0.15, 2)) * (1 - p.cSurfRelief * surfK);
      const heelPenalty = 1 + 0.7 * Math.sin(this.phi) * Math.sin(this.phi);
      const R = (p.cViscous + p.cWave * bell + p.cPlane * plane) * heelPenalty * immHull * ru * Math.abs(ru);
      Fx -= R;
      Fy -= (p.cSway * rv * Math.abs(rv) + 90 * rv) * immHull;
      // 埋首阻力：艏站浸没超过平衡吃水时，多出来的浸没面正对来流
      if (ru > 0) Fx -= p.cSlam * wv.bowExcess * ru * ru;
      // 倒航形状阻力：正向航行时船体是流线型，倒着走则是方形船尾正面破水。
      // 用同一个 cViscous 描述两个方向，会让顶风停住的船被区区 20 N 的风推到
      // 近 3 节的倒退速度（真实约 1 节）。
      if (ru < 0) Fx -= p.cAstern * ru * Math.abs(ru);
      // 波浪增阻：船在浪里上下起落做功，能量以辐射波的形式带走，表现为掉速。
      // 顶浪时船与浪相向而行，遭遇频率高、艏部起落剧烈，这项显著；顺浪时船跟着
      // 浪走，艏部相对水面几乎不动，这项自动趋近于零 —— 顶浪掉速、顺浪不掉的
      // 真正来源，不是靠给两种航向分别写系数。
      Fx -= p.cAddRes * wv.bowRate * wv.bowRate * Math.sign(ru || 1) * immHull;
      // 翻船时巨大阻水
      if (this.capsized) { Fx -= 260 * ru * Math.abs(ru) + 160 * ru; Fy -= 420 * rv; }
    }

    // 横倾诱导艏摇（船体不对称 → 抢风舵；横倾越大越强，broach 的来源）
    const heelYaw = -p.cHeelYaw * this.phi * ru * Math.abs(ru);
    tauYaw += heelYaw;
    // 艏摇阻尼
    const yawDamping = -p.cYawDampL * this.yawRate - p.cYawDampQ * this.yawRate * Math.abs(this.yawRate);
    tauYaw += yawDamping;

    // —— 正顺风上风侧微倾 ——
    // 现实里正顺风要把船向上风侧压一点：平衡舵感、减小横摇、也是 death-roll 的种子。
    // 上风舷 = 帆的反侧；越接近正顺风越明显。physical 力矩让不自动压舷的玩家也自然
    // 上风倾；phiTarget 供下方自动压舷把船摆到这个目标角(而非死平)。
    const runDeep = smoothstep(140 * DEG, 175 * DEG, Math.abs(twa));
    const windSide = -(Math.sign(this.boom) || 1); // 上风倾的 phi 符号
    const phiTarget = windSide * runDeep * p.runHeelDeg * DEG;
    if (!this.capsized) tauRoll += windSide * runDeep * p.cRunHeel * clamp(Math.abs(ru) / 2.5, 0, 1);

    // —— 船员压舷 ——
    let crewTarget;
    if (this.capsized) {
      crewTarget = 0;
    } else if (ctl.autoHike) {
      // 自动配平到目标倾角（顺风时为上风微倾 phiTarget，其余为水平），手动输入作偏置
      const hold = this.mass * G * p.gmEff * Math.sin(phiTarget); // 维持 phiTarget 需抵消的稳性回正
      const needed = (-tauRoll + hold) / Math.max(1, p.massCrew * G * Math.cos(this.phi));
      crewTarget = clamp(needed, -p.hikeMax, p.hikeMax);
      crewTarget = clamp(crewTarget + ctl.hike * 0.45, -p.hikeMax, p.hikeMax);
    } else {
      crewTarget = clamp(ctl.hike, -1, 1) * p.hikeMax;
    }
    this.crewY += clamp(crewTarget - this.crewY, -p.crewSpeed * dt, p.crewSpeed * dt);
    tauRoll += this.crewY * p.massCrew * G * Math.cos(this.phi);

    // —— 船型稳性（大角度崩溃）——
    const aPhi = Math.abs(this.phi);
    const fade = 1 - 1.18 * smoothstep(p.stabFadeA * DEG, p.stabFadeB * DEG, aPhi);
    tauRoll += -this.mass * G * p.gmEff * Math.sin(this.phi) * fade;
    // 浪致横摇：浮力回复力矩趋向浪面法线（等效把浪面横向坡度当作侧向重力分量）。
    // 放在船员压舷之后累加,自动压舷不会瞬时抵消它 —— 大浪真实摇船,
    // 横浪 + 阵风横倾叠加时逼近稳性崩溃区,构成大浪翻船风险。
    if (!this.capsized) tauRoll += this.mass * p.gmEff * waveRollAcc * p.cRollWave;
    // 横摇阻尼
    tauRoll -= p.cRollDampL * this.phiRate + p.cRollDampQ * this.phiRate * Math.abs(this.phiRate);

    // —— 翻船 / 扶正 ——
    if (!this.capsized && aPhi > p.capsizeDeg * DEG) {
      this.capsized = true;
      this.rightProgress = 0;
    }
    if (this.capsized) {
      const side = Math.sign(this.phi) || 1;
      // 扶正进度：按住前进，松开回退。先推进它，姿态目标角再由它算出来。
      this.rightProgress = ctl.righting
        ? Math.min(1, this.rightProgress + dt / p.rightingTime)
        : Math.max(0, this.rightProgress - dt * 0.6);
      // 姿态目标角随进度从平躺连续摆到近乎扶正，而不是「到点了才把 phi 一把设过去」。
      // 旧写法是固定 93° 的弹簧加一个封顶 950 N·m 的反向力矩：950/2600 只够把船
      // 从 93° 拉到 74°，剩下的 50° 全靠 rightProgress≥1 那一帧瞬移补上，
      // 看上去就是扶正到一半突然跳起来。
      const s = this.rightProgress * this.rightProgress * (3 - 2 * this.rightProgress);
      const span = (p.rightedDeg - p.capsizeRestDeg) * DEG;
      const target = side * (p.capsizeRestDeg * DEG + span * s);
      // 目标角自身的角速度（smoothstep 对进度求导 = 6s(1-s)，进度对时间求导见上）。
      const dProg = ctl.righting ? 1 / p.rightingTime : -0.6;
      const targetRate = side * span * 6 * this.rightProgress * (1 - this.rightProgress) * dProg;
      // 阻尼取「相对目标角速度」而不是绝对角速度：否则弹簧一边拉、阻尼一边按住，
      // 匀速段会留下正比于目标速度的固定滞后，跟不上就又要靠瞬移收尾。
      tauRoll += (target - this.phi) * 2600 - (this.phiRate - targetRate) * 2200;
      if (this.rightProgress >= 1) {
        // 此刻 phi 已经在 rightedDeg 附近、角速度接近零，直接交还给常规稳性即可。
        this.capsized = false;
        this.u *= 0.2; this.v *= 0.2;
        this.sheet = 1; this.ctl.sheet = 1; // 扶正后缭绳放空
      }
    }

    // —— 积分（体轴运动学，含离心耦合）——
    const m1 = this.mass * p.kSurgeAdd;
    const m2 = this.mass * p.kSwayAdd;
    this.u += (Fx / m1 + this.yawRate * this.v) * dt;
    this.v += (Fy / m2 - this.yawRate * this.u) * dt;
    this.yawRate += (tauYaw / p.Iz) * dt;
    this.phiRate += (tauRoll / p.Ix) * dt;
    this.psi = wrapPi(this.psi + this.yawRate * dt);
    this.phi = clamp(this.phi + this.phiRate * dt, -105 * DEG, 105 * DEG);
    this.x += (this.u * sinP + this.v * cosP) * dt;
    this.z += (-this.u * cosP + this.v * sinP) * dt;

    // —— 诊断 ——
    const o = this.out;
    o.awaDeg = awa / DEG;
    o.awsKn = aws / KN;
    o.twaDeg = twa / DEG;
    o.twsKn = w.speed / KN;
    o.boomDeg = this.boom / DEG;
    o.alphaDeg = alphaSail / DEG;
    o.luff = luff;
    o.heelDeg = this.phi / DEG;
    o.speedKn = this.speed / KN;
    // VMG：迎风为正
    const windDirX = Math.sin(w.fromPsi), windDirZ = -Math.cos(w.fromPsi);
    const vw = this.worldVel();
    o.vmgKn = (vw.x * windDirX + vw.z * windDirZ) / KN;
    o.leewayDeg = (Math.abs(this.u) > 0.15 ? Math.atan2(this.v, Math.abs(this.u)) : 0) / DEG;
    o.fr = fr;
    o.planing = plane;
    o.surf = surfAcc;
    o.driveN = Fx;
    o.sideN = Fy;
    o.sailYawNm = sailYaw;
    o.heelYawNm = heelYaw + rigHeelYaw;
    o.rudderYawNm = rudderYaw;
    o.yawDampingNm = yawDamping;
    o.rudderDeg = -this.rudder / DEG; // 转右为正，供 HUD
    o.inIrons = Math.abs(o.twaDeg) < 35 && this.u < 0.6 && !this.capsized;
    o.sternway = this.u < -0.05;
    o.pitchDeg = this.wave.theta / DEG;
    o.airborne = 1 - imm;
    o.slamSpeed = this.wave.slamSpeed;
    o.encounterHz = this.wave.encounterHz;
    o.swellHz = this.wave.swellHz;
    o.waveHz = this.wave.waveHz;
    o.currentKn = Math.hypot(cur.vx, cur.vz) / KN;
    o.currentSetDeg = (Math.atan2(cur.vx, -cur.vz) / DEG + 360) % 360; // 水流去向罗盘角
  }
}
