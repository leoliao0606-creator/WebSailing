import assert from 'node:assert/strict';
import test from 'node:test';

import { MultiplayerSession } from '../src/net/multiplayerSession.js';
import { PeerTransport } from '../src/net/peerTransport.js';

function flushTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeSignaling extends EventTarget {
  constructor(state) {
    super();
    this.state = state;
    this.sent = [];
  }

  sendSignal(targetId, data) {
    this.sent.push({ targetId, data: structuredClone(data) });
    return true;
  }

  emitSignal(sourceId, data) {
    this.dispatchEvent(new CustomEvent('signal', {
      detail: { sourceId, data: structuredClone(data) },
    }));
  }
}

class FakeDataChannel extends EventTarget {
  constructor(label, options = {}) {
    super();
    this.label = label;
    this.ordered = options.ordered ?? true;
    this.maxRetransmits = options.maxRetransmits ?? null;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.sent = [];
    this.closeCalls = 0;
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('data channel is not open');
    this.sent.push(data);
  }

  open() {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  receive(data) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  close() {
    this.closeCalls += 1;
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class FakePeerConnection {
  static instances = [];

  static reset() {
    this.instances = [];
  }

  constructor(configuration) {
    this.id = FakePeerConnection.instances.length + 1;
    this.configuration = structuredClone(configuration ?? {});
    this.channels = [];
    this.localDescriptions = [];
    this.remoteDescriptions = [];
    this.addedIce = [];
    this.closeCalls = 0;
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.ondatachannel = null;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label, options) {
    const channel = new FakeDataChannel(label, options);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    return { type: 'offer', sdp: `offer-${this.id}` };
  }

  async createAnswer() {
    return { type: 'answer', sdp: `answer-${this.id}` };
  }

  async setLocalDescription(description) {
    this.localDescription = structuredClone(description);
    this.localDescriptions.push(structuredClone(description));
  }

  async setRemoteDescription(description) {
    this.remoteDescription = structuredClone(description);
    this.remoteDescriptions.push(structuredClone(description));
  }

  async addIceCandidate(candidate) {
    this.addedIce.push(structuredClone(candidate));
  }

  emitIce(candidate) {
    this.onicecandidate?.({ candidate });
  }

  emitDataChannel(channel) {
    this.ondatachannel?.({ channel });
  }

  close() {
    this.closeCalls += 1;
    this.connectionState = 'closed';
  }
}

class ControlledTimers {
  constructor() {
    this.tasks = [];
    this.scheduledDelays = [];
    this.nextId = 1;
  }

  setTimeout(callback, delay) {
    const task = {
      id: this.nextId,
      callback,
      delay,
      canceled: false,
    };
    this.nextId += 1;
    this.tasks.push(task);
    this.scheduledDelays.push(delay);
    return task;
  }

  clearTimeout(task) {
    if (task) task.canceled = true;
  }

  get pendingCount() {
    return this.tasks.filter((task) => !task.canceled).length;
  }

  runNext() {
    while (this.tasks.length > 0) {
      const task = this.tasks.shift();
      if (task.canceled) continue;
      task.canceled = true;
      task.callback();
      return true;
    }
    return false;
  }
}

function member(playerId, connected = true) {
  return { playerId, nickname: playerId, connected, ready: false, isHost: false };
}

function room({
  roomCode = 'AB2CD9',
  hostId = 'host',
  hostEpoch = 1,
  phase = 'lobby',
  members = [member('host'), member('guest')],
} = {}) {
  return { roomCode, hostId, hostEpoch, phase, members };
}

function channel(peerConnection, label) {
  return peerConnection.channels.find((item) => item.label === label);
}

function eventDetails(target, type) {
  const details = [];
  target.addEventListener(type, (event) => details.push(event.detail));
  return details;
}

function emitDetail(target, type, detail) {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

test.beforeEach(() => {
  FakePeerConnection.reset();
});

test('host creates one configured peer connection and the two required channels per connected guest', async () => {
  const iceServers = [{ urls: 'turn:turn.example.test', username: 'u', credential: 'p' }];
  const signaling = new FakeSignaling({ selfId: 'host', iceServers });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  const topologies = eventDetails(transport, 'topology');

  assert.equal(transport.reconcileTopology(room({
    members: [member('host'), member('guest-a'), member('guest-b', false)],
  })), true);
  transport.reconcileTopology(room({
    members: [member('host'), member('guest-a'), member('guest-b', false)],
  }));
  await flushTasks();

  assert.equal(FakePeerConnection.instances.length, 1);
  const peer = FakePeerConnection.instances[0];
  assert.deepEqual(peer.configuration, { iceServers });
  assert.equal(channel(peer, 'control').ordered, true);
  assert.equal(channel(peer, 'control').maxRetransmits, null);
  assert.equal(channel(peer, 'state').ordered, false);
  assert.equal(channel(peer, 'state').maxRetransmits, 0);
  assert.deepEqual(signaling.sent, [{
    targetId: 'guest-a',
    data: { type: 'offer', sdp: 'offer-1', negotiationId: 'n1-1' },
  }]);
  assert.equal(topologies.at(-1).isHost, true);
  assert.deepEqual(topologies.at(-1).peerIds, ['guest-a']);
  transport.close();
});

test('guest creates no offer and answers only an offer from the current host', async () => {
  const signaling = new FakeSignaling({ playerId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());

  assert.equal(FakePeerConnection.instances.length, 1);
  const peer = FakePeerConnection.instances[0];
  assert.equal(peer.channels.length, 0);
  assert.deepEqual(signaling.sent, []);

  signaling.emitSignal('intruder', { type: 'offer', sdp: 'wrong-offer' });
  signaling.emitSignal('host', {
    type: 'offer', sdp: 'host-offer', negotiationId: 'negotiation-1',
  });
  await flushTasks();

  assert.deepEqual(peer.remoteDescriptions, [{ type: 'offer', sdp: 'host-offer' }]);
  assert.deepEqual(peer.localDescriptions, [{ type: 'answer', sdp: 'answer-1' }]);
  assert.deepEqual(signaling.sent, [{
    targetId: 'host',
    data: { type: 'answer', sdp: 'answer-1', negotiationId: 'negotiation-1' },
  }]);
  transport.close();
});

test('host accepts an answer and buffers remote ICE until the remote description exists', async () => {
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  await flushTasks();
  const peer = FakePeerConnection.instances[0];
  const negotiationId = signaling.sent[0].data.negotiationId;

  signaling.emitSignal('guest', {
    type: 'ice',
    candidate: 'candidate:remote',
    sdpMid: '0',
    sdpMLineIndex: 0,
    negotiationId,
  });
  await flushTasks();
  assert.deepEqual(peer.addedIce, []);

  signaling.emitSignal('guest', { type: 'answer', sdp: 'guest-answer', negotiationId });
  await flushTasks();

  assert.deepEqual(peer.remoteDescriptions, [{ type: 'answer', sdp: 'guest-answer' }]);
  assert.deepEqual(peer.addedIce, [{
    candidate: 'candidate:remote',
    sdpMid: '0',
    sdpMLineIndex: 0,
  }]);
  transport.close();
});

test('guest buffers ICE received before the offer and relays local ICE through signaling', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];

  signaling.emitSignal('host', {
    type: 'ice',
    candidate: 'candidate:early',
    usernameFragment: 'ufrag',
    negotiationId: 'negotiation-1',
  });
  signaling.emitSignal('host', {
    type: 'offer', sdp: 'host-offer', negotiationId: 'negotiation-1',
  });
  await flushTasks();

  assert.deepEqual(peer.addedIce, [{ candidate: 'candidate:early', usernameFragment: 'ufrag' }]);
  peer.emitIce({
    candidate: 'candidate:local',
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: 'local-fragment',
  });
  peer.emitIce(null);
  await flushTasks();

  assert.deepEqual(signaling.sent.slice(-2), [
    {
      targetId: 'host',
      data: {
        type: 'ice',
        candidate: 'candidate:local',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'local-fragment',
        negotiationId: 'negotiation-1',
      },
    },
    {
      targetId: 'host',
      data: { type: 'ice', candidate: null, negotiationId: 'negotiation-1' },
    },
  ]);
  transport.close();
});

test('reliable messages queue FIFO with a bounded drop-oldest policy while state messages drop', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    maxReliableQueue: 2,
  });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const control = new FakeDataChannel('control');
  const state = new FakeDataChannel('state', { ordered: false, maxRetransmits: 0 });
  peer.emitDataChannel(control);
  peer.emitDataChannel(state);
  const first = { order: 1 };

  assert.equal(transport.sendToHost(first, { reliable: true }), true);
  first.order = 99;
  assert.equal(transport.sendToHost({ order: 2 }, { reliable: true }), true);
  assert.equal(transport.sendToHost({ order: 3 }, { reliable: true }), false);
  assert.equal(transport.sendToHost({ transient: true }), false);
  control.open();
  state.open();
  assert.equal(transport.sendToHost({ transient: true }), true);

  assert.deepEqual(control.sent.map(JSON.parse), [{ order: 2 }, { order: 3 }]);
  assert.deepEqual(state.sent.map(JSON.parse), [{ transient: true }]);
  transport.close();
  await flushTasks();
});

