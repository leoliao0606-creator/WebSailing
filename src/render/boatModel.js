// 程序化 ILCA 风格稳向板帆船。
// 船体局部坐标：-z = 艏向前，+x = 右舷，+y = 上（物理体轴 x前/y右 => 局部 -z/+x）。
// 姿态：rotation YXZ = (纵摇, -艏向, -横倾)。

import * as THREE from 'three';
import { DEG, clamp, lerp, damp } from '../util/math.js';

const LOA = 4.2;
const HALF = LOA / 2;
const AXIS_Y = new THREE.Vector3(0, 1, 0); // 复用的竖直轴,避免逐帧分配

// 型线（沿船长 10 个控制站，t: 0=艉 1=艏）
const P_BEAM = [0.54, 0.65, 0.685, 0.695, 0.68, 0.62, 0.52, 0.37, 0.19, 0.03];
const P_KEEL = [0.15, 0.23, 0.29, 0.32, 0.32, 0.30, 0.25, 0.19, 0.12, 0.04];
const P_SHEER = [0.27, 0.26, 0.255, 0.26, 0.27, 0.285, 0.30, 0.325, 0.35, 0.385];

function profileAt(arr, t) {
  const f = clamp(t, 0, 1) * (arr.length - 1);
  const i = Math.floor(f), r = f - i;
  const a = arr[i], b = arr[Math.min(i + 1, arr.length - 1)];
  const s = r * r * (3 - 2 * r);
  return a + (b - a) * s;
}

