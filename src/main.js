// 逐风 WindChaser — 主程序：世界构建、模式状态机、游戏循环。

import './style.css';
import * as THREE from 'three';
import { DEG, KN, clamp, formatTime, wrapPi } from './util/math.js';
import { WaveField } from './sim/waves.js';
import { WindField } from './sim/wind.js';
import { ShadowedWind, shadowFactorAt } from './sim/windShadow.js';
import { createScene } from './render/sceneSetup.js';
import { Water } from './render/water.js';
import { createTerrain, createBuoy } from './render/terrain.js';
import { Input } from './game/input.js';
import { CameraRig } from './game/cameraRig.js';
import { AudioEngine } from './game/audio.js';
import { HUD } from './game/hud.js';
import { Boat } from './game/boat.js';
import { AIHelm } from './game/ai.js';
import { RaceCourse, RaceManager, saveBest, loadBest } from './game/race.js';
import { resolveBoatCollisions, resolveObstacleCollisions } from './sim/collision.js';
import { RulesEngine, PENALTY_SECONDS } from './game/rules.js';
import { GhostRecorder, GhostBoat, saveGhost, loadGhost } from './game/ghost.js';
import { Tutorial } from './game/tutorial.js';
import { Menu, loadSettings } from './game/menu.js';
import {
  buildRaceRoster,
  buildStartGrid,
  EMPTY_CONTROL_INTENT,
  MultiplayerRaceController,
  resolveRaceStartClock,
  restartModePolicy,
} from './game/multiplayerRace.js';
import { leaveOrCloseMultiplayer } from './net/multiplayerSession.js';
import { t } from './i18n.js';

const AI_STYLES = [
  { hullColor: 0xdce9f2, sailNumber: 12, accent: '#2b6ea8', nameKey: 'name.ai1' },
  { hullColor: 0xf2ecd9, sailNumber: 7, accent: '#b8860b', nameKey: 'name.ai2' },
  { hullColor: 0xdff2e4, sailNumber: 21, accent: '#2e7d4f', nameKey: 'name.ai3' },
];

const MULTIPLAYER_STYLES = [
  { hullColor: 0xf4f4f1, sailNumber: 8, accent: '#d84835' },
  { hullColor: 0xdce9f2, sailNumber: 12, accent: '#2b6ea8' },
  { hullColor: 0xf2ecd9, sailNumber: 7, accent: '#b8860b' },
  { hullColor: 0xdff2e4, sailNumber: 21, accent: '#2e7d4f' },
  { hullColor: 0xeadff2, sailNumber: 31, accent: '#74499b' },
  { hullColor: 0xf2dfdf, sailNumber: 44, accent: '#a43d55' },
  { hullColor: 0xdff0ef, sailNumber: 56, accent: '#267d82' },
  { hullColor: 0xe7e5d9, sailNumber: 68, accent: '#555c28' },
];

export class App {
  constructor() {
    const canvas = document.getElementById('app');
    const { renderer, scene, camera, sunDir, sunLight, followShadow } = createScene(canvas);
    Object.assign(this, { renderer, scene, camera, sunLight, followShadow });

    this.settings = loadSettings();
    this.waveField = new WaveField();
    this.wind = new WindField();
    this.shadowWind = new ShadowedWind(this.wind); // 叠加船间风影的风场代理
    this.water = new Water(this.waveField, sunDir);
    scene.add(this.water.mesh);
    this.islands = createTerrain(scene);

    this.input = new Input(canvas);
    this.cameraRig = new CameraRig(camera);
    this.audio = new AudioEngine();
    this.hud = new HUD();
    this.menu = new Menu(this);

    this.mode = 'menu';
    this.paused = false;
    this.time = 0;
    this.boats = [];
    this.player = null;
    this.race = null;
    this.tutorial = null;
    this.aiHelms = [];
    this.tutorialMark = null;
    this._resultsShown = false;
    this._prevCount = null;
    this.fps = 60;          // 平滑帧率（HUD 显示 + 动态分辨率）
    this._fpsCap = 30;      // 观测到的刷新率上限
    this._dynFactor = 1;    // 动态分辨率当前缩放
    this._dynT = 0;
    this.multiplayerSession = null;
    this.multiplayerController = null;
    this._multiplayerListeners = [];
    this._multiplayerHelms = new Map();
    this._multiplayerStart = null;

    this.applySettings();
    this._setupMenuScene();
    this.menu.show('menu-main');
    this.menu.refreshBest();

    // 首次交互启动音频
    window.addEventListener('pointerdown', () => this.audio.start(), { once: true });
    window.addEventListener('keydown', () => this.audio.start(), { once: true });

    this._last = performance.now() / 1000;
    requestAnimationFrame(this._frame.bind(this));
    window.__game = this; // 调试/自动化测试钩子
  }

