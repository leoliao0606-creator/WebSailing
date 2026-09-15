// 可重复平铺的灰度表面纹理。细节由材质法线/粗糙度表达，不增加几何面数。
import * as THREE from 'three';
import { fbm2 } from '../util/math.js';

const cache = new Map();
export function surfaceTexture(kind) {
  if (cache.has(kind)) return cache.get(kind);
  const size = 256;
  const bytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value;
      if (kind === 'sail') {
        const warp = Math.sin(x * Math.PI / 2), weft = Math.sin(y * Math.PI / 2);
        value = 0.55 + warp * 0.1 + weft * 0.1 + warp * weft * 0.05;
      } else if (kind === 'deck') {
        const dx = Math.abs((x % 16) - 8), dy = Math.abs((y % 16) - 8);
        value = 0.42 + 0.35 * Math.max(0, 1 - (dx + dy) / 7);
      } else {
        // 四角周期插值让噪声平铺边界连续。
        const u = x / size, v = y / size, scale = 0.085;
        const sample = (sx, sy) => fbm2(sx * scale, sy * scale, 4);
        value = (sample(x,y)*(1-u) + sample(x-size,y)*u)*(1-v)
          + (sample(x,y-size)*(1-u) + sample(x-size,y-size)*u)*v;
      }
      const i = (y * size + x) * 4;
      bytes[i] = bytes[i + 1] = bytes[i + 2] = Math.round(value * 255);
      bytes[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // 灰度高度属于数值数据，保持线性；不要设 SRGBColorSpace。
  texture.repeat.set(...(kind === 'sail' ? [3, 5] : kind === 'deck' ? [3, 8] : [1, 1]));
  texture.needsUpdate = true;
  cache.set(kind, texture);
  return texture;
}
