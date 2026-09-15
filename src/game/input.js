// 键盘 + 鼠标输入。持续键查询 + 单帧按下事件 + 视角转动 + 滚轮。
//
// 视角转动有两条路径：
//  - 指针锁定(pointer lock)：浏览器把鼠标指针藏起来、锁在窗口里，只把每次移动的
//    位移量报给页面。指针永远不会跑出窗口，也就不需要按住某个键才能转视角 ——
//    和第一人称射击游戏一样。游戏中默认走这条。
//  - 拖拽：没拿到锁定时（菜单里、浏览器拒绝锁定时）退回旧的「按住左键/右键拖」。

import { clamp } from '../util/math.js';

// 单次 mousemove 的位移上限（像素）。Chromium 在刚拿到指针锁定的头一两帧偶尔会
// 报出几百像素的 movementX，不截断的话视角会瞬间甩出去。
const MAX_MOVE_PX = 220;

function isEditableTarget(target) {
  const formTags = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);
  for (let node = target; node; node = node.parentElement) {
    if (formTags.has(String(node.tagName ?? '').toUpperCase())) return true;
    if (node.isContentEditable || node.contentEditable === 'true') return true;
  }
  return false;
}

export class Input {
  constructor(dom) {
    this.keys = new Set();
    this.pressedSet = new Set();
    this.orbitDX = 0;
    this.orbitDY = 0;
    this.wheel = 0;
    this.dragging = false;
    this.lastDragT = -99;

    this.dom = dom;
    this._wasLocked = false;  // 上一次 mousemove 时的锁定状态，用来识别刚锁上的那一帧
    this.doc = dom?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    this.wantLock = false;   // 当前是不是「该锁住指针」的游戏状态
    this.onLockLost = null;  // 锁被收走时回调（App 用来弹暂停菜单）

    window.addEventListener('keydown', (e) => {
      if (isEditableTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) this.pressedSet.add(k);
      this.keys.add(k);
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    dom.addEventListener('mousedown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      // 游戏中点画面 = 重新抓住指针（被 Esc 解锁后就是靠这一下回去的）。
      // 浏览器要求 requestPointerLock 发生在用户手势里，这里正好是。
      if (this.wantLock) { this.requestLock(); return; }
      this.dragging = true;
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      const locked = this.locked;
      // 锁定生效后的第一次移动整个丢掉。实测（无头 Chromium 1280×800）它带的是
      // 「上一次指针位置 → 锁定中心」的差值，这一例是 (-640, -288)，一帧就能把
      // 视角甩过去 31°。而且这个事件比 pointerlockchange 还早到，所以标志位不能
      // 放在那个事件里置，只能在这里比对上一帧的锁定状态。
      if (locked !== this._wasLocked) {
        this._wasLocked = locked;
        if (locked) return;
      }
      if (!locked && !this.dragging) return;
      const dx = clamp(e.movementX || 0, -MAX_MOVE_PX, MAX_MOVE_PX);
      const dy = clamp(e.movementY || 0, -MAX_MOVE_PX, MAX_MOVE_PX);
      if (dx === 0 && dy === 0) return;
      this.orbitDX += dx;
      this.orbitDY += dy;
      this.lastDragT = performance.now() / 1000;
    });
    dom.addEventListener('wheel', (e) => { this.wheel += e.deltaY; e.preventDefault(); }, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    this.doc?.addEventListener?.('pointerlockchange', () => {
      if (this.locked) return;
      this.dragging = false;
      // 按 Esc 一定会解锁，而且那一下 keydown 浏览器不发给页面，所以
      // 「锁没了」本身就是玩家要退出操控的信号，交给 App 决定弹什么。
      if (this.wantLock) this.onLockLost?.();
    });
  }

  get locked() { return !!this.doc && this.doc.pointerLockElement === this.dom; }

  // 进入/退出「锁定指针」的游戏状态。菜单、暂停、大厅里必须关掉，否则点不了按钮。
  setLockWanted(on) {
    const want = !!on;
    const changed = want !== this.wantLock;
    this.wantLock = want;
    if (want) this.requestLock();
    else if (changed || this.locked) this.releaseLock();
  }

  requestLock() {
    if (this.locked || typeof this.dom?.requestPointerLock !== 'function') return;
    // unadjustedMovement 关掉操作系统那一层的鼠标加速/曲线，拿到的位移与物理
    // 移动成正比，这是 FPS 手感的关键。不支持的平台会 reject，退回普通锁定。
    try {
      const r = this.dom.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof r.catch === 'function') r.catch(() => this._plainLock());
    } catch {
      this._plainLock();
    }
  }

  _plainLock() {
    // 刚按过 Esc 时浏览器会在短时间内拒绝再次锁定，忽略即可 —— 玩家再点一下画面
    // 就成功了，不需要报错打断游戏。拒绝可能以抛异常、也可能以返回一个 rejected
    // Promise 的形式出现，两条都要接住，否则会冒成 unhandledrejection。
    try {
      const r = this.dom.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => { /* 忽略 */ });
    } catch { /* 忽略 */ }
  }

  releaseLock() {
    if (this.locked) this.doc.exitPointerLock?.();
  }

  down(...ks) { return ks.some((k) => this.keys.has(k)); }
  pressed(...ks) { return ks.some((k) => this.pressedSet.has(k)); }

  // 将瞬时键盘状态采样为可序列化的控制意图。
  controlIntent() {
    return {
      steerLeft: this.down('a', 'arrowleft'),
      steerRight: this.down('d', 'arrowright'),
      sheetIn: this.down('w', 'arrowup'),
      sheetOut: this.down('s', 'arrowdown'),
      hikeOut: this.down('q'),
      hikeIn: this.down('e'),
      boardDown: this.down('f'),
      boardUp: this.down('r'),
      righting: this.down(' '),
    };
  }

  // 每帧末调用：清空单帧事件与增量
  endFrame() {
    this.pressedSet.clear();
    this.orbitDX = 0;
    this.orbitDY = 0;
    this.wheel = 0;
  }
}
