// 交互式新手教学：9 个分步课程，实时检测航行状态判定过关。

import { DEG, wrapPi } from '../util/math.js';
import { t } from '../i18n.js';

export class Tutorial {
  constructor(game) {
    this.game = game;
    this.card = document.getElementById('tutorial-card');
    this.idx = 0;
    this.dwell = 0;
    this.acc = {};       // 步骤累计量
    this.done = false;
    this.steps = makeSteps();
  }

  start() {
    this.idx = 0;
    this.done = false;
    this._enter();
  }

  _enter() {
    const s = this.steps[this.idx];
    this.acc = {};
    this.dwell = 0;
    s.setup?.(this.game, this.acc);
    this._render('0%');
  }

  _render(barWidth) {
    const k = `tut.${this.idx}`;
    this.card.innerHTML = `
      <div class="t-step">${t('tut.step', { i: this.idx + 1, n: this.steps.length })}</div>
      <h3>${t(k + '.title')}</h3>
      <div class="t-body">${t(k + '.body')}</div>
      <div class="t-goal">🎯 ${t(k + '.goal')}</div>
      <div class="t-progress"><div class="t-bar" style="width:${barWidth}"></div></div>
      <div class="t-skip">${t('tut.skip')}</div>`;
    this.card.classList.add('show');
    this._bar = this.card.querySelector('.t-bar');
  }

  // 语言切换后重绘当前课（不重置进度）
  refreshText() {
    if (this.done) return;
    this._render(this._bar?.style.width || '0%');
  }

  update(dt) {
    if (this.done) return;
    const s = this.steps[this.idx];
    const prog = s.check(this.game, this.acc, dt);
    const t = Math.max(0, Math.min(1, prog));
    if (this._bar) this._bar.style.width = `${(t * 100).toFixed(0)}%`;
    if (t >= 1) {
      this.dwell += dt;
      if (this.dwell > 0.6) this._advance();
    } else this.dwell = 0;
  }

  skip() { this._advance(); }

  _advance() {
    this.game.audio.chime();
    this.idx++;
    if (this.idx >= this.steps.length) {
      this.done = true;
      this.card.classList.remove('show');
      this.game.hud.toast(t('tut.done'), 4);
    } else {
      this._enter();
    }
  }

  hide() { this.card.classList.remove('show'); }
}

// 各课的文案在 i18n.js（tut.<idx>.title/body/goal），这里只保留过关检测逻辑。
function makeSteps() {
  return [
    {
      setup(game, acc) { acc.spin = 0; acc.last = null; },
      check(game, acc, dt) {
        const y = game.cameraRig.orbitYaw;
        if (acc.last !== null) acc.spin += Math.abs(wrapPi(y - acc.last));
        acc.last = y;
        return acc.spin / (Math.PI * 1.6);
      },
    },
    {
      setup(game, acc) { acc.turn = 0; acc.prev = game.player.phys.psi; },
      check(game, acc, dt) {
        const psi = game.player.phys.psi;
        acc.turn += Math.abs(wrapPi(psi - acc.prev));
        acc.prev = psi;
        return acc.turn / (120 * DEG);
      },
    },
    {
      setup(game, acc) { acc.t = 0; },
      check(game, acc, dt) {
        const o = game.player.phys.out;
        const good = o.luff < 0.25 && Math.abs(o.alphaDeg) < 26 && o.speedKn > 3.5;
        acc.t = good ? acc.t + dt : 0;
        return acc.t / 6;
      },
    },
    {
      check(game, acc, dt) {
        const o = game.player.phys.out;
        return o.inIrons ? 1 : Math.max(0, 1 - Math.abs(Math.abs(o.twaDeg) - 10) / 60) * 0.9;
      },
    },
    {
      check(game, acc, dt) {
        return game.player.phys.out.speedKn / 3;
      },
    },
    {
      setup(game, acc) { acc.n = game.player.events.tacks; },
      check(game, acc, dt) {
        return (game.player.events.tacks - acc.n) / 2;
      },
    },
    {
      setup(game, acc) { acc.n = game.player.events.gybes; },
      check(game, acc, dt) {
        return game.player.events.gybes > acc.n ? 1 : 0;
      },
    },
    {
      check(game, acc, dt) {
        const p = game.player.phys;
        return Math.abs(p.out.twaDeg) > 130 && p.board < 0.5 && p.out.speedKn > 3 ? 1 : 0;
      },
    },
    {
      setup(game, acc) { game.settings.autoHike = false; acc.t = 0; },
      check(game, acc, dt) {
        const o = game.player.phys.out;
        const good = Math.abs(o.twaDeg) < 70 && Math.abs(o.heelDeg) < 22 && o.speedKn > 3;
        acc.t = good ? acc.t + dt : Math.max(0, acc.t - dt * 0.5);
        if (game.tutorialDone8) return 1;
        return acc.t / 12;
      },
    },
    {
      setup(game, acc) {
        game.settings.autoHike = true;
        acc.phase = 0;
        const p = game.player.phys;
        const w = game.wind.sample(p.x, p.z);
        const up = { x: Math.sin(w.fromPsi), z: -Math.cos(w.fromPsi) };
        acc.mark = { x: p.x + up.x * 220, z: p.z + up.z * 220 };
        acc.home = { x: p.x, z: p.z };
        game.setTutorialMark(acc.mark);
      },
      check(game, acc, dt) {
        const p = game.player.phys;
        if (acc.phase === 0) {
          const d = Math.hypot(p.x - acc.mark.x, p.z - acc.mark.z);
          if (d < 18) { acc.phase = 1; game.hud.toast(t('tut.rounded')); game.setTutorialMark(acc.home); }
          return Math.max(0.05, 0.5 - d / 500);
        }
        const dh = Math.hypot(p.x - acc.home.x, p.z - acc.home.z);
        return dh < 25 ? 1 : 0.5 + Math.max(0, 0.5 - dh / 500);
      },
    },
  ];
}
