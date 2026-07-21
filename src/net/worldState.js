const PHYS_NUMBER_FIELDS = Object.freeze([
  'x',
  'z',
  'psi',
  'u',
  'v',
  'yawRate',
  'phi',
  'phiRate',
  'boom',
  'rudder',
  'sheet',
  'board',
  'crewY',
  'rightProgress',
  'powerScale',
]);

const CTL_NUMBER_FIELDS = Object.freeze(['rudder', 'sheet', 'board', 'hike']);
const CTL_BOOLEAN_FIELDS = Object.freeze(['autoHike', 'righting', 'autoTrim']);
const CONTROL_FIELDS = Object.freeze(['rudderCmd', 'hikeLevel', 'manualSheetAt']);
// 航行规则处罚状态(boat 顶层字段,rules.js 读写);host 权威判罚,guest 快照回填
const RULES_FIELDS = Object.freeze(['penaltyT', 'ruleCooldown', 'penaltyTurns', 'turnAcc']);
const RACE_ENTRY_FIELDS = Object.freeze([
  'boatId',
  'leg',
  'ocs',
  'splits',
  'finished',
  'finishT',
  'prevX',
  'prevZ',
  'roundAcc',
  'nearMark',
]);

export const MAX_BOATS = 8;
export const MAX_BOAT_ID_BYTES = 128;
export const MAX_SEED_BYTES = 256;
export const MAX_RACE_SPLITS = 16;
export const MAX_RACE_RESULTS = 8;
export const MAX_WORLD_STATE_BYTES = 64 * 1024;
export const RACE_STATES = Object.freeze(['prestart', 'racing', 'finished']);

const RACE_STATE_SET = new Set(RACE_STATES);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  throw new TypeError(message);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value, fields, path) {
  if (!isPlainRecord(value)) fail(`${path} must be a plain object`);

  const allowed = new Set(fields);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(`${path} contains unknown field ${String(key)}`);
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) fail(`${path} requires ${field}`);
  }
}

function finiteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${path} must be a finite number`);
  }
  return value;
}

function boundedNumber(value, minimum, maximum, path) {
  const number = finiteNumber(value, path);
  if (number < minimum || number > maximum) {
    fail(`${path} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function booleanValue(value, path) {
  if (typeof value !== 'boolean') fail(`${path} must be a Boolean`);
  return value;
}

function utf8Length(value) {
  return textEncoder.encode(value).byteLength;
}

function opaqueId(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  if (value.length > MAX_BOAT_ID_BYTES || utf8Length(value) > MAX_BOAT_ID_BYTES) {
    fail(`${path} boatId cannot exceed ${MAX_BOAT_ID_BYTES} UTF-8 bytes`);
  }
  return value;
}

