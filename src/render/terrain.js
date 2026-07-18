// 程序化岛屿：径向衰减 + 分形噪声高度场，顶点色 沙滩->草地->岩石。
// 返回岛屿碰撞列表供物理使用；附带灯塔与航标工厂。

import * as THREE from 'three';
import { fbm2, smoothstep, clamp01, lerp } from '../util/math.js';

const ISLANDS = [
  { x: -780, z: -520, r: 190, h: 34, seed: 3 },
  { x: 820, z: -280, r: 120, h: 18, seed: 11, lighthouse: true },
  { x: 260, z: 950, r: 230, h: 26, seed: 23 },
  { x: -420, z: 760, r: 90, h: 9, seed: 31 },
  { x: 1050, z: 620, r: 140, h: 22, seed: 47 },
];

function islandHeight(ix, iz, isl) {
  const dx = ix - isl.x, dz = iz - isl.z;
  const r = Math.hypot(dx, dz) / isl.r;
  if (r > 1.15) return -4;
  const falloff = Math.pow(Math.max(0, 1 - r * r), 1.5);
  const n = fbm2(dx * 0.013 + isl.seed * 7.1, dz * 0.013 - isl.seed * 3.3, 4);
  const ridge = fbm2(dx * 0.05 + isl.seed, dz * 0.05, 3);
  let h = isl.h * falloff * (0.55 + 0.75 * n) + ridge * 2.2 * falloff - 2.2;
  return h;
}

export function createTerrain(scene) {
  const group = new THREE.Group();
  const colSand = new THREE.Color(0xcfc09a);
  const colGrass = new THREE.Color(0x5e7a45);
  const colRock = new THREE.Color(0x7d7a72);
  const colDark = new THREE.Color(0x47523a);

  for (const isl of ISLANDS) {
    const seg = 72;
    const size = isl.r * 2.5;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + isl.x, wz = pos.getZ(i) + isl.z;
      const h = islandHeight(wx, wz, isl);
      pos.setY(i, h);
      const slope = fbm2(wx * 0.08, wz * 0.08, 2);
      if (h < 0.9) c.copy(colSand);
      else if (h < 2.2) c.copy(colSand).lerp(colGrass, smoothstep(0.9, 2.2, h));
      else {
        c.copy(colGrass).lerp(colDark, clamp01(slope * 0.9));
        if (h > isl.h * 0.45) c.lerp(colRock, smoothstep(isl.h * 0.45, isl.h * 0.8, h));
      }
      // 微噪声打破色带
      const v = 0.92 + fbm2(wx * 0.5, wz * 0.5, 2) * 0.16;
      colors[i * 3] = c.r * v; colors[i * 3 + 1] = c.g * v; colors[i * 3 + 2] = c.b * v;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(isl.x, 0, isl.z); // 顶点为局部网格，高度按世界坐标采样
    group.add(mesh);

    if (isl.lighthouse) group.add(createLighthouse(isl));
    scatterVegetation(group, isl);
  }

  scene.add(group);
  // 碰撞信息（水线半径近似）
  return ISLANDS.map((i) => ({ x: i.x, z: i.z, r: i.r * 0.82 }));
}

function createLighthouse(isl) {
  const g = new THREE.Group();
  // 找个偏高点放灯塔
  let best = { h: -1, x: isl.x, z: isl.z };
  for (let a = 0; a < 12; a++) {
    const x = isl.x + Math.cos(a) * isl.r * 0.25, z = isl.z + Math.sin(a) * isl.r * 0.25;
    const h = islandHeight(x, z, isl);
    if (h > best.h) best = { h, x, z };
  }
  const white = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 });
  const red = new THREE.MeshStandardMaterial({ color: 0xb33529, roughness: 0.5 });
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.4, 14, 14), white);
  tower.position.y = 7;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.25, 3.2, 14), red);
  band.position.y = 3.5;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(1.9, 2.4, 12), red);
  cap.position.y = 15.6;
  const lamp = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 1.6, 10),
    new THREE.MeshStandardMaterial({ color: 0xfff6c9, emissive: 0xffe9a0, emissiveIntensity: 0.7, roughness: 0.2 })
  );
  lamp.position.y = 14.2;
  g.add(tower, band, cap, lamp);
  g.position.set(best.x, Math.max(best.h, 1), best.z);
  return g;
}

function scatterVegetation(group, isl) {
  const green1 = new THREE.MeshStandardMaterial({ color: 0x4a6b38, roughness: 0.9 });
  const green2 = new THREE.MeshStandardMaterial({ color: 0x3c5d3f, roughness: 0.9 });
  const trunkM = new THREE.MeshStandardMaterial({ color: 0x6b5138, roughness: 0.9 });
  const n = Math.floor(isl.r / 9);
  for (let i = 0; i < n; i++) {
    const a = fbm2(i * 3.7 + isl.seed, isl.seed) * Math.PI * 4;
    const rr = (0.15 + 0.55 * fbm2(i * 1.9, isl.seed * 2.2)) * isl.r;
    const x = isl.x + Math.cos(a) * rr, z = isl.z + Math.sin(a) * rr;
    const h = islandHeight(x, z, isl);
    if (h < 1.6 || h > isl.h * 0.6) continue;
    const s = 2.2 + fbm2(x * 0.3, z * 0.3) * 2.6;
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * s, 0.2 * s, s * 0.8, 6), trunkM);
    trunk.position.y = s * 0.4;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(s * 0.55, s * 1.5, 7), i % 2 ? green1 : green2);
    crown.position.y = s * 1.4;
    tree.add(trunk, crown);
    tree.position.set(x, h - 0.15, z);
    tree.rotation.y = a;
    group.add(tree);
  }
}

// —— 航标工厂（比赛标记 / 装饰浮标共用）——
export function createBuoy(color = 0xe8642c, withFlag = false) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.5, 1.0, 12),
    new THREE.MeshStandardMaterial({ color, roughness: 0.4 })
  );
  body.position.y = 0.32;
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.14, 0.75, 8),
    new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 })
  );
  top.position.y = 1.15;
  g.add(body, top);
  if (withFlag) {
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.55, 0.38),
      new THREE.MeshStandardMaterial({ color: 0xe8642c, side: THREE.DoubleSide, roughness: 0.7 })
    );
    flag.position.set(0.28, 1.4, 0);
    g.add(flag);
    g.userData.flag = flag;
  }
  return g;
}

// 起点船（委员会船）：简化摩托艇
export function createCommitteeBoat() {
  const g = new THREE.Group();
  const hullM = new THREE.MeshStandardMaterial({ color: 0xf3f0e8, roughness: 0.35 });
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 4.6, 6, 10), hullM);
  hull.rotation.z = Math.PI / 2;
  hull.position.y = 0.42;
  hull.scale.set(1, 0.62, 1);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 1.1, 1.5),
    new THREE.MeshStandardMaterial({ color: 0xdad4c4, roughness: 0.5 })
  );
  cabin.position.set(-0.4, 1.25, 0);
  const mastM = new THREE.MeshStandardMaterial({ color: 0x555555 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 3.4, 6), mastM);
  mast.position.set(1.4, 2.2, 0);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.55),
    new THREE.MeshStandardMaterial({ color: 0xe8642c, side: THREE.DoubleSide })
  );
  flag.position.set(1.75, 3.5, 0);
  g.add(hull, cabin, mast, flag);
  g.userData.flag = flag;
  return g;
}
