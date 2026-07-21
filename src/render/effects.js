// 船只水面效果：艉流泡沫带（ribbon）+ 艏浪花粒子。每条船一个实例。

import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../util/math.js';

function makeFoamTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  for (let i = 0; i < 1300; i++) {
    const r = 2 + Math.random() * 8;
    const x = Math.random() * 256, y = Math.random() * 256;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.1 + Math.random() * 0.24;
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeSprayTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(240,248,252,0.45)');
  grad.addColorStop(1, 'rgba(240,248,252,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

let foamTex = null, sprayTex = null;

const WAKE_N = 72;

export class BoatEffects {
  constructor(scene, waveField) {
    this.waveField = waveField;
    foamTex ??= makeFoamTexture();
    sprayTex ??= makeSprayTexture();

    // —— 艉流带 ——
    this.samples = []; // {x,z,rx,rz,age,str}
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WAKE_N * 2 * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(WAKE_N * 2 * 2), 2));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(WAKE_N * 2), 1));
    const idx = [];
    for (let i = 0; i < WAKE_N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.wakeGeo = geo;
    this.wakeMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: foamTex } },
      vertexShader: `
        attribute float aAlpha;
        varying vec2 vUv; varying float vA;
        void main(){ vUv = uv; vA = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec2 vUv; varying float vA;
        void main(){
          float t = texture2D(uMap, vUv).a;
          float edge = smoothstep(0.0,0.22,vUv.x)*smoothstep(1.0,0.78,vUv.x);
          gl_FragColor = vec4(vec3(0.93,0.96,0.97), (t*2.1+0.22) * vA * edge);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.wakeMesh = new THREE.Mesh(geo, this.wakeMat);
    this.wakeMesh.frustumCulled = false;
    this.wakeMesh.renderOrder = 2;
    scene.add(this.wakeMesh);

    // —— 艏浪花粒子 ——
    this.PN = 200;
    this.parts = [];
    for (let i = 0; i < this.PN; i++) this.parts.push({ x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1 });
    // 空闲粒子索引栈:粒子死亡时压栈,spawn 时弹栈,避免每次线性扫描
    this._freeParts = this.parts.map((_, i) => i);
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.PN * 3), 3));
    pgeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(this.PN), 1));
    this.sprayGeo = pgeo;
    this.sprayMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: sprayTex } },
      vertexShader: `
        attribute float aAlpha; varying float vA;
        void main(){ vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = 34.0 / -mv.z * 14.0;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform sampler2D uMap; varying float vA;
        void main(){
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(t.rgb, t.a * vA);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(pgeo, this.sprayMat);
    points.frustumCulled = false;
    points.renderOrder = 3;
    scene.add(points);
    this.sprayPoints = points;
    this.scene = scene;
    this.enabled = true;
    this.spawnAcc = 0;
    this.lastX = 0; this.lastZ = 0;
  }

  // 画质设置：关闭时隐藏并跳过全部粒子/网格计算
  setEnabled(on) {
    if (this.enabled === on) return;
    this.enabled = on;
    this.wakeMesh.visible = on;
    this.sprayPoints.visible = on;
    if (!on) {
      this.samples.length = 0;
      for (const p of this.parts) p.life = 0;
      // 全部清死,重建空闲栈(否则被禁用后再启用会缺失可用粒子)
      this._freeParts = this.parts.map((_, i) => i);
    }
  }

  update(phys, dt) {
    if (!this.enabled) return;
    const spd = phys.speed;
    // —— 艉流采样 ——
    const moved = Math.hypot(phys.x - this.lastX, phys.z - this.lastZ);
    if (moved > 0.7 && spd > 0.6) {
      this.lastX = phys.x; this.lastZ = phys.z;
      const rx = Math.cos(phys.psi), rz = Math.sin(phys.psi);
      // 艉部位置（船尾后 1.9m）
      const sx = phys.x - Math.sin(phys.psi) * 1.9;
      const sz = phys.z + Math.cos(phys.psi) * 1.9;
      this.samples.unshift({ x: sx, z: sz, rx, rz, age: 0, str: clamp01(spd / 3) * (0.6 + phys.out.planing * 0.4) });
      if (this.samples.length > WAKE_N) this.samples.pop();
    }
    const yLift = 0.05 + this.waveField.waves[0].amp * 0.18;
    const pos = this.wakeGeo.attributes.position;
    const uv = this.wakeGeo.attributes.uv;
    const al = this.wakeGeo.attributes.aAlpha;
    const n = this.samples.length;
    for (let i = 0; i < WAKE_N; i++) {
      const s = this.samples[i];
      if (!s || n < 2) {
        pos.setXYZ(i * 2, 0, -10, 0); pos.setXYZ(i * 2 + 1, 0, -10, 0);
        al.setX(i * 2, 0); al.setX(i * 2 + 1, 0);
        continue;
      }
      const w = 0.5 + s.age * 0.62;
      const fade = Math.max(0, 1 - s.age / 9) * s.str * 1.5;
      const y = this.waveField.sample(s.x, s.z).y + yLift;
      pos.setXYZ(i * 2, s.x - s.rx * w, y, s.z - s.rz * w);
      pos.setXYZ(i * 2 + 1, s.x + s.rx * w, y, s.z + s.rz * w);
      uv.setXY(i * 2, 0, i * 0.25);
      uv.setXY(i * 2 + 1, 1, i * 0.25);
      al.setX(i * 2, fade);
      al.setX(i * 2 + 1, fade);
    }
    for (const s of this.samples) s.age += dt;
    pos.needsUpdate = true; uv.needsUpdate = true; al.needsUpdate = true;

    // —— 艏浪花 ——
    const sprayRate = spd > 2.6 ? (spd - 2.4) * (3 + phys.out.planing * 26) : 0;
    this.spawnAcc += sprayRate * dt;
    const fwdX = Math.sin(phys.psi), fwdZ = -Math.cos(phys.psi);
    const rgtX = Math.cos(phys.psi), rgtZ = Math.sin(phys.psi);
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      const idx = this._freeParts.pop();
      if (idx === undefined) break;
      const p = this.parts[idx];
      const side = Math.random() > 0.5 ? 1 : -1;
      const bowX = phys.x + fwdX * 1.7, bowZ = phys.z + fwdZ * 1.7;
      p.x = bowX + rgtX * side * 0.35;
      p.z = bowZ + rgtZ * side * 0.35;
      p.y = this.waveField.sample(p.x, p.z).y + 0.15;
      const kick = 0.5 + Math.random() * 1.3;
      p.vx = fwdX * spd * 0.45 + rgtX * side * kick;
      p.vz = fwdZ * spd * 0.45 + rgtZ * side * kick;
      p.vy = 0.8 + Math.random() * 1.6 + phys.out.planing * 1.2;
      p.max = p.life = 0.5 + Math.random() * 0.45;
    }
    const ppos = this.sprayGeo.attributes.position;
    const pal = this.sprayGeo.attributes.aAlpha;
    for (let i = 0; i < this.PN; i++) {
      const p = this.parts[i];
      if (p.life > 0) {
        p.life -= dt;
        p.vy -= 7.5 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        ppos.setXYZ(i, p.x, p.y, p.z);
        pal.setX(i, clamp(p.life / p.max, 0, 1) * 0.85);
        if (p.life <= 0) this._freeParts.push(i); // 本帧刚死亡,归还空闲栈
      } else {
        ppos.setXYZ(i, 0, -99, 0);
        pal.setX(i, 0);
      }
    }
    ppos.needsUpdate = true; pal.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.wakeMesh);
    this.scene.remove(this.sprayPoints);
    this.wakeGeo.dispose();
    this.sprayGeo.dispose();
    this.wakeMat.dispose();
    this.sprayMat.dispose();
  }
}
