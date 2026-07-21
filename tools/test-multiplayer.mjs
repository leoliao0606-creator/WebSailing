#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createSignalingServer } from '../server/signalingServer.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 低配/软渲染机器上游戏时钟远慢于实时,可用环境变量放宽
const STEP_TIMEOUT_MS = Number(process.env.E2E_STEP_TIMEOUT_MS) || 20_000;
const MIGRATION_TIMEOUT_MS = Number(process.env.E2E_MIGRATION_TIMEOUT_MS) || 12_000;
const POSITION_TOLERANCE_METERS = 8;
const SYSTEM_CHROMIUM_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function step(message) {
  process.stdout.write(`\n[multiplayer-e2e] ${message}\n`);
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function loadTooling() {
  let playwright;
  let vite;
  try {
    playwright = await import('playwright');
  } catch (error) {
    throw new Error(
      'Playwright is not installed. Run `npm install` before `npm run test:multiplayer`.',
      { cause: error },
    );
  }
  try {
    vite = await import('vite');
  } catch (error) {
    throw new Error(
      'Vite is not installed. Run `npm install` before `npm run test:multiplayer`.',
      { cause: error },
    );
  }
  return { chromium: playwright.chromium, createViteServer: vite.createServer };
}

async function chromiumLaunchOptions(chromium) {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (explicit) {
    if (!await exists(explicit)) {
      throw new Error(
        `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH does not exist: ${explicit}`,
      );
    }
    return { executablePath: explicit };
  }

  const bundled = chromium.executablePath();
  if (await exists(bundled)) return {};

  for (const candidate of SYSTEM_CHROMIUM_CANDIDATES) {
    if (await exists(candidate)) return { executablePath: candidate };
  }

  throw new Error(
    'No Chromium browser is available. Run `npx playwright install chromium`, '
      + 'or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a Chromium-compatible executable.',
  );
}

function testId(page, id) {
  return page.locator(`[data-testid="${id}"]`);
}

async function gameDiagnostics(page) {
  try {
    return await page.evaluate(() => {
      const game = window.__game;
      const lobby = game?.menu?.multiplayerLobby;
      return {
        mode: game?.mode ?? null,
        boatCount: game?.boats?.length ?? null,
        tick: game?.multiplayerController?.tick ?? null,
        controllerRole: game?.multiplayerController?.role ?? null,
        controllerMigrating: game?.multiplayerController?.migrating ?? null,
        snapshotBufferSize: game?.multiplayerController?.snapshotBuffer?.size ?? null,
        latestCheckpointTick: game?.multiplayerSession?.latestCheckpoint?.tick ?? null,
        latestCheckpointBytes: game?.multiplayerSession?.latestCheckpoint
          ? new TextEncoder().encode(JSON.stringify(game.multiplayerSession.latestCheckpoint)).byteLength
          : null,
        paused: game?.paused ?? null,
        netEvents: window.__multiplayerE2eNet ?? null,
        session: game?.multiplayerSession?.state ?? null,
        signaling: lobby?.stack?.signaling?.state ?? null,
        lobby: lobby ? {
          statusKey: lobby.statusKey,
          roomCommandPending: lobby.roomCommandPending,
          roomCode: lobby.state?.roomCode ?? null,
        } : null,
        visibleScreen: [...document.querySelectorAll('#menus > .screen.show')]
          .map((element) => element.id),
        onlineStatus: document.querySelector('[data-testid="multiplayer-status"]')?.textContent ?? null,
        lobbyStatus: document.querySelector('[data-testid="lobby-status"]')?.textContent ?? null,
      };
    });
  } catch {
    return null;
  }
}

async function waitForVisible(page, id, description) {
  try {
    await testId(page, id).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  } catch (error) {
    throw new Error(
      `${description} did not become visible within ${STEP_TIMEOUT_MS}ms. `
        + `Diagnostics: ${JSON.stringify(await gameDiagnostics(page))}`,
      { cause: error },
    );
  }
}

async function waitForGame(page, description, predicate, argument, timeout = STEP_TIMEOUT_MS) {
  try {
    await page.waitForFunction(predicate, argument, { timeout });
  } catch (error) {
    throw new Error(
      `${description} did not complete within ${timeout}ms. `
        + `Diagnostics: ${JSON.stringify(await gameDiagnostics(page))}`,
      { cause: error },
    );
  }
}

async function openGame(page, appUrl) {
  await page.goto(appUrl, { waitUntil: 'networkidle', timeout: STEP_TIMEOUT_MS });
  await waitForGame(
    page,
    'game bootstrap',
    () => window.__game?.mode === 'menu' && window.__game?.menu,
  );
}

async function openOnlineScreen(page) {
  await testId(page, 'multiplayer-button').click();
  await waitForVisible(page, 'multiplayer-online-screen', 'online multiplayer screen');
}

async function createRoom(page, nickname) {
  await openOnlineScreen(page);
  await testId(page, 'multiplayer-nickname').fill(nickname);
  await testId(page, 'multiplayer-create').click();
  await waitForVisible(page, 'multiplayer-lobby-screen', 'created-room lobby');
  await waitForGame(
    page,
    'room creation',
    () => {
      const code = document.querySelector('[data-testid="lobby-room-code"]')?.textContent?.trim();
      return Boolean(window.__game?.multiplayerSession?.state?.roomCode)
        && typeof code === 'string'
        && /^[A-Z2-9]{6}$/.test(code);
    },
  );
  return (await testId(page, 'lobby-room-code').textContent()).trim();
}

async function joinRoom(page, roomCode, nickname) {
  await openOnlineScreen(page);
  await testId(page, 'multiplayer-nickname').fill(nickname);
  await testId(page, 'multiplayer-room-code').fill(roomCode);
  await testId(page, 'multiplayer-join').click();
  await waitForVisible(page, 'multiplayer-lobby-screen', 'joined-room lobby');
  await waitForGame(
    page,
    'room join',
    (expectedCode) => {
      const state = window.__game?.multiplayerSession?.state;
      return state?.roomCode === expectedCode;
    },
    roomCode,
  );
}

async function readWorld(page) {
  return page.evaluate(() => {
    const game = window.__game;
    const controller = game.multiplayerController;
    return {
      mode: game.mode,
      tick: controller?.tick ?? null,
      worldTime: controller?.worldTime ?? null,
      role: controller?.role ?? null,
      session: game.multiplayerSession?.state ?? null,
      takeoverPlayerIds: controller ? [...controller.takeoverPlayerIds] : [],
      controlModes: controller
        ? Object.fromEntries(game.boats
          .filter((boat) => boat.playerId)
          .map((boat) => [boat.playerId, controller.controlModeFor(boat.playerId)]))
        : {},
      boats: game.boats.map((boat) => ({
        boatId: boat.boatId,
        playerId: boat.playerId,
        x: boat.phys.x,
        z: boat.phys.z,
        psi: boat.phys.psi,
        rudderCmd: boat.rudderCmd,
      })),
    };
  });
}

async function readWorldsWithinTickDrift(pages, maximumTicks, timeout = MIGRATION_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let worlds = [];
  do {
    worlds = await Promise.all(pages.map(readWorld));
    const authorityTick = worlds[0]?.tick;
    if (Number.isSafeInteger(authorityTick) && worlds.slice(1).every((world) => (
      Number.isSafeInteger(world?.tick) && Math.abs(world.tick - authorityTick) <= maximumTicks
    ))) {
      return worlds;
    }
    await Promise.all(pages.map((page) => page.waitForTimeout(50)));
  } while (Date.now() < deadline);

  throw new Error(
    `guest clocks did not converge within ${maximumTicks} ticks of authority: `
      + JSON.stringify(worlds.map((world) => world?.tick ?? null)),
  );
}

async function instrumentMultiplayer(page) {
  await page.evaluate(() => {
    const session = window.__game?.multiplayerSession;
    const counters = {
      snapshots: 0,
      checkpoints: 0,
      lastSnapshotTick: null,
      lastCheckpointTick: null,
      rejected: [],
      providerErrors: [],
      sessionErrors: [],
      peerRateLimits: [],
      peerCloses: [],
      peerOpens: [],
    };
    window.__multiplayerE2eNet = counters;
    session.addEventListener('snapshot', (event) => {
      counters.snapshots += 1;
      counters.lastSnapshotTick = event.detail?.snapshot?.tick ?? null;
    });
    session.addEventListener('checkpoint', (event) => {
      counters.checkpoints += 1;
      counters.lastCheckpointTick = event.detail?.checkpoint?.tick ?? null;
    });
    session.addEventListener('rejected-message', (event) => {
      counters.rejected.push(event.detail ?? null);
    });
    session.addEventListener('provider-error', (event) => {
      counters.providerErrors.push(event.detail ?? null);
    });
    session.addEventListener('session-error', (event) => {
      counters.sessionErrors.push(event.detail ?? null);
    });
    const transport = window.__game?.menu?.multiplayerLobby?.stack?.transport;
    transport.addEventListener('peer-rate-limit', (event) => {
      counters.peerRateLimits.push(event.detail ?? null);
    });
    transport.addEventListener('peer-close', (event) => {
      counters.peerCloses.push(event.detail ?? null);
    });
    transport.addEventListener('peer-open', (event) => {
      counters.peerOpens.push(event.detail ?? null);
    });
  });
}

function assertWorldsClose(hostWorld, guestWorld, expectedBoats = 3) {
  assert.equal(hostWorld.boats.length, expectedBoats, 'host should render every human boat');
  assert.equal(guestWorld.boats.length, expectedBoats, 'guest should render every human boat');
  const guestById = new Map(guestWorld.boats.map((boat) => [boat.boatId, boat]));
  for (const hostBoat of hostWorld.boats) {
    const guestBoat = guestById.get(hostBoat.boatId);
    assert.ok(guestBoat, `guest is missing authoritative boat ${hostBoat.boatId}`);
    const separation = Math.hypot(hostBoat.x - guestBoat.x, hostBoat.z - guestBoat.z);
    assert.ok(
      separation <= POSITION_TOLERANCE_METERS,
      `boat ${hostBoat.boatId} diverged by ${separation.toFixed(2)}m `
        + `(tolerance ${POSITION_TOLERANCE_METERS}m)`,
    );
  }
}

async function assertChatDelivered(pages, message) {
  await Promise.all(pages.map((page) => waitForGame(
    page,
    `chat delivery for ${JSON.stringify(message)}`,
    (expected) => document.querySelector('[data-testid="chat-log"]')?.textContent?.includes(expected),
    message,
  )));
}

async function startServers(createViteServer) {
  const signaling = await createSignalingServer({
    port: 0,
    host: '127.0.0.1',
    heartbeatMs: 100,
    hostLossMs: 250,
    reconnectGraceMs: 2_000,
  });

  const previousTarget = process.env.SIGNALING_TARGET;
  process.env.SIGNALING_TARGET = signaling.baseUrl;
  let vite = null;
  try {
    vite = await createViteServer({
      root: PROJECT_ROOT,
      logLevel: 'error',
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
      },
    });
    await vite.listen();
  } catch (error) {
    await vite?.close().catch(() => {});
    await signaling.close();
    throw error;
  } finally {
    if (previousTarget === undefined) delete process.env.SIGNALING_TARGET;
    else process.env.SIGNALING_TARGET = previousTarget;
  }

  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') {
    await vite.close();
    await signaling.close();
    throw new Error('Vite did not expose a TCP listening address');
  }
  return {
    signaling,
    vite,
    appUrl: `http://127.0.0.1:${address.port}/`,
  };
}

