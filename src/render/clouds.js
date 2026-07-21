// 程序化云层:一张 fbm 软噪声贴图铺到若干公告板(Sprite),
// 以相机为中心的移动云穹(始终环绕视野),随风缓慢平移并出界回绕。
// 纯装饰,不参与光照/阴影。

import * as THREE from 'three';
import { fbm2, headingToDir } from '../util/math.js';

const SPAN = 2200;   // 云穹半跨度 m(相对相机的方形范围)
const Y_MIN = 240, Y_MAX = 520;

function makeCloudTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const img = g.createImageData(128, 128);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      // 中心浓、边缘淡的软团 × fbm 噪声,得到蓬松边界
      const dx = (x - 64) / 64, dy = (y - 64) / 64;
      const disc = Math.max(0, 1 - Math.hypot(dx, dy));
      const n = fbm2(x * 0.06, y * 0.06, 4);
      const a = Math.pow(disc, 1.3) * (0.35 + 0.65 * n);
      const i = (y * 128 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.min(255, (a - 0.1) * 340)) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createClouds(scene, count = 44) {
  const tex = makeCloudTexture();
  const group = new THREE.Group();
  const sprites = [];
  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0.6 + Math.random() * 0.35,
      depthWrite: false, // 半透明:不写深度;保留深度测试使其正确处于天空之前、被地形遮挡
      fog: false,
    });
    const s = new THREE.Sprite(mat);
    // 相对相机的偏移(每帧加到相机位置)
    s.userData.ox = (Math.random() * 2 - 1) * SPAN;
    s.userData.oz = (Math.random() * 2 - 1) * SPAN;
    s.position.y = Y_MIN + Math.random() * (Y_MAX - Y_MIN);
    const scale = 300 + Math.random() * 460;
    s.scale.set(scale, scale * (0.5 + Math.random() * 0.2), 1);
    group.add(s);
    sprites.push(s);
  }
  scene.add(group);

  return {
    group,
    setDensity(n) {
      for (let i = 0; i < sprites.length; i++) sprites[i].visible = i < n;
    },
    // dt 秒,wind 提供 baseFromPsi,camera 提供中心;云随风平移并在相机四周方形回绕
    update(dt, wind, camera) {
      const from = wind?.baseFromPsi ?? 0;
      const d = headingToDir(from);      // 指向上风;气流朝反方向流动
      const vx = -d.x * 5, vz = -d.z * 5; // 高空云漂速 m/s
      const cx = camera?.position.x ?? 0;
      const cz = camera?.position.z ?? 0;
      for (const s of sprites) {
        let ox = s.userData.ox + vx * dt;
        let oz = s.userData.oz + vz * dt;
        if (ox > SPAN) ox -= SPAN * 2; else if (ox < -SPAN) ox += SPAN * 2;
        if (oz > SPAN) oz -= SPAN * 2; else if (oz < -SPAN) oz += SPAN * 2;
        s.userData.ox = ox;
        s.userData.oz = oz;
        s.position.x = cx + ox;
        s.position.z = cz + oz;
      }
    },
    dispose() {
      scene.remove(group);
      for (const s of sprites) s.material.dispose();
      tex.dispose();
    },
  };
}
