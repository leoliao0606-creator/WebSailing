// 相机系统：追尾 / 舱内 / 高空三种模式，鼠标环绕 + 滚轮缩放。

import * as THREE from 'three';
import { DEG, clamp, damp, dampAngle, lerp, wrapPi } from '../util/math.js';

export const CAM_MODES = ['chase', 'onboard', 'drone'];

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.dist = 11.5;
    this.pitch = 13 * DEG;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.pos = new THREE.Vector3(-10, 4, 10);
    this.look = new THREE.Vector3();
    this.fov = 55;
    this._tmp = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  cycle() {
    const i = CAM_MODES.indexOf(this.mode);
    this.mode = CAM_MODES[(i + 1) % CAM_MODES.length];
  }

  update(input, boat, waveField, dt, lookBack = false) {
    const phys = boat.phys;
    // 鼠标环绕
    this.orbitYaw -= input.orbitDX * 0.005;
    this.orbitPitch = clamp(this.orbitPitch - input.orbitDY * 0.004, -0.5, 0.9);
    this.dist = clamp(this.dist * (1 + input.wheel * 0.0011), 4.5, 55);
    // 追尾模式：拖拽停止后自动回正
    const idle = performance.now() / 1000 - input.lastDragT;
    if (this.mode === 'chase' && idle > 1.8 && phys.speed > 1) {
      this.orbitYaw = dampAngle(this.orbitYaw, 0, 1.2, dt);
      this.orbitPitch = damp(this.orbitPitch, 0, 1.2, dt);
    }

    const psi = phys.psi;
    const backYaw = lookBack ? Math.PI : 0;

    if (this.mode === 'chase') {
      const a = psi + Math.PI + this.orbitYaw + backYaw;
      const pitch = clamp(this.pitch + this.orbitPitch, 0.03, 1.2);
      const d = this.dist;
      const px = phys.x + Math.sin(a) * d * Math.cos(pitch);
      const pz = phys.z - Math.cos(a) * d * Math.cos(pitch);
      let py = 0.9 + d * Math.sin(pitch);
      const wy = waveField.sample(px, pz).y;
      py = Math.max(py, wy + 0.9);
      const k = 4.2 + phys.speed * 0.25;
      this.pos.x = damp(this.pos.x, px, k, dt);
      this.pos.y = damp(this.pos.y, py, k * 0.8, dt);
      this.pos.z = damp(this.pos.z, pz, k, dt);
      this.look.set(
        phys.x + Math.sin(psi + backYaw) * 5,
        1.1,
        phys.z - Math.cos(psi + backYaw) * 5
      );
      this.camera.position.copy(this.pos);
      this._up.set(0, 1, 0);
      this.camera.up.copy(this._up);
      this.camera.lookAt(this.look);
      this.camera.rotateZ(phys.phi * 0.1);
      const fovT = 55 + phys.out.planing * 7 + clamp(phys.speed - 3, 0, 5) * 0.8;
      this.fov = damp(this.fov, fovT, 2, dt);
    } else if (this.mode === 'onboard') {
      // 舵手视角：完全感受横倾（隐藏船员避免遮挡）
      if (boat.visual.crew) boat.visual.crew.visible = false;
      const g = boat.visual.group;
      this._tmp.set(phys.crewY * 0.72, 1.5, 0.5);
      g.localToWorld(this._tmp);
      this.pos.copy(this._tmp);
      this.camera.position.copy(this.pos);
      const lookA = psi + this.orbitYaw + backYaw;
      const upBoat = new THREE.Vector3(0, 1, 0).applyQuaternion(g.quaternion);
      this.camera.up.copy(upBoat.lerp(this._up.set(0, 1, 0), 0.35).normalize());
      this.look.set(
        this.pos.x + Math.sin(lookA) * 10,
        this.pos.y - 0.5 + this.orbitPitch * -8,
        this.pos.z - Math.cos(lookA) * 10
      );
      this.camera.lookAt(this.look);
      this.fov = damp(this.fov, 68, 3, dt);
    } else {
      // 高空跟随
      const a = psi + Math.PI + this.orbitYaw;
      const px = phys.x + Math.sin(a) * 34;
      const pz = phys.z - Math.cos(a) * 34;
      const py = 26 + this.orbitPitch * 22;
      this.pos.x = damp(this.pos.x, px, 1.6, dt);
      this.pos.y = damp(this.pos.y, py, 1.6, dt);
      this.pos.z = damp(this.pos.z, pz, 1.6, dt);
      this.camera.position.copy(this.pos);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(phys.x, 0, phys.z);
      this.fov = damp(this.fov, 50, 2, dt);
    }

    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