async function main() {
  const { chromium, createViteServer } = await loadTooling();
  const launchOptions = await chromiumLaunchOptions(chromium);
  let signaling = null;
  let vite = null;
  let browser = null;
  let hostContext = null;
  let guestContext = null;
  let observerContext = null;
  const pageErrors = [];
  const consoleErrors = [];

  try {
    step('starting ephemeral signaling and Vite servers');
    const servers = await startServers(createViteServer);
    ({ signaling, vite } = servers);
    const { appUrl } = servers;
    process.stdout.write(`[multiplayer-e2e] app: ${appUrl}\n`);
    process.stdout.write(`[multiplayer-e2e] signal: ${signaling.signalUrl}\n`);

    step('launching Chromium and three isolated browser contexts');
    try {
      browser = await chromium.launch({
        headless: true,
        timeout: STEP_TIMEOUT_MS,
        ...launchOptions,
        args: [
          '--enable-webgl',
          '--enable-unsafe-swiftshader',
          '--use-angle=swiftshader',
          // Isolated headless contexts cannot reliably resolve one another's
          // privacy-preserving .local ICE candidates in containerized CI.
          // This changes only the temporary test browser, never production.
          '--disable-features=WebRtcHideLocalIpsWithMdns',
        ],
      });
    } catch (error) {
      const executable = launchOptions.executablePath ?? chromium.executablePath();
      throw new Error(
        `Chromium could not start (${executable}). Install a Playwright browser with `
          + '`npx playwright install chromium`, or set '
          + 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a runnable executable.',
        { cause: error },
      );
    }

    hostContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 960, height: 600 } });
    guestContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 960, height: 600 } });
    observerContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 960, height: 600 } });
    // 软渲染 CI/低配机器:预置最低画质,避免三个 WebGL 实例把内存/CPU 打爆
    const lowQuality = () => {
      localStorage.setItem('windchaser.settings', JSON.stringify({
        quality: 'low', resScale: 0.5, shadowQ: 'off', waterDetail: 'low',
        effects: false, dynamicRes: false, ghost: false,
      }));
    };
    await hostContext.addInitScript(lowQuality);
    await guestContext.addInitScript(lowQuality);
    await observerContext.addInitScript(lowQuality);
    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();
    const observerPage = await observerContext.newPage();
    for (const [label, page] of [
      ['host', hostPage],
      ['guest', guestPage],
      ['observer', observerPage],
    ]) {
      page.setDefaultTimeout(STEP_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(STEP_TIMEOUT_MS);
      page.on('pageerror', (error) => pageErrors.push(`${label}: ${error.stack ?? error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') {
          const location = message.location();
          const source = location.url ? ` (${location.url}:${location.lineNumber})` : '';
          consoleErrors.push(`${label}: ${message.text()}${source}`);
        }
      });
    }

    await Promise.all([
      openGame(hostPage, appUrl),
      openGame(guestPage, appUrl),
      openGame(observerPage, appUrl),
    ]);

    step('creating and joining a private room');
    const roomCode = await createRoom(hostPage, '船长甲');
    await joinRoom(guestPage, roomCode, '水手乙');
    await joinRoom(observerPage, roomCode, '水手丙');
    await Promise.all([hostPage, guestPage, observerPage].map((page) => waitForGame(
      page,
      'three-member room view',
      (expectedCode) => {
        const state = window.__game?.multiplayerSession?.state;
        return state?.roomCode === expectedCode
          && state.members?.filter((member) => member.connected).length === 3;
      },
      roomCode,
    )));
    await Promise.all([hostPage, guestPage, observerPage].map((page) => waitForGame(
      page,
      'clean initial host assignment',
      () => {
        const lobby = window.__game?.menu?.multiplayerLobby;
        const banner = document.querySelector('[data-testid="multiplayer-status-banner"]');
        return lobby?.statusKey !== 'lobby.status.migrating' && banner?.hidden === true;
      },
    )));

    step('readying all players and waiting for the reliable WebRTC topology');
    await testId(hostPage, 'lobby-ready').click();
    await testId(guestPage, 'lobby-ready').click();
    await testId(observerPage, 'lobby-ready').click();
    await waitForGame(
      hostPage,
      'host start eligibility',
      () => {
        const button = document.querySelector('[data-testid="lobby-start"]');
        const members = window.__game?.multiplayerSession?.state?.members ?? [];
        return members.length === 3
          && members.every((member) => member.connected && member.ready)
          && button && !button.hidden && !button.disabled;
      },
    );

    await Promise.all([
      instrumentMultiplayer(hostPage),
      instrumentMultiplayer(guestPage),
      instrumentMultiplayer(observerPage),
    ]);

    step('starting a deterministic three-human authoritative race');
    await hostPage.evaluate(() => {
      window.__game.settings.aiCount = 0;
      window.__game.settings.countdown = 0;
    });
    await testId(hostPage, 'lobby-start').click();
    await Promise.all([hostPage, guestPage, observerPage].map((page) => waitForGame(
      page,
      'multiplayer race start',
      () => window.__game?.mode === 'multiplayer-race'
        && window.__game?.boats?.length === 3
        && Number.isSafeInteger(window.__game?.multiplayerController?.tick),
    )));

    // 诊断探针:记录 guest 端消息拒收与检查点流,失败时随诊断一并输出
    await guestPage.evaluate(() => {
      window.__probe = { rejects: [], invalidated: [], checkpoints: [] };
      const s = window.__game?.multiplayerSession;
      s?.addEventListener('message-rejected', (e) => window.__probe.rejects.push({ ...e.detail }));
      s?.addEventListener('invalidated', (e) => window.__probe.invalidated.push(e.detail));
      s?.addEventListener('checkpoint', (e) => window.__probe.checkpoints.push(e.detail?.checkpoint?.tick));
    });

    const guestPlayerId = await guestPage.evaluate(
      () => window.__game.multiplayerSession.state.playerId,
    );
    step('sending guest keyboard control through WebRTC to host authority');
    await guestPage.evaluate(() => {
      const canvas = document.querySelector('#app');
      canvas.tabIndex = -1;
      canvas.focus();
    });
    await guestPage.keyboard.down('ArrowLeft');
    await guestPage.keyboard.down('ArrowUp');
    await waitForGame(
      guestPage,
      'guest local control prediction',
      () => window.__game?.player?.rudderCmd < -0.2,
    );
    await waitForGame(
      hostPage,
      'guest control at host authority',
      (playerId) => window.__game?.boats
        ?.some((boat) => boat.playerId === playerId && boat.rudderCmd < -0.1),
      guestPlayerId,
    );
    await guestPage.keyboard.up('ArrowUp');
    await guestPage.keyboard.up('ArrowLeft');

    await waitForGame(
      hostPage,
      'authoritative tick progression',
      () => window.__game?.multiplayerController?.tick >= 45,
    );
    await guestPage.waitForTimeout(350);
    const hostWorld = await readWorld(hostPage);
    const guestWorld = await readWorld(guestPage);
    assert.equal(hostWorld.role, 'host');
    assert.equal(guestWorld.role, 'guest');
    assert.equal(hostWorld.session.phase, 'racing');
    assert.equal(guestWorld.session.phase, 'racing');
    assertWorldsClose(hostWorld, guestWorld, 3);
    const hostPlayerId = hostWorld.session.playerId;

    step('exchanging unrestricted Unicode chat in both directions');
    const hostMessage = '甲→乙：风正好 🧭 <script>不屏蔽</script>';
    const guestMessage = '乙→甲：收到，继续！⛵ & 自由聊天';
    await testId(hostPage, 'chat-input').fill(hostMessage);
    await testId(hostPage, 'chat-send').click();
    await assertChatDelivered([hostPage, guestPage, observerPage], hostMessage);
    await testId(guestPage, 'chat-input').fill(guestMessage);
    await testId(guestPage, 'chat-send').click();
    await assertChatDelivered([hostPage, guestPage, observerPage], guestMessage);
    assert.equal(
      await testId(hostPage, 'chat-log').locator('script').count(),
      0,
      'chat text must not create a script element',
    );

    step('closing the host and waiting for automatic guest promotion');
    const [authorityBeforeLoss] = await readWorldsWithinTickDrift(
      [hostPage, guestPage, observerPage],
      30,
    );
    const authorityTickBeforeHostLoss = authorityBeforeLoss.tick;
    const beforeLossDiagnostics = await Promise.all([
      gameDiagnostics(hostPage),
      gameDiagnostics(guestPage),
      gameDiagnostics(observerPage),
    ]);
    assert.ok(
      beforeLossDiagnostics[1]?.latestCheckpointTick >= authorityTickBeforeHostLoss - 30,
      `guest checkpoint is too old before host loss: ${JSON.stringify(beforeLossDiagnostics)}`,
    );
    const migrationStartedAt = Date.now();
    await hostContext.close();
    hostContext = null;
    await Promise.all([
      waitForGame(
        guestPage,
        `guest host promotion from authority tick ${authorityTickBeforeHostLoss}`,
        (previousTick) => {
          const game = window.__game;
          const state = game?.multiplayerSession?.state;
          const controller = game?.multiplayerController;
          return state?.role === 'host'
            && state.hostId === state.playerId
            && state.hostEpoch >= 2
            && state.migrating === false
            && state.invalidated === false
            && controller?.role === 'host'
            && controller.tick >= previousTick - 30;
        },
        authorityTickBeforeHostLoss,
        MIGRATION_TIMEOUT_MS,
      ),
      waitForGame(
        observerPage,
        `surviving guest migration recovery from authority tick ${authorityTickBeforeHostLoss}`,
        (previousTick) => {
          const game = window.__game;
          const state = game?.multiplayerSession?.state;
          const controller = game?.multiplayerController;
          return state?.role === 'guest'
            && state.hostId !== state.playerId
            && state.hostEpoch >= 2
            && state.migrating === false
            && state.invalidated === false
            && controller?.role === 'guest'
            && controller.tick >= previousTick - 30;
        },
        authorityTickBeforeHostLoss,
        MIGRATION_TIMEOUT_MS,
      ),
    ]);
    await Promise.all([guestPage, observerPage].map(async (page) => {
      await waitForGame(
        page,
        'migration keeps the racing UI unobstructed',
        () => window.__game?.mode === 'multiplayer-race'
          && !document.querySelector('[data-testid="multiplayer-lobby-screen"]')
            ?.classList.contains('show'),
        undefined,
        MIGRATION_TIMEOUT_MS,
      );
      assert.equal(
        await testId(page, 'multiplayer-lobby-screen').isVisible(),
        false,
        'host migration must not reopen the multiplayer lobby over the race',
      );
    }));
    const migrationElapsedMs = Date.now() - migrationStartedAt;
    assert.ok(
      migrationElapsedMs <= MIGRATION_TIMEOUT_MS,
      `migration took ${migrationElapsedMs}ms (budget ${MIGRATION_TIMEOUT_MS}ms)`,
    );
    const promoted = await readWorld(guestPage);
    assert.ok(
      promoted.tick >= authorityTickBeforeHostLoss - 30,
      `migration rolled back ${authorityTickBeforeHostLoss - promoted.tick} ticks (maximum 30)`,
    );
    await Promise.all([
      waitForGame(
        guestPage,
        'post-migration authoritative tick progression',
        (promotedTick) => window.__game?.multiplayerController?.role === 'host'
          && window.__game.multiplayerController.tick >= promotedTick + 30,
        promoted.tick,
        STEP_TIMEOUT_MS,
      ),
      waitForGame(
        observerPage,
        'post-migration guest snapshot progression',
        (promotedTick) => window.__game?.multiplayerController?.role === 'guest'
          && window.__game.multiplayerController.tick >= promotedTick + 20,
        promoted.tick,
        STEP_TIMEOUT_MS,
      ),
    ]);
    const continued = await readWorld(guestPage);
    const survivingGuest = await readWorld(observerPage);
    assert.equal(continued.boats.length, 3, 'AI takeover should preserve the disconnected host boat');
    assert.ok(continued.tick > promoted.tick, 'new host must continue the authoritative clock');
    assert.equal(continued.session.invalidated, false, 'migration must not invalidate the race');
    assert.equal(survivingGuest.session.invalidated, false, 'surviving guest must remain valid');
    assertWorldsClose(continued, survivingGuest, 3);
    assert.ok(
      continued.takeoverPlayerIds.includes(hostPlayerId),
      'the disconnected former host must be assigned to AI takeover',
    );
    assert.equal(
      continued.controlModes[hostPlayerId],
      'ai-takeover',
      'the disconnected former host boat must use AI controls',
    );
    assert.deepEqual(pageErrors, [], `unexpected browser page errors:\n${pageErrors.join('\n')}`);
    assert.deepEqual(consoleErrors, [], `unexpected browser console errors:\n${consoleErrors.join('\n')}`);

    step(
      `PASS — room ${roomCode}, synchronized 3 boats across 2 survivors, bidirectional chat, `
        + `epoch ${continued.session.hostEpoch}, migration ${migrationElapsedMs}ms, `
        + `tick ${promoted.tick}→${continued.tick}`,
    );
  } finally {
    await hostContext?.close().catch(() => {});
    await guestContext?.close().catch(() => {});
    await observerContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await vite?.close().catch(() => {});
    await signaling?.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`\n[multiplayer-e2e] FAIL\n${error.stack ?? error.message}\n`);
  let cause = error.cause;
  while (cause) {
    process.stderr.write(`Caused by: ${cause.stack ?? cause.message ?? String(cause)}\n`);
    cause = cause.cause;
  }
  process.exitCode = 1;
});
