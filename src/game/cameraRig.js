// 相机系统：追尾 / 舱内 / 高空三种模式，鼠标环绕 + 滚轮缩放。

import * as THREE from 'three';
import { DEG, clamp, damp, dampAngle, lerp, wrapPi } from '../util/math.js';

export const CAM_MODES = ['chase', 'onboard', 'drone'];

// 鼠标灵敏度，弧度/像素。0.0025 ≈ 0.14°/像素：800 DPI 的鼠标横move 约 9 cm 转一圈，
// 落在常见 FPS 的区间里。旧值 0.005 是按「按住才转」调的，改成常驻捕捉后太跳。
// 嫌快/嫌慢改这两个数就行。
const MOUSE_SENS_X = 0.0025;
const MOUSE_SENS_Y = 0.002;

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
    this._upBoat = new THREE.Vector3();
    this.lookY = 1.1; // 追尾视角注视点高度：阻尼跟随船的升沉
  }

  cycle() {
    const i = CAM_MODES.indexOf(this.mode);
    this.mode = CAM_MODES[(i + 1) % CAM_MODES.length];
  }

  update(input, boat, waveField, dt, lookBack = false) {
    const phys = boat.phys;
    // 鼠标环绕。水平取正号：视角方位角 = 船艏向 + orbitYaw，而船艏向增大就是向右
    // 转，所以鼠标右移让 orbitYaw 增大，画面就跟着向右扫 —— 和 FPS 一致。
    // 旧代码是减号，右移反而向左看。
    this.orbitYaw += input.orbitDX * MOUSE_SENS_X;
    this.orbitPitch = clamp(this.orbitPitch - input.orbitDY * MOUSE_SENS_Y, -0.5, 0.9);
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
      // 注视点跟一部分船的升沉：跟满了画面会随船一起抖，完全不跟则船在浪里
      // 上下时画面纹丝不动，起伏感全被抵消掉。像跟拍艇那样阻尼跟随。
      const boatY = phys.wave?.active ? phys.wave.heaveY : 0;
      this.lookY = damp(this.lookY, 1.1 + boatY * 0.65, 3.5, dt);
      this.look.set(
        phys.x + Math.sin(psi + backYaw) * 5,
        this.lookY,
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
      this._upBoat.set(0, 1, 0).applyQuaternion(g.quaternion);
      this.camera.up.copy(this._upBoat.lerp(this._up.set(0, 1, 0), 0.35).normalize());
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
