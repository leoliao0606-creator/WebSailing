// 写实水面：Gerstner 顶点位移（与 CPU 物理同参数同相位）+ 菲涅尔天空反射
// + 太阳高光/闪烁 + 浪尖白沫 + 阵风暗斑（与 JS 风场噪声逐位一致，可"读风"）。

import * as THREE from 'three';
import { WAVE_COUNT } from '../sim/waves.js';
import { FOG_COLOR } from './sceneSetup.js';

const VERT = /* glsl */ `
uniform float uTime;
uniform float uWaves[${WAVE_COUNT * 6}]; // dx,dz,k,w,amp,q
varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
varying float vDist;

void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  float distCam = distance(wp, cameraPosition);
  float fade = 1.0 - smoothstep(260.0, 900.0, distCam);

  vec3 p = wp;
  vec3 tx = vec3(1.0, 0.0, 0.0);
  vec3 tz = vec3(0.0, 0.0, 1.0);
  float crest = 0.0;
  float crestNorm = 0.0001;

  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    float dx = uWaves[i*6+0], dz = uWaves[i*6+1];
    float k  = uWaves[i*6+2], w  = uWaves[i*6+3];
    float A  = uWaves[i*6+4] * fade, Q = uWaves[i*6+5];
    float ph = k * (dx * wp.x + dz * wp.z) - w * uTime;
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

  // 表面细波纹扰动法线（近处强，阵风区更碎）
  vec3 N = normalize(vNormal);
  {
    float s1 = vnoise(vWorld.xz * 0.55 - uWindFlow * uTime * 0.55);
    float s2 = vnoise(vWorld.xz * 2.3 - uWindFlow * uTime * 1.4 + 13.7);
    float s3 = vnoise(vWorld.xz * 7.1 + vec2(uTime * 0.4, -uTime * 0.33));
    float str = (0.16 + 0.1 * max(gust, 0.0) * uGustAmp * 3.0) * (0.25 + 0.75 * detailFade);
    N = normalize(N + vec3(s1 - 0.5, 0.0, s2 - 0.5) * str + vec3(s3 - 0.5, 0.0, 0.5 - s3) * str * 0.5);
  }

  float NdV = max(dot(N, V), 0.0);
  float fresnel = 0.022 + 0.978 * pow(1.0 - NdV, 5.0);

  // 天空反射（解析）
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 skyCol = mix(uHorizon, uZenith, pow(max(R.y, 0.0), 0.6));
  // 阵风区更"毛糙" -> 反射变暗变灰
  skyCol *= 1.0 - 0.16 * smoothstep(0.05, 0.5, gust) * uGustAmp * 2.5;
  // 太阳眩光路径
  float sunR = max(dot(R, uSunDir), 0.0);
  vec3 sunGlint = uSunColor * (pow(sunR, 1100.0) * 90.0 + pow(sunR, 90.0) * 0.9);

  // 水体色：深水 + 浪尖次表面散射
  float sunN = max(dot(N, normalize(uSunDir + vec3(0.0, 0.35, 0.0))), 0.0);
  float sss = vCrest * (0.35 + 0.65 * sunN);
  vec3 bodyCol = mix(uDeep, uScatter, clamp(sss, 0.0, 1.0));

  vec3 col = mix(bodyCol, skyCol, fresnel) + sunGlint * (0.35 + 0.65 * fresnel);

  // 浪尖白沫（风大才出现），叠噪声破碎感
  float foamN = vnoise(vWorld.xz * 0.9 + uWindFlow * uTime * 0.25) * 0.6 +
                vnoise(vWorld.xz * 3.1 - uWindFlow * uTime * 0.5) * 0.4;
  float cap = smoothstep(1.18 - uWhitecap * 0.55, 1.38 - uWhitecap * 0.5, vCrest + foamN * 0.62);
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

// 水面细节档位 -> 网格分段数（顶点位移的采样密度）
const WATER_SEGMENTS = { low: 96, medium: 160, high: 256 };

export class Water {
  constructor(waveField, sunDir) {
    this.waveField = waveField;
    this.size = 1700;
    this.segments = 256;
    const geo = new THREE.PlaneGeometry(this.size, this.size, this.segments, this.segments);
    geo.rotateX(-Math.PI / 2);

    this.wavePack = new Float32Array(WAVE_COUNT * 6);
    waveField.packUniforms(this.wavePack);

    this.uniforms = {
      uTime: { value: 0 },
      uWaves: { value: this.wavePack },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.92, 0.78) },
      uZenith: { value: new THREE.Color(0.11, 0.29, 0.5) },
      uHorizon: { value: new THREE.Color(0.68, 0.79, 0.86) },
      uDeep: { value: new THREE.Color(0.012, 0.052, 0.085) },
      uScatter: { value: new THREE.Color(0.05, 0.2, 0.21) },
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
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.snap = this.size / this.segments;
  }

  // 画质设置：重建不同分段数的网格（着色器/uniform 不变）
  setDetail(level) {
    const seg = WATER_SEGMENTS[level] ?? WATER_SEGMENTS.high;
    if (seg === this.segments) return;
    this.segments = seg;
    const geo = new THREE.PlaneGeometry(this.size, this.size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.snap = this.size / seg;
  }

  // 每帧：跟随相机（网格对齐防抖动），同步波/风参数
  update(wind, centerX, centerZ) {
    const s = this.snap;
    this.mesh.position.set(Math.round(centerX / s) * s, 0, Math.round(centerZ / s) * s);
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
