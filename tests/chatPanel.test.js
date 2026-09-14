import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ChatModel,
  ChatPanel,
  unicodeLength,
} from '../src/game/chatPanel.js';
import { Menu } from '../src/game/menu.js';

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}

class FakeClassList {
  constructor(element) { this.element = element; this.values = new Set(); }
  add(...values) { for (const value of values) this.values.add(value); }
  remove(...values) { for (const value of values) this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

function matches(element, selector) {
  const testId = selector.match(/^\[data-testid="([^"]+)"\]$/)?.[1];
  if (testId !== undefined) return element.dataset.testid === testId;
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

class FakeElement extends EventTarget {
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.maxLength = -1;
    this._text = '';
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(_value) {
    this.ownerDocument.innerHTMLAssignments += 1;
    throw new Error('chat DOM must not use innerHTML');
  }

  setAttribute(name, value) {
    const normalized = String(value);
    this.attributes.set(name, normalized);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      this.dataset[key] = normalized;
      if (name === 'data-testid') this.dataset.testid = normalized;
    }
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(child) { this.append(child); return child; }

  replaceChildren(...children) {
    this.children = [];
    this._text = '';
    this.append(...children);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (matches(child, selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (matches(child, selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }

  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  scrollTo() {}
}

class FakeDocument {
  constructor() {
    this.innerHTMLAssignments = 0;
    this.body = new FakeElement('body', this);
    this.activeElement = null;
  }

  createElement(tagName) { return new FakeElement(tagName, this); }
}

class FakeSession extends EventTarget {
  constructor() {
    super();
    this.sent = [];
    this.sendResult = true;
    this.rateLimitedOnSend = false;
    this.state = {
      roomCode: 'AB2CD9',
      playerId: 'me',
      hostId: 'me',
      role: 'host',
      migrating: false,
      invalidated: false,
      members: [
        { playerId: 'me', nickname: '我', connected: true, ready: true },
        { playerId: 'other', nickname: '海友', connected: true, ready: true },
      ],
    };
  }

  sendChat(text) {
    this.sent.push(text);
    if (this.rateLimitedOnSend) {
      this.dispatchEvent(detailEvent('chat-rate-limited', { sourceId: this.state.playerId }));
    }
    return this.sendResult;
  }
  receive(sourceId, text) { this.dispatchEvent(detailEvent('chat', { sourceId, text })); }
  changeRoom(roomCode) {
    this.state = { ...this.state, roomCode };
    this.dispatchEvent(detailEvent('statechange', this.state));
  }
}

test('Unicode length counts code points and rejects 501 without truncating or rewriting 500', () => {
  const model = new ChatModel();
  const exact = '🌊'.repeat(500);
  assert.equal(unicodeLength(exact), 500);
  assert.equal(model.validate(exact).ok, true);
  assert.equal(model.validate(exact).text, exact);
  assert.equal(model.validate(`${exact}🌊`).ok, false);
  assert.equal(model.validate('  完全自由 <b>内容</b>  ').text, '  完全自由 <b>内容</b>  ');
});

test('history is bounded to the latest 100 messages', () => {
  const model = new ChatModel({ historyLimit: 100 });
  for (let index = 0; index < 105; index += 1) {
    model.add({ sourceId: 'p', text: `message-${index}` });
  }
  assert.equal(model.messages.length, 100);
  assert.equal(model.messages[0].text, 'message-5');
  assert.equal(model.messages.at(-1).text, 'message-104');
});

test('mute is local-only: it hides history, preserves it, and unmute restores it', () => {
  const model = new ChatModel();
  model.add({ sourceId: 'other', text: '仍在本机历史里' });
  model.add({ sourceId: 'me', text: 'mine' });

  assert.equal(model.toggleMute('other'), true);
  assert.deepEqual(model.visibleMessages.map(({ text }) => text), ['mine']);
  assert.equal(model.messages.length, 2);
  assert.equal(model.toggleMute('other'), false);
  assert.deepEqual(model.visibleMessages.map(({ text }) => text), ['仍在本机历史里', 'mine']);
});

test('panel renders hostile markup only as textContent and never parses chat HTML', () => {
  const documentRef = new FakeDocument();
  const session = new FakeSession();
  const panel = new ChatPanel({ documentRef, mountRoot: documentRef.body, session });
  const hostile = '<img src=x onerror="globalThis.pwned=true">你好';

  session.receive('other', hostile);

  const content = panel.element.querySelector('.chat-message-text');
  assert.equal(content.textContent, hostile);
  assert.equal(content.children.length, 0);
  assert.equal(documentRef.innerHTMLAssignments, 0);
});

test('panel local mute does not alter session traffic and unmute restores retained messages', () => {
  const documentRef = new FakeDocument();
  const session = new FakeSession();
  const panel = new ChatPanel({ documentRef, mountRoot: documentRef.body, session });
  session.receive('other', 'before mute');

  panel.toggleMute('other');
  session.receive('other', 'while muted');
  assert.equal(panel.element.querySelectorAll('.chat-message-text').length, 0);
  assert.equal(session.sent.length, 0);

  panel.toggleMute('other');
  assert.deepEqual(
    panel.element.querySelectorAll('.chat-message-text').map((node) => node.textContent),
    ['before mute', 'while muted'],
  );
});

test('persistent panel refreshes all static labels after a language change', () => {
  const documentRef = new FakeDocument();
  const session = new FakeSession();
  let language = 'en';
  const strings = {
    en: {
      'chat.title': 'Chat', 'chat.collapse': 'Collapse', 'chat.expand': 'Expand',
      'chat.muteList': 'Mute list', 'chat.input': 'Message', 'chat.placeholder': 'Type',
      'chat.send': 'Send', 'chat.mute': 'Mute', 'chat.unmute': 'Unmute',
    },
    ja: {
      'chat.title': 'チャット', 'chat.collapse': '折りたたむ', 'chat.expand': '展開',
      'chat.muteList': 'ミュート一覧', 'chat.input': 'メッセージ', 'chat.placeholder': '入力',
      'chat.send': '送信', 'chat.mute': 'ミュート', 'chat.unmute': '解除',
    },
  };
  const panel = new ChatPanel({
    documentRef,
    mountRoot: documentRef.body,
    session,
    translate: (key) => strings[language][key] ?? key,
  });

  language = 'ja';
  panel.refreshLanguage();

  assert.equal(panel.element.getAttribute('aria-label'), 'チャット');
  assert.equal(panel.element.querySelector('.chat-title').textContent, 'チャット');
  assert.equal(panel.element.querySelector('[data-testid="chat-toggle"]').textContent, '折りたたむ');
  assert.equal(panel.element.querySelector('[data-testid="chat-input"]').getAttribute('placeholder'), '入力');
  assert.match(panel.element.querySelector('[data-testid="chat-mute-other"]').textContent, /ミュート/);
});

test('leaving a room clears local history, mute choices, and rate budget before another room', () => {
  const documentRef = new FakeDocument();
  const session = new FakeSession();
  let now = 1_000;
  const panel = new ChatPanel({
    documentRef, mountRoot: documentRef.body, session, now: () => now,
  });
  session.receive('other', 'private to the old room');
  panel.toggleMute('other');
  for (let index = 0; index < 5; index += 1) panel.send(`old-${index}`);

  session.changeRoom(null);
  session.changeRoom('NEW234');

  assert.equal(panel.model.messages.length, 0);
  assert.equal(panel.model.isMuted('other'), false);
  assert.equal(panel.send('first in new room'), true);
});

test('panel enforces local send-rate feedback and forwards accepted content unchanged', () => {
  const documentRef = new FakeDocument();
  const session = new FakeSession();
  let now = 1_000;
  const panel = new ChatPanel({
    documentRef,
    mountRoot: documentRef.body,
    session,
    now: () => now,
  });

  for (let index = 0; index < 5; index += 1) {
    assert.equal(panel.send(`  msg-${index}  `), true);
  }
  assert.equal(panel.send('sixth'), false);
  assert.deepEqual(session.sent, [
    '  msg-0  ', '  msg-1  ', '  msg-2  ', '  msg-3  ', '  msg-4  ',
  ]);
  assert.notEqual(panel.element.querySelector('[data-testid="chat-error"]').textContent, '');

  now += 5_001;
  assert.equal(panel.send('after window'), true);
  assert.equal(session.sent.at(-1), 'after window');
});

test('a transport send failure is reported as unavailable rather than rate limited', () => {
  const documentRef = new FakeDocument();
  const session = new FakeSession();
  session.sendResult = false;
  const panel = new ChatPanel({ documentRef, mountRoot: documentRef.body, session });

  assert.equal(panel.send('hello'), false);
  const error = panel.element.querySelector('[data-testid="chat-error"]').textContent;
  assert.match(error, /无法|unavailable/i);
  assert.doesNotMatch(error, /过快|quickly|rate/i);
});

test('a synchronous authoritative rate-limit signal keeps rate feedback', () => {
  const documentRef = new FakeDocument();
  const session = new FakeSession();
  session.sendResult = false;
  session.rateLimitedOnSend = true;
  const panel = new ChatPanel({ documentRef, mountRoot: documentRef.body, session });

  assert.equal(panel.send('hello'), false);
  assert.match(
    panel.element.querySelector('[data-testid="chat-error"]').textContent,
    /过快|quickly|rate/i,
  );
});

test('counter uses Unicode characters; Enter sends and Escape blurs without leaking keys', () => {
  const documentRef = new FakeDocument();
  const session = new FakeSession();
  const panel = new ChatPanel({ documentRef, mountRoot: documentRef.body, session });
  const input = panel.element.querySelector('[data-testid="chat-input"]');
  assert.ok(input.maxLength < 0 || input.maxLength >= 1_000, 'native UTF-16 limit must allow 500 astral characters');
  input.value = '🌊航';
  input.dispatchEvent(new Event('input'));
  assert.equal(panel.element.querySelector('[data-testid="chat-count"]').textContent, '2/500');

  const enter = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(enter, 'key', { value: 'Enter' });
  input.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(session.sent.at(-1), '🌊航');

  input.focus();
  const escape = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  input.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(documentRef.activeElement, null);
});

test('IME composition Enter never sends or prevents the composition keystroke', () => {
  const documentRef = new FakeDocument();
  const session = new FakeSession();
  const panel = new ChatPanel({ documentRef, mountRoot: documentRef.body, session });
  const input = panel.element.querySelector('[data-testid="chat-input"]');
  input.value = '正在组合';

  for (const property of ['isComposing', 'keyCode']) {
    const event = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      key: { value: 'Enter' },
      [property]: { value: property === 'isComposing' ? true : 229 },
    });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(session.sent, []);
  assert.equal(input.value, '正在组合');
});

test('chat and lobby CSS stay bounded and responsive around the sailing HUD', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const desktop = css.match(/\.chat-panel\s*\{([^}]*)\}/)?.[1] ?? '';
  const desktopRight = Number(desktop.match(/right:\s*([0-9]+)px/)?.[1]);
  const desktopClearance = Number(
    desktop.match(/width:\s*min\(340px,\s*calc\(100vw\s*-\s*([0-9]+)px\)\)/)?.[1],
  );
  assert.ok(desktopRight >= 236, 'desktop chat must end left of the right-side HUD circles');
  assert.ok(
    desktopClearance >= 464,
    'desktop chat must also clear the lower-left instruments at the 721px breakpoint',
  );

  const mobileSource = css.slice(css.lastIndexOf('@media (max-width: 720px)'));
  const mobile = mobileSource.match(/\.chat-panel\s*\{([^}]*)\}/)?.[1] ?? '';
  const mobileTop = Number(mobile.match(/top:\s*([0-9]+)px/)?.[1]);
  const mobileBottom = Number(mobile.match(/bottom:\s*([0-9]+)px/)?.[1]);
  assert.ok(mobileTop >= 238, 'mobile chat must start below the wind dial');
  assert.ok(mobileBottom >= 250, 'mobile chat must end above the minimap and instruments');

  for (const height of [560, 720, 844]) {
    const chatBottom = height - mobileBottom;
    const minimapTop = height - 232;
    assert.ok(chatBottom <= minimapTop - 18, `chat overlaps minimap at ${height}px high`);
  }
});

// —— 赛前大厅的聊天面板避让 ——
//
// 聊天面板那套 right:236px / top:242px 是照着赛中画面定的（避开右上风向表、
// 右下小地图）。赛前大厅却是一个居中的整屏菜单，同一个坐标会压在成员列表和
// 「准备」按钮上。窗口宽度小于约 1010px 时，非房主根本点不到「准备」——
// 房主的按钮行里多一个「开始比赛」，整行更宽、准备按钮被推到更左边，反而躲开了，
// 所以这个缺陷只在非房主身上出现，端到端测试里表现为一条 20 秒的点击超时。

test('打开多人大厅时把 lobby-open 标到 body 上，离开时收回', () => {
  const marked = new Set();
  const noop = { toggle() {} };
  const menu = {
    root: {
      children: [
        { id: 'menu-main', classList: noop },
        { id: 'menu-online-lobby', classList: noop },
      ],
      classList: noop,
      ownerDocument: {
        body: {
          classList: {
            toggle(name, on) { if (on) marked.add(name); else marked.delete(name); },
          },
        },
      },
    },
  };
  const show = (id) => Menu.prototype.show.call(menu, id);

  show('menu-online-lobby');
  assert.ok(marked.has('lobby-open'), '大厅界面显示时样式表要能切到并排布局');
  show('menu-main');
  assert.ok(!marked.has('lobby-open'), '离开大厅要恢复赛中那套 HUD 避让坐标');
  show('menu-online-lobby');
  show(null);
  assert.ok(!marked.has('lobby-open'), '开赛后菜单全隐，标记也要收回');
});

test('大厅态的聊天面板有独立定位，并给大厅内容留出等宽内边距', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

  const lobbyPanel = css.match(/body\.lobby-open\s+\.chat-panel\s*\{([^}]*)\}/)?.[1];
  assert.ok(lobbyPanel, '缺少 body.lobby-open .chat-panel 规则，大厅会退回赛中坐标');
  assert.ok(
    /right:\s*var\(--lobby-chat-gap\)/.test(lobbyPanel),
    '大厅态面板应贴屏幕右缘，而不是留 236px 悬在中间',
  );
  assert.ok(
    /width:\s*var\(--lobby-chat-w\)/.test(lobbyPanel),
    '面板宽度要和大厅让出的内边距用同一个变量，两处数字不能各写各的',
  );

  const lobbyScreen = css.match(/body\.lobby-open\s+#menu-online-lobby\s*\{([^}]*)\}/)?.[1];
  assert.ok(lobbyScreen, '大厅界面没有让位的内边距，内容仍会被面板压住');
  assert.ok(
    /padding-right:\s*calc\(var\(--lobby-chat-w\)\s*\+\s*var\(--lobby-chat-gap\)\s*\*\s*2\)/
      .test(lobbyScreen),
    '让出的宽度必须等于面板宽加两侧留白',
  );

  // 让出右侧后可用宽度变窄，大厅里的定宽块必须跟着收，否则横向溢出
  assert.ok(
    /#menu-online-lobby\s+\.lobby-members\s*\{[^}]*width:\s*min\(620px,\s*100%\)/.test(css),
    '成员列表要受父容器可用宽度约束',
  );

  // 窄屏左右并排挤不开，必须改成面板贴底、大厅内容往上让
  const mobileSource = css.slice(css.lastIndexOf('@media (max-width: 720px)'));
  const mobilePanel = mobileSource.match(/body\.lobby-open\s+\.chat-panel\s*\{([^}]*)\}/)?.[1];
  assert.ok(mobilePanel, '窄屏缺少大厅态面板规则');
  assert.ok(/bottom:\s*0/.test(mobilePanel), '窄屏大厅态面板应贴底');
  const mobileScreen = mobileSource.match(/body\.lobby-open\s+#menu-online-lobby\s*\{([^}]*)\}/)?.[1];
  assert.ok(
    mobileScreen && /padding-bottom:\s*40vh/.test(mobileScreen),
    '窄屏大厅内容要为贴底的面板让出等高的下内边距',
  );
});