function buildHull(topColor = 0xf4f1e8, bottomColor = 0x35566b) {
  const NS = 26, M = 15;
  const positions = [], colors = [], indices = [];
  const cTop = new THREE.Color(topColor);
  const cBot = new THREE.Color(bottomColor);
  const cTmp = new THREE.Color();
  const WL = -0.045; // 水线高度:以下为防污漆色,形成双色船体
  for (let i = 0; i <= NS; i++) {
    const t = i / NS;
    const xb = lerp(-HALF, HALF, t);       // 体轴 x
    const zl = -xb;                        // 局部 z
    const b = profileAt(P_BEAM, t), d = profileAt(P_KEEL, t), sh = profileAt(P_SHEER, t);
    for (let k = 0; k <= M; k++) {
      const u = (k / M) * 2 - 1;           // -1 左舷舷缘 .. 0 龙骨 .. +1 右舷舷缘
      const tt = 1 - Math.abs(u);
      const y = sh - (sh + d) * Math.pow(tt, 1.18);
      const x = Math.sign(u) * b * Math.pow(1 - Math.pow(tt, 2.1), 0.72);
      positions.push(x, y, zl);
      cTmp.copy(cBot).lerp(cTop, smooth01((y - WL) / 0.05));
      colors.push(cTmp.r, cTmp.g, cTmp.b);
    }
  }
  for (let i = 0; i < NS; i++) {
    for (let k = 0; k < M; k++) {
      const a = i * (M + 1) + k, b2 = a + M + 1;
      indices.push(a, b2, a + 1, a + 1, b2, b2 + 1);
    }
  }
  // 艉封板:复制一圈独立轮缘顶点(不与侧壳共享,保证平面硬边法线),
  // 绕序取从船艉(+z)看逆时针,面片朝外。
  const sternBase = positions.length / 3;
  const b0 = profileAt(P_BEAM, 0), d0 = profileAt(P_KEEL, 0), sh0 = profileAt(P_SHEER, 0);
  for (let k = 0; k <= M; k++) {
    const u = (k / M) * 2 - 1;
    const tt = 1 - Math.abs(u);
    const y = sh0 - (sh0 + d0) * Math.pow(tt, 1.18);
    const x = Math.sign(u) * b0 * Math.pow(1 - Math.pow(tt, 2.1), 0.72);
    positions.push(x, y, HALF);
    cTmp.copy(cBot).lerp(cTop, smooth01((y - WL) / 0.05));
    colors.push(cTmp.r, cTmp.g, cTmp.b);
  }
  const cIdx = positions.length / 3;
  positions.push(0, (sh0 - d0) / 2, HALF);
  cTmp.copy(cBot).lerp(cTop, smooth01(((sh0 - d0) / 2 - WL) / 0.05));
  colors.push(cTmp.r, cTmp.g, cTmp.b);
  for (let k = 0; k < M; k++) indices.push(sternBase + k, sternBase + k + 1, cIdx);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildDeck() {
  const NS = 26, M = 10;
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= NS; i++) {
    const t = i / NS;
    const xb = lerp(-HALF, HALF, t);
    const zl = -xb;
    const b = profileAt(P_BEAM, t) * 0.995, sh = profileAt(P_SHEER, t);
    for (let k = 0; k <= M; k++) {
      const u = (k / M) * 2 - 1;
      const x = u * b;
      let y = sh + (1 - u * u) * 0.035;    // 甲板拱度
      // 驾驶舱凹槽（体轴 x -1.55..0.35，半宽 0.34）
      const inX = smooth01((xb + 1.55) / 0.3) * (1 - smooth01((xb - 0.15) / 0.3));
      const inZ = 1 - smooth01((Math.abs(x) - 0.3) / 0.12);
      y -= 0.2 * clamp(inX, 0, 1) * clamp(inZ, 0, 1);
      positions.push(x, y, zl);
      uvs.push(u * 0.5 + 0.5, t);
    }
  }
  for (let i = 0; i < NS; i++) {
    for (let k = 0; k < M; k++) {
      const a = i * (M + 1) + k, b2 = a + M + 1;
      indices.push(a, a + 1, b2, a + 1, b2 + 1, b2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function smooth01(x) {
  x = clamp(x, 0, 1);
  return x * x * (3 - 2 * x);
}

// 帆布纹理：底色 + 扇形拼幅缝线 + 帆骨袋 + 观察窗 + 红色星芒 + 帆号
function makeSailTexture(sailNumber, accent = '#c03a2b') {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  // 底色带轻微纵向渐变(帆顶略亮,更有透光感)
  const bg = g.createLinearGradient(0, 0, 0, 512);
  bg.addColorStop(0, '#faf8f1');
  bg.addColorStop(1, '#f2eee1');
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 512);
  // 布纹微噪声
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `rgba(${180 + Math.random() * 40 | 0},${178 + Math.random() * 40 | 0},${168 + Math.random() * 40 | 0},0.05)`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  // 扇形拼幅缝线:从帆尾角(纹理右下)放射,微弯更像切割帆
  // 纹理坐标:u=弦向(0 桅杆 -> 1 后缘),v=高度(0 帆脚 -> 1 帆顶),v 朝上画布 y 反向
  g.strokeStyle = 'rgba(120,115,100,0.38)';
  g.lineWidth = 1.5;
  for (let i = 1; i <= 6; i++) {
    const y = 512 - i * 68;
    g.beginPath();
    g.moveTo(0, y);
    g.quadraticCurveTo(280, y - 14, 512, y - 40 - i * 4);
    g.stroke();
  }
  // 帆骨袋(后缘 4 条短双线)
  g.strokeStyle = 'rgba(110,105,92,0.5)';
  g.lineWidth = 3;
  for (let i = 1; i <= 4; i++) {
    const y = 512 - i * 96;
    g.beginPath(); g.moveTo(512, y); g.lineTo(400, y + 8); g.stroke();
  }
  // 观察窗(帆脚上方的半透明视窗,画成浅灰蓝)
  g.fillStyle = 'rgba(168,190,205,0.6)';
  g.strokeStyle = 'rgba(110,115,120,0.6)';
  g.lineWidth = 2;
  g.beginPath();
  if (g.roundRect) g.roundRect(96, 400, 150, 54, 10);
  else g.rect(96, 400, 150, 54);
  g.fill();
  g.stroke();
  // 星芒标志
  const cx = 320, cy = 160;
  g.fillStyle = accent;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a - 0.06) * 12, cy + Math.sin(a - 0.06) * 12);
    g.lineTo(cx + Math.cos(a) * 44, cy + Math.sin(a) * 44);
    g.lineTo(cx + Math.cos(a + 0.06) * 12, cy + Math.sin(a + 0.06) * 12);
    g.fill();
  }
  g.beginPath(); g.arc(cx, cy, 10, 0, Math.PI * 2); g.fill();
  // 帆号
  g.fillStyle = '#4a4640';
  g.font = 'bold 84px sans-serif';
  g.textAlign = 'center';
  g.fillText(String(sailNumber), 250, 330);
  // 底边红带
  g.fillStyle = accent;
  g.fillRect(0, 500, 512, 12);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createBoatVisual(opts = {}) {
  const hullColor = opts.hullColor ?? 0xf4f1e8;
  const sailNumber = opts.sailNumber ?? 8;
  const accent = opts.accent ?? '#c03a2b';

  const group = new THREE.Group();

  // —— 船体 / 甲板(水线以下防污漆双色) ——
  const hullMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.22, clearcoat: 0.7, clearcoatRoughness: 0.25,
  });
  const hull = new THREE.Mesh(buildHull(hullColor, 0x35566b), hullMat);
  hull.castShadow = true;
  const deckMat = new THREE.MeshStandardMaterial({ color: 0xe6dfcd, roughness: 0.6 });
  const deck = new THREE.Mesh(buildDeck(), deckMat);
  deck.castShadow = true;
  deck.receiveShadow = true;
  group.add(hull, deck);

  // 舱内深度遮罩塞块:只写深度不写颜色,在船体(order 0)之后、水面(order 2)之前
  // 绘制,把画进驾驶舱凹槽的水面片元按深度剔除;顶面压在舷缘之下,
  // 不遮舷外水花,浪峰高过舷缘时仍会漫进来(可接受的进水观感)。
  {
    const plug = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 0.31, 2.1),
      new THREE.MeshBasicMaterial({ colorWrite: false }),
    );
    plug.position.set(0, 0.1, 0.6); // 覆盖凹槽 z∈[-0.45,1.65],顶面 y≈0.255
    plug.renderOrder = 1;
    group.add(plug);
  }

  // 舷缘护舷条 + 舷侧彩色饰条(队色)
  {
    const mkRail = (yOff, inset, radius, mat) => {
      const pts = [];
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const xb = lerp(-HALF, HALF, t);
        pts.push(new THREE.Vector3(profileAt(P_BEAM, t) * inset, profileAt(P_SHEER, t) + yOff, -xb));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const railR = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, radius, 6), mat);
      const railL = railR.clone();
      railL.scale.x = -1;
      return [railR, railL];
    };
    const railMat = new THREE.MeshStandardMaterial({ color: 0x4b4b4b, roughness: 0.7 });
    group.add(...mkRail(0.015, 1, 0.022, railMat));
    const stripeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(accent), roughness: 0.35 });
    group.add(...mkRail(-0.05, 1.002, 0.012, stripeMat));
  }

  // —— 桅杆（含风向标）——
  const mastZ = -1.28;
  const sparMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc2, roughness: 0.4, metalness: 0.75 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.042, 5.5, 10), sparMat);
  mast.position.set(0, 2.85, mastZ);
  mast.castShadow = true;
  group.add(mast);

  const windex = new THREE.Group();
  {
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.5, 5),
      new THREE.MeshStandardMaterial({ color: 0x333333 }));
    stick.rotation.x = Math.PI / 2;
    stick.position.z = -0.1;
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.2, 4),
      new THREE.MeshStandardMaterial({ color: 0xd7481f }));
    fin.rotation.x = -Math.PI / 2;
    fin.position.z = -0.32;
    windex.add(stick, fin);
    windex.position.set(0, 5.72, mastZ);
    group.add(windex);
  }

  // —— 帆杠组（帆 + 帆杠）——
  const boomGroup = new THREE.Group();
  boomGroup.position.set(0, 0, mastZ);
  group.add(boomGroup);

  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 2.5, 8), sparMat);
  boom.geometry.rotateX(Math.PI / 2);
  boom.position.set(0, 0.98, 1.3);
  boom.castShadow = true;
  boomGroup.add(boom);

  // 帆网格
  const SAIL_R = 13, SAIL_C = 9;
  const sailGeo = new THREE.BufferGeometry();
  {
    const n = (SAIL_R + 1) * (SAIL_C + 1);
    sailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const uvs = new Float32Array(n * 2);
    let p = 0;
    for (let r = 0; r <= SAIL_R; r++)
      for (let s = 0; s <= SAIL_C; s++) { uvs[p++] = s / SAIL_C; uvs[p++] = r / SAIL_R; }
    sailGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const idx = [];
    for (let r = 0; r < SAIL_R; r++)
      for (let s = 0; s < SAIL_C; s++) {
        const a = r * (SAIL_C + 1) + s, b = a + SAIL_C + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    sailGeo.setIndex(idx);
  }
  const sailMat = new THREE.MeshStandardMaterial({
    map: makeSailTexture(sailNumber, accent),
    side: THREE.DoubleSide, roughness: 0.75,
    emissive: 0xffffff, emissiveIntensity: 0.07, // 帆布透光感
  });
  const sail = new THREE.Mesh(sailGeo, sailMat);
  sail.castShadow = true;
  boomGroup.add(sail);

  // —— 帆面纤维带(telltales):贴流时向后飘直,空帆/失速时乱抖,弱风下垂 ——
  const TT_SEGS = 5;
  const TT_SPECS = [
    { rr: 0.3, ss: 0.18, side: 1, color: 0x2e9e5b },
    { rr: 0.3, ss: 0.18, side: -1, color: 0xd04030 },
    { rr: 0.58, ss: 0.18, side: 1, color: 0x2e9e5b },
    { rr: 0.58, ss: 0.18, side: -1, color: 0xd04030 },
  ];
  const telltales = TT_SPECS.map((spec, i) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((TT_SEGS + 1) * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: spec.color }));
    line.frustumCulled = false;
    boomGroup.add(line);
    return { ...spec, line, phase: i * 2.3 };
  });

  // —— 稳向板（可升降）——
  const boardMat = new THREE.MeshStandardMaterial({ color: 0xd9c98f, roughness: 0.45 });
  const boardGroup = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.045, 1.2, 0.3), boardMat);
  blade.geometry.translate(0, -0.6, 0);
  boardGroup.add(blade);
  boardGroup.position.set(0, 0.45, -0.18);
  group.add(boardGroup);

  // —— 舵 + 舵柄 ——
  const rudderGroup = new THREE.Group();
  rudderGroup.position.set(0, 0.22, 2.08);
  const rblade = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.95, 0.26), boardMat);
  rblade.geometry.translate(0, -0.45, 0.05);
  const rhead = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x3c3c3c, roughness: 0.6 }));
  rhead.position.y = 0.1;
  const tiller = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 1.2, 6), sparMat);
  tiller.geometry.rotateX(Math.PI / 2);
  tiller.position.set(0, 0.26, -0.62);
  tiller.rotation.x = -0.12;
  rudderGroup.add(rblade, rhead, tiller);
  group.add(rudderGroup);

  // —— 船员:分段人偶(髋/大腿/小腿/躯干/颈/头/双臂),每帧按压舷姿态摆位 ——
  const crew = new THREE.Group();
  const wetsuit = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.8 });
  const vestM = new THREE.MeshStandardMaterial({ color: 0xc23f2e, roughness: 0.7 });
  const skinM = new THREE.MeshStandardMaterial({ color: 0xd9a37e, roughness: 0.7 });
  const hip = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.18, 4, 8), wetsuit);
  hip.rotation.x = Math.PI / 2; // 骨盆沿前后向,连接两侧髋关节
  hip.position.y = 0.06;

  // 四肢:单位胶囊按两端点摆位拉伸(近似 IK,姿态由 update 每帧解出)
  const _limbDir = new THREE.Vector3();
  function makeLimb(mat, radius, span) {
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, span, 4, 8), mat);
    crew.add(mesh);
    return { mesh, total: span + radius * 2 };
  }
  function placeLimb(limb, ax, ay, az, bx, by, bz) {
    _limbDir.set(bx - ax, by - ay, bz - az);
    const len = Math.max(_limbDir.length(), 1e-4);
    limb.mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    limb.mesh.quaternion.setFromUnitVectors(AXIS_Y, _limbDir.divideScalar(len));
    limb.mesh.scale.set(1, len / limb.total, 1);
  }
  const thighL = makeLimb(wetsuit, 0.072, 0.2);
  const thighR = makeLimb(wetsuit, 0.072, 0.2);
  const shinL = makeLimb(wetsuit, 0.052, 0.22);
  const shinR = makeLimb(wetsuit, 0.052, 0.22);
  const armAftU = makeLimb(vestM, 0.045, 0.16); // 后臂(舵手臂)上段
  const armAftF = makeLimb(skinM, 0.036, 0.16); // 后臂前段
  const armFwdU = makeLimb(vestM, 0.045, 0.16); // 前臂(缭绳臂)上段
  const armFwdF = makeLimb(skinM, 0.036, 0.16); // 前臂前段

  const torso = new THREE.Group();
  const torsoMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.145, 0.3, 4, 10), vestM);
  torsoMesh.position.y = 0.24;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.09, 8), skinM);
  neck.position.y = 0.44;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), skinM);
  head.position.y = 0.56;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.105, 12, 6, 0, Math.PI * 2, 0, 1.25), new THREE.MeshStandardMaterial({ color: 0xf0ede4, roughness: 0.8 }));
  cap.position.y = 0.585;
  torso.add(torsoMesh, neck, head, cap);
  torso.position.y = 0.08;
  crew.add(hip, torso);
  crew.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  group.add(crew);

  // —— 缭绳 ——
  const sheetGeo = new THREE.BufferGeometry();
  sheetGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  const sheetLine = new THREE.Line(sheetGeo, new THREE.LineBasicMaterial({ color: 0x222222 }));
  group.add(sheetLine);

  // —— 每帧姿态更新 ——
  const sailPos = sailGeo.attributes.position;
  const _boomEnd = new THREE.Vector3();
  let smPitch = 0, smRoll = 0, smHeave = 0, camberSm = 0, crewXSm = 0;
  // 帆法线重算降频:main.js 按到相机距离/是否玩家船设置(1=每帧,越远越稀)
  const sailNormals = { interval: 1, frame: 0 };

  function update(phys, waveField, time, dt) {
    // 波面姿态
    const w = waveField.sample(phys.x, phys.z);
    const fwdX = Math.sin(phys.psi), fwdZ = -Math.cos(phys.psi);
    const rgtX = Math.cos(phys.psi), rgtZ = Math.sin(phys.psi);
    const pitchWave = Math.atan2(-(w.nx * fwdX + w.nz * fwdZ), w.ny) * 0.7;
    const rollWave = Math.atan2(-(w.nx * rgtX + w.nz * rgtZ), w.ny) * 0.35;
    const bowUp = phys.out.planing * 0.06 + clamp(phys.u, 0, 6) * 0.004;
    smPitch = damp(smPitch, pitchWave + bowUp, 5, dt);
    smRoll = damp(smRoll, rollWave, 5, dt);
    smHeave = damp(smHeave, w.y, 8, dt);

    // 大角度横倾时船体浮起（舷宽 < 型深，侧躺吃水更浅）
    const heelLift = Math.pow(Math.abs(Math.sin(phys.phi)), 2) * 0.3;
    group.position.set(phys.x, smHeave - 0.04 + heelLift, phys.z);
    group.rotation.set(smPitch, -phys.psi, -(phys.phi + smRoll), 'YXZ');

    // 帆杠 / 舵 / 稳向板 / 风向标
    boomGroup.rotation.y = phys.boom;
    rudderGroup.rotation.y = -phys.rudder;
    boardGroup.position.y = lerp(1.15, 0.45, phys.board);
    windex.rotation.y = -phys.out.awaDeg * DEG;

    // 帆形：扭转 + 拱度 + 空帆抖动
    const luff = phys.out.luff;
    camberSm = damp(camberSm, clamp(phys.boom / 0.3, -1, 1), 6, dt);
    const twistAmt = (4 + 16 * phys.sheet) * DEG;
    let p = 0;
    for (let r = 0; r <= SAIL_R; r++) {
      const rr = r / SAIL_R;
      const luffY = 0.95 + 4.35 * rr;
      const luffZ = 0.09 + rr * 0.04;
      const chord = 2.34 * Math.pow(1 - rr, 0.92) + 0.1 * Math.sin(Math.PI * rr);
      const tw = twistAmt * rr * -Math.sign(camberSm || 1) * 0.7;
      for (let s = 0; s <= SAIL_C; s++) {
        const ss = s / SAIL_C;
        const bulge = Math.sin(Math.PI * Math.pow(ss, 0.85));
        let x = camberSm * bulge * chord * 0.105 + Math.sin(tw) * chord * ss * 0.5;
        // 空帆抖动波
        x += luff * 0.075 * Math.sin(ss * 12 - time * 16 + rr * 3) * bulge * (0.3 + 0.7 * rr);
        const z = luffZ + Math.cos(tw * ss) * chord * ss;
        sailPos.setXYZ(p++, x, luffY, z);
      }
    }
    sailPos.needsUpdate = true;
    // 帆形位置每帧更新,但法线重算(遍历 13×9 网格)按间隔降频降低远处/AI 船开销
    if (sailNormals.frame++ % sailNormals.interval === 0) sailGeo.computeVertexNormals();

    // 纤维带:与帆面同一套成形公式取根部位置,再向后缘拖出摆动的短飘带
    const stalled = Math.abs(phys.out.alphaDeg) > 26;
    const disturb = Math.max(luff, stalled ? 0.75 : 0);
    const airFlow = clamp(phys.out.awsKn / 8, 0.1, 1);
    for (const tt of telltales) {
      const rr = tt.rr, ss = tt.ss;
      const luffY = 0.95 + 4.35 * rr;
      const luffZ = 0.09 + rr * 0.04;
      const chord = 2.34 * Math.pow(1 - rr, 0.92) + 0.1 * Math.sin(Math.PI * rr);
      const tw = twistAmt * rr * -Math.sign(camberSm || 1) * 0.7;
      const bulge = Math.sin(Math.PI * Math.pow(ss, 0.85));
      const pos = tt.line.geometry.attributes.position;
      const segLen = 0.085;
      let x = camberSm * bulge * chord * 0.105 + Math.sin(tw) * chord * ss * 0.5 + tt.side * 0.02;
      let y = luffY;
      let z = luffZ + Math.cos(tw * ss) * chord * ss;
      pos.setXYZ(0, x, y, z);
      for (let i = 1; i <= TT_SEGS; i++) {
        const wob = Math.sin(time * 21 + tt.phase + i * 1.7) * disturb;
        x += tt.side * 0.004 + wob * segLen * 0.85;
        z += segLen * (0.2 + 0.8 * airFlow) * Math.cos(wob);
        y -= segLen * (1 - airFlow) * 0.85 + 0.005;
        pos.setXYZ(i, x, y, z);
      }
      pos.needsUpdate = true;
    }

    // 船员:坐在上风侧舱边,脚横伸钩住舱底压舷带;压舷越满臀部越出舷、膝盖越直
    const hikeK = clamp(phys.crewY / phys.p.hikeMax, -1, 1);
    // 坐侧:压舷取压舷侧;坐正时坐在帆杠对侧(上风舷)
    const side = Math.abs(hikeK) > 0.04 ? Math.sign(hikeK) : -(Math.sign(phys.boom) || 1);
    const seatX = phys.crewY * 0.72 + side * 0.16;
    crewXSm = damp(crewXSm, seatX, 6, dt);
    crew.position.set(crewXSm, 0.3, 0.42);
    const lean = hikeK * 1.05;
    torso.rotation.z = -lean;
    torso.rotation.y = -side * 0.7;
    // 双脚锚在船中线附近的压舷带(crew 组内坐标须抵消 crewXSm)
    const footX = -side * 0.08 - crewXSm;
    const bendUp = (1 - Math.abs(hikeK)) * 0.14;
    for (const [thigh, shin, fz] of [[thighL, shinL, -0.12], [thighR, shinR, 0.06]]) {
      const hipX = 0, hipY = 0.06;
      const fx = footX, fy = -0.2;
      const kx = (hipX + fx) * 0.5, ky = (hipY + fy) * 0.5 + bendUp, kz = fz + 0.02;
      placeLimb(thigh, hipX, hipY, fz, kx, ky, kz);
      placeLimb(shin, kx, ky, kz, fx, fy, fz + 0.04);
    }
    // 肩点随躯干外倾旋转;后手持舵柄延伸杆收在体侧,前手拉住缭绳方向
    const shX = -Math.sin(lean) * 0.42;
    const shY = 0.08 + Math.cos(lean) * 0.42;
    const aftHandX = shX - side * 0.06, aftHandY = shY - 0.34;
    const fwdHandX = clamp(-crewXSm * 0.7, -0.5, 0.5), fwdHandY = shY - 0.3;
    let ex = (shX + aftHandX) * 0.5 + side * 0.08, ey = (shY + aftHandY) * 0.5;
    placeLimb(armAftU, shX, shY, 0.1, ex, ey, 0.2);
    placeLimb(armAftF, ex, ey, 0.2, aftHandX, aftHandY, 0.3);
    ex = (shX + fwdHandX) * 0.5 + side * 0.06;
    ey = (shY + fwdHandY) * 0.5 - 0.04;
    placeLimb(armFwdU, shX, shY, -0.1, ex, ey, -0.16);
    placeLimb(armFwdF, ex, ey, -0.16, fwdHandX, fwdHandY, -0.2);
    crew.visible = !phys.capsized;

    // 缭绳：帆杠末端 -> 舱底(boomGroup 原点在桅杆处,故 bz 再加 mastZ)
    _boomEnd.set(0, 0.95, 2.45).applyAxisAngle(AXIS_Y, phys.boom);
    const bx = _boomEnd.x, by = _boomEnd.y, bz = _boomEnd.z + mastZ;
    const sp = sheetGeo.attributes.position;
    sp.setXYZ(0, bx, by, bz);
    sp.setXYZ(1, bx * 0.5, (by + 0.25) * 0.55, (bz + 0.9) * 0.5);
    sp.setXYZ(2, 0, 0.22, 0.9);
    sp.needsUpdate = true;
  }

  return { group, update, boomGroup, crew, sailNormals };
}