  // —— 设置应用 ——
  applySettings() {
    const s = this.settings;
    this.wind.setBase(this.wind.baseFromPsi, s.windKn);
    this.wind.gustiness = s.gustiness;
    this.waveField.setConditions(this.wind.baseFromPsi, s.windKn);
    this.audio.setVolume(s.volume);

    // —— 画质 ——
    this._applyPixelRatio();
    const shadowOn = s.shadowQ !== 'off';
    if (this.renderer.shadowMap.enabled !== shadowOn) {
      this.renderer.shadowMap.enabled = shadowOn;
      // 阴影开关需要材质重编译才生效
      this.scene.traverse((o) => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      });
    }
    const mapSize = { medium: 1024, high: 2048, ultra: 4096 }[s.shadowQ] ?? 2048;
    if (this.sunLight.shadow.mapSize.x !== mapSize) {
      this.sunLight.shadow.mapSize.set(mapSize, mapSize);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
    this.water.setDetail(s.waterDetail);
    for (const b of this.boats) b.effects.setEnabled(s.effects);
  }

  _applyPixelRatio() {
    const s = this.settings;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pr = clamp(dpr * s.resScale * (s.dynamicRes ? this._dynFactor : 1), 0.5, 3);
    if (Math.abs(this.renderer.getPixelRatio() - pr) > 0.01) this.renderer.setPixelRatio(pr);
  }

  // 语言切换（菜单自身已重建）：刷新帮助面板与教学卡片
  onLanguageChanged() {
    this.hud.renderHelp();
    if (this.tutorial && !this.tutorial.done) this.tutorial.refreshText();
  }

  _newWindDirection() {
    const psi = -0.65 + (Math.random() - 0.5) * 0.9;
    this.wind.setBase(psi, this.settings.windKn);
    this.waveField.setConditions(psi, this.settings.windKn);
  }

  // —— 模式管理 ——
  _clearBoats() {
    for (const b of this.boats) b.dispose();
    this.boats = [];
    this.aiHelms = [];
    this.player = null;
    this._multiplayerHelms.clear();
  }

  _clearMode() {
    this.multiplayerController?.detach();
    this.multiplayerController = null;
    this._clearBoats();
    this.race?.course?.dispose();
    this.race = null;
    this.rules = null;
    this._contacts = [];
    this.ghost?.dispose();
    this.ghost = null;
    this.ghostRec = null;
    this.tutorial?.hide();
    this.tutorial = null;
    this.setTutorialMark(null);
    this.hud.setBanner('');
    this._resultsShown = false;
    this._prevCount = null;
    this._prevPenalty = null;
  }

  // —— 多人会话 API（房间 UI 只需要依赖这三个公开入口）——
  attachMultiplayer(session) {
    if (!session
      || typeof session.addEventListener !== 'function'
      || typeof session.startRace !== 'function') {
      throw new TypeError('multiplayer session must provide EventTarget and startRace() APIs');
    }
    this.multiplayerController?.detach();
    for (const [target, type, listener] of this._multiplayerListeners) {
      target.removeEventListener(type, listener);
    }
    this._multiplayerListeners = [];
    this.multiplayerSession = session;

    const onStart = (event) => this._beginMultiplayerRace(event.detail);
    const onState = (event) => {
      if (this.multiplayerController && Array.isArray(event.detail?.members)) {
        this.multiplayerController.syncRoom(event.detail);
      }
    };
    session.addEventListener('start-race', onStart);
    session.addEventListener('statechange', onState);
    this._multiplayerListeners.push(
      [session, 'start-race', onStart],
      [session, 'statechange', onState],
    );
    return this;
  }

  attachMultiplayerSession(session) {
    return this.attachMultiplayer(session);
  }

