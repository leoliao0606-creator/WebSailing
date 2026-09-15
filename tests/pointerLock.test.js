import assert from 'node:assert/strict';
import test from 'node:test';

// Input 的构造函数要挂一堆 DOM 事件监听。Node 里没有 DOM，用一个最小的替身：
// 只记下「谁监听了哪个事件」，测试再手工把事件派发进去。
function fakeTarget(doc = null) {
  const listeners = new Map();
  return {
    ownerDocument: doc,
    addEventListener(type, fn) { (listeners.get(type) ?? listeners.set(type, []).get(type)).push(fn); },
    emit(type, ev = {}) { for (const fn of listeners.get(type) ?? []) fn(ev); },
    requestPointerLock(opts) {
      this.lockCalls = (this.lockCalls ?? 0) + 1;
      this.lastLockOpts = opts;
      if (this.lockFails) return Promise.reject(new Error('denied'));
      doc.pointerLockElement = this;
      return Promise.resolve();
    },
  };
}

function makeDoc() {
  const doc = fakeTarget(null);
  doc.pointerLockElement = null;
  doc.exitPointerLock = () => { doc.pointerLockElement = null; doc.emit('pointerlockchange'); };
  return doc;
}

async function withInput(fn) {
  const { Input } = await import('../src/game/input.js');
  const doc = makeDoc();
  const canvas = fakeTarget(doc);
  const prevWindow = globalThis.window;
  const prevPerf = globalThis.performance;
  globalThis.window = fakeTarget(doc);
  globalThis.performance ??= { now: () => 0 };
  try {
    return await fn(new Input(canvas), { canvas, doc, win: globalThis.window });
  } finally {
    globalThis.window = prevWindow;
    globalThis.performance = prevPerf;
  }
}

// 锁定生效后的第一次 mousemove 会被丢掉（见下面那条专门的测试），
// 所以要先空派发一次，再测真正的累加。
function lockAndSettle(input, { win, doc, canvas }) {
  doc.pointerLockElement = canvas;
  win.emit('mousemove', { movementX: 0, movementY: 0 });
  doc.emit('pointerlockchange');
}

test('指针锁定时不按住键也累加视角位移', () => withInput((input, ctx) => {
  const { win } = ctx;
  lockAndSettle(input, ctx);
  win.emit('mousemove', { movementX: 12, movementY: -7 });
  assert.equal(input.orbitDX, 12);
  assert.equal(input.orbitDY, -7);
}));

test('没锁定又没按住时鼠标移动不转视角，锁定前的拖拽回退仍然可用', () => withInput((input, { win, canvas }) => {
  win.emit('mousemove', { movementX: 30, movementY: 30 });
  assert.equal(input.orbitDX, 0, '没锁定也没拖拽却转了视角');
  canvas.emit('mousedown', { button: 0 });
  assert.equal(input.dragging, true);
  win.emit('mousemove', { movementX: 5, movementY: 5 });
  assert.equal(input.orbitDX, 5);
}));

test('单帧位移有上限：异常大的位移不会把视角甩飞', () => withInput((input, ctx) => {
  const { win } = ctx;
  lockAndSettle(input, ctx);
  win.emit('mousemove', { movementX: 9000, movementY: -9000 });
  assert.ok(Math.abs(input.orbitDX) <= 220, `单帧累加了 ${input.orbitDX} 像素`);
  assert.ok(Math.abs(input.orbitDY) <= 220);
}));

test('进入游戏请求锁定并关掉系统鼠标加速，回菜单释放锁定', () => withInput((input, { canvas, doc }) => {
  input.setLockWanted(true);
  assert.equal(canvas.lockCalls, 1);
  assert.deepEqual(canvas.lastLockOpts, { unadjustedMovement: true });
  assert.equal(doc.pointerLockElement, canvas);
  input.setLockWanted(false);
  assert.equal(doc.pointerLockElement, null);
}));

test('浏览器拒绝带参数的锁定时退回普通锁定，不抛错', () => withInput(async (input, { canvas, doc }) => {
  canvas.lockFails = true;
  input.setLockWanted(true);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  // 两次都被拒也不能冒出 unhandledrejection —— 那会在 Electron 里打断整局游戏。
  assert.ok(canvas.lockCalls >= 2, '没有退回普通锁定');
  assert.equal(doc.pointerLockElement, null);
}));

test('锁被收走（玩家按 Esc）时通知上层，并且吃掉那一下 Esc', () => withInput((input, { canvas, doc }) => {
  let lost = 0;
  input.onLockLost = () => { lost++; };
  input.setLockWanted(true);
  input.keys.add('escape'); input.pressedSet.add('escape');
  doc.exitPointerLock();
  assert.equal(lost, 1);
  // 浏览器规定按 Esc 一定解锁，有的内核还会把这一下 keydown 也发给页面。
  // 上层若同时按「锁没了」和「按了 Esc」各处理一次，就会暂停完立刻又恢复。
  input.onLockLost = () => { input.pressedSet.delete('escape'); };
  assert.equal(input.wantLock, true, '锁没了不代表退出了游戏状态，重新点画面还要能锁回去');
}));

test('游戏中点画面重新抓回指针，而不是进入拖拽', () => withInput((input, { canvas }) => {
  input.wantLock = true;
  canvas.emit('mousedown', { button: 0 });
  assert.equal(input.dragging, false, '锁定模式下不该再走拖拽分支');
  assert.equal(canvas.lockCalls, 1);
}));

test('锁定生效后的第一次移动被丢掉，即使它比 pointerlockchange 还早到', () => withInput((input, { win, doc, canvas }) => {
  // 实测顺序（无头 Chromium）：document.pointerLockElement 已经指向画布了，
  // 带着「上一次指针位置 → 锁定中心」差值的那个 mousemove 先到，
  // pointerlockchange 后到。标志位若放在 pointerlockchange 里置就来不及。
  doc.pointerLockElement = canvas;
  win.emit('mousemove', { movementX: -640, movementY: -288 });
  assert.equal(input.orbitDX, 0, `锁定首帧的跳变漏进来了：${input.orbitDX}`);
  assert.equal(input.orbitDY, 0);
  doc.emit('pointerlockchange');
  win.emit('mousemove', { movementX: 9, movementY: 4 });
  assert.equal(input.orbitDX, 9, '丢掉首帧之后就不该再丢了');
  // 解锁再锁上，还要再丢一次
  doc.pointerLockElement = null;
  win.emit('mousemove', { movementX: 100, movementY: 0 });
  doc.pointerLockElement = canvas;
  win.emit('mousemove', { movementX: -500, movementY: 0 });
  assert.equal(input.orbitDX, 9, '重新锁定时没有再丢掉首帧');
}));
