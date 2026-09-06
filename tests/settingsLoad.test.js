import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSettings } from '../src/game/menu.js';

// loadSettings 会读 localStorage,并调用 setLang（要用到 document）。
// Node 里这两个都不存在,临时装上桩(stub:替身实现),测完还原。
function withStoredSettings(raw, fn) {
  const hadLocalStorage = 'localStorage' in globalThis;
  const prevLocalStorage = globalThis.localStorage;
  const prevDocument = globalThis.document;
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (k) => (k === 'windchaser.settings' ? raw : null), setItem() {} },
    configurable: true,
    writable: true,
  });
  globalThis.document = { documentElement: {}, title: '' };
  try {
    return fn();
  } finally {
    if (hadLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', {
        value: prevLocalStorage, configurable: true, writable: true,
      });
    } else {
      delete globalThis.localStorage;
    }
    globalThis.document = prevDocument;
  }
}

test('全新存档拿到海浪/音效两档音量的默认值', () => {
  const s = withStoredSettings('{}', loadSettings);
  assert.equal(s.volSea, 0.7);
  assert.equal(s.volSfx, 0.8);
});

test('存过的音量原样读回,没存过的字段吃默认值', () => {
  const s = withStoredSettings(JSON.stringify({ volume: 0.5, volSea: 0.9 }), loadSettings);
  assert.equal(s.volume, 0.5);
  assert.equal(s.volSea, 0.9);
  assert.equal(s.volSfx, 0.8);
  assert.equal(s.volAmbient, 0.6);
});

test('存档损坏时回落到默认值,不抛错', () => {
  const s = withStoredSettings('{ 坏掉的 JSON', loadSettings);
  assert.equal(s.volSea, 0.7);
  assert.equal(s.volSfx, 0.8);
});
// 下面这四个都是合法 JSON,JSON.parse 不会抛错,但解析出来不是对象。
// 以前 loadSettings 会在 "'shadowQ' in stored" 这类判断上抛 TypeError,
// 游戏起不来;坏值还留在 localStorage 里,刷新一次崩一次。
for (const raw of ['null', '5', '"abc"', 'true']) {
  test(`存档是合法 JSON 但不是对象(${raw})时回落到默认值,不抛错`, () => {
    const s = withStoredSettings(raw, loadSettings);
    assert.equal(s.volSea, 0.7);
    assert.equal(s.volSfx, 0.8);
    assert.equal(s.shadowQ, 'high');
  });
}
