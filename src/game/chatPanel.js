import { t } from '../i18n.js';

export const CHAT_MAX_LENGTH = 500;
export const CHAT_HISTORY_LIMIT = 100;

export function unicodeLength(value) {
  return [...String(value)].length;
}

function assertSession(value) {
  if (!value
    || typeof value.addEventListener !== 'function'
    || typeof value.removeEventListener !== 'function'
    || typeof value.sendChat !== 'function') {
    throw new TypeError('session must be an EventTarget with sendChat(text)');
  }
  return value;
}

function button(documentRef, testId, label) {
  const element = documentRef.createElement('button');
  element.type = 'button';
  element.setAttribute('data-testid', testId);
  element.textContent = label;
  return element;
}

export class ChatModel {
  constructor({
    historyLimit = CHAT_HISTORY_LIMIT,
    maxLength = CHAT_MAX_LENGTH,
    maxMessages = 5,
    windowMs = 5_000,
  } = {}) {
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
      throw new TypeError('historyLimit must be a positive integer');
    }
    if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
      throw new TypeError('maxLength must be a positive integer');
    }
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) {
      throw new TypeError('maxMessages must be a positive integer');
    }
    if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new TypeError('windowMs must be positive');
    }
    this.historyLimit = historyLimit;
    this.maxLength = maxLength;
    this.maxMessages = maxMessages;
    this.windowMs = windowMs;
    this.messages = [];
    this.mutedPlayerIds = new Set();
    this.outgoingTimes = [];
  }

  validate(text) {
    if (typeof text !== 'string') return { ok: false, error: 'type' };
    if (unicodeLength(text) > this.maxLength) return { ok: false, error: 'length' };
    return { ok: true, text };
  }

  add({ sourceId, text }) {
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new TypeError('sourceId must be a non-empty string');
    }
    const validated = this.validate(text);
    if (!validated.ok) throw new TypeError(`chat ${validated.error} is invalid`);
    const message = Object.freeze({ sourceId, text: validated.text });
    this.messages.push(message);
    if (this.messages.length > this.historyLimit) {
      this.messages.splice(0, this.messages.length - this.historyLimit);
    }
    return message;
  }

  toggleMute(playerId) {
    if (typeof playerId !== 'string' || playerId.length === 0) {
      throw new TypeError('playerId must be a non-empty string');
    }
    if (this.mutedPlayerIds.has(playerId)) {
      this.mutedPlayerIds.delete(playerId);
      return false;
    }
    this.mutedPlayerIds.add(playerId);
    return true;
  }

  isMuted(playerId) { return this.mutedPlayerIds.has(playerId); }

  get visibleMessages() {
    return this.messages.filter(({ sourceId }) => !this.mutedPlayerIds.has(sourceId));
  }

  rateAllowed(now) {
    if (typeof now !== 'number' || !Number.isFinite(now)) return false;
    const threshold = now - this.windowMs;
    this.outgoingTimes = this.outgoingTimes.filter((timestamp) => timestamp > threshold);
    return this.outgoingTimes.length < this.maxMessages;
  }

  recordOutgoing(now) {
    this.outgoingTimes.push(now);
  }

  resetRoom() {
    this.messages.length = 0;
    this.mutedPlayerIds.clear();
    this.outgoingTimes.length = 0;
  }
}

