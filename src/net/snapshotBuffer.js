import { cloneWorldState } from './worldState.js';

const PHYS_LINEAR_FIELDS = Object.freeze([
  'x',
  'z',
  'u',
  'v',
  'yawRate',
  'phiRate',
  'sheet',
  'board',
  'crewY',
  'rightProgress',
]);
const PHYS_ANGLE_FIELDS = Object.freeze(['psi', 'phi', 'boom', 'rudder']);
const CTL_LINEAR_FIELDS = Object.freeze(['rudder', 'sheet', 'board', 'hike']);
const CTL_BOOLEAN_FIELDS = Object.freeze(['autoHike', 'righting', 'autoTrim']);
const CONTROL_LINEAR_FIELDS = Object.freeze(['rudderCmd', 'hikeLevel']);

function finiteOption(value, path, minimum, maximum = Number.POSITIVE_INFINITY) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function lerp(left, right, alpha) {
  return left + (right - left) * alpha;
}

export function wrapPi(angle) {
  let wrapped = (angle + Math.PI) % (Math.PI * 2);
  if (wrapped < 0) wrapped += Math.PI * 2;
  return wrapped - Math.PI;
}

function lerpAngle(left, right, alpha) {
  return wrapPi(left + wrapPi(right - left) * alpha);
}

function sameBoatIds(left, right) {
  if (left.boats.length !== right.boats.length) return false;
  const rightIds = new Set(right.boats.map((boat) => boat.boatId));
  return left.boats.every((boat) => rightIds.has(boat.boatId));
}

function interpolateBoat(left, right, alpha) {
  const selected = alpha < 0.5 ? left : right;
  const output = {
    boatId: selected.boatId,
    phys: { ...selected.phys, ctl: { ...selected.phys.ctl } },
    control: { ...selected.control },
  };

  for (const field of PHYS_LINEAR_FIELDS) {
    output.phys[field] = lerp(left.phys[field], right.phys[field], alpha);
  }
  for (const field of PHYS_ANGLE_FIELDS) {
    output.phys[field] = lerpAngle(left.phys[field], right.phys[field], alpha);
  }
  output.phys.capsized = alpha < 0.5 ? left.phys.capsized : right.phys.capsized;
  for (const field of CTL_LINEAR_FIELDS) {
    output.phys.ctl[field] = lerp(left.phys.ctl[field], right.phys.ctl[field], alpha);
  }
  for (const field of CTL_BOOLEAN_FIELDS) {
    output.phys.ctl[field] = alpha < 0.5 ? left.phys.ctl[field] : right.phys.ctl[field];
  }
  for (const field of CONTROL_LINEAR_FIELDS) {
    output.control[field] = lerp(left.control[field], right.control[field], alpha);
  }
  output.control.manualSheetAt = right.control.manualSheetAt;
  return output;
}

function renderOnly(state) {
  return Object.freeze({ renderOnly: true, state });
}

function interpolateSnapshots(left, right, targetTime) {
  const duration = right.worldTime - left.worldTime;
  if (!(duration > 0) || left.hostEpoch !== right.hostEpoch || !sameBoatIds(left, right)) {
    return cloneWorldState(targetTime - left.worldTime < right.worldTime - targetTime ? left : right);
  }

  const alpha = Math.max(0, Math.min(1, (targetTime - left.worldTime) / duration));
  const chosen = alpha < 0.5 ? left : right;
  const output = cloneWorldState(chosen);
  const rightBoats = new Map(right.boats.map((boat) => [boat.boatId, boat]));
  output.tick = chosen.tick;
  output.worldTime = targetTime;
  output.boats = left.boats.map((boat) => interpolateBoat(boat, rightBoats.get(boat.boatId), alpha));
  output.race.t = lerp(left.race.t, right.race.t, alpha);

  const leftEntries = new Map(left.race.entries.map((entry) => [entry.boatId, entry]));
  const rightEntries = new Map(right.race.entries.map((entry) => [entry.boatId, entry]));
  for (const entry of output.race.entries) {
    const leftEntry = leftEntries.get(entry.boatId);
    const rightEntry = rightEntries.get(entry.boatId);
    if (!leftEntry || !rightEntry) continue;
    entry.prevX = lerp(leftEntry.prevX, rightEntry.prevX, alpha);
    entry.prevZ = lerp(leftEntry.prevZ, rightEntry.prevZ, alpha);
  }
  return cloneWorldState(output);
}

