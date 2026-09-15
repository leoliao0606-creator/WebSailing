// 天空与环境反射共用的世界坐标云层：程序化云、迎光边缘、底部自遮蔽。
// 不再用面对相机的半透明白色 Sprite；减少透明叠加，也避免转动镜头时云形改变。
import * as THREE from 'three';
import { CLOUD_BUDGETS } from './quality.js';

export const CLOUD_GLSL = /* glsl */ `
uniform vec2 uCloudOffset;
uniform float uCloudCoverage;
uniform float uCloudEnabled;
uniform int uCloudOctaves;
uniform vec3 uCloudLight;
uniform vec3 uCloudShade;
uniform vec3 uCloudSun;

float cloudNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec4 h = vec4(dot(i, vec2(127.1,311.7)), dot(i+vec2(1,0), vec2(127.1,311.7)),
                dot(i+vec2(0,1), vec2(127.1,311.7)), dot(i+vec2(1,1), vec2(127.1,311.7)));
  h = fract(sin(h) * 43758.5453);
  return mix(mix(h.x,h.y,f.x), mix(h.z,h.w,f.x), f.y);
}
float cloudFbm(vec2 p, int octaves) {
  float n = 0.0, a = 0.54, total = 0.0;
  for (int i=0; i<6; i++) {
    if (i >= octaves) break;
    n += cloudNoise(p) * a;
    total += a;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3;
    a *= 0.48;
  }
  return n / total;
}
vec3 cloudRadiance(vec3 sky, vec3 ray, vec2 origin, int octaves) {
  if (uCloudEnabled < 0.5 || ray.y < 0.015) return sky;
  // 900 m 高云底，坐标为世界空间；倒影与天空采样同一层随风移动的云。
  vec2 p = (origin + ray.xz * (900.0 / max(ray.y, 0.015))) * 0.0011 + uCloudOffset;
  float n = cloudFbm(p, octaves);
  float threshold = 0.72 - uCloudCoverage * 0.34;
  float aa = min(0.16, fwidth(n));
  float density = smoothstep(threshold - aa, threshold + 0.20 + aa, n);
  float upSun = cloudFbm(p + uCloudSun.xz * 0.24, max(2, octaves - 1));
  float edgeLight = clamp((n - upSun) * 5.0 + 0.48, 0.0, 1.0);
  float thickness = smoothstep(0.05, 0.9, density);
  vec3 cloud = mix(uCloudLight, uCloudShade, thickness * (0.78 - 0.44 * edgeLight));
  float silver = pow(max(dot(ray, uCloudSun), 0.0), 12.0);
  cloud += uCloudLight * silver * (1.0 - thickness) * 0.5;
  float alpha = density * smoothstep(0.015, 0.12, ray.y);
  return mix(sky, cloud, alpha);
}
`;

export function createClouds() {
  const uniforms = {
    uCloudOffset: { value: new THREE.Vector2(0.3, 1.7) },
    uCloudCoverage: { value: 0.48 },
    uCloudEnabled: { value: 1 },
    uCloudOctaves: { value: 5 },
    uCloudLight: { value: new THREE.Color(1.9, 1.85, 1.75) },
    uCloudShade: { value: new THREE.Color(0.32, 0.44, 0.62) },
    uCloudSun: { value: new THREE.Vector3() },
  };
  return {
    uniforms,
    decorateSky(sky) {
      Object.assign(sky.material.uniforms, uniforms, { uSkyGain: { value: 0.14 } });
      sky.material.fragmentShader = `uniform float uSkyGain;\n${CLOUD_GLSL}\n${sky.material.fragmentShader}`
        // Sky 原始 retColor 已做一次 gamma 提亮，再做色调映射会令晴空发白。
        // 保持线性辐亮度，统一交给 renderer 做一次色调映射和输出色彩转换。
        .replace('vec4( retColor, 1.0 )', 'vec4( cloudRadiance(texColor * uSkyGain, direction, cameraPosition.xz, uCloudOctaves), 1.0 )');
    },
    setEnabled(enabled) { uniforms.uCloudEnabled.value = enabled ? 1 : 0; },
    setDetail(level) { uniforms.uCloudOctaves.value = CLOUD_BUDGETS[level] ?? 5; },
    setWeather(preset, sunDir) {
      uniforms.uCloudCoverage.value = preset.cloudCover;
      uniforms.uCloudLight.value.set(preset.cloudLight).multiplyScalar(preset.cloudInt);
      uniforms.uCloudShade.value.set(preset.cloudShade);
      uniforms.uCloudSun.value.copy(sunDir);
    },
    update(dt, wind) {
      const from = wind?.baseFromPsi ?? 0;
      uniforms.uCloudOffset.value.x -= Math.sin(from) * dt * 0.0035;
      uniforms.uCloudOffset.value.y += Math.cos(from) * dt * 0.0035;
    },
  };
}