test('reliable broadcast preflight checks serialization, every target, and queue capacity without sending', () => {
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    maxReliableQueue: 1,
  });
  transport.reconcileTopology(room({
    members: [member('host'), member('guest-a'), member('guest-b')],
  }));
  const [peerA] = FakePeerConnection.instances;
  const controlA = channel(peerA, 'control');
  controlA.open();
  const targets = ['guest-a', 'guest-b'];

  assert.equal(transport.canBroadcastReliable({ race: 'ready' }, { playerIds: targets }), true);
  assert.equal(transport.canBroadcastReliable({ race: 'ready' }, { playerIds: targets }), true);
  assert.deepEqual(controlA.sent, []);

  assert.equal(transport.sendToPeer('guest-b', { queued: true }, { reliable: true }), true);
  assert.equal(transport.canBroadcastReliable({ race: 'ready' }, { playerIds: targets }), false);
  assert.equal(
    transport.canBroadcastReliable([{ checkpoint: true }, { ready: true }], {
      playerIds: ['guest-a'],
    }),
    true,
  );
  assert.equal(
    transport.canBroadcastReliable([{ checkpoint: true }, { ready: true }], {
      playerIds: ['guest-b'],
    }),
    false,
  );
  assert.equal(
    transport.canBroadcastReliable({ race: 'ready' }, { playerIds: ['missing'] }),
    false,
  );
  const circular = {};
  circular.self = circular;
  assert.equal(transport.canBroadcastReliable(circular, { playerIds: targets }), false);
  assert.deepEqual(controlA.sent, []);
  transport.close();
});

