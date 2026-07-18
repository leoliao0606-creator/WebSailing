import {
  MAX_ICE_CANDIDATE_BYTES,
  MAX_ICE_METADATA_BYTES,
  MAX_NEGOTIATION_ID_BYTES,
} from './protocol.js';

const CONTROL_CHANNEL = 'control';
const STATE_CHANNEL = 'state';
const INVALID_ICE = Symbol('invalid ICE candidate');
const MAX_PEER_MESSAGE_BYTES = 64 * 1024;
const MAX_REMOTE_ICE_CANDIDATES = 64;
const DEFAULT_INBOUND_RATE_LIMIT = Object.freeze({
  windowMs: 1000,
  maxMessages: 120,
  maxBytes: 512 * 1024,
});
const textEncoder = new TextEncoder();

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredId(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function validNegotiationId(value) {
  return typeof value === 'string'
    && value.length > 0
    && textEncoder.encode(value).byteLength <= MAX_NEGOTIATION_ID_BYTES;
}

function validChannelConfiguration(dataChannel) {
  if (dataChannel.label === CONTROL_CHANNEL) {
    return dataChannel.ordered === true
      && dataChannel.maxRetransmits === null
      && dataChannel.maxPacketLifeTime === null;
  }
  return dataChannel.label === STATE_CHANNEL
    && dataChannel.ordered === false
    && dataChannel.maxRetransmits === 0
    && dataChannel.maxPacketLifeTime === null;
}

function normalizeRoomView(value) {
  if (!isRecord(value)) throw new TypeError('roomView must be a plain object');
  const roomCode = requiredId(value.roomCode, 'roomView.roomCode');
  if (value.hostId !== null && value.hostId !== undefined && typeof value.hostId !== 'string') {
    throw new TypeError('roomView.hostId must be a string or null');
  }
  if (!Number.isSafeInteger(value.hostEpoch) || value.hostEpoch < 0) {
    throw new TypeError('roomView.hostEpoch must be a non-negative safe integer');
  }
  if (!Array.isArray(value.members) || value.members.length > 8) {
    throw new TypeError('roomView.members must be an array of at most eight members');
  }

  const members = [];
  const memberIds = new Set();
  for (let index = 0; index < value.members.length; index += 1) {
    const source = value.members[index];
    if (!isRecord(source)) throw new TypeError(`roomView.members[${index}] must be an object`);
    const playerId = requiredId(source.playerId, `roomView.members[${index}].playerId`);
    if (memberIds.has(playerId)) throw new TypeError(`duplicate room member ${playerId}`);
    if (typeof source.connected !== 'boolean') {
      throw new TypeError(`roomView.members[${index}].connected must be a Boolean`);
    }
    memberIds.add(playerId);
    members.push({ playerId, connected: source.connected });
  }

  const hostId = value.hostId ?? null;
  return { roomCode, hostId, hostEpoch: value.hostEpoch, members };
}

function signalingSelfId(signaling) {
  const state = signaling.state;
  const playerId = state?.selfId ?? state?.playerId;
  return typeof playerId === 'string' && playerId.length > 0 ? playerId : null;
}

function serializeMessage(message) {
  try {
    const serialized = JSON.stringify(message);
    if (typeof serialized !== 'string') return null;
    return textEncoder.encode(serialized).byteLength <= MAX_PEER_MESSAGE_BYTES
      ? serialized
      : null;
  } catch {
    return null;
  }
}

function inboundMessageBytes(data) {
  if (typeof data === 'string') return textEncoder.encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
  return 0;
}

function normalizeInboundRateLimit(value) {
  if (!isRecord(value)) {
    throw new TypeError('inboundRateLimit must be a plain object');
  }
  const windowMs = Object.hasOwn(value, 'windowMs')
    ? value.windowMs
    : DEFAULT_INBOUND_RATE_LIMIT.windowMs;
  const maxMessages = Object.hasOwn(value, 'maxMessages')
    ? value.maxMessages
    : DEFAULT_INBOUND_RATE_LIMIT.maxMessages;
  const maxBytes = Object.hasOwn(value, 'maxBytes')
    ? value.maxBytes
    : DEFAULT_INBOUND_RATE_LIMIT.maxBytes;
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('inboundRateLimit.windowMs must be a positive finite number');
  }
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) {
    throw new TypeError('inboundRateLimit.maxMessages must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('inboundRateLimit.maxBytes must be a positive safe integer');
  }
  return Object.freeze({ windowMs, maxMessages, maxBytes });
}

function localDescriptionData(description, expectedType, negotiationId) {
  if (!description || description.type !== expectedType || typeof description.sdp !== 'string') {
    return null;
  }
  return { type: expectedType, sdp: description.sdp, negotiationId };
}

