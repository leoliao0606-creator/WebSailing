import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { BoatEffects } from '../src/render/effects.js';

// 无渲染桩：发射、寿命、位置和网格均运行真实实现。
function fixture() {
  const fx = new BoatEffects(new THREE.Scene(), { peakAmp: 0.12, time: 0, sample: () => ({ y: 0 }), packUniforms: a => a.fill(0) });
  const phys = { x: 0, z: 0, psi: 0, speed: 1.5, u: 1.5, v: 0, out: { planing: 0 }, wave: { slamSpeed: 0 } };
  const advance = (frames = 120) => {
    for (let i = 0; i < frames; i++) {
      phys.z -= phys.speed / 60;
      fx.waveField.time += 1 / 60;
      fx.update(phys, 1 / 60);
    }
  };
  return { fx, phys, advance };
}

test('普通航速无需滑行或砸水也持续产生船艏浪花', () => {
  const { fx, advance } = fixture();
  advance();
  assert.ok(fx.parts.filter(p => p.life > 0).length >= 8);
  assert.ok(fx.samples.length >= 2);
  fx.dispose();
});

test('停船不凭空喷浪，暂停不推进粒子寿命', () => {
  const { fx, phys, advance } = fixture();
  phys.speed = phys.u = 0;
  advance();
  assert.equal(fx.parts.filter(p => p.life > 0).length, 0);
  phys.speed = phys.u = 3;
  advance();
  const life = fx.parts.map(p => p.life);
  fx.update(phys, 0);
  assert.deepEqual(fx.parts.map(p => p.life), life);
  fx.dispose();
});

test('船只传送后清除旧轨迹，不画跨越地图的泡沫带', () => {
  const { fx, phys, advance } = fixture();
  advance();
  phys.x = 500;
  fx.update(phys, 1 / 60);
  assert.ok(fx.samples.every(s => Math.abs(s.x - phys.x) < 5));
  fx.dispose();
});

test('特效关闭后重新开启不复活旧粒子', () => {
  const { fx, phys, advance } = fixture();
  advance();
  fx.setEnabled(false);
  advance();
  fx.setEnabled(true);
  phys.speed = phys.u = 0;
  fx.update(phys, 1 / 60);
  assert.equal(fx.samples.length, 0);
  assert.equal(fx.parts.filter(p => p.life > 0).length, 0);
  fx.dispose();
});
