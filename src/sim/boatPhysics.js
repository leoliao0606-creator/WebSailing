// 稳向板帆船 4 自由度动力学：前进(surge)/横漂(sway)/艏摇(yaw)/横摇(roll)。
// 船体坐标系：x=艏向前，y=右舷。横倾 φ>0 = 右舷下沉。罗盘角顺时针为正。
//
// 物理来源一览：
//  - 帆：有拱度翼型升阻力（失速/抖动），帆杠受缭绳限制自然摆到下风
//  - 稳向板/舵叶：有限展弦比对称翼，失速角 ~16°（低速大侧滑时横漂）
//  - 船体：黏性 + 兴波阻力（Froude 峰），高速滑行减阻
//  - 横摇：帆侧力 × 力臂 vs 船员压舷 + 船型稳性（大角度崩溃 → 翻船）
//  - 表观风、艏摇诱导流、倒车流动（失速进入死区后会倒漂）全部自然涌现

import { DEG, KN, clamp, lerp, smoothstep, wrapPi } from '../util/math.js';
import { RHO_AIR, RHO_WATER, sailCoeffs, sailLuff, foilCoeffs, foilForce2D } from './foils.js';

const G = 9.81;

// ILCA(Laser) 级单人稳向板参数
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
  kSurgeAdd: 1.04,      // 附加质量系数
  kSwayAdd: 1.4,
  cViscous: 3.9,        // 黏性阻力 N/(m/s)²
  cWave: 4.4,           // 兴波阻力系数
  cPlane: 9.6,          // 滑行段阻力系数
  cSway: 320,           // 横向船体阻力 N/(m/s)²
  cYawDampL: 240,       // 艏摇线性阻尼
  cYawDampQ: 520,
  cRollDampL: 70,
  cRollDampQ: 260,
  cHeelYaw: 26,         // 横倾诱导艏摇（抢风舵/broach 来源）
  windageArea: 1.1,     // 船体+船员受风面积 m²
  rudderRateDeg: 85,    // 舵机速率 °/s
  boomRateDeg: 150,     // 帆杠摆动速率 °/s
  sheetRate: 0.55,      // 缭绳收放速率 (0..1)/s
  boardRate: 0.6,
  capsizeDeg: 80,       // 判定翻船角
  rightingTime: 3.0,    // 按住扶正到位所需秒数
  cOrbital: 0.7,        // 波浪轨道流速对水动力的耦合系数（船体吃水处略衰减）
  cSurf: 1.0,           // 浪面坡度推力增益（冲浪/顶浪的来源）
  cSurfRelief: 0.5,     // 冲浪时船体卸载：自身波系叠加浪面，兴波阻力下降比例
};