test('role guards allow only guests to send to host and only hosts to send or broadcast to guests', () => {
  const guestSignaling = new FakeSignaling({ selfId: 'guest' });
  const guestTransport = new PeerTransport({
    signaling: guestSignaling,
    RTCPeerConnectionImpl: FakePeerConnection,
  });
  guestTransport.reconcileTopology(room());
  const guestPeer = FakePeerConnection.instances[0];
  const guestState = new FakeDataChannel('state', { ordered: false, maxRetransmits: 0 });
  guestPeer.emitDataChannel(guestState);
  guestState.open();

  assert.equal(guestTransport.sendToHost({ from: 'guest' }), true);
  assert.equal(guestTransport.sendToPeer('host', { forbidden: true }), false);
  assert.equal(guestTransport.broadcast({ forbidden: true }), false);
  guestTransport.close();

  FakePeerConnection.reset();
  const hostSignaling = new FakeSignaling({ selfId: 'host' });
  const hostTransport = new PeerTransport({
    signaling: hostSignaling,
    RTCPeerConnectionImpl: FakePeerConnection,
  });
  hostTransport.reconcileTopology(room({
    members: [member('host'), member('guest-a'), member('guest-b')],
  }));
  for (const peer of FakePeerConnection.instances) channel(peer, 'state').open();

  assert.equal(hostTransport.sendToHost({ forbidden: true }), false);
  assert.equal(hostTransport.sendToPeer('guest-a', { direct: true }), true);
  assert.equal(hostTransport.broadcast({ all: true }), true);
  assert.deepEqual(channel(FakePeerConnection.instances[0], 'state').sent.map(JSON.parse), [
    { direct: true },
    { all: true },
  ]);
  assert.deepEqual(channel(FakePeerConnection.instances[1], 'state').sent.map(JSON.parse), [
    { all: true },
  ]);
  hostTransport.close();
});

test('data channels emit open close and safely parsed peer-message events', () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  const opened = eventDetails(transport, 'peer-open');
  const closed = eventDetails(transport, 'peer-close');
  const messages = eventDetails(transport, 'peer-message');
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const control = new FakeDataChannel('control');
  peer.emitDataChannel(control);

  control.open();
  control.receive(JSON.stringify({ hello: '世界' }));
  assert.doesNotThrow(() => control.receive('{invalid-json'));
  control.receive(new Uint8Array([1, 2, 3]));
  control.close();

  assert.deepEqual(opened, [{
    playerId: 'host',
    channel: 'control',
    reliable: true,
    hostEpoch: 1,
  }]);
  assert.deepEqual(messages, [{
    playerId: 'host',
    channel: 'control',
    reliable: true,
    message: { hello: '世界' },
    hostEpoch: 1,
  }]);
  assert.deepEqual(closed, [{
    playerId: 'host',
    channel: 'control',
    reliable: true,
    hostEpoch: 1,
  }]);
  transport.close();
});

test('host epoch migration tears down every old generation and suppresses stale callbacks', async () => {
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  const messages = eventDetails(transport, 'peer-message');
  transport.reconcileTopology(room({ hostEpoch: 1 }));
  const oldPeer = FakePeerConnection.instances[0];
  const oldState = channel(oldPeer, 'state');

  transport.reconcileTopology(room({ hostEpoch: 2 }));
  const newPeer = FakePeerConnection.instances[1];
  await flushTasks();
  const sentBeforeStaleIce = signaling.sent.length;
  oldPeer.emitIce({ candidate: 'candidate:stale' });
  oldState.open();
  oldState.receive(JSON.stringify({ stale: true }));

  assert.equal(oldPeer.closeCalls, 1);
  assert.equal(newPeer.closeCalls, 0);
  assert.equal(signaling.sent.length, sentBeforeStaleIce);
  assert.deepEqual(messages, []);
  assert.deepEqual(signaling.sent, [{
    targetId: 'guest',
    data: { type: 'offer', sdp: 'offer-2', negotiationId: 'n2-2' },
  }]);

  assert.equal(transport.reconcileTopology(room({ hostEpoch: 1 })), false);
  assert.equal(FakePeerConnection.instances.length, 2);
  transport.close();
});

test('host change rebuilds a guest topology without letting the guest create an offer', async () => {
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room({ hostId: 'host', hostEpoch: 1 }));
  const oldPeer = FakePeerConnection.instances[0];
  await flushTasks();
  signaling.sent.length = 0;

  transport.reconcileTopology(room({
    hostId: 'new-host',
    hostEpoch: 2,
    members: [member('host'), member('new-host'), member('guest')],
  }));
  await flushTasks();

  assert.equal(oldPeer.closeCalls, 1);
  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(FakePeerConnection.instances[1].channels.length, 0);
  assert.deepEqual(signaling.sent, []);
  transport.close();
});

test('a disconnected peer is closed and cannot receive messages on the unchanged epoch', async () => {
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  await flushTasks();

  transport.reconcileTopology(room({ members: [member('host'), member('guest', false)] }));

  assert.equal(peer.closeCalls, 1);
  assert.equal(transport.sendToPeer('guest', { after: 'disconnect' }), false);
  transport.close();
});

test('reconciling a null room tears down topology and guards every send API', async () => {
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  await flushTasks();

  assert.equal(transport.reconcileTopology(null), true);

  assert.equal(peer.closeCalls, 1);
  assert.equal(transport.sendToPeer('guest', { after: 'leave' }), false);
  assert.equal(transport.broadcast({ after: 'leave' }), false);
  transport.close();
});

test('migration before createOffer settles prevents an old-generation offer from being signaled', async () => {
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });

  transport.reconcileTopology(room({ hostEpoch: 1 }));
  transport.reconcileTopology(room({ hostEpoch: 2 }));
  await flushTasks();

  assert.deepEqual(signaling.sent, [{
    targetId: 'guest',
    data: { type: 'offer', sdp: 'offer-2', negotiationId: 'n2-2' },
  }]);
  transport.close();
});

test('close removes signaling listeners, closes peers, clears queues, and is idempotent', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const control = new FakeDataChannel('control');
  peer.emitDataChannel(control);
  assert.equal(transport.sendToHost({ queued: true }, { reliable: true }), true);

  transport.close();
  transport.close();
  signaling.emitSignal('host', { type: 'offer', sdp: 'after-close' });
  control.open();
  await flushTasks();

  assert.equal(peer.closeCalls, 1);
  assert.deepEqual(control.sent, []);
  assert.equal(transport.reconcileTopology(room()), false);
  assert.equal(transport.sendToHost({ closed: true }), false);
});