function outgoingIceData(candidate, negotiationId) {
  if (candidate === null) return { type: 'ice', candidate: null, negotiationId };
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') return null;

  let source = candidate;
  if (typeof candidate.toJSON === 'function') {
    try {
      source = candidate.toJSON();
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== 'object' || typeof source.candidate !== 'string') return null;
  if (textEncoder.encode(source.candidate).byteLength > MAX_ICE_CANDIDATE_BYTES) return null;
  if (typeof source.sdpMid === 'string'
    && textEncoder.encode(source.sdpMid).byteLength > MAX_ICE_METADATA_BYTES) return null;
  if (typeof source.usernameFragment === 'string'
    && textEncoder.encode(source.usernameFragment).byteLength > MAX_ICE_METADATA_BYTES) return null;

  const data = { type: 'ice', candidate: source.candidate, negotiationId };
  if (source.sdpMid === null || typeof source.sdpMid === 'string') data.sdpMid = source.sdpMid;
  if (
    source.sdpMLineIndex === null
    || (Number.isSafeInteger(source.sdpMLineIndex) && source.sdpMLineIndex >= 0)
  ) {
    data.sdpMLineIndex = source.sdpMLineIndex;
  }
  if (source.usernameFragment === null || typeof source.usernameFragment === 'string') {
    data.usernameFragment = source.usernameFragment;
  }
  return data;
}

function incomingIceCandidate(data) {
  if (!isRecord(data) || data.type !== 'ice') return INVALID_ICE;
  if (data.candidate === null) return null;
  if (typeof data.candidate !== 'string') return INVALID_ICE;
  if (textEncoder.encode(data.candidate).byteLength > MAX_ICE_CANDIDATE_BYTES) return INVALID_ICE;

  const candidate = { candidate: data.candidate };
  if (Object.hasOwn(data, 'sdpMid')) {
    if (data.sdpMid !== null && typeof data.sdpMid !== 'string') return INVALID_ICE;
    if (typeof data.sdpMid === 'string'
      && textEncoder.encode(data.sdpMid).byteLength > MAX_ICE_METADATA_BYTES) return INVALID_ICE;
    candidate.sdpMid = data.sdpMid;
  }
  if (Object.hasOwn(data, 'sdpMLineIndex')) {
    if (
      data.sdpMLineIndex !== null
      && (!Number.isSafeInteger(data.sdpMLineIndex) || data.sdpMLineIndex < 0)
    ) {
      return INVALID_ICE;
    }
    candidate.sdpMLineIndex = data.sdpMLineIndex;
  }
  if (Object.hasOwn(data, 'usernameFragment')) {
    if (data.usernameFragment !== null && typeof data.usernameFragment !== 'string') {
      return INVALID_ICE;
    }
    if (typeof data.usernameFragment === 'string'
      && textEncoder.encode(data.usernameFragment).byteLength > MAX_ICE_METADATA_BYTES) {
      return INVALID_ICE;
    }
    candidate.usernameFragment = data.usernameFragment;
  }
  return candidate;
}

export class PeerTransport extends EventTarget {
  #signaling;

  #RTCPeerConnectionImpl;

  #maxReliableQueue;

  #maxBufferedAmount;

  #retryDelaysMs;

  #timers;

  #maxSeenNegotiations;

  #inboundRateLimit;

  #clock;

  #lastClockTime;

  #signalListener;

  #peers = new Map();

  #topology = null;

  #generation = 0;

  #nextNegotiationSequence = 1;

  #retryAttempts = new Map();

  #retryTimers = new Map();

  #exhaustedRetries = new Set();

  #rateLimitedRetryChains = new Set();

  #seenNegotiations = new Map();

  #closed = false;

  constructor({
    signaling,
    RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
    maxReliableQueue = 64,
    maxBufferedAmount = 1024 * 1024,
    retryDelaysMs = [0, 100, 500],
    maxSeenNegotiations = 64,
    timers = globalThis,
    inboundRateLimit = {},
    clock = globalThis.performance ?? Date,
  } = {}) {
    super();
    if (
      !signaling
      || typeof signaling.addEventListener !== 'function'
      || typeof signaling.removeEventListener !== 'function'
      || typeof signaling.sendSignal !== 'function'
    ) {
      throw new TypeError('signaling must provide events and sendSignal(targetId, data)');
    }
    if (typeof RTCPeerConnectionImpl !== 'function') {
      throw new TypeError('RTCPeerConnectionImpl must be a constructor');
    }
    if (!Number.isSafeInteger(maxReliableQueue) || maxReliableQueue < 0) {
      throw new TypeError('maxReliableQueue must be a non-negative safe integer');
    }
    if (typeof maxBufferedAmount !== 'number'
      || !Number.isFinite(maxBufferedAmount)
      || maxBufferedAmount < 0) {
      throw new TypeError('maxBufferedAmount must be a non-negative finite number');
    }
    if (!Array.isArray(retryDelaysMs)
      || retryDelaysMs.length > 8
      || retryDelaysMs.some((delay) => (
        typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0
      ))) {
      throw new TypeError('retryDelaysMs must contain at most eight non-negative finite delays');
    }
    if (!Number.isSafeInteger(maxSeenNegotiations) || maxSeenNegotiations < 1) {
      throw new TypeError('maxSeenNegotiations must be a positive safe integer');
    }
    if (!timers
      || typeof timers.setTimeout !== 'function'
      || typeof timers.clearTimeout !== 'function') {
      throw new TypeError('timers must provide setTimeout() and clearTimeout()');
    }
    const normalizedInboundRateLimit = normalizeInboundRateLimit(inboundRateLimit);
    if (!clock || typeof clock.now !== 'function') {
      throw new TypeError('clock must provide now()');
    }
    let initialClockTime;
    try {
      initialClockTime = clock.now();
    } catch {
      throw new TypeError('clock.now() must return a finite number');
    }
    if (typeof initialClockTime !== 'number' || !Number.isFinite(initialClockTime)) {
      throw new TypeError('clock.now() must return a finite number');
    }

    this.#signaling = signaling;
    this.#RTCPeerConnectionImpl = RTCPeerConnectionImpl;
    this.#maxReliableQueue = maxReliableQueue;
    this.#maxBufferedAmount = maxBufferedAmount;
    this.#retryDelaysMs = Object.freeze([...retryDelaysMs]);
    this.#timers = timers;
    this.#maxSeenNegotiations = maxSeenNegotiations;
    this.#inboundRateLimit = normalizedInboundRateLimit;
    this.#clock = clock;
    this.#lastClockTime = initialClockTime;
    this.#signalListener = (event) => this.#handleSignalEvent(event);
    this.#signaling.addEventListener('signal', this.#signalListener);
  }

  reconcileTopology(roomView) {
    if (this.#closed) return false;
    if (roomView === null) {
      this.#resetTopology();
      return true;
    }
    const next = normalizeRoomView(roomView);
    const selfId = signalingSelfId(this.#signaling);
    if (selfId === null) {
      this.#resetTopology();
      return false;
    }
    if (
      this.#topology
      && next.roomCode === this.#topology.roomCode
      && next.hostEpoch < this.#topology.hostEpoch
    ) {
      return false;
    }

    const topologyChanged = this.#topology === null
      || next.roomCode !== this.#topology.roomCode
      || next.hostId !== this.#topology.hostId
      || next.hostEpoch !== this.#topology.hostEpoch
      || selfId !== this.#topology.selfId;
    if (topologyChanged) {
      this.#clearAllRetries();
      this.#generation += 1;
      this.#closeAllPeers();
    }

    const memberMap = new Map(next.members.map((item) => [item.playerId, item]));
    const isHost = next.hostId === selfId;
    this.#topology = {
      roomCode: next.roomCode,
      hostId: next.hostId,
      hostEpoch: next.hostEpoch,
      selfId,
      isHost,
      members: memberMap,
    };

    const desiredPeerIds = [];
    const selfConnected = memberMap.get(selfId)?.connected === true;
    if (selfConnected && isHost) {
      for (const item of next.members) {
        if (item.playerId !== selfId && item.connected) desiredPeerIds.push(item.playerId);
      }
    } else if (selfConnected && next.hostId !== null && next.hostId !== selfId) {
      if (memberMap.get(next.hostId)?.connected === true) desiredPeerIds.push(next.hostId);
    }
    const desired = new Set(desiredPeerIds);

    const retryPlayerIds = new Set([
      ...this.#retryAttempts.keys(),
      ...this.#retryTimers.keys(),
      ...this.#exhaustedRetries,
    ]);
    for (const playerId of retryPlayerIds) {
      if (!desired.has(playerId)) this.#clearRetry(playerId);
    }

    for (const record of [...this.#peers.values()]) {
      if (!desired.has(record.playerId)) {
        this.#clearRetry(record.playerId);
        this.#removePeer(record);
      }
    }
    for (const playerId of desiredPeerIds) {
      if (!this.#peers.has(playerId)
        && !this.#retryTimers.has(playerId)
        && !this.#exhaustedRetries.has(playerId)) {
        this.#createPeer(playerId, isHost);
      }
    }

    this.dispatchEvent(new CustomEvent('topology', {
      detail: {
        roomCode: next.roomCode,
        hostId: next.hostId,
        hostEpoch: next.hostEpoch,
        selfId,
        isHost,
        peerIds: desiredPeerIds,
      },
    }));
    return true;
  }

  canBroadcastReliable(messageOrMessages, options = {}) {
    if (this.#closed || !this.#topology?.isHost || !isRecord(options)) return false;
    const messages = Array.isArray(messageOrMessages) ? messageOrMessages : [messageOrMessages];
    if (messages.length === 0) return false;
    const serializedMessages = messages.map(serializeMessage);
    if (serializedMessages.some((serialized) => serialized === null)) return false;

    const playerIds = Object.hasOwn(options, 'playerIds')
      ? options.playerIds
      : [...this.#peers.keys()];
    if (!Array.isArray(playerIds)) return false;
    const uniquePlayerIds = new Set(playerIds);
    if (uniquePlayerIds.size !== playerIds.length
      || playerIds.some((playerId) => typeof playerId !== 'string' || playerId.length === 0)) {
      return false;
    }

    for (const playerId of playerIds) {
      const record = this.#peers.get(playerId);
      if (!record || !this.#canSendReliableBatch(record, serializedMessages)) return false;
    }
    return true;
  }

  sendToHost(message, { reliable = false } = {}) {
    if (this.#closed || !this.#topology || this.#topology.isHost) return false;
    const hostId = this.#topology.hostId;
    if (hostId === null) return false;
    const record = this.#peers.get(hostId);
    if (!record) return false;
    const serialized = serializeMessage(message);
    if (serialized === null) return false;
    return this.#sendSerialized(record, serialized, reliable === true);
  }

  sendToPeer(playerId, message, { reliable = false } = {}) {
    if (this.#closed || !this.#topology?.isHost) return false;
    const record = this.#peers.get(playerId);
    if (!record) return false;
    const serialized = serializeMessage(message);
    if (serialized === null) return false;
    return this.#sendSerialized(record, serialized, reliable === true);
  }

  broadcast(message, { reliable = false } = {}) {
    if (this.#closed || !this.#topology?.isHost) return false;
    const serialized = serializeMessage(message);
    if (serialized === null) return false;
    let accepted = true;
    for (const record of this.#peers.values()) {
      if (!this.#sendSerialized(record, serialized, reliable === true)) accepted = false;
    }
    return accepted;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearAllRetries();
    this.#generation += 1;
    this.#signaling.removeEventListener('signal', this.#signalListener);
    this.#closeAllPeers();
    this.#topology = null;
    this.#seenNegotiations.clear();
  }

  #resetTopology() {
    this.#clearAllRetries();
    this.#generation += 1;
    this.#closeAllPeers();
    this.#topology = null;
  }

  #createPeer(playerId, initiator) {
    const stateIceServers = this.#signaling.state?.iceServers;
    const configuration = { iceServers: Array.isArray(stateIceServers) ? stateIceServers : [] };
    let peerConnection;
    try {
      peerConnection = new this.#RTCPeerConnectionImpl(configuration);
    } catch {
      this.#scheduleRetry(playerId, initiator, this.#generation);
      return null;
    }
    const record = {
      playerId,
      initiator,
      generation: this.#generation,
      hostEpoch: this.#topology.hostEpoch,
      negotiationId: initiator ? this.#createNegotiationId(this.#topology.hostEpoch) : null,
      peerConnection,
      channels: new Map(),
      channelHandlers: new Map(),
      openChannels: new Set(),
      reliableQueue: [],
      flushingReliable: false,
      pendingIce: [],
      iceInFlight: false,
      sdpChain: Promise.resolve(),
      remoteDescriptionSet: false,
      inboundEvents: [],
      inboundBytes: 0,
      active: true,
    };
    this.#peers.set(playerId, record);
    if (record.negotiationId !== null) {
      this.#rememberNegotiation(playerId, record.negotiationId);
    }

    peerConnection.onicecandidate = (event) => {
      if (!this.#isCurrent(record)) return;
      if (record.negotiationId === null) return;
      const data = outgoingIceData(event?.candidate, record.negotiationId);
      if (data !== null) void this.#sendSignal(record, data);
    };
    peerConnection.ondatachannel = (event) => {
      const incoming = event?.channel;
      if (!this.#isCurrent(record) || record.initiator) {
        try {
          incoming?.close?.();
        } catch {
          // Ignore an unusable remote channel.
        }
        return;
      }
      this.#attachChannel(record, incoming);
    };
    peerConnection.onconnectionstatechange = () => {
      if (!this.#isCurrent(record)) return;
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
        this.#failPeer(record);
      }
    };

    if (initiator) {
      try {
        const control = peerConnection.createDataChannel(CONTROL_CHANNEL, { ordered: true });
        if (!this.#attachChannel(record, control)) {
          throw new Error('control data channel could not be attached');
        }
        const state = peerConnection.createDataChannel(STATE_CHANNEL, {
          ordered: false,
          maxRetransmits: 0,
        });
        if (!this.#attachChannel(record, state)) {
          throw new Error('state data channel could not be attached');
        }
      } catch {
        this.#failPeer(record);
        return null;
      }
      void this.#startOffer(record);
    }
    return record;
  }

  async #startOffer(record) {
    try {
      const offer = await record.peerConnection.createOffer();
      if (!this.#isCurrent(record)) return;
      await record.peerConnection.setLocalDescription(offer);
      if (!this.#isCurrent(record)) return;
      const data = localDescriptionData(
        record.peerConnection.localDescription ?? offer,
        'offer',
        record.negotiationId,
      );
      if (data) await this.#sendSignal(record, data);
    } catch {
      if (this.#isCurrent(record)) this.#failPeer(record);
    }
  }

  #handleSignalEvent(event) {
    if (this.#closed) return;
    const sourceId = event?.detail?.sourceId;
    const data = event?.detail?.data;
    if (typeof sourceId !== 'string' || !isRecord(data)) return;
    let record = this.#peers.get(sourceId);
    if (!record || !this.#isCurrent(record)) return;
    if (!validNegotiationId(data.negotiationId)) return;
    if (record.initiator && data.negotiationId !== record.negotiationId) return;
    if (!record.initiator && data.type === 'offer') {
      if (record.negotiationId === data.negotiationId) return;
      if (this.#hasSeenNegotiation(sourceId, data.negotiationId)) return;
      if (record.negotiationId !== null) {
        this.#removePeer(record);
        record = this.#createPeer(sourceId, false);
        if (!record) return;
      }
      record.negotiationId = data.negotiationId;
      this.#rememberNegotiation(sourceId, data.negotiationId);
    }
    if (!record.initiator
      && data.type === 'ice'
      && record.negotiationId !== null
      && data.negotiationId !== record.negotiationId) return;

    if (data.type === 'ice') {
      this.#receiveIce(record, data);
      return;
    }
    if (record.initiator && data.type !== 'answer') return;
    if (!record.initiator && data.type !== 'offer') return;
    if (typeof data.sdp !== 'string') return;

    record.sdpChain = record.sdpChain.then(async () => {
      if (record.initiator) await this.#acceptAnswer(record, data);
      else await this.#acceptOffer(record, data);
    }).catch(() => {
      if (this.#isCurrent(record)) this.#failPeer(record);
    });
  }

  async #acceptAnswer(record, data) {
    await this.#setRemoteDescription(record, { type: 'answer', sdp: data.sdp });
  }

  async #acceptOffer(record, data) {
    const accepted = await this.#setRemoteDescription(record, { type: 'offer', sdp: data.sdp });
    if (!accepted || !this.#isCurrent(record)) return;
    const answer = await record.peerConnection.createAnswer();
    if (!this.#isCurrent(record)) return;
    await record.peerConnection.setLocalDescription(answer);
    if (!this.#isCurrent(record)) return;
    const response = localDescriptionData(
      record.peerConnection.localDescription ?? answer,
      'answer',
      record.negotiationId,
    );
    if (response) await this.#sendSignal(record, response);
  }

  async #setRemoteDescription(record, description) {
    if (!this.#isCurrent(record)) return false;
    await record.peerConnection.setRemoteDescription(description);
    if (!this.#isCurrent(record)) return false;
    record.remoteDescriptionSet = true;
    record.pendingIce = record.pendingIce.filter((entry) => (
      entry.negotiationId === record.negotiationId
    ));
    this.#drainIce(record);
    return true;
  }

  #receiveIce(record, data) {
    const candidate = incomingIceCandidate(data);
    if (candidate === INVALID_ICE) return;
    const retained = record.pendingIce.length + (record.iceInFlight ? 1 : 0);
    if (retained >= MAX_REMOTE_ICE_CANDIDATES) return;
    record.pendingIce.push({ candidate, negotiationId: data.negotiationId });
    this.#drainIce(record);
  }

  #drainIce(record) {
    if (!this.#isCurrent(record)
      || !record.remoteDescriptionSet
      || record.iceInFlight
      || record.pendingIce.length === 0) return;
    const { candidate } = record.pendingIce.shift();
    record.iceInFlight = true;
    Promise.resolve()
      .then(() => {
        if (!this.#isCurrent(record)) return undefined;
        return record.peerConnection.addIceCandidate(candidate);
      })
      .catch(() => {})
      .finally(() => {
        record.iceInFlight = false;
        if (this.#isCurrent(record)) this.#drainIce(record);
      });
  }

  async #sendSignal(record, data) {
    if (!this.#isCurrent(record)) return false;
    try {
      return (await this.#signaling.sendSignal(record.playerId, data)) !== false;
    } catch {
      return false;
    }
  }

  #attachChannel(record, dataChannel) {
    if (!dataChannel || !validChannelConfiguration(dataChannel)) {
      try {
        dataChannel?.close?.();
      } catch {
        // Ignore an unusable channel.
      }
      return false;
    }
    const label = dataChannel.label;
    const existing = record.channels.get(label);
    if (existing && existing !== dataChannel) {
      try {
        dataChannel.close();
      } catch {
        // Ignore a duplicate channel that cannot be closed.
      }
      return false;
    }
    if (existing === dataChannel) return true;

    const onOpen = () => {
      if (!this.#isCurrentChannel(record, label, dataChannel)) return;
      if (record.openChannels.has(label)) return;
      record.openChannels.add(label);
      if (record.openChannels.has(CONTROL_CHANNEL)
        && record.openChannels.has(STATE_CHANNEL)
        && !this.#rateLimitedRetryChains.has(record.playerId)) {
        this.#clearRetry(record.playerId);
      }
      if (label === CONTROL_CHANNEL) {
        this.#flushReliableQueue(record);
      }
      this.#dispatchChannelEvent('peer-open', record, label);
    };
    const onClose = () => {
      if (!this.#isCurrentChannel(record, label, dataChannel)) return;
      const wasOpen = record.openChannels.delete(label);
      if (wasOpen) this.#dispatchChannelEvent('peer-close', record, label);
      this.#failPeer(record);
    };
    const onMessage = (event) => {
      if (!this.#isCurrentChannel(record, label, dataChannel)) return;
      const bytes = inboundMessageBytes(event?.data);
      if (!this.#acceptInbound(record, label, bytes)) return;
      if (typeof event?.data !== 'string') return;
      if (bytes > MAX_PEER_MESSAGE_BYTES) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.dispatchEvent(new CustomEvent('peer-message', {
        detail: {
          playerId: record.playerId,
          channel: label,
          reliable: label === CONTROL_CHANNEL,
          message,
          hostEpoch: record.hostEpoch,
        },
      }));
    };
    const onBufferedAmountLow = () => {
      if (label === CONTROL_CHANNEL) this.#flushReliableQueue(record);
    };

    record.channels.set(label, dataChannel);
    record.channelHandlers.set(dataChannel, {
      onOpen,
      onClose,
      onMessage,
      onBufferedAmountLow,
    });
    dataChannel.addEventListener('open', onOpen);
    dataChannel.addEventListener('close', onClose);
    dataChannel.addEventListener('message', onMessage);
    dataChannel.addEventListener('bufferedamountlow', onBufferedAmountLow);
    try {
      dataChannel.bufferedAmountLowThreshold = Math.floor(this.#maxBufferedAmount / 2);
    } catch {
      // Some implementations expose a read-only threshold; capacity is still checked before send.
    }
    if (dataChannel.readyState === 'open') onOpen();
    return true;
  }

  #sendSerialized(record, serialized, reliable) {
    if (!this.#isCurrent(record)) return false;
    const label = reliable ? CONTROL_CHANNEL : STATE_CHANNEL;
    const dataChannel = record.channels.get(label);
    if (reliable && (record.flushingReliable || record.reliableQueue.length > 0)) {
      return this.#enqueueReliable(record, serialized);
    }
    if (dataChannel?.readyState === 'open' && this.#hasSendCapacity(dataChannel, serialized)) {
      try {
        dataChannel.send(serialized);
        return true;
      } catch {
        return reliable ? this.#enqueueReliable(record, serialized) : false;
      }
    }
    if (!reliable || this.#maxReliableQueue === 0) return false;

    return this.#enqueueReliable(record, serialized);
  }

  #canSendReliableBatch(record, serializedMessages) {
    if (!this.#isCurrent(record)) return false;
    if (record.flushingReliable || record.reliableQueue.length > 0) {
      return record.reliableQueue.length + serializedMessages.length <= this.#maxReliableQueue;
    }

    const dataChannel = record.channels.get(CONTROL_CHANNEL);
    if (dataChannel?.readyState !== 'open') {
      return serializedMessages.length <= this.#maxReliableQueue;
    }
    const bufferedAmount = typeof dataChannel.bufferedAmount === 'number'
      && Number.isFinite(dataChannel.bufferedAmount)
      && dataChannel.bufferedAmount >= 0
      ? dataChannel.bufferedAmount
      : Infinity;
    let projectedBufferedAmount = bufferedAmount;
    for (let index = 0; index < serializedMessages.length; index += 1) {
      const bytes = textEncoder.encode(serializedMessages[index]).byteLength;
      if (projectedBufferedAmount + bytes <= this.#maxBufferedAmount) {
        projectedBufferedAmount += bytes;
        continue;
      }
      return serializedMessages.length - index <= this.#maxReliableQueue;
    }
    return true;
  }

  #createNegotiationId(hostEpoch) {
    const negotiationId = `n${hostEpoch}-${this.#nextNegotiationSequence}`;
    this.#nextNegotiationSequence += 1;
    return negotiationId;
  }

  #hasSeenNegotiation(playerId, negotiationId) {
    return this.#seenNegotiations.get(playerId)?.set.has(negotiationId) === true;
  }

  #rememberNegotiation(playerId, negotiationId) {
    let ledger = this.#seenNegotiations.get(playerId);
    if (!ledger) {
      ledger = { order: [], set: new Set() };
      this.#seenNegotiations.set(playerId, ledger);
    }
    if (ledger.set.has(negotiationId)) return;
    ledger.order.push(negotiationId);
    ledger.set.add(negotiationId);
    while (ledger.order.length > this.#maxSeenNegotiations) {
      ledger.set.delete(ledger.order.shift());
    }
  }

  #enqueueReliable(record, serialized) {
    if (this.#maxReliableQueue === 0) return false;
    let dropped = false;
    if (record.reliableQueue.length >= this.#maxReliableQueue) {
      record.reliableQueue.shift();
      dropped = true;
    }
    record.reliableQueue.push(serialized);
    return !dropped;
  }

  #flushReliableQueue(record) {
    if (record.flushingReliable) return;
    const dataChannel = record.channels.get(CONTROL_CHANNEL);
    record.flushingReliable = true;
    try {
      while (
        this.#isCurrent(record)
        && dataChannel?.readyState === 'open'
        && record.reliableQueue.length > 0
        && this.#hasSendCapacity(dataChannel, record.reliableQueue[0])
      ) {
        dataChannel.send(record.reliableQueue[0]);
        record.reliableQueue.shift();
      }
    } catch {
      // Keep the unsent head queued so later messages cannot overtake it.
    } finally {
      record.flushingReliable = false;
    }
  }

  #hasSendCapacity(dataChannel, serialized) {
    const bufferedAmount = typeof dataChannel?.bufferedAmount === 'number'
      && Number.isFinite(dataChannel.bufferedAmount)
      && dataChannel.bufferedAmount >= 0
      ? dataChannel.bufferedAmount
      : Infinity;
    return bufferedAmount + textEncoder.encode(serialized).byteLength <= this.#maxBufferedAmount;
  }

  #dispatchChannelEvent(type, record, label) {
    this.dispatchEvent(new CustomEvent(type, {
      detail: {
        playerId: record.playerId,
        channel: label,
        reliable: label === CONTROL_CHANNEL,
        hostEpoch: record.hostEpoch,
      },
    }));
  }

  #acceptInbound(record, label, bytes) {
    let now;
    try {
      now = this.#clock.now();
    } catch {
      now = NaN;
    }
    if (typeof now !== 'number' || !Number.isFinite(now) || now < this.#lastClockTime) {
      this.#rateLimitedRetryChains.add(record.playerId);
      this.#dispatchInboundRateLimit(record, label, 'clock',
        record.inboundEvents.length + 1, record.inboundBytes + bytes);
      this.#failPeer(record);
      return false;
    }
    this.#lastClockTime = now;

    while (record.inboundEvents.length > 0
      && now - record.inboundEvents[0].receivedAt >= this.#inboundRateLimit.windowMs) {
      record.inboundBytes -= record.inboundEvents.shift().bytes;
    }
    record.inboundEvents.push({ receivedAt: now, bytes });
    record.inboundBytes += bytes;

    let reason = null;
    if (record.inboundEvents.length > this.#inboundRateLimit.maxMessages) reason = 'messages';
    else if (record.inboundBytes > this.#inboundRateLimit.maxBytes) reason = 'bytes';
    if (reason === null) return true;

    this.#rateLimitedRetryChains.add(record.playerId);
    this.#dispatchInboundRateLimit(
      record,
      label,
      reason,
      record.inboundEvents.length,
      record.inboundBytes,
    );
    this.#failPeer(record);
    return false;
  }

  #dispatchInboundRateLimit(record, label, reason, observedMessages, observedBytes) {
    this.dispatchEvent(new CustomEvent('peer-rate-limit', {
      detail: {
        playerId: record.playerId,
        channel: label,
        reliable: label === CONTROL_CHANNEL,
        hostEpoch: record.hostEpoch,
        reason,
        observedMessages,
        observedBytes,
        ...this.#inboundRateLimit,
      },
    }));
  }

  #isCurrent(record) {
    return !this.#closed
      && record.active
      && record.generation === this.#generation
      && this.#peers.get(record.playerId) === record;
  }

  #isCurrentChannel(record, label, dataChannel) {
    return this.#isCurrent(record) && record.channels.get(label) === dataChannel;
  }

  #removePeer(record) {
    if (this.#peers.get(record.playerId) === record) this.#peers.delete(record.playerId);
    this.#closePeer(record);
  }

  #failPeer(record) {
    if (!this.#isCurrent(record)) return;
    const { playerId, initiator, generation } = record;
    this.#removePeer(record);
    this.#scheduleRetry(playerId, initiator, generation);
  }

  #scheduleRetry(playerId, initiator, generation) {
    if (this.#closed || generation !== this.#generation || this.#retryTimers.has(playerId)) return;
    const attempt = this.#retryAttempts.get(playerId) ?? 0;
    if (attempt >= this.#retryDelaysMs.length) {
      this.#exhaustedRetries.add(playerId);
      return;
    }
    this.#exhaustedRetries.delete(playerId);
    this.#retryAttempts.set(playerId, attempt + 1);
    const timer = this.#timers.setTimeout(() => {
      this.#retryTimers.delete(playerId);
      if (this.#closed
        || generation !== this.#generation
        || this.#peers.has(playerId)
        || !this.#isDesiredPeer(playerId)) return;
      this.#createPeer(playerId, initiator);
    }, this.#retryDelaysMs[attempt]);
    this.#retryTimers.set(playerId, timer);
  }

  #isDesiredPeer(playerId) {
    if (!this.#topology || this.#topology.members.get(playerId)?.connected !== true) return false;
    if (this.#topology.isHost) return playerId !== this.#topology.selfId;
    return playerId === this.#topology.hostId;
  }

  #clearRetry(playerId) {
    const timer = this.#retryTimers.get(playerId);
    if (timer !== undefined) this.#timers.clearTimeout(timer);
    this.#retryTimers.delete(playerId);
    this.#retryAttempts.delete(playerId);
    this.#exhaustedRetries.delete(playerId);
    this.#rateLimitedRetryChains.delete(playerId);
  }

  #clearAllRetries() {
    for (const timer of this.#retryTimers.values()) this.#timers.clearTimeout(timer);
    this.#retryTimers.clear();
    this.#retryAttempts.clear();
    this.#exhaustedRetries.clear();
    this.#rateLimitedRetryChains.clear();
  }

  #closeAllPeers() {
    const records = [...this.#peers.values()];
    this.#peers.clear();
    for (const record of records) this.#closePeer(record);
  }

  #closePeer(record) {
    if (!record.active) return;
    record.active = false;
    record.reliableQueue.length = 0;
    record.pendingIce.length = 0;
    record.inboundEvents.length = 0;
    record.inboundBytes = 0;
    record.peerConnection.onicecandidate = null;
    record.peerConnection.ondatachannel = null;
    record.peerConnection.onconnectionstatechange = null;

    for (const [label, dataChannel] of record.channels) {
      if (record.openChannels.has(label)) this.#dispatchChannelEvent('peer-close', record, label);
      this.#detachChannelHandlers(record, dataChannel);
      try {
        dataChannel.close();
      } catch {
        // Ignore teardown failures from an already broken channel.
      }
    }
    record.channels.clear();
    record.openChannels.clear();
    try {
      record.peerConnection.close();
    } catch {
      // Peer teardown is best effort and must remain idempotent.
    }
  }

  #detachChannelHandlers(record, dataChannel) {
    const handlers = record.channelHandlers.get(dataChannel);
    if (!handlers) return;
    dataChannel.removeEventListener('open', handlers.onOpen);
    dataChannel.removeEventListener('close', handlers.onClose);
    dataChannel.removeEventListener('message', handlers.onMessage);
    dataChannel.removeEventListener('bufferedamountlow', handlers.onBufferedAmountLow);
    record.channelHandlers.delete(dataChannel);
  }
}