function extrapolateSnapshot(snapshot, targetTime, maxSeconds, maxSpeed, maxAngularSpeed) {
  const output = cloneWorldState(snapshot);
  const elapsed = Math.max(0, Math.min(maxSeconds, targetTime - snapshot.worldTime));
  if (elapsed === 0) return output;

  for (const boat of output.boats) {
    const phys = boat.phys;
    const speed = Math.hypot(phys.u, phys.v);
    const scale = speed > maxSpeed && speed > 0 ? maxSpeed / speed : 1;
    const sinHeading = Math.sin(phys.psi);
    const cosHeading = Math.cos(phys.psi);
    const velocityX = (phys.u * sinHeading + phys.v * cosHeading) * scale;
    const velocityZ = (-phys.u * cosHeading + phys.v * sinHeading) * scale;
    phys.x += velocityX * elapsed;
    phys.z += velocityZ * elapsed;
    const yawRate = Math.max(-maxAngularSpeed, Math.min(maxAngularSpeed, phys.yawRate));
    const phiRate = Math.max(-maxAngularSpeed, Math.min(maxAngularSpeed, phys.phiRate));
    phys.psi = wrapPi(phys.psi + yawRate * elapsed);
    phys.phi = wrapPi(phys.phi + phiRate * elapsed);
  }
  output.worldTime = snapshot.worldTime + elapsed;
  if (output.race.state !== 'finished') output.race.t += elapsed;
  return cloneWorldState(output);
}

export class SnapshotBuffer {
  #capacity;

  #interpolationDelayMs;

  #maxExtrapolationMs;

  #maxExtrapolationSpeed;

  #maxAngularSpeed;

  #snapshots = [];

  constructor({
    capacity = 32,
    interpolationDelayMs = 125,
    maxExtrapolationMs = 100,
    maxExtrapolationSpeed = 20,
    maxAngularSpeed = Math.PI * 2,
  } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new TypeError('capacity must be a positive safe integer');
    }
    this.#capacity = capacity;
    this.#interpolationDelayMs = finiteOption(
      interpolationDelayMs,
      'interpolationDelayMs',
      100,
      150,
    );
    this.#maxExtrapolationMs = finiteOption(maxExtrapolationMs, 'maxExtrapolationMs', 0, 250);
    this.#maxExtrapolationSpeed = finiteOption(
      maxExtrapolationSpeed,
      'maxExtrapolationSpeed',
      0,
    );
    this.#maxAngularSpeed = finiteOption(maxAngularSpeed, 'maxAngularSpeed', 0);
  }

  get size() {
    return this.#snapshots.length;
  }

  get capacity() {
    return this.#capacity;
  }

  get interpolationDelayMs() {
    return this.#interpolationDelayMs;
  }

  clear() {
    this.#snapshots = [];
  }

  add(snapshot) {
    const copy = cloneWorldState(snapshot);
    const newestEpoch = this.#snapshots.reduce(
      (epoch, item) => Math.max(epoch, item.hostEpoch),
      Number.NEGATIVE_INFINITY,
    );
    if (copy.hostEpoch < newestEpoch) return false;
    if (copy.hostEpoch > newestEpoch) this.#snapshots = [];

    const duplicateIndex = this.#snapshots.findIndex((item) => (
      item.hostEpoch === copy.hostEpoch && item.tick === copy.tick
    ));
    if (duplicateIndex >= 0) this.#snapshots.splice(duplicateIndex, 1);
    this.#snapshots.push(copy);
    this.#snapshots.sort((left, right) => (
      left.worldTime - right.worldTime || left.tick - right.tick
    ));
    if (this.#snapshots.length > this.#capacity) {
      this.#snapshots.splice(0, this.#snapshots.length - this.#capacity);
    }
    return true;
  }

  getSnapshots() {
    return this.#snapshots.map((snapshot) => cloneWorldState(snapshot));
  }

  sample(renderWorldTime) {
    finiteOption(renderWorldTime, 'renderWorldTime', 0);
    if (this.#snapshots.length === 0) return null;

    const targetTime = renderWorldTime - this.#interpolationDelayMs / 1_000;
    const first = this.#snapshots[0];
    const newest = this.#snapshots[this.#snapshots.length - 1];
    if (targetTime <= first.worldTime) return renderOnly(cloneWorldState(first));
    if (targetTime >= newest.worldTime) {
      return renderOnly(extrapolateSnapshot(
        newest,
        targetTime,
        this.#maxExtrapolationMs / 1_000,
        this.#maxExtrapolationSpeed,
        this.#maxAngularSpeed,
      ));
    }

    for (let index = 1; index < this.#snapshots.length; index += 1) {
      const right = this.#snapshots[index];
      if (targetTime > right.worldTime) continue;
      return renderOnly(interpolateSnapshots(this.#snapshots[index - 1], right, targetTime));
    }
    return renderOnly(cloneWorldState(newest));
  }
}
