import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ChatModel,
  ChatPanel,
  unicodeLength,
} from '../src/game/chatPanel.js';

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

  sendChat(text) { this.sent.push(text); return true; }
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
  assert.match(css, /\.chat-panel\s*\{/);
  assert.match(css, /\.multiplayer-screen\s+/);
  assert.match(css, /max-height:\s*(?:min\(|calc\(|[0-9]+vh)/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /\.chat-panel[\s\S]*pointer-events:\s*auto/);
});
