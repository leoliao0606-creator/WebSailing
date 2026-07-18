# Multiplayer Private Race Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a complete 2–8 player private mark-racing flow with host-authoritative WebRTC, automatic host migration, best-effort integrity checks, temporary nicknames, AI takeover, and unrestricted text chat.

**Architecture:** A small always-on WebSocket service owns room membership, signaling, reconnection leases, and host epochs, but never advances game physics. The elected browser host runs a fixed-tick authoritative world and sends snapshots through an unreliable WebRTC data channel; reliable room, start, migration, and chat messages use a second data channel. Every guest caches checkpoints so the signaling service can elect a replacement host and resume the race after a short pause.

**Tech Stack:** Vite 7, Three.js 0.180, native browser WebRTC/Web Crypto APIs, Node.js 22, `ws`, Node's built-in test runner, and Playwright.

---

## Workflow gates

- **Pre-flight gate:** `node --test` and the existing production build must run before integration. A missing dependency or failing baseline blocks the affected task.
- **Revision gate:** Each task receives a spec review and then a code-quality review. A failure returns to the implementer, with at most three review cycles.
- **Escalation gate:** Requirements that would move physics to a dedicated server, add persistent identity, or require deployment credentials return to the user.
- **Abort gate:** Preserve the current files and stop if an unrecoverable dependency, filesystem, or test-runner failure occurs.

## Protocol invariants

- Room codes contain six unambiguous uppercase characters; rooms hold at most eight human seats.
- A player has a random `playerId`, opaque `resumeToken`, temporary nickname, join order, connection state, and ready state.
- Every authoritative message contains `roomCode`, monotonically increasing `hostEpoch`, and a simulation `tick` where applicable.
- A guest sends control intent only. Position, velocity, race progress, and results are never accepted as guest input.
- The host advances a 60 Hz outer tick; `BoatPhysics` keeps its two 120 Hz substeps.
- Continuous input and state use an unordered channel with no retransmission. Room lifecycle, start, checkpoints, migration, audit, and chat use a reliable ordered channel.
- Chat content is not filtered. Network safety still enforces a 500-character maximum and a rate limit.
- Host migration is coordinated by the signaling service. Peers ignore messages from stale host epochs.

### Task 1: Add the test harness and WebSocket dependency