  startMultiplayerRace(options = {}) {
    if (!this.multiplayerSession) throw new Error('attach a multiplayer session before starting');
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('multiplayer race options must be an object');
    }
    const state = this.multiplayerSession.state;
    const tick = options.tick ?? this.multiplayerController?.tick ?? 0;
    const nested = options.config ?? options;
    const countdown = nested.countdown ?? this.settings.countdown;
    const roomMembers = state.members ?? [];
    const roster = nested.roster ?? roomMembers.map((member) => ({
      playerId: member.playerId,
      nickname: member.nickname ?? member.playerId,
    }));
    const seed = options.seed ?? `${state.roomCode}:${state.hostEpoch}:${tick}`;
    const windPsi = nested.windPsi ?? (-0.65 + (Math.random() - 0.5) * 0.9);
    const config = {
      windPsi,
      windKn: nested.windKn ?? this.settings.windKn,
      gustiness: nested.gustiness ?? this.settings.gustiness,
      countdown,
      startTick: nested.startTick ?? tick + countdown * 60,
      roster,
      aiFill: nested.aiFill ?? 0,
      penaltyMode: nested.penaltyMode ?? this.settings.penaltyMode,
    };
    return this.multiplayerSession.startRace({ tick, seed, config });
  }

  _beginMultiplayerRace(start) {
    const config = start?.config;
    if (!config) throw new TypeError('authoritative multiplayer start config is required');
    const localPlayerId = this.multiplayerSession?.state?.playerId ?? null;
    const roster = buildRaceRoster({
      roster: config.roster,
      aiFill: config.aiFill,
      localPlayerId,
    });
    const raceClock = resolveRaceStartClock({
      tick: start.tick,
      startTick: config.startTick,
    });

    this._clearMode();
    this.mode = 'multiplayer-race';
    this._raceAi = config.aiFill;
    this._multiplayerStart = start;
    this.time = raceClock.worldTime;
    this.wind.setSeed(start.seed);
    this.wind.time = 0;
    this.wind.setBase(config.windPsi, config.windKn);
    this.wind.gustiness = config.gustiness;
    this.waveField.time = 0;
    this.waveField.setConditions(config.windPsi, config.windKn);

    const course = new RaceCourse(this.scene, this.waveField, config.windPsi);
    const down = { x: -Math.sin(course.windPsi), z: Math.cos(course.windPsi) };
    const right = { x: Math.cos(course.windPsi), z: Math.sin(course.windPsi) };
    const mkSlot = (lat, lon) => ({
      x: course.lineMid.x + right.x * lat + down.x * lon,
      z: course.lineMid.z + right.z * lat + down.z * lon,
    });
    const racers = [];
    const startGrid = buildStartGrid(roster.length);
    for (let index = 0; index < roster.length; index += 1) {
      const member = roster[index];
      const style = MULTIPLAYER_STYLES[index % MULTIPLAYER_STYLES.length];
      const boat = new Boat(this.scene, this.waveField, {
        ...style,
        boatId: member.boatId,
        playerId: member.playerId,
        nickname: member.nickname,
        isLocal: member.isLocal,
        isPlayer: member.isLocal,
        nameKey: member.isHuman ? 'name.player' : (AI_STYLES[member.aiIndex % AI_STYLES.length]?.nameKey ?? 'name.ai1'),
      });
      boat.effects.setEnabled(this.settings.effects);
      boat.isHuman = member.isHuman;
      boat.aiIndex = member.aiIndex ?? null;
      const { lateral, downwind: startDownwind } = startGrid[index];
      const slot = mkSlot(lateral, startDownwind);
      boat.place(slot.x, slot.z, wrapPi(course.windPsi + (82 + (index % 3) * 4) * DEG), 1);
      boat.slot = mkSlot(lateral, 12);
      boat.slot.lineTarget = mkSlot(lateral, -30);
      this.boats.push(boat);
      racers.push(boat);
      const helm = new AIHelm(boat, 0.86 + (index % 5) * 0.035, `${start.seed}:helm:${boat.boatId}`);
      helm.course = course;
      this._multiplayerHelms.set(boat.boatId, helm);
      if (member.isLocal) this.player = boat;
    }
    if (!this.player) throw new Error('local player is missing from the multiplayer roster');
    this.cameraRig.pos.set(this.player.phys.x - 12, 5, this.player.phys.z + 12);
    this.race = new RaceManager(course, racers, raceClock.countdown);
    this.race.t = raceClock.raceTime;
    // 所有参与者(host 与 guest)都持有规则引擎:guest 平时不调 update,
    // 迁移晋升为 host 后免接线继续判罚(处罚状态经 checkpoint 的 boat.rules 恢复)
    this.rules = new RulesEngine(this.wind, { mode: config.penaltyMode ?? 'turns' });

    this.multiplayerController = new MultiplayerRaceController({
      session: this.multiplayerSession,
      boats: this.boats,
      race: this.race,
      seed: start.seed,
      localPlayerId,
      tick: raceClock.tick,
      startTick: raceClock.startTick,
      worldTime: raceClock.worldTime,
      controlProvider: () => (this.paused ? EMPTY_CONTROL_INTENT : this.input.controlIntent()),
      authorityStep: (context) => this._multiplayerAuthorityStep(context),
      predictionStep: (context) => this._multiplayerPredictionStep(context),
      onAuthoritySnapshot: (state) => this._applyAuthoritativeEnvironment(state),
      onApplyEnvironment: (state) => this._applyAuthoritativeEnvironment(state),
      onRescueRequest: ({ playerId }) => this._approveMultiplayerRescue(playerId),
    });
    this.multiplayerController.syncRoom(this.multiplayerSession.state);
    this.menu.hideAll();
    this.hud.toast(t('toast.raceReady', { s: config.countdown }), 3.5);
  }

  _setupMenuScene() {
    // 主菜单背景：一条 AI 帆船自在巡航
    this._clearMode();
    this.mode = 'menu';
    this._newWindDirection();
    const demo = new Boat(this.scene, this.waveField, { ...AI_STYLES[0], isPlayer: false });
    demo.effects.setEnabled(this.settings.effects);
    const w = this.wind.baseFromPsi;
    demo.place(40, -30, wrapPi(w + 100 * DEG), 2.5);
    this.boats = [demo];
    this.demoHelm = new AIHelm(demo, 1);
    this._demoWaypoints = [
      { x: 150, z: -120 }, { x: 220, z: 60 }, { x: 20, z: 120 }, { x: -120, z: -20 },
    ];
    this._demoWp = 0;
  }

  startFree() {
    this._clearMode();
    this.mode = 'free';
    this._newWindDirection();
    this._spawnPlayer(0, 0);
    this.menu.hideAll();
    this.hud.toast(t('toast.free'), 3.5);
  }

  startRace(aiCount) {
    this._clearMode();
    this.mode = 'race';
    this._raceAi = aiCount;
    this._newWindDirection();
    const course = new RaceCourse(this.scene, this.waveField, this.wind.baseFromPsi);
    // 出发区：起航线下风 40~65m
    const down = { x: -Math.sin(course.windPsi), z: Math.cos(course.windPsi) };
    const right = { x: Math.cos(course.windPsi), z: Math.sin(course.windPsi) };
    const mkSlot = (lat, lon) => ({
      x: course.lineMid.x + right.x * lat + down.x * lon,
      z: course.lineMid.z + right.z * lat + down.z * lon,
    });
    this._spawnPlayer(mkSlot(10, 55).x, mkSlot(10, 55).z, wrapPi(course.windPsi + 90 * DEG));
    const racers = [this.player];
    for (let i = 0; i < aiCount; i++) {
      const st = AI_STYLES[i % AI_STYLES.length];
      const ai = new Boat(this.scene, this.waveField, { ...st, isPlayer: false });
      ai.effects.setEnabled(this.settings.effects);
      ai.aiIndex = i;
      const slot = mkSlot(-15 - i * 22, 45 + i * 8);
      ai.place(slot.x, slot.z, wrapPi(course.windPsi + 80 * DEG), 1);
      ai.slot = mkSlot(-12 - i * 20, 12);
      ai.slot.lineTarget = mkSlot(-10 - i * 18, -30);
      const helm = new AIHelm(ai, 0.86 + i * 0.07);
      helm.course = course; // 起航偏向有利端需要起航线两端位置
      this.aiHelms.push(helm);
      this.boats.push(ai);
      racers.push(ai);
    }
    this.race = new RaceManager(course, racers, this.settings.countdown);
    this.rules = new RulesEngine(this.wind, { mode: this.settings.penaltyMode });
    // 幽灵船：回放该风速/该模式下的个人最佳轨迹
    this.ghostRec = new GhostRecorder(course);
    const ghostData = this.settings.ghost ? loadGhost(this.settings.windKn, aiCount) : null;
    if (ghostData) this.ghost = new GhostBoat(this.scene, course, ghostData);
    this.menu.hideAll();
    this.hud.toast(
      t(aiCount ? 'toast.raceReady' : 'toast.trialReady', { s: this.settings.countdown }) +
      (ghostData ? t('toast.ghost') : ''), 3.5);
  }

  startTutorial() {
    this._clearMode();
    this.mode = 'tutorial';
    // 教学用温和风况
    this.wind.setBase(-0.5, 9);
    this.wind.gustiness = 0.15;
    this.waveField.setConditions(-0.5, 9);
    this._spawnPlayer(0, 0);
    this.tutorial = new Tutorial(this);
    this.tutorial.start();
    this.menu.hideAll();
  }

  _spawnPlayer(x, z, psi = null) {
    const heading = psi ?? wrapPi(this.wind.baseFromPsi + 100 * DEG);
    const p = new Boat(this.scene, this.waveField, { isPlayer: true, sailNumber: 8, nameKey: 'name.you' });
    p.effects.setEnabled(this.settings.effects);
    p.place(x, z, heading, 1.5);
    this.player = p;
    this.boats.push(p);
    this.cameraRig.pos.set(x - 12, 5, z + 12);
  }

  toMainMenu() {
    if (this.multiplayerSession?.state?.roomCode) {
      leaveOrCloseMultiplayer(this.multiplayerSession);
    }
    this.paused = false;
    this._setupMenuScene();
    this.applySettings();
    this.menu.show('menu-main');
    this.menu.refreshBest();
  }

  restartMode() {
    const policy = restartModePolicy(this.mode, this.paused);
    if (!policy.restart) return;
    this.paused = policy.paused;
    if (this.mode === 'race') this.startRace(this._raceAi);
    else if (this.mode === 'tutorial') this.startTutorial();
    else this.startFree();
  }

  pause() {
    if (this.mode === 'menu') return;
    this.paused = true;
    this.menu.show('menu-pause');
  }

  resume() {
    this.paused = false;
    this.menu.hideAll();
  }

  setTutorialMark(pos) {
    if (this.tutorialMark) {
      this.scene.remove(this.tutorialMark);
      this.tutorialMark = null;
    }
    if (pos) {
      this.tutorialMark = createBuoy(0xffa321, true);
      this.tutorialMark.scale.setScalar(1.6);
      this.tutorialMark.position.set(pos.x, 0, pos.z);
      this.scene.add(this.tutorialMark);
    }
  }

  // —— 全局按键 ——
  _hotkeys() {
    const inp = this.input;
    if (inp.pressed('escape')) {
      if (this.mode === 'menu') { /* 主菜单无操作 */ }
      else if (this.paused) this.resume();
      else if (this.tutorial && !this.tutorial.done) this.toMainMenu();
      else this.pause();
    }
    if (this.mode === 'menu' || this.paused) return;
    if (inp.pressed('c')) this.cameraRig.cycle();
    if (inp.pressed('h')) this.hud.toggleHelp();
    if (inp.pressed('n') && this.tutorial && !this.tutorial.done) this.tutorial.skip();
    if (inp.pressed('t')) {
      if (this.mode === 'multiplayer-race') {
        this.multiplayerSession?.requestRescue();
        return;
      }
      // 救援复位：原地扶正
      this._resetBoat(this.player);
      this.hud.toast(t('toast.reset'));
    }
  }

  // —— 主循环 ——
  _frame(tms) {
    requestAnimationFrame(this._frame.bind(this));
    const now = tms / 1000;
    const rawDt = clamp(now - this._last, 1e-3, 0.25);
    let dt = clamp(now - this._last, 0, 0.09);
    this._last = now;
    if (this.paused && this.mode !== 'multiplayer-race') dt = 0;

    // 帧率统计 + 动态分辨率：掉帧时降低渲染分辨率，充裕时恢复。
    // 阈值相对观测到的刷新率上限（封顶 60），兼容高刷/低刷屏。
    this.fps += (1 / rawDt - this.fps) * 0.06;
    this._fpsCap = Math.max(this._fpsCap, Math.min(this.fps, 144));
    this._dynT += rawDt;
    if (this._dynT > 1.5) {
      this._dynT = 0;
      if (this.settings.dynamicRes) {
        const ref = Math.min(60, this._fpsCap);
        if (this.fps < ref * 0.82 && this._dynFactor > 0.55) {
          this._dynFactor = Math.max(0.55, this._dynFactor - 0.1);
          this._applyPixelRatio();
        } else if (this.fps > ref * 0.96 && this._dynFactor < 1) {
          this._dynFactor = Math.min(1, this._dynFactor + 0.05);
          this._applyPixelRatio();
        }
      } else if (this._dynFactor !== 1) {
        this._dynFactor = 1;
        this._applyPixelRatio();
      }
    }

    this._hotkeys();

    if (this.mode === 'multiplayer-race' && this.multiplayerController) {
      this.multiplayerController.setLocalPaused(this.paused);
      this.multiplayerController.advanceFrame(dt, { now: tms });
      this.time = this.multiplayerController.worldTime;
      if (this.multiplayerController.role === 'guest') {
        this.multiplayerController.sampleRemoteBoats({ now: tms });
      }
      this._renderMultiplayer(Math.max(dt, 1e-4));
    } else if (dt > 0) {
      this.time += dt;
      this.wind.update(dt);
      this.waveField.update(dt);

      if (this.mode === 'menu') this._updateDemo(dt);
      else this._updateGame(dt);
    }

    // 渲染
    const camTarget = this.player ?? this.boats[0];
    if (camTarget) {
      this.cameraRig.update(this.input, camTarget, this.waveField, Math.max(dt, 1e-4), this.input.down('v'));
      this.followShadow(camTarget.phys.x, camTarget.phys.z);
    }
    this.water.update(this.wind, this.camera.position.x, this.camera.position.z);
    if (this.tutorialMark) {
      const w = this.waveField.sample(this.tutorialMark.position.x, this.tutorialMark.position.z);
      this.tutorialMark.position.y = w.y;
    }
    this.renderer.render(this.scene, this.camera);
    this.hud.draw(this, Math.max(dt, 1e-4));
    this.input.endFrame();
  }

  _updateDemo(dt) {
    const demo = this.boats[0];
    if (!demo) return;
    const wp = this._demoWaypoints[this._demoWp];
    if (Math.hypot(demo.phys.x - wp.x, demo.phys.z - wp.z) < 30) {
      this._demoWp = (this._demoWp + 1) % this._demoWaypoints.length;
    }
    this.demoHelm.update(this.wind, wp, this.time, dt);
    demo.update(this.wind, dt, this.time, this.islands);
    // 电影感环绕镜头
    const a = this.time * 0.07;
    const p = demo.phys;
    this.camera.position.set(
      p.x + Math.sin(a) * 16,
      3.2 + Math.sin(this.time * 0.11) * 1.2,
      p.z + Math.cos(a) * 16
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(p.x, 1.2, p.z);
  }

  _updateGame(dt) {
    const s = this.settings;
    // 玩家输入
    this.player.applyInput(this.input, s, dt, this.time);

    // AI(采样带风影的风场:能感知脏风并做逃逸战术)
    this.shadowWind.boats = this.boats;
    for (const helm of this.aiHelms) {
      const b = helm.boat;
      this.shadowWind.exclude = b;
      if (this.race && this.race.state === 'prestart') {
        helm.holdNear(this.shadowWind, b.slot, this.time, -this.race.t);
      } else {
        const target = this.race ? this.race.targetFor(b) : null;
        helm.update(this.shadowWind, target, this.time, dt);
      }
    }
    this.shadowWind.exclude = null;

    // 物理与视觉（每条船感受到被其他船遮挡后的风）
    this.shadowWind.boats = this.boats;
    for (const b of this.boats) {
      this.shadowWind.exclude = b;
      b.shadowF = shadowFactorAt(b.phys.x, b.phys.z, this.wind.currentFromPsi(), this.boats, b);
      b.update(this.shadowWind, dt, this.time, this.islands, this.audio);
    }
    this.shadowWind.exclude = null;
    this._boatCollisions();

    // 航行规则:碰撞/触标判责 -> 回转或减速处罚
    if (this.rules) {
      this.rules.update(this.boats, this._contacts, dt, this._markContacts);
      this._consumeRuleEvents();
    }

    // 比赛
    if (this.race) {
      this.race.update(dt);
      this.race.course.setActiveTarget(this.race.activeTargetFor(this.player));
      this.race.course.update(this.time);
      // 幽灵船：录制本场 + 回放历史最佳
      if (this.race.state !== 'prestart') {
        const pe0 = this.race.entries.get(this.player);
        if (!pe0.finished) this.ghostRec?.record(this.race.t, this.player.phys);
        this.ghost?.update(this.race.t, this.waveField, this.time, dt);
      }
      for (const msg of this.race.takeEvents()) this.hud.toast(msg);
      const st = this.race.playerStatus(this.player);
      this.hud.setBanner(st.text);
      // 倒计时哔声
      if (this.race.state === 'prestart') {
        const sec = Math.ceil(-this.race.t);
        if (sec !== this._prevCount) {
          this._prevCount = sec;
          if (sec <= 5 || sec === 10 || sec === 20 || sec === 30) this.audio.beep(sec <= 5 ? 1320 : 880, 0.1);
        }
      } else if (this._prevCount !== -1) {
        this._prevCount = -1;
        this.audio.beep(1760, 0.5, 0.3);
      }
      // 结果
      const pe = this.race.entries.get(this.player);
      if (pe.finished && !this._resultsShown) {
        this._resultsShown = true;
        const newBest = saveBest(s.windKn, this._raceAi, pe.finishT);
        if (newBest && this.ghostRec) saveGhost(s.windKn, this._raceAi, this.ghostRec, pe.finishT);
        this.audio.chime();
        setTimeout(() => {
          const rows = this.race.standings().map((b) => ({
            name: t(b.nameKey),
            isPlayer: b.isPlayer,
            time: this.race.entries.get(b).finished ? this.race.entries.get(b).finishT : null,
          }));
          this.menu.showResults(rows, newBest);
        }, 1800);
      }
    }

    // 教学
    if (this.tutorial && !this.tutorial.done) this.tutorial.update(dt);

    // 音效
    const o = this.player.phys.out;
    this.audio.update(o.awsKn, o.luff * (Math.abs(o.twaDeg) < 160 ? 1 : 0), o.speedKn, o.planing);

    // 搁浅提示
    if (this.player.grounded) {
      this.player.grounded = false;
      if (!this._groundToastT || this.time - this._groundToastT > 5) {
        this._groundToastT = this.time;
        this.hud.toast(t('toast.grounded'));
      }
    }
  }

  _multiplayerAuthorityStep({ dt, worldTime, takeoverPlayerIds, controlFor }) {
    this.time = worldTime;
    this.wind.update(dt);
    this.waveField.update(dt);

    for (const boat of this.boats) {
      const aiControlled = !boat.playerId || takeoverPlayerIds.has(boat.playerId);
      if (aiControlled) {
        const helm = this._multiplayerHelms.get(boat.boatId);
        this.shadowWind.boats = this.boats;
        this.shadowWind.exclude = boat;
        if (this.race.state === 'prestart') {
          helm.holdNear(this.shadowWind, boat.slot, worldTime, -this.race.t);
        } else {
          helm.update(this.shadowWind, this.race.targetFor(boat), worldTime, dt);
        }
        this.shadowWind.exclude = null;
      } else {
        boat.applyControlIntent(controlFor(boat.playerId), this.settings, dt, worldTime);
      }
    }

    this.shadowWind.boats = this.boats;
    for (const boat of this.boats) {
      this.shadowWind.exclude = boat;
      boat.shadowF = shadowFactorAt(
        boat.phys.x,
        boat.phys.z,
        this.wind.currentFromPsi(),
        this.boats,
        boat,
      );
      boat.simulate(this.shadowWind, dt, worldTime, this.islands, this.audio);
    }
    this.shadowWind.exclude = null;
    this._boatCollisions();
    // host 权威判罚:碰撞/触标 -> 回转或减速处罚;处罚状态随快照下发 guest
    if (this.rules) {
      this.rules.update(this.boats, this._contacts, dt, this._markContacts);
      this._consumeRuleEvents();
    }
    this.race.update(dt);
  }

  _multiplayerPredictionStep({ dt, worldTime, controlFor }) {
    this.time = worldTime;
    this.wind.update(dt);
    this.waveField.update(dt);
    if (!this.player) return;
    this.player.applyControlIntent(
      controlFor(this.player.playerId),
      this.settings,
      dt,
      worldTime,
    );
    this.shadowWind.boats = this.boats;
    this.shadowWind.exclude = this.player;
    this.player.shadowF = shadowFactorAt(
      this.player.phys.x,
      this.player.phys.z,
      this.wind.currentFromPsi(),
      this.boats,
      this.player,
    );
    // guest 只预测本船;船间碰撞和比赛裁决等待 host 快照。
    // 岛屿与赛道障碍在本地预测中做纯位置修正(不产生判罚,判罚只在 host),
    // 避免"先穿模再被快照拽回"的观感。
    this.player.simulate(this.shadowWind, dt, worldTime, this.islands, this.audio);
    if (this.race?.course?.obstacles) {
      resolveObstacleCollisions([this.player], this.race.course.obstacles);
    }
    this.shadowWind.exclude = null;
  }

  _renderMultiplayer(dt) {
    for (const boat of this.boats) boat.render(this.time, dt);
    if (this.race && this.player) {
      this.race.course.setActiveTarget(this.race.activeTargetFor(this.player));
    }
    this.race?.course?.update(this.time);
    this._updateMultiplayerRacePresentation();
    if (!this.player) return;
    const output = this.player.phys.out;
    this.audio.update(
      output.awsKn,
      output.luff * (Math.abs(output.twaDeg) < 160 ? 1 : 0),
      output.speedKn,
      output.planing,
    );
  }

  _updateMultiplayerRacePresentation() {
    if (!this.race || !this.player) return;
    for (const msg of this.race.takeEvents()) this.hud.toast(msg);
    this.hud.setBanner(this.race.playerStatus(this.player).text);
    if (this.race.state === 'prestart') {
      const sec = Math.ceil(-this.race.t);
      if (sec !== this._prevCount) {
        this._prevCount = sec;
        if (sec <= 5 || sec === 10 || sec === 20 || sec === 30) {
          this.audio.beep(sec <= 5 ? 1320 : 880, 0.1);
        }
      }
    } else if (this._prevCount !== -1) {
      this._prevCount = -1;
      this.audio.beep(1760, 0.5, 0.3);
    }

    // 处罚提示:guest 的处罚状态经快照回填,没有本地规则事件,做沿检测;
    // host 的提示已由权威步进的 _consumeRuleEvents 发出
    if (this.multiplayerController?.role !== 'host') {
      const turns = this.player.penaltyTurns ?? 0;
      const slow = (this.player.penaltyT ?? 0) > 0;
      const prev = this._prevPenalty ?? { turns: 0, slow: false };
      if (turns > prev.turns) {
        this.hud.toast(t('rules.penaltyTurns.you', { n: turns }), 3.5);
        this.audio.beep(392, 0.35, 0.25);
      } else if (turns < prev.turns) {
        this.hud.toast(turns > 0 ? t('rules.turnDone.more', { n: turns }) : t('rules.turnDone.clear'), 3);
        this.audio.beep(1040, 0.25, 0.22);
      }
      if (slow && !prev.slow) {
        this.hud.toast(t('rules.penalty.you', { s: PENALTY_SECONDS }), 3.5);
        this.audio.beep(392, 0.35, 0.25);
      }
      this._prevPenalty = { turns, slow };
    }

    const entry = this.race.entries.get(this.player);
    if (entry?.finished && !this._resultsShown) {
      this._resultsShown = true;
      this.audio.chime();
      setTimeout(() => {
        const rows = this.race.standings().map((boat) => ({
          name: boat.displayName ?? t(boat.nameKey),
          isPlayer: boat.isLocal,
          time: this.race.entries.get(boat).finished
            ? this.race.entries.get(boat).finishT
            : null,
        }));
        this.menu.showResults(rows, false);
      }, 1800);
    }
  }

  _applyAuthoritativeEnvironment(state) {
    if (state.seed !== this._multiplayerStart?.seed) {
      this._multiplayerStart = { ...this._multiplayerStart, seed: state.seed };
      this.wind.setSeed(state.seed);
    }
    this.wind.time = state.worldTime;
    this.waveField.time = state.worldTime;
    this.time = state.worldTime;
  }

  _approveMultiplayerRescue(playerId) {
    const boat = this.boats.find((candidate) => candidate.playerId === playerId);
    if (!boat) return false;
    this._resetBoat(boat);
    if (boat === this.player) this.hud.toast(t('toast.reset'));
    return true;
  }

  _resetBoat(boat) {
    if (!boat) return;
    const p = boat.phys;
    p.phi = 0;
    p.phiRate = 0;
    p.capsized = false;
    p.u = Math.min(p.u, 1);
    p.v = 0;
    p.yawRate = 0;
    p.sheet = p.ctl.sheet = 1;
  }

  // 规则事件 -> 玩家提示音与 toast(单机与联机权威路径共用)
  _consumeRuleEvents() {
    for (const ev of this.rules.takeEvents()) {
      if (ev.kind === 'turnDone') {
        if (ev.boat.isPlayer) {
          this.hud.toast(
            ev.turns > 0 ? t('rules.turnDone.more', { n: ev.turns }) : t('rules.turnDone.clear'), 3);
          this.audio.beep(1040, 0.25, 0.22);
        }
        continue;
      }
      if (ev.boat.isPlayer) {
        const msg = this.rules.mode === 'turns'
          ? t(ev.kind === 'mark' ? 'rules.markTouchTurns.you' : 'rules.penaltyTurns.you', { n: ev.turns })
          : t(ev.kind === 'mark' ? 'rules.markTouch.you' : 'rules.penalty.you', { s: PENALTY_SECONDS });
        this.hud.toast(msg, 3.5);
        this.audio.beep(392, 0.35, 0.25);
      } else if (ev.other?.isPlayer) {
        this.hud.toast(t('rules.penalty.other', { name: ev.boat.displayName ?? t(ev.boat.nameKey) }));
      }
    }
  }

  _boatCollisions() {
    // 胶囊体碰撞(sim/collision.js);接触列表交给航行规则引擎判责
    this._contacts = resolveBoatCollisions(this.boats);
    // 赛道障碍(标/起航线端点船)实体碰撞;接触列表供触标判罚
    this._markContacts = this.race
      ? resolveObstacleCollisions(this.boats, this.race.course.obstacles)
      : [];
  }
}

new App();