test('constructor and outgoing serialization reject invalid inputs without throwing later', () => {
  assert.throws(() => new PeerTransport(), /signaling/i);
  assert.throws(
    () => new PeerTransport({
      signaling: new FakeSignaling({ selfId: 'guest' }),
      RTCPeerConnectionImpl: FakePeerConnection,
      maxReliableQueue: -1,
    }),
    /maxReliableQueue/i,
  );
  assert.throws(
    () => new PeerTransport({
      signaling: new FakeSignaling({ selfId: 'guest' }),
      RTCPeerConnectionImpl: FakePeerConnection,
      timers: { setTimeout() {} },
    }),
    /timers/i,
  );

  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(transport.sendToHost(cyclic, { reliable: true }), false);
  assert.equal(transport.sendToHost(undefined, { reliable: true }), false);
  transport.close();
});

test('room views reject more than eight members before creating peer connections', () => {
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  const members = Array.from({ length: 9 }, (_, index) => member(`player-${index}`));

  assert.throws(
    () => transport.reconcileTopology(room({ hostId: 'player-0', members })),
    /at most eight|eight members/i,
  );
  assert.equal(FakePeerConnection.instances.length, 0);
  transport.close();
});

test('outbound peer JSON over 64 KiB in UTF-8 is rejected before send or queue', () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const control = new FakeDataChannel('control');
  peer.emitDataChannel(control);

  assert.equal(transport.sendToHost({ text: '界'.repeat(22_000) }, { reliable: true }), false);
  control.open();
  assert.deepEqual(control.sent, []);
  transport.close();
});

test('inbound peer JSON over 64 KiB in UTF-8 is dropped before parsing or dispatch', () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  const messages = eventDetails(transport, 'peer-message');
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const control = new FakeDataChannel('control');
  peer.emitDataChannel(control);
  control.open();

  control.receive(JSON.stringify({ text: '界'.repeat(22_000) }));

  assert.deepEqual(messages, []);
  transport.close();
});

test('buffer pressure queues reliable messages but drops transient state until capacity returns', () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    maxBufferedAmount: 32,
  });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const control = new FakeDataChannel('control');
  const state = new FakeDataChannel('state', { ordered: false, maxRetransmits: 0 });
  peer.emitDataChannel(control);
  peer.emitDataChannel(state);
  control.open();
  state.open();
  control.bufferedAmount = 32;
  state.bufferedAmount = 32;

  assert.equal(transport.sendToHost({ reliable: 1 }, { reliable: true }), true);
  assert.equal(transport.sendToHost({ transient: 1 }), false);
  assert.deepEqual(control.sent, []);
  assert.deepEqual(state.sent, []);

  control.bufferedAmount = 0;
  control.dispatchEvent(new Event('bufferedamountlow'));
  assert.deepEqual(control.sent.map(JSON.parse), [{ reliable: 1 }]);
  transport.close();
});

test('queued reliable messages flush before the control peer-open event is observable', () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const control = new FakeDataChannel('control');
  peer.emitDataChannel(control);
  transport.sendToHost({ order: 1 }, { reliable: true });
  const sentAtOpen = [];
  transport.addEventListener('peer-open', () => {
    sentAtOpen.push(...control.sent.map(JSON.parse));
  });

  control.open();

  assert.deepEqual(sentAtOpen, [{ order: 1 }]);
  transport.close();
});

test('reliable messages submitted during a flush stay behind the existing FIFO queue', () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const control = new FakeDataChannel('control');
  peer.emitDataChannel(control);
  transport.sendToHost({ order: 1 }, { reliable: true });
  transport.sendToHost({ order: 2 }, { reliable: true });
  const send = control.send.bind(control);
  let injected = false;
  control.send = (data) => {
    send(data);
    if (!injected) {
      injected = true;
      transport.sendToHost({ order: 3 }, { reliable: true });
    }
  };

  control.open();

  assert.deepEqual(control.sent.map(JSON.parse), [{ order: 1 }, { order: 2 }, { order: 3 }]);
  transport.close();
});

test('a reliable send exception queues the head so later messages cannot overtake it', () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const control = new FakeDataChannel('control');
  peer.emitDataChannel(control);
  control.open();
  const send = control.send.bind(control);
  let shouldThrow = true;
  control.send = (data) => {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error('transient send failure');
    }
    send(data);
  };

  assert.equal(transport.sendToHost({ order: 1 }, { reliable: true }), true);
  assert.equal(transport.sendToHost({ order: 2 }, { reliable: true }), true);
  assert.deepEqual(control.sent, []);
  control.dispatchEvent(new Event('bufferedamountlow'));

  assert.deepEqual(control.sent.map(JSON.parse), [{ order: 1 }, { order: 2 }]);
  transport.close();
});

test('remote ICE candidates over 4 KiB in UTF-8 are dropped before buffering', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];

  signaling.emitSignal('host', {
    type: 'ice', candidate: '界'.repeat(1_366), negotiationId: 'negotiation-1',
  });
  signaling.emitSignal('host', {
    type: 'ice', candidate: 'candidate:valid', negotiationId: 'negotiation-1',
  });
  signaling.emitSignal('host', {
    type: 'offer', sdp: 'host-offer', negotiationId: 'negotiation-1',
  });
  await flushTasks();

  assert.deepEqual(peer.addedIce, [{ candidate: 'candidate:valid' }]);
  transport.close();
});