**Objective:** Establish repeatable unit and browser test commands before production modules are added.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/smoke.test.js`

**Step 1: Write failing test**

Create a Node test that imports the planned `src/net/protocol.js` module and asserts `PROTOCOL_VERSION === 1`.

**Step 2: Run test to verify failure**

Run: `node --test tests/smoke.test.js`

Expected: FAIL because `src/net/protocol.js` does not exist.

**Step 3: Install infrastructure dependency and scripts**

- Add `ws` as a runtime dependency.
- Add scripts: `test`, `test:unit`, `test:multiplayer`, `signal`, and `serve`.
- Do not make the smoke test green until Task 2 creates the protocol module.

**Step 4: Verify baseline build**

Run: `npm run build`

Expected: PASS with the existing client.

### Task 2: Define and validate the wire protocol

**Objective:** Provide strict, testable message validation and canonical control intent before any socket code exists.

**Files:**
- Create: `src/net/protocol.js`
- Create: `tests/protocol.test.js`
- Modify: `tests/smoke.test.js`

**Required public API:**

```js
export const PROTOCOL_VERSION = 1;
export const MAX_PLAYERS = 8;
export const MAX_NICKNAME_LENGTH = 20;
export const MAX_CHAT_LENGTH = 500;
export function normalizeNickname(value) {}
export function normalizeRoomCode(value) {}
export function normalizeControlIntent(value) {}
export function validateSignalMessage(value) {}
export function validatePeerMessage(value, expectedEpoch) {}
```

**Step 1: Write failing tests**

Cover version/constants, Unicode nickname trimming without content filtering, room-code normalization, Boolean control intent fields, numeric sequence/tick bounds, chat truncation/rejection policy, stale epochs, and unknown message types.

**Step 2: Verify RED**

Run: `node --test tests/protocol.test.js tests/smoke.test.js`

Expected: FAIL on missing exports.

**Step 3: Implement the minimal protocol module**

Use explicit allowlists for signaling and peer message types. Return normalized immutable data or `{ ok: false, error }`; never pass arbitrary message objects into the game.

**Step 4: Verify GREEN**

Run: `node --test tests/protocol.test.js tests/smoke.test.js`

Expected: PASS.

### Task 3: Implement room membership, reconnection, and host election

**Objective:** Model room behavior independently of WebSockets and wall-clock timers.

**Files:**
- Create: `server/roomRegistry.js`
- Create: `tests/roomRegistry.test.js`

**Required public API:**

```js
export class RoomRegistry {
  constructor({ now = Date.now, randomBytes, reconnectGraceMs = 30_000 } = {}) {}
  createPlayer(nickname) {}
  createRoom(player) {}
  joinRoom(code, player) {}
  disconnect(playerId) {}
  resume({ roomCode, playerId, resumeToken }) {}
  removeExpired() {}
  setReady(playerId, ready) {}
  roomView(code) {}
}
```

**Step 1: Write failing tests**

Cover unique six-character codes, 2–8 membership, ninth-player rejection, ready state, host join order, immediate connected-host election after host loss, incremented `hostEpoch`, 30-second seat reservation, valid/invalid resume tokens, old host returning as a guest, and empty-room cleanup.

**Step 2: Verify RED**

Run: `node --test tests/roomRegistry.test.js`

Expected: FAIL because the registry is missing.

**Step 3: Implement minimal in-memory registry**

Keep timers outside the registry. Return explicit domain events such as `host-changed`, `member-left`, and `member-removed` so the WebSocket layer only translates events.

**Step 4: Verify GREEN**

Run: `node --test tests/roomRegistry.test.js`

Expected: PASS.

### Task 4: Build the signaling and static-serving process

**Objective:** Expose room creation/join/resume, SDP/ICE relay, readiness, host epochs, health checks, and production static files.

**Files:**
- Create: `server/signalingServer.js`
- Create: `server/index.js`
- Create: `tests/signalingServer.test.js`

**Required public API:**

```js
export async function createSignalingServer({
  port = 8787,
  host = '127.0.0.1',
  publicDir,
  reconnectGraceMs,
  hostLossMs,
  iceServers = [],
} = {}) {}
```

**Step 1: Write failing integration tests**

Using real `ws` clients, cover create/join, room views, targeted signal relay, rejection of cross-room targets, payload limits, ready broadcasts, host disconnect/election after injected short delay, resume, `/health`, and static-file path traversal rejection.

**Step 2: Verify RED**

Run: `node --test tests/signalingServer.test.js`

Expected: FAIL because the server module is missing.

**Step 3: Implement the server**

- Bind WebSocket upgrades at `/signal`.
- Enforce origin allowlist when configured, a 64 KiB maximum payload, and per-socket message rate limits.
- Parse `ICE_SERVERS_JSON`, `ALLOWED_ORIGINS`, `HOST_LOSS_MS`, and `RECONNECT_GRACE_MS` in `server/index.js`.
- Serve `dist/` with safe path resolution and correct MIME types when present.
- Expose a `close()` method for tests.

**Step 4: Verify GREEN**

Run: `node --test tests/signalingServer.test.js`

Expected: PASS with no leaked handles.

### Task 5: Implement the browser signaling client

**Objective:** Give the browser a reconnecting, event-driven API for rooms and host epochs.

**Files:**
- Create: `src/net/signalingClient.js`
- Create: `tests/signalingClient.test.js`

**Required public API:**

```js
export class SignalingClient extends EventTarget {
  constructor({ url, WebSocketImpl = WebSocket, storage = sessionStorage } = {}) {}
  connect() {}
  createRoom(nickname) {}
  joinRoom(roomCode, nickname) {}
  setReady(ready) {}
  sendSignal(targetId, data) {}
  leave() {}
}
```

**Step 1: Write failing tests**

Use a small fake WebSocket transport to cover URL construction, create/join sends, persisted resume credentials, automatic resume after reconnect, room-view updates, host-change events, stale socket suppression, and bounded exponential reconnect.

**Step 2: Verify RED**

Run: `node --test tests/signalingClient.test.js`

Expected: FAIL on missing module.

**Step 3: Implement minimal client**

Keep signaling state separate from gameplay. Dispatch typed `CustomEvent`s and expose a read-only state snapshot.

**Step 4: Verify GREEN**

Run: `node --test tests/signalingClient.test.js`

Expected: PASS.

### Task 6: Implement the host-star WebRTC transport

**Objective:** Maintain one reliable and one lossy DataChannel between the elected host and every guest, rebuilding topology after migration.

**Files:**
- Create: `src/net/peerTransport.js`
- Create: `tests/peerTransport.test.js`

**Required public API:**

```js
export class PeerTransport extends EventTarget {
  constructor({ signaling, RTCPeerConnectionImpl = RTCPeerConnection } = {}) {}
  reconcileTopology(roomView) {}
  sendToHost(message, { reliable = false } = {}) {}
  sendToPeer(playerId, message, { reliable = false } = {}) {}
  broadcast(message, { reliable = false } = {}) {}
  close() {}
}
```

**Step 1: Write failing tests**

With fake peer connections/data channels, cover host-offer ownership, guest answer, ICE forwarding, channel options, open/close events, host-only broadcast, stale-epoch rejection, teardown/rebuild on host change, and queued reliable messages with bounded memory.

**Step 2: Verify RED**

Run: `node --test tests/peerTransport.test.js`

Expected: FAIL.

**Step 3: Implement transport**

Create `control` as ordered/reliable and `state` as unordered with `maxRetransmits: 0`. The signaling server remains the only path used to exchange SDP and ICE.

**Step 4: Verify GREEN**

Run: `node --test tests/peerTransport.test.js`

Expected: PASS.

### Task 7: Make simulation inputs and environment reproducible

**Objective:** Separate keyboard sampling from authoritative control application and make wind/race randomness explicit.

**Files:**
- Modify: `src/game/boat.js`
- Modify: `src/game/input.js`
- Modify: `src/sim/wind.js`
- Modify: `src/game/ai.js`
- Create: `src/sim/random.js`
- Create: `tests/controlIntent.test.js`
- Create: `tests/seededEnvironment.test.js`

**Step 1: Write characterization and desired-behavior tests**

Cover `captureControlIntent()`, applying the same intent through local and remote paths, control slew limits, explicit wind seed equality, different-seed inequality, and deterministic AI initialization.

**Step 2: Verify RED**

Run: `node --test tests/controlIntent.test.js tests/seededEnvironment.test.js`

Expected: FAIL on the new APIs.

**Step 3: Refactor minimally**

- Add `Input.controlIntent()`.
- Add `Boat.applyControlIntent(intent, settings, dt, time)` and keep `applyInput()` as a compatibility wrapper.
- Add a small seeded PRNG and explicit seed setters for wind and AI.
- Preserve all offline controls and existing defaults.

**Step 4: Verify GREEN and regression**

Run: `node --test tests/controlIntent.test.js tests/seededEnvironment.test.js && npm run build && npm run polar`

Expected: PASS.

### Task 8: Define snapshots, interpolation, checkpoints, and integrity auditing

**Objective:** Serialize the authoritative world, drive remote visuals smoothly, and reject implausible or stale authority.

**Files:**
- Create: `src/net/worldState.js`
- Create: `src/net/snapshotBuffer.js`
- Create: `src/net/integrityMonitor.js`
- Create: `tests/worldState.test.js`
- Create: `tests/snapshotBuffer.test.js`
- Create: `tests/integrityMonitor.test.js`

**Required state fields:**

`x`, `z`, `psi`, `u`, `v`, `yawRate`, `phi`, `phiRate`, `boom`, `rudder`, `sheet`, `board`, `crewY`, `capsized`, `rightProgress`, control intermediates, race state, per-entry progress, tick, world time, seed, and host epoch.

**Step 1: Write failing tests**

Cover round-trip state, object-identity-independent race entries keyed by `boatId`, angular interpolation across ±π, 100–150 ms interpolation delay, bounded extrapolation, monotonic tick/epoch checks, finite numeric ranges, impossible displacement detection, and an audit result that invalidates without crashing the client.

**Step 2: Verify RED**

Run: `node --test tests/worldState.test.js tests/snapshotBuffer.test.js tests/integrityMonitor.test.js`

Expected: FAIL.

**Step 3: Implement minimal modules**

Keep JSON encoding for the first playable slice but isolate encode/decode behind functions so binary quantization can replace it later.

**Step 4: Verify GREEN**

Run the same command; expected PASS.

### Task 9: Build the multiplayer session coordinator

**Objective:** Connect signaling, peer transport, input cadence, snapshot cadence, reliable checkpoints, chat, audits, and role changes behind one API.

**Files:**
- Create: `src/net/multiplayerSession.js`
- Create: `tests/multiplayerSession.test.js`

**Required behavior:**

- Guests send their current control intent at 30 Hz with sequence/tick metadata.
- Hosts accept only the latest legal intent for the sending peer.
- Hosts send snapshots at 15–20 Hz and checkpoints every 500 ms.
- All role-sensitive messages carry and verify `hostEpoch`.
- A new host exposes the latest cached checkpoint before resuming.
- Chat is reliable, room-scoped, at most 500 characters, and rate-limited without inspecting content.

**Step 1: Write failing tests**

Use fake signaling/transport clocks. Cover cadence, input ownership, host relay, snapshot caching, stale host rejection, role transition, initial checkpoint after promotion, audit invalidation, chat relay, and spam throttling.

**Step 2: Verify RED**

Run: `node --test tests/multiplayerSession.test.js`

Expected: FAIL.

**Step 3: Implement coordinator**

The coordinator dispatches semantic events and never imports Three.js or DOM menu code.

**Step 4: Verify GREEN**

Run the same test; expected PASS.

### Task 10: Integrate an authoritative multiplayer race into `App`

**Objective:** Make a real host run all boats/race rules while guests predict locally and render authoritative remote state.

**Files:**
- Modify: `src/main.js`
- Modify: `src/game/boat.js`
- Modify: `src/game/race.js`
- Modify: `src/render/terrain.js`
- Create: `tests/raceSnapshot.test.js`

**Step 1: Write failing pure-state tests**

Cover stable `boatId` race entries, capture/apply of countdown/OCS/leg/finish state, promoted-host restoration, disconnected-human AI controller attachment, and local pause not stopping multiplayer time.

**Step 2: Verify RED**

Run: `node --test tests/raceSnapshot.test.js`

Expected: FAIL.

**Step 3: Integrate**

- Add a `multiplayer-race` mode without changing offline modes.
- Generalize spawning to stable boat/player IDs and up to eight human styles.
- Host: fixed 60 Hz accumulator, all player/AI inputs, physics, wind shadow, collisions, and `RaceManager` authority.
- Guest: local prediction/reconciliation; buffered interpolation for remote boats; host race state applied from snapshots.
- Move rescue reset to a host-approved command.
- Freeze briefly on migration; promoted host restores cached state and resumes under the new epoch.

**Step 4: Verify GREEN and offline regression**

Run: `node --test tests/raceSnapshot.test.js && npm run build && npm run polar`

Expected: PASS.

### Task 11: Add private-room lobby and unrestricted chat UI

**Objective:** Let players create/join a room, see connection/ready status, start with 2–8 humans, and chat before/during racing.

**Files:**
- Modify: `src/game/menu.js`
- Modify: `src/style.css`
- Modify: `src/i18n.js`
- Create: `src/game/chatPanel.js`
- Create: `tests/chatPanel.test.js`

**Step 1: Write failing DOM-behavior tests where practical**

Test chat model/history separately with a minimal fake document. Browser coverage in Task 13 verifies the real DOM.

**Step 2: Verify RED**

Run: `node --test tests/chatPanel.test.js`

Expected: FAIL.

**Step 3: Implement UI**

- Add “多人联机 / Multiplayer / マルチプレイ” to the main menu.
- Add nickname, create room, room-code join, copyable room code, member list, connection status, ready toggle, and host start button.
- Require at least two connected humans and all connected humans ready.
- Add an unobtrusive chat panel with local mute controls, no content filter, a 500-character counter, and send-rate feedback.
- Add host migration and integrity-invalidated banners.

**Step 4: Verify GREEN and language regression**

Run: `node --test tests/chatPanel.test.js && npm run build`

Expected: PASS.

### Task 12: Complete automatic host migration and AI takeover

**Objective:** Preserve a running race after host or guest loss with a bounded pause and rollback.

**Files:**
- Modify: `src/net/multiplayerSession.js`
- Modify: `src/main.js`
- Create: `tests/hostMigration.test.js`

**Step 1: Write failing scenario tests**

Cover host loss with two and eight players, election by connected join order, exactly one new epoch, stale-host snapshot rejection, newest cached checkpoint restoration, no more than the configured rollback window, absent-player AI takeover, returning player control restoration, and old host returning as a guest.

**Step 2: Verify RED**

Run: `node --test tests/hostMigration.test.js`

Expected: FAIL.

**Step 3: Implement migration state machine**

Use explicit states `running`, `migration-paused`, `promoting`, `reconnecting`, and `invalidated`. Resume when the new host has restored a checkpoint and reliable channels to all currently connected members are open, or after a bounded fallback timeout.

**Step 4: Verify GREEN**

Run the same test; expected PASS.

### Task 13: Add a real two-browser multiplayer test

**Objective:** Prove room creation, join, readiness, synchronized racing, chat, host loss, migration, and continued ticks through real WebRTC.

**Files:**
- Create: `tools/test-multiplayer.mjs`
- Modify: `package.json`

**Step 1: Write the failing Playwright test**

The script starts an ephemeral signaling server and Vite server, opens two isolated browser contexts, creates/joins a room, readies both players, starts the race, changes guest controls, checks both pages see the same two boats within tolerance, exchanges an uncensored Unicode chat message, closes the host page, waits for guest promotion, and verifies the race tick continues.

**Step 2: Verify RED**

Run: `npm run test:multiplayer`

Expected: FAIL before the UI/integration is complete.

**Step 3: Fix only integration gaps exposed by the test**

Do not weaken assertions. Add stable `data-testid` attributes rather than timing-dependent selectors.

**Step 4: Verify GREEN**

Run: `npm run test:multiplayer`

Expected: PASS and no browser console/page errors.

### Task 14: Document development and China-region deployment

**Objective:** Make local use and production signaling/TURN configuration reproducible.

**Files:**
- Modify: `README.md`
- Create: `.env.example`

**Step 1: Add documentation checks to the final review**

Verify the README names every required command and environment variable and clearly states that production requires HTTPS/WSS and a mainland-reachable STUN/TURN service.

**Step 2: Document**

Include local two-terminal startup, room flow, reverse-proxy expectations, `ICE_SERVERS_JSON` format, ephemeral TURN credential recommendation, ports/protocols, origin restrictions, reconnect/migration behavior, anti-cheat limitations, and future multi-region considerations.

**Step 3: Run final verification**

Run:

```bash
npm run test:unit
npm run build
npm run polar
npm run test:multiplayer
```

Expected: all commands PASS.

### Task 15: Final integration review

**Objective:** Confirm the entire vertical slice meets the agreed user requirements without regressing offline play.

**Review checklist:**

- [ ] Private room creation/join works with temporary nicknames.
- [ ] Two connected, ready humans can start; ninth human is rejected.
- [ ] Only the current host epoch advances authority.
- [ ] Guests never submit position, velocity, progress, or results.
- [ ] Wind, waves, race timing, wind shadow, collision, and results come from host state.
- [ ] A host departure promotes another browser and resumes the same race.
- [ ] Disconnected humans receive AI takeover and can reclaim control.
- [ ] Integrity violations invalidate the match visibly.
- [ ] Chat passes arbitrary Unicode content without filtering while respecting length/rate safety.
- [ ] Existing free sail, time trial, AI race, tutorial, settings, languages, ghost, and polar checks still work.
- [ ] Production build contains no signaling secrets.

Because the workspace has no usable Git repository, preserve a task-by-task test log and final changed-file summary instead of commits.