function cloneSeed(value) {
  if (typeof value === 'string' && value.length > 0) {
    if (value.length > MAX_SEED_BYTES || utf8Length(value) > MAX_SEED_BYTES) {
      fail(`seed cannot exceed ${MAX_SEED_BYTES} UTF-8 bytes`);
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  fail('seed must be a non-empty string or finite number');
}

function cloneCtl(value, path) {
  const fields = [...CTL_NUMBER_FIELDS, ...CTL_BOOLEAN_FIELDS];
  exactRecord(value, fields, path);

  return {
    rudder: boundedNumber(value.rudder, -1, 1, `${path}.rudder`),
    sheet: boundedNumber(value.sheet, 0, 1, `${path}.sheet`),
    board: boundedNumber(value.board, 0, 1, `${path}.board`),
    hike: boundedNumber(value.hike, -1, 1, `${path}.hike`),
    autoHike: booleanValue(value.autoHike, `${path}.autoHike`),
    righting: booleanValue(value.righting, `${path}.righting`),
    autoTrim: booleanValue(value.autoTrim, `${path}.autoTrim`),
  };
}

function clonePhys(value, path) {
  exactRecord(value, [...PHYS_NUMBER_FIELDS, 'capsized', 'ctl'], path);

  const clone = {};
  for (const field of PHYS_NUMBER_FIELDS) {
    clone[field] = finiteNumber(value[field], `${path}.${field}`);
  }
  clone.sheet = boundedNumber(value.sheet, 0, 1, `${path}.sheet`);
  clone.board = boundedNumber(value.board, 0, 1, `${path}.board`);
  clone.rightProgress = boundedNumber(value.rightProgress, 0, 1, `${path}.rightProgress`);
  clone.powerScale = boundedNumber(value.powerScale, 0, 1, `${path}.powerScale`);
  clone.capsized = booleanValue(value.capsized, `${path}.capsized`);
  clone.ctl = cloneCtl(value.ctl, `${path}.ctl`);
  return clone;
}

function cloneRules(value, path) {
  exactRecord(value, RULES_FIELDS, path);
  return {
    penaltyT: boundedNumber(value.penaltyT, 0, Number.MAX_VALUE, `${path}.penaltyT`),
    ruleCooldown: finiteNumber(value.ruleCooldown, `${path}.ruleCooldown`),
    penaltyTurns: nonNegativeInteger(value.penaltyTurns, `${path}.penaltyTurns`),
    turnAcc: finiteNumber(value.turnAcc, `${path}.turnAcc`),
  };
}

function cloneControl(value, path) {
  exactRecord(value, CONTROL_FIELDS, path);
  return {
    rudderCmd: boundedNumber(value.rudderCmd, -1, 1, `${path}.rudderCmd`),
    hikeLevel: boundedNumber(value.hikeLevel, -1, 1, `${path}.hikeLevel`),
    manualSheetAt: finiteNumber(value.manualSheetAt, `${path}.manualSheetAt`),
  };
}

function cloneBoat(value, index) {
  const path = `boats[${index}]`;
  exactRecord(value, ['boatId', 'phys', 'control', 'rules'], path);
  return {
    boatId: opaqueId(value.boatId, `${path}.boatId`),
    phys: clonePhys(value.phys, `${path}.phys`),
    control: cloneControl(value.control, `${path}.control`),
    rules: cloneRules(value.rules, `${path}.rules`),
  };
}

function cloneRaceEntry(value, index, boatIds) {
  const path = `race.entries[${index}]`;
  exactRecord(value, RACE_ENTRY_FIELDS, path);
  const boatId = opaqueId(value.boatId, `${path}.boatId`);
  if (!boatIds.has(boatId)) fail(`${path} references unknown boatId ${boatId}`);
  if (!Array.isArray(value.splits)) fail(`${path}.splits must be an array`);
  if (value.splits.length > MAX_RACE_SPLITS) {
    fail(`${path}.splits cannot exceed ${MAX_RACE_SPLITS} entries`);
  }

  return {
    boatId,
    leg: nonNegativeInteger(value.leg, `${path}.leg`),
    ocs: booleanValue(value.ocs, `${path}.ocs`),
    splits: value.splits.map((split, splitIndex) => (
      finiteNumber(split, `${path}.splits[${splitIndex}]`)
    )),
    finished: booleanValue(value.finished, `${path}.finished`),
    finishT: finiteNumber(value.finishT, `${path}.finishT`),
    prevX: finiteNumber(value.prevX, `${path}.prevX`),
    prevZ: finiteNumber(value.prevZ, `${path}.prevZ`),
    roundAcc: finiteNumber(value.roundAcc, `${path}.roundAcc`),
    nearMark: booleanValue(value.nearMark, `${path}.nearMark`),
  };
}

function cloneRaceResult(value, index, boatIds) {
  const path = `race.results[${index}]`;
  exactRecord(value, ['boatId', 'time'], path);
  const boatId = opaqueId(value.boatId, `${path}.boatId`);
  if (!boatIds.has(boatId)) fail(`${path} references unknown boatId ${boatId}`);
  return { boatId, time: finiteNumber(value.time, `${path}.time`) };
}

function cloneRace(value, boatIds) {
  exactRecord(value, ['state', 't', 'entries', 'results'], 'race');
  if (typeof value.state !== 'string' || !RACE_STATE_SET.has(value.state)) {
    fail(`race.state must be one of ${RACE_STATES.join(', ')}`);
  }
  if (!Array.isArray(value.entries)) fail('race.entries must be an array');
  if (!Array.isArray(value.results)) fail('race.results must be an array');
  if (value.entries.length > MAX_BOATS) {
    fail(`race.entries cannot exceed ${MAX_BOATS} entries`);
  }
  if (value.results.length > MAX_RACE_RESULTS) {
    fail(`race.results cannot exceed ${MAX_RACE_RESULTS} entries`);
  }

  const entries = value.entries.map((entry, index) => cloneRaceEntry(entry, index, boatIds));
  const entryIds = new Set();
  for (const entry of entries) {
    if (entryIds.has(entry.boatId)) fail(`race.entries contains duplicate boatId ${entry.boatId}`);
    entryIds.add(entry.boatId);
  }
  if (entryIds.size !== boatIds.size) fail('race.entries must contain one entry for every boat');

  const results = value.results.map((result, index) => cloneRaceResult(result, index, boatIds));
  const resultIds = new Set();
  for (const result of results) {
    if (resultIds.has(result.boatId)) fail(`race.results contains duplicate boatId ${result.boatId}`);
    resultIds.add(result.boatId);
  }

  return {
    state: value.state,
    t: finiteNumber(value.t, 'race.t'),
    entries,
    results,
  };
}

export function cloneWorldState(value) {
  exactRecord(value, ['tick', 'worldTime', 'seed', 'hostEpoch', 'boats', 'race'], 'world state');
  if (!Array.isArray(value.boats) || value.boats.length === 0 || value.boats.length > MAX_BOATS) {
    fail('boats must be an array containing one to eight boats');
  }

  const boats = value.boats.map(cloneBoat);
  const boatIds = new Set();
  for (const boat of boats) {
    if (boatIds.has(boat.boatId)) fail(`boats contains duplicate boatId ${boat.boatId}`);
    boatIds.add(boat.boatId);
  }

  return {
    tick: nonNegativeInteger(value.tick, 'tick'),
    worldTime: boundedNumber(value.worldTime, 0, Number.MAX_VALUE, 'worldTime'),
    seed: cloneSeed(value.seed),
    hostEpoch: nonNegativeInteger(value.hostEpoch, 'hostEpoch'),
    boats,
    race: cloneRace(value.race, boatIds),
  };
}

export function decodeWorldStateJson(payload) {
  let bytes;
  let text;
  if (typeof payload === 'string') {
    if (payload.length > MAX_WORLD_STATE_BYTES) {
      fail(`world-state JSON payload cannot exceed ${MAX_WORLD_STATE_BYTES} bytes (64 KiB)`);
    }
    bytes = textEncoder.encode(payload);
    text = payload;
  } else if (payload instanceof Uint8Array) {
    bytes = payload;
  } else {
    fail('world-state JSON payload must be a string or Uint8Array');
  }
  if (bytes.byteLength > MAX_WORLD_STATE_BYTES) {
    fail(`world-state JSON payload cannot exceed ${MAX_WORLD_STATE_BYTES} bytes (64 KiB)`);
  }
  if (text === undefined) text = textDecoder.decode(bytes);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`world-state JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return cloneWorldState(parsed);
}

function sourceBoatId(boat, path) {
  if (boat === null || typeof boat !== 'object') fail(`${path} must be a boat object`);
  return opaqueId(boat.boatId, `${path}.boatId`);
}

function captureRaceEntry(race, boat, boatId) {
  if (!(race.entries instanceof Map)) fail('race.entries must be a Map while capturing');
  const entry = race.entries.get(boat) ?? race.entries.get(boatId);
  if (!entry) fail(`race.entries is missing boatId ${boatId}`);
  return {
    boatId,
    leg: entry.leg,
    ocs: entry.ocs,
    splits: entry.splits,
    finished: entry.finished,
    finishT: entry.finishT,
    prevX: entry.prevX,
    prevZ: entry.prevZ,
    roundAcc: entry.roundAcc,
    nearMark: entry.nearMark,
  };
}

function resultBoatId(result, idsByBoat) {
  if (result && typeof result.boatId === 'string') return result.boatId;
  return idsByBoat.get(result?.boat);
}

export function captureWorldState({ tick, worldTime, seed, hostEpoch, boats, race }) {
  if (!Array.isArray(boats)) fail('boats must be an array while capturing');
  if (race === null || typeof race !== 'object') fail('race must be an object while capturing');

  const idsByBoat = new Map();
  const capturedBoats = boats.map((boat, index) => {
    const boatId = sourceBoatId(boat, `boats[${index}]`);
    idsByBoat.set(boat, boatId);
    return {
      boatId,
      phys: {
        ...Object.fromEntries(PHYS_NUMBER_FIELDS.map((field) => [field, boat.phys?.[field]])),
        capsized: boat.phys?.capsized,
        ctl: {
          ...Object.fromEntries(CTL_NUMBER_FIELDS.map((field) => [field, boat.phys?.ctl?.[field]])),
          ...Object.fromEntries(CTL_BOOLEAN_FIELDS.map((field) => [field, boat.phys?.ctl?.[field]])),
        },
      },
      control: Object.fromEntries(CONTROL_FIELDS.map((field) => [field, boat[field]])),
      rules: Object.fromEntries(RULES_FIELDS.map((field) => [field, boat[field]])),
    };
  });

  const raw = {
    tick,
    worldTime,
    seed,
    hostEpoch,
    boats: capturedBoats,
    race: {
      state: race.state,
      t: race.t,
      entries: boats.map((boat) => captureRaceEntry(race, boat, idsByBoat.get(boat))),
      results: Array.isArray(race.results)
        ? race.results.map((result) => ({
          boatId: resultBoatId(result, idsByBoat),
          time: result.time,
        }))
        : race.results,
    },
  };

  return cloneWorldState(raw);
}

function ownDataValue(object, field, path) {
  const descriptor = Object.getOwnPropertyDescriptor(object, field);
  if (!descriptor) fail(`${path} requires own data property ${field}`);
  if (!Object.hasOwn(descriptor, 'value')) fail(`${path}.${field} cannot be an accessor`);
  return descriptor.value;
}

function requirePlainTarget(value, path) {
  if (!isPlainRecord(value)) fail(`${path} must be a plain object`);
  return value;
}

function requireWritableField(object, field, path) {
  const descriptor = Object.getOwnPropertyDescriptor(object, field);
  if (!descriptor) {
    if (!Object.isExtensible(object)) fail(`${path}.${field} must be writable`);
    return;
  }
  if (!Object.hasOwn(descriptor, 'value')) fail(`${path}.${field} cannot be an accessor`);
  if (!descriptor.writable) fail(`${path}.${field} must be writable`);
}

function writeDataField(object, field, value) {
  if (Object.hasOwn(object, field)) {
    object[field] = value;
    return;
  }
  Object.defineProperty(object, field, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function targetBoatMap(boats, expectedIds) {
  if (!Array.isArray(boats)) fail('target boats must be an array');
  const byId = new Map();
  for (let index = 0; index < boats.length; index += 1) {
    const path = `target boats[${index}]`;
    const boat = requirePlainTarget(boats[index], path);
    const boatId = opaqueId(ownDataValue(boat, 'boatId', path), `${path}.boatId`);
    if (byId.has(boatId)) fail(`target boats contains duplicate boatId ${boatId}`);
    const phys = requirePlainTarget(ownDataValue(boat, 'phys', path), `${path}.phys`);
    const ctl = requirePlainTarget(ownDataValue(phys, 'ctl', `${path}.phys`), `${path}.phys.ctl`);
    for (const field of [...PHYS_NUMBER_FIELDS, 'capsized']) {
      requireWritableField(phys, field, `${path}.phys`);
    }
    for (const field of [...CTL_NUMBER_FIELDS, ...CTL_BOOLEAN_FIELDS]) {
      requireWritableField(ctl, field, `${path}.phys.ctl`);
    }
    for (const field of CONTROL_FIELDS) requireWritableField(boat, field, path);
    for (const field of RULES_FIELDS) requireWritableField(boat, field, path);
    byId.set(boatId, boat);
  }
  if (byId.size !== expectedIds.size) fail('target boats must exactly match snapshot boats');
  for (const boatId of expectedIds) {
    if (!byId.has(boatId)) fail(`target boats is missing boatId ${boatId}`);
  }
  return byId;
}

export function applyWorldState(snapshot, target) {
  const state = cloneWorldState(snapshot);
  requirePlainTarget(target, 'target world');
  const boats = ownDataValue(target, 'boats', 'target world');
  const race = requirePlainTarget(ownDataValue(target, 'race', 'target world'), 'target race');
  const entries = ownDataValue(race, 'entries', 'target race');
  if (!(entries instanceof Map) || Object.getPrototypeOf(entries) !== Map.prototype) {
    fail('target race.entries must be a native Map');
  }
  try {
    Map.prototype.has.call(entries, entries);
  } catch {
    fail('target race.entries must be a native Map');
  }
  for (const field of ['tick', 'worldTime', 'seed', 'hostEpoch']) {
    requireWritableField(target, field, 'target world');
  }
  for (const field of ['state', 't', 'results']) {
    requireWritableField(race, field, 'target race');
  }

  const expectedIds = new Set(state.boats.map((boat) => boat.boatId));
  const boatsById = targetBoatMap(boats, expectedIds);
  const nextEntries = state.race.entries.map((entry) => ({
    boat: boatsById.get(entry.boatId),
    value: {
      leg: entry.leg,
      ocs: entry.ocs,
      splits: [...entry.splits],
      finished: entry.finished,
      finishT: entry.finishT,
      prevX: entry.prevX,
      prevZ: entry.prevZ,
      roundAcc: entry.roundAcc,
      nearMark: entry.nearMark,
    },
  }));
  const nextResults = state.race.results.map((result) => ({
    boat: boatsById.get(result.boatId),
    time: result.time,
  }));

  for (const boatState of state.boats) {
    const boat = boatsById.get(boatState.boatId);
    const phys = ownDataValue(boat, 'phys', `target boat ${boatState.boatId}`);
    const ctl = ownDataValue(phys, 'ctl', `target boat ${boatState.boatId}.phys`);
    for (const field of PHYS_NUMBER_FIELDS) writeDataField(phys, field, boatState.phys[field]);
    writeDataField(phys, 'capsized', boatState.phys.capsized);
    for (const field of CTL_NUMBER_FIELDS) {
      writeDataField(ctl, field, boatState.phys.ctl[field]);
    }
    for (const field of CTL_BOOLEAN_FIELDS) {
      writeDataField(ctl, field, boatState.phys.ctl[field]);
    }
    for (const field of CONTROL_FIELDS) writeDataField(boat, field, boatState.control[field]);
    for (const field of RULES_FIELDS) writeDataField(boat, field, boatState.rules[field]);
  }

  writeDataField(race, 'state', state.race.state);
  writeDataField(race, 't', state.race.t);
  Map.prototype.clear.call(entries);
  for (const { boat, value } of nextEntries) Map.prototype.set.call(entries, boat, value);
  writeDataField(race, 'results', nextResults);
  writeDataField(target, 'tick', state.tick);
  writeDataField(target, 'worldTime', state.worldTime);
  writeDataField(target, 'seed', state.seed);
  writeDataField(target, 'hostEpoch', state.hostEpoch);

  return state;
}