test('local ICE candidates over 4 KiB in UTF-8 are not relayed through signaling', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  signaling.emitSignal('host', {
    type: 'offer', sdp: 'host-offer', negotiationId: 'negotiation-1',
  });
  await flushTasks();
  signaling.sent.length = 0;

  peer.emitIce({ candidate: '界'.repeat(1_366) });
  peer.emitIce({ candidate: 'candidate:valid' });
  await flushTasks();

  assert.deepEqual(signaling.sent, [{
    targetId: 'host',
    data: { type: 'ice', candidate: 'candidate:valid', negotiationId: 'negotiation-1' },
  }]);
  transport.close();
});

test('at most 64 remote ICE candidates are retained before the remote description', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];

  for (let index = 0; index < 70; index += 1) {
    signaling.emitSignal('host', {
      type: 'ice', candidate: `candidate:${index}`, negotiationId: 'negotiation-1',
    });
  }
  signaling.emitSignal('host', {
    type: 'offer', sdp: 'host-offer', negotiationId: 'negotiation-1',
  });
  await flushTasks();
  await flushTasks();

  assert.equal(peer.addedIce.length, 64);
  assert.deepEqual(
    peer.addedIce.map((candidate) => candidate.candidate),
    Array.from({ length: 64 }, (_, index) => `candidate:${index}`),
  );
  transport.close();
});

test('the 64-candidate ICE bound includes queued and in-flight additions', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const gates = [];
  peer.addIceCandidate = async (candidate) => {
    peer.addedIce.push(structuredClone(candidate));
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
  };
  signaling.emitSignal('host', {
    type: 'offer', sdp: 'host-offer', negotiationId: 'negotiation-1',
  });
  await flushTasks();

  for (let index = 0; index < 70; index += 1) {
    signaling.emitSignal('host', {
      type: 'ice', candidate: `candidate:${index}`, negotiationId: 'negotiation-1',
    });
  }
  await flushTasks();
  for (let index = 0; index < 70; index += 1) {
    const gate = gates[index];
    if (!gate) break;
    gate.resolve();
    await flushTasks();
  }

  assert.equal(peer.addedIce.length, 64);
  transport.close();
});

test('a data-channel creation failure removes the partial peer so unchanged topology can rebuild it', async () => {
  let failStateChannel = true;
  class ChannelFailOncePeerConnection extends FakePeerConnection {
    createDataChannel(label, options) {
      if (label === 'state' && failStateChannel) {
        failStateChannel = false;
        throw new Error('state channel failed');
      }
      return super.createDataChannel(label, options);
    }
  }
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: ChannelFailOncePeerConnection,
    retryDelaysMs: [0],
    timers,
  });

  try {
    assert.doesNotThrow(() => transport.reconcileTopology(room()));
    const failedPeer = FakePeerConnection.instances[0];
    assert.equal(failedPeer.closeCalls, 1);
    assert.equal(failedPeer.channels[0].closeCalls, 1);
    assert.equal(FakePeerConnection.instances.length, 1);
    assert.equal(timers.runNext(), true);
    await flushTasks();

    assert.equal(FakePeerConnection.instances.length, 2);
    assert.equal(FakePeerConnection.instances[1].closeCalls, 0);
    assert.equal(signaling.sent.length, 1);
  } finally {
    transport.close();
  }
});

test('an offer creation failure tears down its peer and permits an unchanged-topology retry', async () => {
  let failOffer = true;
  class OfferFailOncePeerConnection extends FakePeerConnection {
    async createOffer() {
      if (failOffer) {
        failOffer = false;
        throw new Error('offer failed');
      }
      return super.createOffer();
    }
  }
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: OfferFailOncePeerConnection,
    retryDelaysMs: [0],
    timers,
  });
  try {
    transport.reconcileTopology(room());
    const failedPeer = FakePeerConnection.instances[0];
    await flushTasks();

    assert.equal(failedPeer.closeCalls, 1);
    assert.equal(FakePeerConnection.instances.length, 1);
    assert.equal(timers.runNext(), true);
    await flushTasks();

    assert.equal(FakePeerConnection.instances.length, 2);
    assert.equal(signaling.sent.length, 1);
  } finally {
    transport.close();
  }
});

test('an SDP application failure tears down the guest peer for same-topology rebuild', async () => {
  let failRemoteDescription = true;
  class SdpFailOncePeerConnection extends FakePeerConnection {
    async setRemoteDescription(description) {
      if (failRemoteDescription) {
        failRemoteDescription = false;
        throw new Error('remote SDP failed');
      }
      return super.setRemoteDescription(description);
    }
  }
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: SdpFailOncePeerConnection,
    retryDelaysMs: [0],
    timers,
  });
  try {
    transport.reconcileTopology(room());
    const failedPeer = FakePeerConnection.instances[0];
    signaling.emitSignal('host', {
      type: 'offer', sdp: 'host-offer', negotiationId: 'negotiation-1',
    });
    await flushTasks();

    assert.equal(failedPeer.closeCalls, 1);
    assert.equal(FakePeerConnection.instances.length, 1);
    assert.equal(timers.runNext(), true);

    assert.equal(FakePeerConnection.instances.length, 2);
  } finally {
    transport.close();
  }
});

test('a failed peer connection is atomically replaced by a bounded same-topology retry', async () => {
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs: [0],
    timers,
  });
  try {
    transport.reconcileTopology(room());
    const failedPeer = FakePeerConnection.instances[0];

    failedPeer.connectionState = 'failed';
    failedPeer.onconnectionstatechange();
    assert.equal(timers.runNext(), true);
    await flushTasks();

    assert.equal(failedPeer.closeCalls, 1);
    assert.equal(FakePeerConnection.instances.length, 2);
    assert.equal(FakePeerConnection.instances[1].closeCalls, 0);
  } finally {
    transport.close();
  }
});

