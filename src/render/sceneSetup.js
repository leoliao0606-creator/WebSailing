// 渲染基础：渲染器、大气散射天空、太阳光照、环境反射贴图、雾。
// 时段/天气预设(applySkyPreset)统一改天空、日照、雾、曝光并重烘环境贴图。

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { createClouds } from './clouds.js';

export const FOG_COLOR = new THREE.Color(0xaccbdc);

// 时段/天气预设。数值取好看的斜逆光,非严格天文。
export const SKY_PRESETS = {
  golden: { // 现状默认:斜逆光暖调
    elev: 33, azim: 205, turbidity: 1.8, rayleigh: 1.15, mie: 0.0015, mieG: 0.8,
    sunColor: 0xffefda, sunInt: 3.1, hemiSky: 0x9bcaf2, hemiGround: 0x24404a, hemiInt: 0.65,
    exposure: 0.92, fog: 0xaccbdc, fogD: 0.00032, envInt: 0.7, waterSun: 0xffe5bd,
    skyGain: 0.1, zenith: 0x2878bd, horizon: 0xaccbdc, deep: 0x073e50, scatter: 0x168b87,
    cloudCover: 0.42, cloudLight: 0xfff5e5, cloudShade: 0x7793b0, cloudInt: 2.2, sunGlint: 1,
  },
  noon: { // 正午:高日照、清透
    elev: 64, azim: 175, turbidity: 1.5, rayleigh: 1.4, mie: 0.001, mieG: 0.8,
    sunColor: 0xfff8ef, sunInt: 3.4, hemiSky: 0x9dcefa, hemiGround: 0x24425a, hemiInt: 0.7,
    exposure: 0.9, fog: 0xa5cde5, fogD: 0.00026, envInt: 0.75, waterSun: 0xfff3df,
    skyGain: 0.085, zenith: 0x207bc5, horizon: 0xa5cde5, deep: 0x054457, scatter: 0x159e98,
    cloudCover: 0.42, cloudLight: 0xfafcff, cloudShade: 0x7899b8, cloudInt: 2.4, sunGlint: 1,
  },
  dusk: { // 黄昏:低日、橙红、雾浓
    elev: 7, azim: 250, turbidity: 6, rayleigh: 2.6, mie: 0.005, mieG: 0.86,
    sunColor: 0xffb46a, sunInt: 2.6, hemiSky: 0x8f7fa8, hemiGround: 0x241f2e, hemiInt: 0.5,
    exposure: 0.95, fog: 0xbd928b, fogD: 0.00055, envInt: 0.65, waterSun: 0xffb072,
    skyGain: 0.28, zenith: 0x505482, horizon: 0xbd928b, deep: 0x152f42, scatter: 0x497a82,
    cloudCover: 0.52, cloudLight: 0xffb781, cloudShade: 0x555572, cloudInt: 1.8, sunGlint: 0.75,
  },
  overcast: { // 阴天:高浊度、弱直射、灰蓝、强环境光
    elev: 42, azim: 200, turbidity: 9, rayleigh: 3.2, mie: 0.008, mieG: 0.7,
    sunColor: 0xd7dde2, sunInt: 1.5, hemiSky: 0xb7c4cd, hemiGround: 0x3a444c, hemiInt: 0.95,
    exposure: 0.9, fog: 0xa6bac6, fogD: 0.00085, envInt: 0.75, waterSun: 0xd2dae0,
    skyGain: 0.1, zenith: 0x8095ac, horizon: 0xa6bac6, deep: 0x193e4b, scatter: 0x44797d,
    cloudCover: 0.95, cloudLight: 0xc9d5df, cloudShade: 0x667788, cloudInt: 1.2, sunGlint: 0.08,
  },
};

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.88;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOG_COLOR.clone(), SKY_PRESETS.golden.fogD);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 30000);
  camera.position.set(-14, 5.5, 12);

  // —— 天空 ——
  const sky = new Sky();
  const clouds = createClouds();
  clouds.decorateSky(sky);
  sky.scale.setScalar(25000);
  scene.add(sky);
  const su = sky.material.uniforms;

  const sunDir = new THREE.Vector3();

  // —— 光照 ——
  const sunLight = new THREE.DirectionalLight(0xfff2e0, 3.4);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 30;
  sunLight.shadow.camera.far = 300;
  const sc = 24;
  sunLight.shadow.camera.left = -sc;
  sunLight.shadow.camera.right = sc;
  sunLight.shadow.camera.top = sc;
  sunLight.shadow.camera.bottom = -sc;
  sunLight.shadow.bias = -0.00015;
  sunLight.shadow.normalBias = 0.025;
  scene.add(sunLight);
  scene.add(sunLight.target);

  const hemi = new THREE.HemisphereLight(0x9fc3e0, 0x1c3345, 0.55);
  scene.add(hemi);

  // —— 环境反射（由天空烘焙,可重烘）——
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  clouds.decorateSky(envSky);
  // 直射日光由 DirectionalLight 和水面太阳高光负责，环境图不重复计入太阳圆盘。
  envSky.material.fragmentShader = envSky.material.fragmentShader.replace(
    'L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', 'L0 += vec3(0.0);');
  envSky.scale.setScalar(25000);
  envScene.add(envSky);
  let envRT = null;

  function bakeEnvironment() {
    const eu = envSky.material.uniforms;
    eu.turbidity.value = su.turbidity.value;
    eu.rayleigh.value = su.rayleigh.value;
    eu.mieCoefficient.value = su.mieCoefficient.value;
    eu.mieDirectionalG.value = su.mieDirectionalG.value;
    eu.uSkyGain.value = su.uSkyGain.value;
    eu.sunPosition.value.copy(sunDir);
    envRT?.dispose();
    envRT = pmrem.fromScene(envScene, 0.02);
    scene.environment = envRT.texture;
  }

  // 应用时段/天气预设:更新天空/日照/雾/曝光/环境反射(毫秒级,仅设置变更时调用)
  function applySkyPreset(name) {
    const p = SKY_PRESETS[name] ?? SKY_PRESETS.golden;
    su.turbidity.value = p.turbidity;
    su.rayleigh.value = p.rayleigh;
    su.mieCoefficient.value = p.mie;
    su.mieDirectionalG.value = p.mieG;
    su.uSkyGain.value = p.skyGain;
    const elev = p.elev * Math.PI / 180, azim = p.azim * Math.PI / 180;
    sunDir.setFromSphericalCoords(1, Math.PI / 2 - elev, azim);
    su.sunPosition.value.copy(sunDir);
    clouds.setWeather(p, sunDir);
    sunLight.color.set(p.sunColor);
    sunLight.intensity = p.sunInt;
    sunLight.position.copy(sunDir).multiplyScalar(120);
    hemi.color.set(p.hemiSky);
    hemi.groundColor.set(p.hemiGround);
    hemi.intensity = p.hemiInt;
    renderer.toneMappingExposure = p.exposure;
    scene.fog.color.set(p.fog);
    scene.fog.density = p.fogD;
    scene.environmentIntensity = p.envInt;
    bakeEnvironment();
    return p; // 供调用方同步水面(uSunDir/uSunColor/雾)
  }

  applySkyPreset('golden');

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // 太阳阴影跟随目标（玩家船）
  function followShadow(x, z) {
    sunLight.position.set(x + sunDir.x * 120, sunDir.y * 120, z + sunDir.z * 120);
    sunLight.target.position.set(x, 0, z);
  }

  return { renderer, scene, camera, sunDir, sunLight, followShadow, applySkyPreset, clouds };
}
