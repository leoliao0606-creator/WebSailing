// 写实水面：Gerstner 顶点位移（与 CPU 物理同参数同相位）+ 菲涅尔天空反射
// + 太阳高光/闪烁 + 浪尖白沫 + 阵风暗斑（与 JS 风场噪声逐位一致，可"读风"）。
//
// 网格用径向布局（顶点沿半径指数分布，中心跟随相机）而非均匀方格：均匀方格要
// 同时覆盖 1.7km 视距和分米级碎浪是做不到的（256 段铺 1700m = 6.6m 一格，连 21m
// 的主浪都只有 3 个采样点，波峰被采成折线且随网格跳动）。径向布局让近处格距降到
// 分米级，远场格距放到几十米，顶点总数反而更少。
// 配套地，每个波按"在当地能被几个顶点采到"自动衰减，超出网格解析力的碎浪平滑
// 消失（它们在远处本来也只该表现为粗糙的反射，那由片元着色器的法线扰动负责）。

import * as THREE from 'three';
import { WAVE_COUNT, WAVE_STRIDE } from '../sim/waves.js';
import { FOG_COLOR } from './sceneSetup.js';

const VERT = /* glsl */ `
uniform float uTime;
uniform float uWaves[${WAVE_COUNT * WAVE_STRIDE}]; // dx,dz,k,w,amp,q,ph
uniform float uGridR0;    // 径向网格最内环半径 m
uniform float uGridK;     // 相邻环的相对间距 Δr/r（指数分布的增长率）
varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
varying float vDist;

void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  float distCam = distance(wp, cameraPosition);
  // 顶点到网格中心的半径决定当地格距（局部坐标原点即网格中心）
  float ring = max(length(position.xz), uGridR0);
  float cell = ring * uGridK;

  vec3 p = wp;
  vec3 tx = vec3(1.0, 0.0, 0.0);
  vec3 tz = vec3(0.0, 0.0, 1.0);
  float crest = 0.0;
  float crestNorm = 0.0001;

  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    float dx = uWaves[i*${WAVE_STRIDE}+0], dz = uWaves[i*${WAVE_STRIDE}+1];
    float k  = uWaves[i*${WAVE_STRIDE}+2], w  = uWaves[i*${WAVE_STRIDE}+3];
    float Q  = uWaves[i*${WAVE_STRIDE}+5], PH = uWaves[i*${WAVE_STRIDE}+6];
    // 可解析度：一个波长被几个顶点采到。低于 ~4 点开始衰减，低于 2 点（奈奎斯特
    // 极限）归零，否则短波在稀疏网格上会退化成随位置乱跳的噪声。
    float lambda = 6.2831853 / k;
    float res = 1.0 - smoothstep(0.22, 0.5, cell / lambda);
    float A  = uWaves[i*${WAVE_STRIDE}+4] * res;
    float ph = k * (dx * wp.x + dz * wp.z) - w * uTime + PH;
    float c = cos(ph), s = sin(ph);
    // Gerstner：水平向波峰聚拢 + 垂直起伏
    p.x += Q * A * dx * c;
    p.z += Q * A * dz * c;
    p.y += A * c;
    // 解析导数 -> 切向量
    float kA = k * A;
    tx.x += -Q * kA * dx * dx * s;
    tx.z += -Q * kA * dx * dz * s;
    tx.y += -kA * dx * s;
    tz.x += -Q * kA * dx * dz * s;
    tz.z += -Q * kA * dz * dz * s;
    tz.y += -kA * dz * s;
    float steep = Q * kA;
    crest += pow(max(c, 0.0), 4.0) * steep;
    crestNorm += steep;
  }

  vNormal = normalize(cross(tz, tx));
  vCrest = crest / crestNorm;
  vWorld = p;
  vDist = distCam;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uDeep;
uniform vec3 uScatter;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec2 uGustDir;    // 风来向单位向量
uniform float uDrift;     // 阵风团漂移距离（与 JS 一致）
uniform float uGustScale;
uniform float uGustAmp;
uniform float uSeed;
uniform float uWhitecap;  // 白浪程度 0..1
uniform vec2 uWindFlow;   // 表面细波纹漂移方向

varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
varying float vDist;

// —— 与 JS util/math.js 逐位一致的整数哈希值噪声（读风用）——
float hashi(int ix, int iz) {
  uint h = uint(ix) * 374761393u + uint(iz) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h ^= (h >> 16u);
  return float(h) / 4294967295.0;
}
float vnoise(vec2 p) {
  vec2 f = fract(p);
  int ix = int(floor(p.x)), iz = int(floor(p.y));
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hashi(ix, iz), b = hashi(ix + 1, iz);
  float c = hashi(ix, iz + 1), d = hashi(ix + 1, iz + 1);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// 阵风系数（同 wind.js gustFactor 的噪声部分，返回 -1..1）
float gustMask(vec2 xz) {
  vec2 g = (xz + uGustDir * uDrift) / uGustScale;
  float n = vnoise(vec2(g.x + uSeed, g.y - uSeed)) * 0.65 +
            vnoise(vec2(g.x * 2.7 + 31.7, g.y * 2.7)) * 0.35;
  return n * 2.0 - 1.0;
}

void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float detailFade = exp(-vDist / 260.0);

  float gust = gustMask(vWorld.xz);
  float gustPos = max(gust, 0.0) * uGustAmp * 2.5;   // 阵风强度 ~0..0.8
  float lull = max(-gust, 0.0) * uGustAmp * 2.5;     // 风窝强度

  // 表面细波纹扰动法线（近处强,阵风区更碎,风窝处趋于镜面）
  vec3 N = normalize(vNormal);
  float s3;
  {
    float s1 = vnoise(vWorld.xz * 0.55 - uWindFlow * uTime * 0.55);
    float s2 = vnoise(vWorld.xz * 2.3 - uWindFlow * uTime * 1.4 + 13.7);
    s3 = vnoise(vWorld.xz * 7.1 + vec2(uTime * 0.4, -uTime * 0.33));
    // 顶点位移只做得动长浪；分米到米级的粗糙感全靠这层噪声法线，所以它要够强
    float str = (0.23 + 0.17 * gustPos) * (0.32 + 0.68 * detailFade);
    str *= 1.0 - 0.5 * min(lull, 1.0);
    N = normalize(N + vec3(s1 - 0.5, 0.0, s2 - 0.5) * str + vec3(s3 - 0.5, 0.0, 0.5 - s3) * str * 0.5);
  }

  float NdV = max(dot(N, V), 0.0);
  float fresnel = 0.022 + 0.978 * pow(1.0 - NdV, 5.0);

  // 天空反射（解析）
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 skyCol = mix(uHorizon, uZenith, pow(max(R.y, 0.0), 0.6));
  // 阵风区更"毛糙" -> 反射明显变暗(读风的主要线索);风窝处反射更亮更平
  skyCol *= 1.0 - 0.30 * smoothstep(0.02, 0.55, gust) * uGustAmp * 2.5;
  skyCol *= 1.0 + 0.10 * min(lull, 1.0);
  // 太阳眩光路径 + 噪声调制的碎闪
  float sunR = max(dot(R, uSunDir), 0.0);
  vec3 sunGlint = uSunColor * (pow(sunR, 1100.0) * 90.0 + pow(sunR, 90.0) * 0.9);
  sunGlint += uSunColor * pow(sunR, 260.0) * 2.4 * (0.3 + 0.7 * s3) * detailFade;

  // 水体色：深水 + 浪尖次表面散射;阵风区水体也略深
  float sunN = max(dot(N, normalize(uSunDir + vec3(0.0, 0.35, 0.0))), 0.0);
  float sss = vCrest * (0.35 + 0.65 * sunN);
  vec3 bodyCol = mix(uDeep, uScatter, clamp(sss, 0.0, 1.0));
  bodyCol *= 1.0 - 0.14 * min(gustPos, 1.0);

  vec3 col = mix(bodyCol, skyCol, fresnel) + sunGlint * (0.35 + 0.65 * fresnel);

  // 浪尖白沫（风大才出现），叠噪声破碎感;阵风扫过处白沫更密
  float foamN = vnoise(vWorld.xz * 0.9 + uWindFlow * uTime * 0.25) * 0.6 +
                vnoise(vWorld.xz * 3.1 - uWindFlow * uTime * 0.5) * 0.4;
  float cap = smoothstep(1.18 - uWhitecap * 0.55, 1.38 - uWhitecap * 0.5,
                         vCrest + foamN * 0.62 + 0.09 * max(gust, 0.0));
  cap *= 0.55 + 0.45 * detailFade;
  col = mix(col, vec3(0.92, 0.95, 0.96), cap * 0.85);

  // 雾（与场景 FogExp2 一致）
  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vDist * vDist);
  col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// 水面细节档位 -> 径向网格的环数与周向分段数
const WATER_GRID = {
  low: { rings: 104, sectors: 120 },
  medium: { rings: 144, sectors: 160 },
  high: { rings: 184, sectors: 192 },
};
const GRID_R0 = 1.2;    // 最内环半径 m
const GRID_RMAX = 3000; // 最外环半径 m（远超雾的可见距离，用来填满地平线）

// 径向网格：环半径按指数分布（相邻环的间距正比于半径），中心跟随相机。
// 近处格距降到分米级（碎浪的形状出得来），远场格距放到几十米（只剩长浪，而它们
// 本来就被 uWaves 的可解析度衰减和雾一起吃掉）。
function buildRadialGrid(rings, sectors) {
  const count = rings * sectors + 1; // +1 = 圆心
  const pos = new Float32Array(count * 3);
  const growth = Math.pow(GRID_RMAX / GRID_R0, 1 / (rings - 1));
  let p = 3; // 圆心留在 (0,0,0)
  for (let j = 0; j < rings; j++) {
    const r = GRID_R0 * Math.pow(growth, j);
    for (let s = 0; s < sectors; s++) {
      const a = (s / sectors) * Math.PI * 2;
      pos[p++] = Math.cos(a) * r;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * r;
    }
  }
  // 索引：圆心扇形 + 每条环带两个三角形。材质用 DoubleSide，绕序无关紧要。
  const tri = sectors + (rings - 1) * sectors * 2;
  const idx = count > 65535 ? new Uint32Array(tri * 3) : new Uint16Array(tri * 3);
  let q = 0;
  for (let s = 0; s < sectors; s++) {
    idx[q++] = 0;
    idx[q++] = 1 + ((s + 1) % sectors);
    idx[q++] = 1 + s;
  }
  for (let j = 0; j < rings - 1; j++) {
    const base = 1 + j * sectors, next = base + sectors;
    for (let s = 0; s < sectors; s++) {
      const s1 = (s + 1) % sectors;
      idx[q++] = base + s; idx[q++] = next + s1; idx[q++] = next + s;
      idx[q++] = base + s; idx[q++] = base + s1; idx[q++] = next + s1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), GRID_RMAX);
  // 相邻环的相对间距 Δr/r —— 顶点着色器用它把半径换算成当地格距
  geo.userData.gridK = growth - 1;
  return geo;
}

export class Water {
  constructor(waveField, sunDir) {
    this.waveField = waveField;
    this.detail = 'high';
    const geo = buildRadialGrid(WATER_GRID.high.rings, WATER_GRID.high.sectors);

    this.wavePack = new Float32Array(WAVE_COUNT * WAVE_STRIDE);
    waveField.packUniforms(this.wavePack);

    this.uniforms = {
      uTime: { value: 0 },
      uWaves: { value: this.wavePack },
      uGridR0: { value: GRID_R0 },
      uGridK: { value: geo.userData.gridK },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.92, 0.78) },
      uZenith: { value: new THREE.Color(0.11, 0.29, 0.5) },
      uHorizon: { value: new THREE.Color(0.68, 0.79, 0.86) },
      uDeep: { value: new THREE.Color(0.010, 0.056, 0.098) },
      uScatter: { value: new THREE.Color(0.055, 0.23, 0.225) },
      uFogColor: { value: FOG_COLOR.clone() },
      uFogDensity: { value: 0.00095 },
      uGustDir: { value: new THREE.Vector2(0, -1) },
      uDrift: { value: 0 },
      uGustScale: { value: 90 },
      uGustAmp: { value: 0.32 },
      uSeed: { value: 0 },
      uWhitecap: { value: 0.2 },
      uWindFlow: { value: new THREE.Vector2(0, 1) },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    // 在船体的舱内深度遮罩塞块(renderOrder 1,见 boatModel.js)之后绘制,
    // 使舱内水面片元被深度测试剔除
    this.mesh.renderOrder = 2;
  }

  // 时段/天气预设:同步太阳方向、日照颜色与雾(与 sceneSetup.applySkyPreset 一致)
  setSky(sunDir, preset) {
    this.uniforms.uSunDir.value.copy(sunDir);
    if (preset) {
      this.uniforms.uSunColor.value.set(preset.waterSun);
      this.uniforms.uFogColor.value.set(preset.fog);
      this.uniforms.uFogDensity.value = preset.fogD;
    }
  }

  // 画质设置：重建不同密度的径向网格（着色器不变，格距 uniform 跟着换）
  setDetail(level) {
    const key = WATER_GRID[level] ? level : 'high';
    if (key === this.detail) return;
    this.detail = key;
    const g = WATER_GRID[key];
    const geo = buildRadialGrid(g.rings, g.sectors);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.uniforms.uGridK.value = geo.userData.gridK;
  }

  // 每帧：跟随相机，同步波/风参数
  update(wind, centerX, centerZ) {
    // 径向网格随相机连续平移即可：近处环距只有几厘米，网格滑动看不出来；
    // 远处环距大但波幅已被可解析度衰减压掉，也不会抖。
    this.mesh.position.set(centerX, 0, centerZ);
    this.uniforms.uTime.value = this.waveField.time;
    this.waveField.packUniforms(this.wavePack);

    const psi = wind.currentFromPsi();
    const dx = Math.sin(psi), dz = -Math.cos(psi);
    this.uniforms.uGustDir.value.set(dx, dz);
    this.uniforms.uWindFlow.value.set(-dx, -dz); // 细波纹顺风漂
    this.uniforms.uDrift.value = wind.time * wind.baseSpeed * 0.62;
    this.uniforms.uGustScale.value = wind.gustScale;
    this.uniforms.uGustAmp.value = wind.gustiness;
    this.uniforms.uSeed.value = wind._seed;
    const kn = wind.baseSpeed / 0.514444;
    this.uniforms.uWhitecap.value = Math.min(1, Math.max(0, (kn - 8) / 14));
  }
}