// 平水环境（不传波浪场时使用）
const FLAT_WAVE = { ovx: 0, ovz: 0, ax: 0, az: 0 };

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
    this.rudder = 0;               // 舵角（弦向角，+鼻朝右）
    this.sheet = 1;                // 缭绳 0=收满 1=放尽
    this.board = 1;                // 稳向板 1=全放下
    this.crewY = 0;                // 船员横向位置（+右舷）
    this.capsized = false;
    this.rightProgress = 0;
    this.powerScale = 1;           // 帆效率外部缩放(航行规则处罚等),1 = 正常
    // —— 控制输入 ——
    this.ctl = { rudder: 0, sheet: 1, board: 1, hike: 0, autoHike: true, righting: false, autoTrim: false };
    // —— 诊断输出（HUD/AI/教学读取）——
    this.out = {
      awaDeg: 0, awsKn: 0, twaDeg: 0, twsKn: 0, boomDeg: 0, alphaDeg: 0, luff: 1,
      heelDeg: 0, speedKn: 0, vmgKn: 0, leewayDeg: 0, fr: 0, planing: 0,
      driveN: 0, sideN: 0, rudderDeg: 0, inIrons: false, sternway: false,
      surf: 0, // 浪面坡度沿艏向的推进加速度 m/s²（+ = 正在被浪推，HUD 冲浪提示）
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
    // 波浪环境每帧采样一次（波长 >> 单帧位移）：艏艉两点平均，
    // 短于船长的碎浪自然被平均掉，只有长浪能推船。
    const wv = this._waveEnv ??= { ovx: 0, ovz: 0, ax: 0, az: 0 };
    if (waves) {
      const fwdX = Math.sin(this.psi), fwdZ = -Math.cos(this.psi);
      const a = waves.sample(this.x + fwdX * 1.35, this.z + fwdZ * 1.35, this._wsBow ??= {});
      const b = waves.sample(this.x - fwdX * 1.35, this.z - fwdZ * 1.35, this._wsAft ??= {});
      wv.ovx = (a.vx + b.vx) * 0.5;
      wv.ovz = (a.vz + b.vz) * 0.5;
      // 浪面坡度产生的沿坡向下水平加速度：a = -g·∇y = g·(nx,nz)/ny
      wv.ax = G * 0.5 * (a.nx / a.ny + b.nx / b.ny);
      wv.az = G * 0.5 * (a.nz / a.ny + b.nz / b.ny);
    } else {
      wv.ovx = wv.ovz = wv.ax = wv.az = 0;
    }
    const SUB = 1 / 120;
    let t = dt;
    while (t > 1e-6) {
      const h = Math.min(SUB, t);
      this._substep(wind, h);
      t -= h;
    }
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
    const boomStep = p.boomRateDeg * DEG * dt;
    this.boom += clamp(boomTarget - this.boom, -boomStep, boomStep);

    // —— 力累加（体轴）——
    let Fx = 0, Fy = 0, tauYaw = 0, tauRoll = 0;

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
      const ceY = Math.sin(this.boom) * p.ceAlongBoom * 0.85;
      Fx += f.fx; Fy += f.fy;
      tauYaw += ceX * f.fy - ceY * f.fx;
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
    const wv = this._waveEnv ?? FLAT_WAVE;
    const owX = toBodyX(wv.ovx, wv.ovz) * p.cOrbital;
    const owY = toBodyY(wv.ovx, wv.ovz) * p.cOrbital;
    const ru = this.u - owX; // 相对水体的体轴速度（一切水动力的参照系）
    const rv = this.v - owY;
    let surfAcc = 0;
    {
      const sax = toBodyX(wv.ax, wv.az) * p.cSurf;
      const say = toBodyY(wv.ax, wv.az) * p.cSurf;
      surfAcc = sax;
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
      const f = foilForce2D(flowX, flowY, 0, boardArea, RHO_WATER,
        (a) => foilCoeffs(a, boardAspect, 16));
      Fx += f.fx; Fy += f.fy;
      tauYaw += p.boardX * f.fy;
      tauRoll += f.fy * -(p.boardDepth * this.board + 0.08);
    }
    // 舵叶
    let rudderStall = false;
    if (!this.capsized) {
      const flowX = -ru;
      const flowY = -(rv + this.yawRate * p.rudderX);
      const f = foilForce2D(flowX, flowY, this.rudder, p.rudderArea, RHO_WATER,
        (a) => { rudderStall = Math.abs(a) > 26 * DEG; return foilCoeffs(a, p.rudderAspect, 24); });
      Fx += f.fx; Fy += f.fy;
      tauYaw += p.rudderX * f.fy;
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
      const R = (p.cViscous + p.cWave * bell + p.cPlane * plane) * heelPenalty * ru * Math.abs(ru);
      Fx -= R;
      Fy -= p.cSway * rv * Math.abs(rv) + 90 * rv;
      // 翻船时巨大阻水
      if (this.capsized) { Fx -= 260 * ru * Math.abs(ru) + 160 * ru; Fy -= 420 * rv; }
    }

    // 横倾诱导艏摇（船体不对称 → 抢风舵；横倾越大越强，broach 的来源）
    tauYaw += -p.cHeelYaw * this.phi * ru * Math.abs(ru);
    // 艏摇阻尼
    tauYaw -= p.cYawDampL * this.yawRate + p.cYawDampQ * this.yawRate * Math.abs(this.yawRate);

    // —— 船员压舷 ——
    let crewTarget;
    if (this.capsized) {
      crewTarget = 0;
    } else if (ctl.autoHike) {
      // 自动配平到接近水平，手动输入作偏置
      const needed = -tauRoll / Math.max(1, p.massCrew * G * Math.cos(this.phi));
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
    // 横摇阻尼
    tauRoll -= p.cRollDampL * this.phiRate + p.cRollDampQ * this.phiRate * Math.abs(this.phiRate);

    // —— 翻船 / 扶正 ——
    if (!this.capsized && aPhi > p.capsizeDeg * DEG) {
      this.capsized = true;
      this.rightProgress = 0;
    }
    if (this.capsized) {
      const side = Math.sign(this.phi) || 1;
      // 平躺姿态弹簧
      tauRoll += (side * 93 * DEG - this.phi) * 2600 - this.phiRate * 2200;
      if (ctl.righting) {
        this.rightProgress += dt / p.rightingTime;
        tauRoll += -side * 950 * Math.min(1, this.rightProgress * 1.4);
        if (this.rightProgress >= 1) {
          this.capsized = false;
          this.phi = side * 25 * DEG;
          this.phiRate = 0;
          this.u *= 0.2; this.v *= 0.2;
          this.sheet = 1; this.ctl.sheet = 1; // 扶正后缭绳放空
        }
      } else {
        this.rightProgress = Math.max(0, this.rightProgress - dt * 0.6);
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
    o.rudderDeg = -this.rudder / DEG; // 转右为正，供 HUD
    o.inIrons = Math.abs(o.twaDeg) < 35 && this.u < 0.6 && !this.capsized;
    o.sternway = this.u < -0.05;
  }
}
