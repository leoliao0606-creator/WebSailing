// 键盘 + 鼠标输入。持续键查询 + 单帧按下事件 + 相机拖拽/滚轮。

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
      if (e.button === 0 || e.button === 2) this.dragging = true;
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (this.dragging) {
        this.orbitDX += e.movementX;
        this.orbitDY += e.movementY;
        this.lastDragT = performance.now() / 1000;
      }
    });
    dom.addEventListener('wheel', (e) => { this.wheel += e.deltaY; e.preventDefault(); }, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
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