test('a peer-connection constructor failure with no retry budget stays exhausted', () => {
  let constructorCalls = 0;
  class ThrowingPeerConnection {
    constructor() {
      constructorCalls += 1;
      throw new Error('constructor failed');
    }
  }
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: ThrowingPeerConnection,
    retryDelaysMs: [],
  });

  try {
    transport.reconcileTopology(room());
    transport.reconcileTopology(room());
    transport.reconcileTopology(room());

    assert.equal(constructorCalls, 1);
  } finally {
    transport.close();
  }
});

test('constructor failures consume each delayed retry before becoming exhausted', () => {
  let constructorCalls = 0;
  class ThrowingPeerConnection {
    constructor() {
      constructorCalls += 1;
      throw new Error('constructor failed');
    }
  }
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: ThrowingPeerConnection,
    retryDelaysMs: [10, 20],
    timers,
  });

  try {
    transport.reconcileTopology(room());
    transport.reconcileTopology(room());
    assert.equal(constructorCalls, 1);
    assert.equal(timers.pendingCount, 1);

    assert.equal(timers.runNext(), true);
    transport.reconcileTopology(room());
    assert.equal(constructorCalls, 2);
    assert.equal(timers.pendingCount, 1);

    assert.equal(timers.runNext(), true);
    transport.reconcileTopology(room());
    transport.reconcileTopology(room());
    assert.equal(constructorCalls, 3);
    assert.equal(timers.pendingCount, 0);
    assert.deepEqual(timers.scheduledDelays, [10, 20]);
  } finally {
    transport.close();
  }
});

test('closing an open control channel atomically replaces the peer and reliability can reopen', async () => {
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs: [0],
    timers,
  });
  const opened = eventDetails(transport, 'peer-open');
  const closed = eventDetails(transport, 'peer-close');
  transport.reconcileTopology(room());
  await flushTasks();
  const oldPeer = FakePeerConnection.instances[0];
  const oldControl = channel(oldPeer, 'control');
  const oldState = channel(oldPeer, 'state');
  oldPeer.connectionState = 'connected';
  oldControl.open();
  oldState.open();
  const oldNegotiationId = signaling.sent[0].data.negotiationId;

  oldControl.close();

  assert.equal(oldPeer.closeCalls, 1);
  assert.equal(oldState.readyState, 'closed');
  assert.equal(transport.sendToPeer('guest', { during: 'retry' }, { reliable: true }), false);
  assert.deepEqual(closed.map(({ channel: label, reliable }) => ({ label, reliable })), [
    { label: 'control', reliable: true },
    { label: 'state', reliable: false },
  ]);

  assert.equal(timers.runNext(), true);
  await flushTasks();
  const replacement = FakePeerConnection.instances[1];
  assert.ok(replacement);
  assert.notEqual(signaling.sent.at(-1).data.negotiationId, oldNegotiationId);
  const replacementControl = channel(replacement, 'control');
  replacement.connectionState = 'connected';
  replacementControl.open();

  assert.equal(opened.filter(({ channel: label }) => label === 'control').length, 2);
  assert.equal(transport.sendToPeer('guest', { after: 'retry' }, { reliable: true }), true);
  assert.deepEqual(replacementControl.sent.map(JSON.parse), [{ after: 'retry' }]);
  transport.close();
});

test('closing an open state channel emits each required close once and schedules one retry', async () => {
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs: [0, 0],
    timers,
  });
  const closed = eventDetails(transport, 'peer-close');
  transport.reconcileTopology(room());
  const oldPeer = FakePeerConnection.instances[0];
  const oldControl = channel(oldPeer, 'control');
  const oldState = channel(oldPeer, 'state');
  oldPeer.connectionState = 'connected';
  oldControl.open();
  oldState.open();

  oldState.close();
  oldControl.dispatchEvent(new Event('close'));

  assert.equal(oldPeer.closeCalls, 1);
  assert.deepEqual(closed.map(({ channel: label, reliable }) => ({ label, reliable })), [
    { label: 'state', reliable: false },
    { label: 'control', reliable: true },
  ]);
  assert.equal(closed.filter(({ reliable }) => reliable).length, 1);

  assert.equal(timers.runNext(), true);
  await flushTasks();
  assert.equal(FakePeerConnection.instances.length, 2);
  transport.close();
});

test('opening only control cannot reset the bounded retry budget of a half-open peer', async () => {
  const retryDelaysMs = [0, 0];
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs,
    timers,
  });
  transport.reconcileTopology(room());

  for (let index = 0; index <= retryDelaysMs.length; index += 1) {
    const peer = FakePeerConnection.instances[index];
    channel(peer, 'control').open();
    channel(peer, 'state').close();
    if (index < retryDelaysMs.length) assert.equal(timers.runNext(), true);
    await flushTasks();
  }

  assert.equal(FakePeerConnection.instances.length, 1 + retryDelaysMs.length);
  transport.close();
});

test('opening both required channels resets the retry budget in either channel order', async () => {
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs: [0],
    timers,
  });
  transport.reconcileTopology(room());

  channel(FakePeerConnection.instances[0], 'state').close();
  assert.equal(timers.runNext(), true);
  await flushTasks();

  const stateFirstPeer = FakePeerConnection.instances[1];
  channel(stateFirstPeer, 'state').open();
  channel(stateFirstPeer, 'control').open();
  channel(stateFirstPeer, 'state').close();
  assert.equal(timers.runNext(), true);
  await flushTasks();

  const controlFirstPeer = FakePeerConnection.instances[2];
  channel(controlFirstPeer, 'control').open();
  channel(controlFirstPeer, 'state').open();
  channel(controlFirstPeer, 'control').close();
  assert.equal(timers.runNext(), true);
  await flushTasks();

  assert.equal(FakePeerConnection.instances.length, 4);
  transport.close();
});

