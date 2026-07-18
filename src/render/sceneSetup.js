// 渲染基础：渲染器、大气散射天空、太阳光照、环境反射贴图、雾。

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

export const FOG_COLOR = new THREE.Color(0xbfd4e2);

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.88;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00095);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 30000);
  camera.position.set(-14, 5.5, 12);

  // —— 天空 ——
  const sky = new Sky();
  sky.scale.setScalar(25000);
  scene.add(sky);
  const su = sky.material.uniforms;
  su.turbidity.value = 3.6;
  su.rayleigh.value = 1.15;
  su.mieCoefficient.value = 0.0028;
  su.mieDirectionalG.value = 0.8;

  // 太阳方位：仰角 33°，方位偏西南（数值上取好看的斜逆光）
  const sunDir = new THREE.Vector3();
  const elev = 33 * Math.PI / 180, azim = 205 * Math.PI / 180;
  sunDir.setFromSphericalCoords(1, Math.PI / 2 - elev, azim);
  su.sunPosition.value.copy(sunDir);

  // —— 光照 ——
  const sunLight = new THREE.DirectionalLight(0xfff2e0, 3.4);
  sunLight.position.copy(sunDir).multiplyScalar(120);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 30;
  sunLight.shadow.camera.far = 300;
  const sc = 16;
  sunLight.shadow.camera.left = -sc;
  sunLight.shadow.camera.right = sc;
  sunLight.shadow.camera.top = sc;
  sunLight.shadow.camera.bottom = -sc;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.02;
  scene.add(sunLight);
  scene.add(sunLight.target);

  const hemi = new THREE.HemisphereLight(0x9fc3e0, 0x1c3345, 0.55);
  scene.add(hemi);

  // —— 环境反射（由天空烘焙）——
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(25000);
  envSky.material.uniforms.turbidity.value = su.turbidity.value;
  envSky.material.uniforms.rayleigh.value = su.rayleigh.value;
  envSky.material.uniforms.mieCoefficient.value = su.mieCoefficient.value;
  envSky.material.uniforms.mieDirectionalG.value = su.mieDirectionalG.value;
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  envScene.add(envSky);
  const envRT = pmrem.fromScene(envScene, 0.02);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();

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

  return { renderer, scene, camera, sunDir, sunLight, followShadow };
}
