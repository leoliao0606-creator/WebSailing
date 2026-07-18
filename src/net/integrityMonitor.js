import {
  cloneWorldState,
  MAX_BOATS,
  MAX_RACE_RESULTS,
  MAX_RACE_SPLITS,
  RACE_STATES,
} from './worldState.js';

const RACE_STATE_INDEX = new Map(RACE_STATES.map((state, index) => [state, index]));

function finiteOption(value, path, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${path} must be a finite number no smaller than ${minimum}`);
  }
  return value;
}

function addReason(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

function outside(value, minimum, maximum) {
  return typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum;
}

function outcome(status, reasons = [], snapshot = null) {
  return Object.freeze({
    status,
    invalidated: status === 'invalidated',
    ignored: status === 'ignored',
    reasons: Object.freeze([...new Set(reasons)]),
    snapshot,
  });
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function sameSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function preservesPrefix(previous, next) {
  return previous.length <= next.length
    && previous.every((value, index) => Object.is(value, next[index]));
}

export class IntegrityMonitor {
  #baseline = null;

  #maxSpeed;

  #maxDisplacementPerSecond;

  #positionTolerance;

  #maxCoordinate;

  #maxRaceTime;

  #minRaceTime;

  #maxWorldTime;

  #maxAngularRate;

  #maxCrewOffset;

  #tickRate;

  #maxTickTimeDrift;

  constructor({
    maxSpeed = 25,
    maxDisplacementPerSecond = 30,
    positionTolerance = 1,
    maxCoordinate = 100_000,
    maxRaceTime = 21_600,
    minRaceTime = -300,
    maxWorldTime = 86_400,
    maxAngularRate = Math.PI * 4,
    maxCrewOffset = 2,
    tickRate = 60,
    maxTickTimeDrift = 0.05,
  } = {}) {
    this.#maxSpeed = finiteOption(maxSpeed, 'maxSpeed');
    this.#maxDisplacementPerSecond = finiteOption(
      maxDisplacementPerSecond,
      'maxDisplacementPerSecond',
    );
    this.#positionTolerance = finiteOption(positionTolerance, 'positionTolerance');
    this.#maxCoordinate = finiteOption(maxCoordinate, 'maxCoordinate');
    this.#maxRaceTime = finiteOption(maxRaceTime, 'maxRaceTime');
    if (typeof minRaceTime !== 'number' || !Number.isFinite(minRaceTime) || minRaceTime > 0) {
      throw new TypeError('minRaceTime must be a finite number no greater than zero');
    }
    this.#minRaceTime = minRaceTime;
    this.#maxWorldTime = finiteOption(maxWorldTime, 'maxWorldTime');
    this.#maxAngularRate = finiteOption(maxAngularRate, 'maxAngularRate');
    this.#maxCrewOffset = finiteOption(maxCrewOffset, 'maxCrewOffset');
    this.#tickRate = finiteOption(tickRate, 'tickRate', Number.MIN_VALUE);
    this.#maxTickTimeDrift = finiteOption(maxTickTimeDrift, 'maxTickTimeDrift');
  }

  reset() {
    this.#baseline = null;
  }

  inspect(candidate, authorization) {
    try {
      const classification = this.#classifyEnvelope(candidate, authorization);
      if (classification) return classification;

      const rangeReasons = this.#rangeReasons(candidate);
      if (rangeReasons.length > 0) return outcome('invalidated', rangeReasons);

      let snapshot;
      try {
        snapshot = cloneWorldState(candidate);
      } catch (error) {
        return outcome('invalidated', [`schema: ${errorText(error)}`]);
      }

      const stateReasons = this.#stateReasons(snapshot);
      if (stateReasons.length > 0) return outcome('invalidated', stateReasons);

      const continuityReasons = this.#continuityReasons(snapshot);
      if (continuityReasons.length > 0) return outcome('invalidated', continuityReasons);

      this.#baseline = snapshot;
      return outcome('accepted', [], cloneWorldState(snapshot));
    } catch (error) {
      return outcome('invalidated', [`schema: ${errorText(error)}`]);
    }
  }

  #classifyEnvelope(candidate, authorization) {
    const expectedEpoch = authorization?.expectedEpoch;
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) {
      return outcome('invalidated', ['expectedEpoch authorization is required']);
    }
    if (candidate === null || typeof candidate !== 'object') {
      return outcome('invalidated', ['world state envelope must be an object']);
    }

    const { hostEpoch, tick, worldTime } = candidate;
    if (!Number.isSafeInteger(hostEpoch) || hostEpoch < 0) {
      return outcome('invalidated', ['hostEpoch must be a non-negative safe integer']);
    }
    if (!Number.isSafeInteger(tick) || tick < 0) {
      return outcome('invalidated', ['tick must be a non-negative safe integer']);
    }
    if (typeof worldTime !== 'number' || !Number.isFinite(worldTime) || worldTime < 0) {
      return outcome('invalidated', ['worldTime must be a non-negative finite number']);
    }

    if (hostEpoch < expectedEpoch) {
      return outcome('ignored', [`stale hostEpoch ${hostEpoch}; expected ${expectedEpoch}`]);
    }
    if (hostEpoch > expectedEpoch) {
      return outcome('invalidated', [`hostEpoch ${hostEpoch} was not authorized by expectedEpoch ${expectedEpoch}`]);
    }
    if (this.#baseline === null) return null;

    if (hostEpoch < this.#baseline.hostEpoch) {
      return outcome('ignored', [`stale hostEpoch ${hostEpoch}`]);
    }
    if (hostEpoch > this.#baseline.hostEpoch + 1) {
      return outcome('invalidated', [
        `hostEpoch jump from ${this.#baseline.hostEpoch} to ${hostEpoch} is not allowed`,
      ]);
    }
    if (hostEpoch === this.#baseline.hostEpoch
      && (tick <= this.#baseline.tick || worldTime <= this.#baseline.worldTime)) {
      return outcome('ignored', ['duplicate or out-of-order tick/worldTime']);
    }
    return null;
  }

  #rangeReasons(candidate) {
    const reasons = [];
    addReason(
      reasons,
      outside(candidate.worldTime, 0, this.#maxWorldTime),
      `worldTime must be finite and between 0 and ${this.#maxWorldTime}`,
    );

    if (Array.isArray(candidate.boats)) {
      candidate.boats.slice(0, MAX_BOATS + 1).forEach((boat, index) => {
        const phys = boat?.phys;
        if (phys === null || typeof phys !== 'object') return;
        const prefix = `boats[${index}]`;
        addReason(
          reasons,
          outside(phys.x, -this.#maxCoordinate, this.#maxCoordinate)
            || outside(phys.z, -this.#maxCoordinate, this.#maxCoordinate),
          `${prefix} coordinate exceeds ${this.#maxCoordinate}`,
        );

        const speed = Math.hypot(phys.u, phys.v);
        addReason(
          reasons,
          !Number.isFinite(speed) || speed > this.#maxSpeed,
          `${prefix} speed exceeds ${this.#maxSpeed}`,
        );
        addReason(
          reasons,
          outside(phys.yawRate, -this.#maxAngularRate, this.#maxAngularRate),
          `${prefix}.phys.yawRate exceeds angular-rate range`,
        );
        addReason(
          reasons,
          outside(phys.phiRate, -this.#maxAngularRate, this.#maxAngularRate),
          `${prefix}.phys.phiRate exceeds angular-rate range`,
        );
        for (const angleField of ['psi', 'phi', 'boom', 'rudder']) {
          addReason(
            reasons,
            outside(phys[angleField], -Math.PI, Math.PI),
            `${prefix}.phys.${angleField} must be finite and within plus or minus pi`,
          );
        }
        for (const unitField of ['sheet', 'board', 'rightProgress']) {
          addReason(
            reasons,
            outside(phys[unitField], 0, 1),
            `${prefix}.phys.${unitField} must be between 0 and 1`,
          );
        }
        addReason(
          reasons,
          outside(phys.crewY, -this.#maxCrewOffset, this.#maxCrewOffset),
          `${prefix}.phys.crewY exceeds crew range`,
        );

        const ctl = phys.ctl;
        if (ctl && typeof ctl === 'object') {
          for (const signedField of ['rudder', 'hike']) {
            addReason(
              reasons,
              outside(ctl[signedField], -1, 1),
              `${prefix}.phys.ctl.${signedField} must be between -1 and 1`,
            );
          }
          for (const unitField of ['sheet', 'board']) {
            addReason(
              reasons,
              outside(ctl[unitField], 0, 1),
              `${prefix}.phys.ctl.${unitField} must be between 0 and 1`,
            );
          }
        }

        const control = boat?.control;
        if (control && typeof control === 'object') {
          for (const field of ['rudderCmd', 'hikeLevel']) {
            addReason(
              reasons,
              outside(control[field], -1, 1),
              `${prefix}.control.${field} must be between -1 and 1`,
            );
          }
          addReason(
            reasons,
            typeof control.manualSheetAt !== 'number' || !Number.isFinite(control.manualSheetAt),
            `${prefix}.control.manualSheetAt must be finite`,
          );
        }
      });
    }

    const race = candidate.race;
    if (race && typeof race === 'object') {
      addReason(
        reasons,
        outside(race.t, this.#minRaceTime, this.#maxRaceTime),
        `race.t must be finite and between ${this.#minRaceTime} and ${this.#maxRaceTime}`,
      );
      if (Array.isArray(race.entries)) {
        race.entries.slice(0, MAX_BOATS + 1).forEach((entry, index) => {
          if (!entry || typeof entry !== 'object') return;
          const times = [
            entry.finishT,
            ...(Array.isArray(entry.splits)
              ? entry.splits.slice(0, MAX_RACE_SPLITS + 1)
              : []),
          ];
          addReason(
            reasons,
            times.some((time) => outside(time, 0, this.#maxRaceTime)),
            `race.entries[${index}] contains race time outside 0 to ${this.#maxRaceTime}`,
          );
        });
      }
      if (Array.isArray(race.results)) {
        race.results.slice(0, MAX_RACE_RESULTS + 1).forEach((result, index) => {
          if (!result || typeof result !== 'object') return;
          addReason(
            reasons,
            outside(result.time, 0, this.#maxRaceTime),
            `race.results[${index}].time must be between 0 and ${this.#maxRaceTime}`,
          );
        });
      }
    }
    return reasons;
  }

  #stateReasons(snapshot) {
    const reasons = [];
    const entries = new Map(snapshot.race.entries.map((entry) => [entry.boatId, entry]));
    const results = new Map(snapshot.race.results.map((result) => [result.boatId, result]));

    for (const entry of snapshot.race.entries) {
      for (let index = 1; index < entry.splits.length; index += 1) {
        addReason(
          reasons,
          entry.splits[index] <= entry.splits[index - 1],
          `boat ${entry.boatId} splits must preserve chronological order`,
        );
      }
      const result = results.get(entry.boatId);
      addReason(
        reasons,
        entry.finished && !result,
        `finished boat ${entry.boatId} requires a race result`,
      );
      addReason(
        reasons,
        !entry.finished && !!result,
        `race result for ${entry.boatId} requires a finished entry`,
      );
      addReason(
        reasons,
        !!result && !Object.is(result.time, entry.finishT),
        `race result for ${entry.boatId} must equal finishT`,
      );
      addReason(
        reasons,
        !entry.finished && entry.finishT !== 0,
        `unfinished boat ${entry.boatId} must have finishT 0`,
      );
    }

    for (const result of snapshot.race.results) {
      addReason(
        reasons,
        !entries.has(result.boatId),
        `race result references missing entry ${result.boatId}`,
      );
    }
    const allFinished = snapshot.race.entries.every((entry) => entry.finished);
    addReason(
      reasons,
      snapshot.race.state === 'finished' && !allFinished,
      'race.state finished requires every entry to be finished',
    );
    addReason(
      reasons,
      snapshot.race.state !== 'finished' && allFinished,
      'all finished entries require race.state finished',
    );
    return reasons;
  }

  #continuityReasons(snapshot) {
    if (this.#baseline === null || snapshot.hostEpoch > this.#baseline.hostEpoch) return [];
    const previous = this.#baseline;
    const reasons = [];
    const tickDelta = snapshot.tick - previous.tick;
    const worldTimeDelta = snapshot.worldTime - previous.worldTime;
    const expectedTimeDelta = tickDelta / this.#tickRate;
    addReason(
      reasons,
      Math.abs(expectedTimeDelta - worldTimeDelta) > this.#maxTickTimeDrift,
      `tickDelta ${tickDelta} is inconsistent with worldTimeDelta ${worldTimeDelta}`,
    );
    addReason(
      reasons,
      snapshot.race.t < previous.race.t,
      `race.t ${snapshot.race.t} is lower than ${previous.race.t}`,
    );
    addReason(reasons, !Object.is(snapshot.seed, previous.seed), 'seed changed within hostEpoch');

    const previousIds = new Set(previous.boats.map((boat) => boat.boatId));
    const currentIds = new Set(snapshot.boats.map((boat) => boat.boatId));
    addReason(
      reasons,
      !sameSet(previousIds, currentIds),
      'boatId roster changed within hostEpoch',
    );

    const previousStateIndex = RACE_STATE_INDEX.get(previous.race.state);
    const currentStateIndex = RACE_STATE_INDEX.get(snapshot.race.state);
    const stateDelta = currentStateIndex - previousStateIndex;
    addReason(
      reasons,
      stateDelta < 0 || stateDelta > 1,
      `race.state transition ${previous.race.state} -> ${snapshot.race.state} is not allowed`,
    );

    const previousBoats = new Map(previous.boats.map((boat) => [boat.boatId, boat]));
    for (const boat of snapshot.boats) {
      const oldBoat = previousBoats.get(boat.boatId);
      if (!oldBoat) continue;
      const displacement = Math.hypot(
        boat.phys.x - oldBoat.phys.x,
        boat.phys.z - oldBoat.phys.z,
      );
      const allowance = this.#positionTolerance
        + this.#maxDisplacementPerSecond * worldTimeDelta;
      addReason(
        reasons,
        displacement > allowance,
        `boat ${boat.boatId} displacement ${displacement} exceeds ${allowance}`,
      );
    }

    const previousEntries = new Map(previous.race.entries.map((entry) => [entry.boatId, entry]));
    for (const entry of snapshot.race.entries) {
      const oldEntry = previousEntries.get(entry.boatId);
      if (!oldEntry) continue;
      const legDelta = entry.leg - oldEntry.leg;
      addReason(
        reasons,
        legDelta < 0 || legDelta > 1,
        `boat ${entry.boatId} leg changed from ${oldEntry.leg} to ${entry.leg}`,
      );
      addReason(
        reasons,
        oldEntry.finished && !entry.finished,
        `boat ${entry.boatId} finished state cannot roll back`,
      );
      addReason(
        reasons,
        !preservesPrefix(oldEntry.splits, entry.splits),
        `boat ${entry.boatId} splits must preserve the previous prefix`,
      );
      addReason(
        reasons,
        oldEntry.finished && !Object.is(oldEntry.finishT, entry.finishT),
        `boat ${entry.boatId} finishT cannot change after finishing`,
      );
    }
    return reasons;
  }
}
