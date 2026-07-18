import assert from 'node:assert/strict';
import test from 'node:test';

import { Boat, resolveBoatIdentity } from '../src/game/boat.js';
import { Input } from '../src/game/input.js';

const SETTINGS = Object.freeze({ autoTrim: false, autoHike: false });

function inputWithKeys(...keys) {
  const input = Object.create(Input.prototype);
  input.keys = new Set(keys);
  return input;
}

function makeControlOnlyBoat() {
  const boat = Object.create(Boat.prototype);
  boat.phys = {
    ctl: {
      rudder: 0,
      sheet: 0.5,
      board: 0.5,
      hike: 0,
      autoHike: false,
      righting: false,
    },
    crewY: 0.25,
    out: { heelDeg: 10 },
  };
  boat.rudderCmd = 0;
  boat.hikeLevel = 0;
  boat.manualSheetAt = -99;
  return boat;
}

function controlState(boat) {
  return {
    ctl: { ...boat.phys.ctl },
    rudderCmd: boat.rudderCmd,
    hikeLevel: boat.hikeLevel,
    manualSheetAt: boat.manualSheetAt,
  };
}

test('boat identity keeps explicit network ids and local ownership stable', () => {
  assert.deepEqual(resolveBoatIdentity({
    boatId: 'boat-7',
    playerId: 'player-7',
    isLocal: true,
  }), {
    boatId: 'boat-7',
    playerId: 'player-7',
    isLocal: true,
    isPlayer: true,
  });
  assert.deepEqual(resolveBoatIdentity({
    playerId: 'player-8',
    isPlayer: false,
  }), {
    boatId: 'player-8',
    playerId: 'player-8',
    isLocal: false,
    isPlayer: false,
  });
});

test('Input.controlIntent returns every control field as a boolean', () => {
  const input = inputWithKeys('a', 'arrowright', 'w', 'q', 'r', ' ');

  assert.deepEqual(input.controlIntent(), {
    steerLeft: true,
    steerRight: true,
    sheetIn: true,
    sheetOut: false,
    hikeOut: true,
    hikeIn: false,
    boardDown: false,
    boardUp: true,
    righting: true,
  });
});

test('Input ignores game keys from form controls and contenteditable targets', () => {
  const previousWindow = globalThis.window;
  const listeners = new Map();
  const windowRef = {
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const dom = { addEventListener() {} };
  globalThis.window = windowRef;
  try {
    const input = new Input(dom);
    const keydown = listeners.get('keydown');
    for (const target of [
      { tagName: 'INPUT' },
      { tagName: 'SELECT' },
      { tagName: 'TEXTAREA' },
      { tagName: 'BUTTON' },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      keydown({ target, key: ' ', preventDefault() { throw new Error('must be ignored'); } });
    }

    assert.deepEqual([...input.keys], []);
    assert.deepEqual([...input.pressedSet], []);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('applyInput compatibility path matches applyControlIntent', () => {
  const input = inputWithKeys('d', 's', 'q', 'f', ' ');
  const localBoat = makeControlOnlyBoat();
  const remoteBoat = makeControlOnlyBoat();

  localBoat.applyInput(input, SETTINGS, 0.125, 8);
  remoteBoat.applyControlIntent(input.controlIntent(), SETTINGS, 0.125, 8);

  assert.deepEqual(controlState(localBoat), controlState(remoteBoat));
});

test('applyControlIntent preserves the existing control rates', () => {
  const boat = makeControlOnlyBoat();

  boat.applyControlIntent({
    steerLeft: false,
    steerRight: true,
    sheetIn: true,
    sheetOut: false,
    hikeOut: true,
    hikeIn: false,
    boardDown: true,
    boardUp: false,
    righting: true,
  }, SETTINGS, 0.1, 4);

  assert.ok(Math.abs(boat.rudderCmd - 0.26) < 1e-12);
  assert.ok(Math.abs(boat.phys.ctl.sheet - 0.45) < 1e-12);
  assert.ok(Math.abs(boat.hikeLevel - 0.14) < 1e-12);
  assert.ok(Math.abs(boat.phys.ctl.board - 0.56) < 1e-12);
  assert.equal(boat.phys.ctl.righting, true);
  assert.equal(boat.manualSheetAt, 4);

  boat.applyControlIntent({
    steerLeft: false,
    steerRight: false,
    sheetIn: false,
    sheetOut: false,
    hikeOut: false,
    hikeIn: false,
    boardDown: false,
    boardUp: false,
    righting: false,
  }, SETTINGS, 0.05, 4.05);

  assert.ok(Math.abs(boat.rudderCmd - 0.09) < 1e-12);
  assert.equal(boat.phys.ctl.righting, false);
});

test('Boat simulate and render paths are independent and update remains compatible', () => {
  const calls = [];
  const boat = Object.create(Boat.prototype);
  boat.phys = {
    x: 1,
    z: 2,
    boom: 0,
    capsized: false,
    out: { twaDeg: 45 },
    step: (wind, dt, waves) => calls.push(['step', wind, dt, waves]),
  };
  boat.waveField = { sample() {} };
  boat.visual = { update: (...args) => calls.push(['visual', ...args]) };
  boat.effects = { update: (...args) => calls.push(['effects', ...args]) };
  boat.isPlayer = false;
  boat.events = { tacks: 0, gybes: 0, capsizes: 0 };
  boat._prevTwaSign = 0;
  boat._prevBoomSign = 0;
  boat._prevCapsized = false;
  boat._prevPos = { x: 0, z: 0 };

  boat.simulate('wind', 1 / 60, 4, null, null);
  assert.deepEqual(calls.map(([name]) => name), ['step']);

  boat.render(4, 1 / 60);
  assert.deepEqual(calls.map(([name]) => name), ['step', 'visual', 'effects']);

  calls.length = 0;
  boat.update('wind', 1 / 60, 5, null, null);
  assert.deepEqual(calls.map(([name]) => name), ['step', 'visual', 'effects']);
});