test('unchanged topology reconciliation cannot bypass a pending retry timer', async () => {
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs: [25],
    timers,
  });
  const currentRoom = room();
  transport.reconcileTopology(currentRoom);
  channel(FakePeerConnection.instances[0], 'state').close();

  transport.reconcileTopology(currentRoom);
  transport.reconcileTopology(currentRoom);
  transport.reconcileTopology(currentRoom);
  assert.equal(FakePeerConnection.instances.length, 1);

  assert.equal(timers.runNext(), true);
  await flushTasks();
  assert.equal(FakePeerConnection.instances.length, 2);
  transport.close();
});

test('unchanged topology reconciliation cannot bypass an exhausted retry budget', async () => {
  const retryDelaysMs = [0, 0];
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs,
    timers,
  });
  const currentRoom = room();
  transport.reconcileTopology(currentRoom);

  for (let index = 0; index <= retryDelaysMs.length; index += 1) {
    channel(FakePeerConnection.instances[index], 'state').close();
    if (index < retryDelaysMs.length) assert.equal(timers.runNext(), true);
    await flushTasks();
  }
  assert.equal(FakePeerConnection.instances.length, 1 + retryDelaysMs.length);

  transport.reconcileTopology(currentRoom);
  transport.reconcileTopology(currentRoom);
  assert.equal(FakePeerConnection.instances.length, 1 + retryDelaysMs.length);
  transport.close();
});

test('removing a desired peer cancels its pending retry and restores a fresh budget on readd', async () => {
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs: [20],
    timers,
  });
  transport.reconcileTopology(room());
  channel(FakePeerConnection.instances[0], 'state').close();

  transport.reconcileTopology(room({ members: [member('host'), member('guest', false)] }));
  assert.equal(timers.runNext(), false);
  assert.equal(FakePeerConnection.instances.length, 1);

  transport.reconcileTopology(room());
  assert.equal(FakePeerConnection.instances.length, 2);
  channel(FakePeerConnection.instances[1], 'state').close();
  assert.equal(timers.runNext(), true);
  await flushTasks();
  assert.equal(FakePeerConnection.instances.length, 3);
  transport.close();
});

test('removing an exhausted peer restores a fresh initial connection and retry budget on readd', async () => {
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs: [0],
    timers,
  });
  transport.reconcileTopology(room());
  channel(FakePeerConnection.instances[0], 'state').close();
  assert.equal(timers.runNext(), true);
  await flushTasks();
  channel(FakePeerConnection.instances[1], 'state').close();
  await flushTasks();
  assert.equal(FakePeerConnection.instances.length, 2);

  transport.reconcileTopology(room({ members: [member('host'), member('guest', false)] }));
  transport.reconcileTopology(room());
  assert.equal(FakePeerConnection.instances.length, 3);

  channel(FakePeerConnection.instances[2], 'state').close();
  assert.equal(timers.runNext(), true);
  await flushTasks();
  assert.equal(FakePeerConnection.instances.length, 4);
  transport.close();
});

test('intentional migration and close suppress stale channel retries from retired generations', async () => {
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs: [0],
    timers,
  });
  transport.reconcileTopology(room({ hostEpoch: 1 }));
  const retiredPeer = FakePeerConnection.instances[0];
  const retiredControl = channel(retiredPeer, 'control');
  retiredControl.open();

  transport.reconcileTopology(room({ hostEpoch: 2 }));
  const currentPeer = FakePeerConnection.instances[1];
  retiredControl.dispatchEvent(new Event('close'));
  await flushTasks();

  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(timers.pendingCount, 0);
  transport.close();
  channel(currentPeer, 'control').dispatchEvent(new Event('close'));
  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(timers.pendingCount, 0);
});

test('a migrating session becomes ready after a closed control channel is rebuilt and reopened', async () => {
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    retryDelaysMs: [0],
    timers,
  });
  const integrityMonitor = { inspect: () => null, reset() {} };
  const session = new MultiplayerSession({ signaling, transport, integrityMonitor });
  const members = [member('host'), member('guest'), member('guest-b')];
  emitDetail(signaling, 'room-view', {
    room: room({ hostId: 'host', hostEpoch: 1, members }),
  });
  emitDetail(signaling, 'host-changed', {
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  const [, oldHostPeer, guestBPeer] = FakePeerConnection.instances;
  const oldHostControl = channel(oldHostPeer, 'control');
  const guestBControl = channel(guestBPeer, 'control');
  oldHostPeer.connectionState = 'connected';
  guestBPeer.connectionState = 'connected';
  await flushTasks();

  oldHostControl.open();
  oldHostControl.close();
  guestBControl.open();
  assert.equal(session.state.migrating, true);

  assert.equal(timers.runNext(), true);
  await flushTasks();
  const replacement = FakePeerConnection.instances[3];
  assert.ok(replacement);
  replacement.connectionState = 'connected';
  channel(replacement, 'control').open();

  assert.equal(session.state.migrating, false);
  const oldHostOffers = signaling.sent.filter(({ targetId, data }) => (
    targetId === 'host' && data.type === 'offer'
  ));
  assert.equal(oldHostOffers.length, 2);
  assert.notEqual(
    oldHostOffers[0].data.negotiationId,
    oldHostOffers[1].data.negotiationId,
  );
  session.close();
});

test('an asynchronous offer failure uses the configured bounded retry without a new room view', async () => {
  let failOffer = true;
  class OfferRetryPeerConnection extends FakePeerConnection {
    async createOffer() {
      if (failOffer) {
        failOffer = false;
        throw new Error('offer failed');
      }
      return super.createOffer();
    }
  }
  const timers = new ControlledTimers();
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: OfferRetryPeerConnection,
    retryDelaysMs: [0],
    timers,
  });

  transport.reconcileTopology(room());
  await flushTasks();
  assert.equal(timers.runNext(), true);
  await flushTasks();

  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(FakePeerConnection.instances[0].closeCalls, 1);
  assert.equal(signaling.sent.length, 1);
  transport.close();
});