export class ChatPanel {
  constructor({
    documentRef = globalThis.document,
    mountRoot = documentRef?.body,
    session = null,
    model = new ChatModel(),
    now = () => Date.now(),
    translate = t,
  } = {}) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
      throw new TypeError('documentRef must provide createElement()');
    }
    if (!mountRoot || typeof mountRoot.append !== 'function') {
      throw new TypeError('mountRoot must provide append()');
    }
    if (!(model instanceof ChatModel)) throw new TypeError('model must be a ChatModel');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof translate !== 'function') throw new TypeError('translate must be a function');
    this.document = documentRef;
    this.model = model;
    this.now = now;
    this.translate = translate;
    this.session = null;
    this.listeners = [];
    this.collapsed = false;
    this.errorKey = null;
    this.rateLimitedDuringSend = false;
    this.roomCode = undefined;
    this._build();
    mountRoot.append(this.root);
    if (session) this.attachSession(session);
    else this.root.hidden = true;
  }

  get element() { return this.root; }

  _build() {
    const documentRef = this.document;
    this.root = documentRef.createElement('aside');
    this.root.classList.add('chat-panel');
    this.root.setAttribute('data-testid', 'chat-panel');
    this.root.setAttribute('aria-label', this.translate('chat.title'));

    const header = documentRef.createElement('div');
    header.classList.add('chat-header');
    this.heading = documentRef.createElement('span');
    this.heading.classList.add('chat-title');
    this.heading.textContent = this.translate('chat.title');
    this.toggleButton = button(documentRef, 'chat-toggle', this.translate('chat.collapse'));
    this.toggleButton.setAttribute('aria-expanded', 'true');
    this.toggleButton.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    header.append(this.heading, this.toggleButton);

    this.body = documentRef.createElement('div');
    this.body.classList.add('chat-body');
    this.body.setAttribute('data-testid', 'chat-body');

    this.muteList = documentRef.createElement('div');
    this.muteList.classList.add('chat-mute-list');
    this.muteList.setAttribute('aria-label', this.translate('chat.muteList'));

    this.log = documentRef.createElement('div');
    this.log.classList.add('chat-log');
    this.log.setAttribute('data-testid', 'chat-log');
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-live', 'polite');

    const composer = documentRef.createElement('div');
    composer.classList.add('chat-composer');
    this.input = documentRef.createElement('textarea');
    this.input.classList.add('chat-input');
    this.input.setAttribute('data-testid', 'chat-input');
    this.input.setAttribute('aria-label', this.translate('chat.input'));
    this.input.setAttribute('placeholder', this.translate('chat.placeholder'));
    // HTML maxlength counts UTF-16 code units, while the protocol counts Unicode code points.
    // Two code units per code point leaves room for 500 astral characters; JS still enforces 500.
    this.input.maxLength = CHAT_MAX_LENGTH * 2;
    this.input.rows = 2;

    const composerFooter = documentRef.createElement('div');
    composerFooter.classList.add('chat-composer-footer');
    this.counter = documentRef.createElement('span');
    this.counter.classList.add('chat-counter');
    this.counter.setAttribute('data-testid', 'chat-count');
    this.sendButton = button(documentRef, 'chat-send', this.translate('chat.send'));
    composerFooter.append(this.counter, this.sendButton);
    composer.append(this.input, composerFooter);

    this.error = documentRef.createElement('div');
    this.error.classList.add('chat-error');
    this.error.setAttribute('data-testid', 'chat-error');
    this.error.setAttribute('role', 'status');

    this.input.addEventListener('input', () => this._updateCounter());
    this.input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.shiftKey) {
        if (event.isComposing === true || event.keyCode === 229) return;
        event.preventDefault();
        this.send();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.input.blur();
      }
    });
    this.sendButton.addEventListener('click', () => this.send());

    this.body.append(this.muteList, this.log, composer, this.error);
    this.root.append(header, this.body);
    this._updateCounter();
  }

  attachSession(session) {
    assertSession(session);
    this._removeListeners();
    this.session = session;
    this._listen(session, 'chat', (event) => {
      try {
        this.model.add({ sourceId: event?.detail?.sourceId, text: event?.detail?.text });
        this._renderMessages();
      } catch {
        // The session validates inbound chat; malformed synthetic events are ignored by the UI.
      }
    });
    this._listen(session, 'statechange', () => this.refresh());
    this._listen(session, 'rolechange', () => this.refresh());
    this._listen(session, 'chat-rate-limited', (event) => {
      if (event?.detail?.sourceId === this.session?.state?.playerId) {
        this.rateLimitedDuringSend = true;
        this._showError('chat.error.rate');
      }
    });
    this.refresh();
    return this;
  }

  refresh() {
    const state = this.session?.state;
    const nextRoomCode = state?.roomCode ?? null;
    if (this.roomCode !== undefined && nextRoomCode !== this.roomCode) {
      this.model.resetRoom();
      this.input.value = '';
      this.errorKey = null;
      this.error.textContent = '';
      this._updateCounter();
    }
    this.roomCode = nextRoomCode;
    this.root.hidden = !state?.roomCode;
    this._renderMuteList();
    this._renderMessages();
  }

  refreshLanguage() {
    this.root.setAttribute('aria-label', this.translate('chat.title'));
    this.heading.textContent = this.translate('chat.title');
    this.toggleButton.textContent = this.translate(
      this.collapsed ? 'chat.expand' : 'chat.collapse',
    );
    this.muteList.setAttribute('aria-label', this.translate('chat.muteList'));
    this.input.setAttribute('aria-label', this.translate('chat.input'));
    this.input.setAttribute('placeholder', this.translate('chat.placeholder'));
    this.sendButton.textContent = this.translate('chat.send');
    if (this.errorKey) this.error.textContent = this.translate(this.errorKey);
    this._renderMuteList();
    this._renderMessages();
  }

  setCollapsed(collapsed) {
    this.collapsed = Boolean(collapsed);
    this.body.hidden = this.collapsed;
    this.root.classList.toggle('collapsed', this.collapsed);
    this.toggleButton.textContent = this.translate(
      this.collapsed ? 'chat.expand' : 'chat.collapse',
    );
    this.toggleButton.setAttribute('aria-expanded', String(!this.collapsed));
  }

  toggleMute(playerId) {
    const muted = this.model.toggleMute(playerId);
    this._renderMuteList();
    this._renderMessages();
    return muted;
  }

  send(text) {
    const outgoing = text === undefined ? this.input.value : text;
    const validated = this.model.validate(outgoing);
    if (!validated.ok) {
      this._showError(validated.error === 'length' ? 'chat.error.length' : 'chat.error.unavailable');
      return false;
    }
    if (!this.session || !this.session.state?.roomCode) {
      this._showError('chat.error.unavailable');
      return false;
    }
    const timestamp = Number(this.now());
    if (!this.model.rateAllowed(timestamp)) {
      this._showError('chat.error.rate');
      return false;
    }
    let accepted;
    this.rateLimitedDuringSend = false;
    try {
      accepted = this.session.sendChat(validated.text);
    } catch {
      this._showError('chat.error.unavailable');
      return false;
    }
    if (accepted === false) {
      this._showError(this.rateLimitedDuringSend ? 'chat.error.rate' : 'chat.error.unavailable');
      return false;
    }
    this.model.recordOutgoing(timestamp);
    this.errorKey = null;
    this.error.textContent = '';
    if (text === undefined || this.input.value === validated.text) {
      this.input.value = '';
      this._updateCounter();
    }
    return true;
  }

  _listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.listeners.push([target, type, listener]);
  }

  _removeListeners() {
    for (const [target, type, listener] of this.listeners) {
      target.removeEventListener(type, listener);
    }
    this.listeners.length = 0;
  }

  _memberName(playerId) {
    const member = this.session?.state?.members?.find((entry) => entry.playerId === playerId);
    return member?.nickname ?? playerId;
  }

  _renderMuteList() {
    const fragment = [];
    const localId = this.session?.state?.playerId;
    for (const member of this.session?.state?.members ?? []) {
      if (member.playerId === localId) continue;
      const muted = this.model.isMuted(member.playerId);
      const control = button(
        this.document,
        `chat-mute-${member.playerId}`,
        `${member.nickname ?? member.playerId} · ${this.translate(muted ? 'chat.unmute' : 'chat.mute')}`,
      );
      control.classList.add('chat-mute-button');
      control.setAttribute('aria-pressed', String(muted));
      control.addEventListener('click', () => this.toggleMute(member.playerId));
      fragment.push(control);
    }
    this.muteList.replaceChildren(...fragment);
  }

  _renderMessages() {
    const rows = this.model.visibleMessages.map((message) => {
      const row = this.document.createElement('div');
      row.classList.add('chat-message');
      const sender = this.document.createElement('span');
      sender.classList.add('chat-message-sender');
      sender.textContent = `${this._memberName(message.sourceId)}:`;
      const content = this.document.createElement('span');
      content.classList.add('chat-message-text');
      content.textContent = message.text;
      row.append(sender, content);
      return row;
    });
    this.log.replaceChildren(...rows);
    this.log.scrollTop = this.log.scrollHeight;
  }

  _updateCounter() {
    const count = unicodeLength(this.input.value);
    this.counter.textContent = `${count}/${CHAT_MAX_LENGTH}`;
    this.counter.classList.toggle('over-limit', count > CHAT_MAX_LENGTH);
    this.sendButton.disabled = count > CHAT_MAX_LENGTH;
  }

  _showError(key) {
    this.errorKey = key;
    this.error.textContent = this.translate(key);
  }

  destroy() {
    this._removeListeners();
    this.session = null;
    this.root.remove();
  }
}