test('host offer, answer, and ICE are scoped to one required negotiationId', async () => {
  const signaling = new FakeSignaling({ selfId: 'host' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  await flushTasks();
  const peer = FakePeerConnection.instances[0];
  const offer = signaling.sent[0].data;

  assert.equal(typeof offer.negotiationId, 'string');
  assert.notEqual(offer.negotiationId.length, 0);
  peer.emitIce({ candidate: 'candidate:local' });
  await flushTasks();
  assert.equal(signaling.sent.at(-1).data.negotiationId, offer.negotiationId);

  signaling.emitSignal('guest', { type: 'answer', sdp: 'missing-id' });
  signaling.emitSignal('guest', {
    type: 'answer', sdp: 'wrong-id', negotiationId: 'retired-negotiation',
  });
  await flushTasks();
  assert.deepEqual(peer.remoteDescriptions, []);

  signaling.emitSignal('guest', {
    type: 'answer', sdp: 'matched', negotiationId: offer.negotiationId,
  });
  await flushTasks();
  assert.deepEqual(peer.remoteDescriptions, [{ type: 'answer', sdp: 'matched' }]);
  transport.close();
});

test('guest rejects an unscoped offer and echoes a valid negotiationId into answer and ICE', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];

  signaling.emitSignal('host', { type: 'offer', sdp: 'missing-id' });
  await flushTasks();
  assert.deepEqual(peer.remoteDescriptions, []);
  assert.deepEqual(signaling.sent, []);

  signaling.emitSignal('host', {
    type: 'offer', sdp: 'scoped-offer', negotiationId: 'negotiation-1',
  });
  await flushTasks();
  assert.deepEqual(peer.remoteDescriptions, [{ type: 'offer', sdp: 'scoped-offer' }]);
  assert.equal(signaling.sent[0].data.negotiationId, 'negotiation-1');

  peer.emitIce({ candidate: 'candidate:local' });
  await flushTasks();
  assert.equal(signaling.sent.at(-1).data.negotiationId, 'negotiation-1');
  transport.close();
});

test('guest retains only early ICE belonging to the accepted offer negotiationId', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];

  signaling.emitSignal('host', {
    type: 'ice', candidate: 'candidate:stale', negotiationId: 'negotiation-stale',
  });
  signaling.emitSignal('host', {
    type: 'ice', candidate: 'candidate:current', negotiationId: 'negotiation-current',
  });
  signaling.emitSignal('host', {
    type: 'offer', sdp: 'host-offer', negotiationId: 'negotiation-current',
  });
  await flushTasks();

  assert.deepEqual(peer.addedIce, [{ candidate: 'candidate:current' }]);
  transport.close();
});

test('a new negotiationId replaces a guest peer during same-epoch host reconnect', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  transport.reconcileTopology(room());
  const firstPeer = FakePeerConnection.instances[0];
  signaling.emitSignal('host', {
    type: 'offer', sdp: 'first-offer', negotiationId: 'negotiation-1',
  });
  await flushTasks();

  signaling.emitSignal('host', {
    type: 'offer', sdp: 'second-offer', negotiationId: 'negotiation-2',
  });
  await flushTasks();

  assert.equal(firstPeer.closeCalls, 1);
  assert.equal(FakePeerConnection.instances.length, 2);
  assert.deepEqual(FakePeerConnection.instances[1].remoteDescriptions, [
    { type: 'offer', sdp: 'second-offer' },
  ]);
  assert.equal(signaling.sent.at(-1).data.negotiationId, 'negotiation-2');
  transport.close();
});

test('guest rejects recently retired negotiations while bounding the seen-ID ledger', async () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({
    signaling,
    RTCPeerConnectionImpl: FakePeerConnection,
    maxSeenNegotiations: 2,
  });
  transport.reconcileTopology(room());
  async function offer(negotiationId) {
    signaling.emitSignal('host', {
      type: 'offer', sdp: negotiationId, negotiationId,
    });
    await flushTasks();
  }

  await offer('negotiation-1');
  await offer('negotiation-2');
  await offer('negotiation-3');
  assert.equal(FakePeerConnection.instances.length, 3);

  await offer('negotiation-2');
  assert.equal(FakePeerConnection.instances.length, 3);

  await offer('negotiation-1');
  assert.equal(FakePeerConnection.instances.length, 4);
  transport.close();
});

test('guest closes an inbound control channel that is not ordered and reliable', () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  const opened = eventDetails(transport, 'peer-open');
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const invalidControl = new FakeDataChannel('control', { ordered: false, maxRetransmits: 0 });

  peer.emitDataChannel(invalidControl);
  invalidControl.open();

  assert.equal(invalidControl.closeCalls, 1);
  assert.deepEqual(opened, []);
  transport.close();
});

test('guest closes an inbound state channel unless it is unordered with zero retransmits', () => {
  const signaling = new FakeSignaling({ selfId: 'guest' });
  const transport = new PeerTransport({ signaling, RTCPeerConnectionImpl: FakePeerConnection });
  const opened = eventDetails(transport, 'peer-open');
  transport.reconcileTopology(room());
  const peer = FakePeerConnection.instances[0];
  const invalidState = new FakeDataChannel('state', { ordered: true });

  peer.emitDataChannel(invalidState);
  invalidState.open();

  assert.equal(invalidState.closeCalls, 1);
  assert.deepEqual(opened, []);
  transport.close();
});
