// HUD：全屏 2D Canvas 绘制（风表罗盘 / 航行仪表 / 小地图 / 目标指示）+ DOM 横幅与提示。

import * as THREE from 'three';
import { DEG, RAD, clamp, clamp01, formatTime, wrapPi } from '../util/math.js';
import { coachAdvice } from './coach.js';
import { t } from '../i18n.js';

export class HUD {
  constructor() {
    this.canvas = document.getElementById('hud-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.banner = document.getElementById('race-banner');
    this.toastEl = document.getElementById('toast');
    this.helpEl = document.getElementById('help-panel');
    this.visible = true;
    this._toastT = 0;
    this.renderHelp();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  // 操作说明面板（语言切换后重建）
  renderHelp() {
    const rows = [];
    for (let i = 1; i <= 11; i++) {
      rows.push(`<tr><td>${t('help.k' + i)}</td><td>${t('help.v' + i)}</td></tr>`);
    }
    this.helpEl.innerHTML = `
      <h3>${t('help.title')}</h3>
      <table>${rows.join('')}</table>
      <div class="help-tips">${t('help.tips')}</div>`;
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.dpr = dpr;
  }

  toast(msg, dur = 2.6) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    this._toastT = dur;
  }

  setBanner(html) {
    if (this.banner.innerHTML !== html) this.banner.innerHTML = html;
    this.banner.style.display = html ? 'block' : 'none';
  }

  toggleHelp() { this.helpEl.classList.toggle('show'); }

  // —— 主绘制 ——
  draw(game, dt) {
    if (this._toastT > 0) {
      this._toastT -= dt;
      if (this._toastT <= 0) this.toastEl.classList.remove('show');
    }
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (game.settings?.showFps) {
      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      ctx.fillStyle = 'rgba(8,18,28,0.55)';
      roundRect(ctx, 12, 12, 74, 24, 6);
      ctx.fill();
      ctx.fillStyle = (game.fps ?? 60) < 45 ? '#ffb04d' : '#a8e0a0';
      ctx.font = '600 13px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(`${(game.fps ?? 0).toFixed(0)} FPS`, 20, 29);
      ctx.restore();
    }
    if (!this.visible || !game.player) return;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    const w = W / this.dpr, h = H / this.dpr;

    const boat = game.player;

    // 新手教练:最佳缭绳/稳向板 + 单条提示(带 1.6s 防抖)
    let advice = null;
    if (game.settings?.coach && game.mode !== 'menu') {
      advice = coachAdvice(boat.phys, game.race?.targetFor(boat) ?? null);
      this._hintAge = (this._hintAge ?? 0) + dt;
      if (advice.hint !== this._hintKey && (this._hintAge > 1.6 || !this._hintKey)) {
        this._hintKey = advice.hint;
        this._hintAge = 0;
      }
    } else {
      this._hintKey = null;
    }

    this._targetMarker(ctx, w, h, game);
    this._windDial(ctx, w - 118, 128, 86, boat, game);
    this._instruments(ctx, 18, h - 20, boat, game, advice);
    this._rudderBar(ctx, w / 2, h - 26, boat);
    this._minimap(ctx, w - 118, h - 132, 100, game);

    ctx.restore();
  }

  _windDial(ctx, cx, cy, R, boat, game) {
    const o = boat.phys.out;
    const p = boat.phys;
    ctx.save();
    ctx.translate(cx, cy);

    // 背景
    ctx.beginPath();
    ctx.arc(0, 0, R + 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,18,28,0.55)';
    ctx.fill();

    // 死区扇形（以真风向为中心 ±43°）
    const twaRad = o.twaDeg * DEG;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, twaRad - 43 * DEG - Math.PI / 2, twaRad + 43 * DEG - Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(200,60,50,0.16)';
    ctx.fill();

    // 刻度环
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    for (let a = 0; a < 360; a += 30) {
      const r1 = a % 90 === 0 ? R - 9 : R - 5;
      const s = Math.sin(a * DEG), c = -Math.cos(a * DEG);
      ctx.beginPath();
      ctx.moveTo(s * r1, c * r1);
      ctx.lineTo(s * R, c * R);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();

    // 船形（艏朝上）
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.quadraticCurveTo(8, -2, 6, 12);
    ctx.lineTo(-6, 12);
    ctx.quadraticCurveTo(-8, -2, 0, -13);
    ctx.fill();
    // 帆杠线
    ctx.strokeStyle = '#ffd35c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -4);
    const bo = p.boom + Math.PI;
    ctx.lineTo(Math.sin(bo) * 16, -Math.cos(bo) * 16);
    ctx.stroke();

    const arrow = (angRad, r0, r1, color, width, head) => {
      const s = Math.sin(angRad), c = -Math.cos(angRad);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(s * r0, c * r0);
      ctx.lineTo(s * r1, c * r1);
      ctx.stroke();
      // 箭头（指向圆心）
      const hx = s * r1, hy = c * r1;
      const px = -c, py = s;
      ctx.beginPath();
      ctx.moveTo(hx + s * -head, hy + c * -head);
      ctx.lineTo(hx + px * head * 0.55 , hy + py * head * 0.55);
      ctx.lineTo(hx - px * head * 0.55, hy - py * head * 0.55);
      ctx.closePath();
      ctx.fill();
    };

    // 基准风向刻度(空心三角):与真风箭头的夹角即当前风摆
    {
      const baseRel = wrapPi(game.wind.baseFromPsi - p.psi);
      const s = Math.sin(baseRel), c = -Math.cos(baseRel);
      const px = -c, py = s;
      ctx.strokeStyle = 'rgba(57,198,192,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s * (R + 11), c * (R + 11));
      ctx.lineTo(s * (R + 3) + px * 4.5, c * (R + 3) + py * 4.5);
      ctx.lineTo(s * (R + 3) - px * 4.5, c * (R + 3) - py * 4.5);
      ctx.closePath();
      ctx.stroke();
    }

    // 真风（青）与视风（白）箭头：从外指向圆心
    arrow(twaRad, R + 12, R - 22, '#39c6c0', 3, 8);
    arrow(o.awaDeg * DEG, R + 2, R - 30, 'rgba(255,255,255,0.92)', 2, 7);

    // 中心读数
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = '600 15px system-ui';
    ctx.fillText(o.awsKn.toFixed(1), 0, 34);
    ctx.font = '10px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(t('hud.awsUnit'), 0, 46);

    // 真风读数与阵风提示
    const w = game.wind;
    const gustF = w.gustFactor(boat.phys.x, boat.phys.z);
    ctx.fillStyle = gustF > 1.13 ? '#ffd35c' : 'rgba(255,255,255,0.75)';
    ctx.font = '11px system-ui';
    const twd = ((w.currentFromPsi() * RAD) % 360 + 360) % 360;
    ctx.fillText(t('hud.trueWind', { v: o.twsKn.toFixed(1), d: twd.toFixed(0) }) + (gustF > 1.13 ? t('hud.gust') : ''), 0, -R - 20);

    // 潮流读数(仅在有水流时):速度 + 去向罗盘角
    if (o.currentKn > 0.1) {
      ctx.fillStyle = 'rgba(150,210,255,0.82)';
      ctx.font = '11px system-ui';
      ctx.fillText(t('hud.current', { v: o.currentKn.toFixed(1), d: o.currentSetDeg.toFixed(0) }), 0, -R - 34);
    }

    // 风摆读数:相对基准风的偏角;迎风时标注抬升(绿)/受压(红)
    const shift = wrapPi(w.currentFromPsi() - w.baseFromPsi) / DEG;
    if (Math.abs(shift) >= 3) {
      const upwind = Math.abs(o.twaDeg) < 100 && Math.abs(o.twaDeg) > 25;
      const lifted = upwind && Math.sign(o.twaDeg) * shift > 0;
      ctx.fillStyle = upwind ? (lifted ? '#8fe39a' : '#ff9d7a') : 'rgba(255,255,255,0.7)';
      ctx.font = '11px system-ui';
      const txt = t('hud.shift', { d: Math.abs(shift).toFixed(0) }) + (shift > 0 ? ' →' : ' ←')
        + (upwind ? ` · ${t(lifted ? 'hud.lift' : 'hud.header')}` : '');
      ctx.fillText(txt, 0, R + 30);
    }

    // 阵风预警:采样正上风 35/70m 处的阵风系数,提前提示"看水面暗纹"
    {
      const ux = Math.sin(w.currentFromPsi()), uz = -Math.cos(w.currentFromPsi());
      const g1 = w.gustFactor(p.x + ux * 35, p.z + uz * 35);
      const g2 = w.gustFactor(p.x + ux * 70, p.z + uz * 70);
      const ahead = Math.max(g1, g2);
      if (ahead > 1.14 && ahead > gustF + 0.05) {
        ctx.fillStyle = '#ffd35c';
        ctx.font = '600 12px system-ui';
        ctx.fillText(t('hud.gustSoon'), 0, R + 46);
      }
    }
    ctx.restore();
  }

  _instruments(ctx, x, bottom, boat, game, advice) {
    const o = boat.phys.out;
    const p = boat.phys;
    ctx.save();
    ctx.translate(x, bottom - 132);

    ctx.fillStyle = 'rgba(8,18,28,0.55)';
    roundRect(ctx, 0, 0, 172, 132, 10);
    ctx.fill();

    // 航速
    ctx.fillStyle = '#fff';
    ctx.font = '700 34px system-ui';
    ctx.textAlign = 'left';
    const spdTxt = o.speedKn.toFixed(1);
    ctx.fillText(spdTxt, 14, 40);
    ctx.font = '11px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(t('hud.kn'), 16 + ctx.measureText(spdTxt).width * 3.1, 40);
    ctx.fillText(t('hud.vmg', { v: Math.abs(o.vmgKn).toFixed(1) }) + (o.vmgKn >= 0 ? '↑' : '↓'), 104, 22);
    ctx.fillText(t('hud.leeway', { v: Math.abs(o.leewayDeg).toFixed(0) }), 104, 40);

    // 横倾条 ±50°
    const hw = 144, hx = 14, hy = 58;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(ctx, hx, hy, hw, 8, 4);
    ctx.fill();
    ctx.fillStyle = 'rgba(220,80,60,0.5)';
    ctx.fillRect(hx, hy, hw * 0.18, 8);
    ctx.fillRect(hx + hw * 0.82, hy, hw * 0.18, 8);
    const heelT = clamp(o.heelDeg / 50, -1, 1);
    ctx.fillStyle = Math.abs(o.heelDeg) > 35 ? '#ff6a4d' : '#ffd35c';
    ctx.beginPath();
    ctx.arc(hx + hw / 2 + heelT * hw / 2, hy + 4, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '10px system-ui';
    ctx.fillText(t('hud.heel', { v: Math.abs(o.heelDeg).toFixed(0) }), hx, hy + 22);

    // 缭绳 / 稳向板(教练开启时:接近最佳变绿,并画最佳位置刻度)
    const sheetOk = advice && Math.abs(p.sheet - advice.sheetOpt) < 0.12;
    const boardOk = advice && Math.abs(p.board - advice.boardOpt) < 0.15;
    ctx.fillText(t('hud.sheet', { v: (p.sheet * 100).toFixed(0) }), hx, 98);
    bar(ctx, hx + 62, 91, 80, 6, p.sheet, advice ? (sheetOk ? '#79d97f' : '#e8b25c') : '#7fc5e8');
    ctx.fillText(t('hud.board', { v: (p.board * 100).toFixed(0) }), hx, 116);
    bar(ctx, hx + 62, 109, 80, 6, p.board, advice ? (boardOk ? '#79d97f' : '#e8b25c') : '#a3d977');
    if (advice) {
      tick(ctx, hx + 62 + 80 * advice.sheetOpt, 91, 6);
      tick(ctx, hx + 62 + 80 * advice.boardOpt, 109, 6);
    }

    // 状态徽章(处罚/让行预警优先级最高,仅次于翻船)
    const RED = 'rgba(200,50,40,0.85)', BLUE = 'rgba(60,160,220,0.85)', AMBER = 'rgba(230,160,40,0.85)';
    const rowWarn = game?.rules?.warningFor(boat, game.boats);
    let badge = '', badgeColor = AMBER;
    if (p.capsized) { badge = p.rightProgress > 0 ? t('badge.righting', { p: (p.rightProgress * 100).toFixed(0) }) : t('badge.capsized'); badgeColor = RED; }
    else if ((boat.penaltyTurns ?? 0) > 0) {
      // 回转处罚:剩余回转数 + 当前回转进度
      badge = t('badge.turns', {
        n: boat.penaltyTurns,
        p: Math.min(99, Math.abs(boat.turnAcc ?? 0) / (Math.PI * 2) * 100).toFixed(0),
      });
      badgeColor = RED;
    }
    else if ((boat.penaltyT ?? 0) > 0) { badge = t('badge.penalty', { s: Math.ceil(boat.penaltyT) }); badgeColor = RED; }
    else if (rowWarn) { badge = `⚠ ${t(rowWarn.rule)}`; badgeColor = AMBER; }
    else if (o.inIrons) badge = t('badge.irons');
    else if (o.sternway) badge = t('badge.sternway');
    else if ((boat.shadowF ?? 1) < 0.86) badge = t('badge.dirty');
    else if (o.surf > 0.32 && o.speedKn > 3) { badge = t('badge.surf'); badgeColor = BLUE; }
    else if (o.planing > 0.5) { badge = t('badge.plane'); badgeColor = BLUE; }
    else if (o.luff > 0.5 && o.twsKn > 4 && Math.abs(o.twaDeg) < 160) badge = t('badge.luff');
    if (badge) {
      ctx.font = '600 12px system-ui';
      const bw = ctx.measureText(badge).width + 16;
      ctx.fillStyle = badgeColor;
      roundRect(ctx, 0, -30, bw, 22, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(badge, 8, -14);
    }

    // 教练提示(徽章上方一行)
    if (advice && this._hintKey) {
      const txt = t(this._hintKey);
      ctx.font = '600 12px system-ui';
      const bw = ctx.measureText(txt).width + 16;
      const y0 = badge ? -58 : -30;
      ctx.fillStyle = this._hintKey === 'coach.good' ? 'rgba(46,125,79,0.82)' : 'rgba(35,95,140,0.85)';
      roundRect(ctx, 0, y0, bw, 22, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, 8, y0 + 16);
    }
    ctx.restore();
  }

  // 屏幕空间目标指示:目标可见时画倒三角+距离,在屏幕外/身后时沿边缘画指向箭头
  _targetMarker(ctx, w, h, game) {
    if (!game.race || !game.player || !game.camera) return;
    const entry = game.race.entries.get(game.player);
    if (!entry || entry.finished) return;
    const tgt = game.race.targetFor(game.player);
    if (!tgt) return;

    this._v3 ??= new THREE.Vector3();
    this._vRel ??= new THREE.Vector3();
    this._camDir ??= new THREE.Vector3();
    const v = this._v3.set(tgt.x, 2, tgt.z);
    this._vRel.copy(v).sub(game.camera.position);
    const behind = this._vRel.dot(game.camera.getWorldDirection(this._camDir)) < 0;
    v.project(game.camera);
    let sx = (v.x * 0.5 + 0.5) * w;
    let sy = (1 - (v.y * 0.5 + 0.5)) * h;
    if (behind) { sx = w - sx; sy = h - sy; }

    const dist = Math.hypot(tgt.x - game.player.phys.x, tgt.z - game.player.phys.z);
    const distTxt = dist >= 1000 ? `${(dist / 1000).toFixed(1)}km` : `${dist.toFixed(0)}m`;
    const margin = 52;
    const onScreen = !behind && sx > margin && sx < w - margin && sy > margin && sy < h - margin - 60;

    ctx.save();
    ctx.fillStyle = 'rgba(255,211,92,0.95)';
    ctx.strokeStyle = 'rgba(10,20,30,0.6)';
    ctx.lineWidth = 3;
    ctx.font = '600 12px system-ui';
    ctx.textAlign = 'center';
    if (onScreen) {
      ctx.translate(sx, sy);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-8, -13);
      ctx.lineTo(8, -13);
      ctx.closePath();
      ctx.fill();
      ctx.strokeText(distTxt, 0, -20);
      ctx.fillText(distTxt, 0, -20);
    } else {
      // 从屏幕中心沿目标方向找边缘交点
      const cx0 = w / 2, cy0 = h / 2;
      const dx = sx - cx0, dy = sy - cy0;
      const len = Math.hypot(dx, dy) || 1;
      const kx = (w / 2 - margin) / Math.abs(dx / len || 1e-6);
      const ky = (h / 2 - margin) / Math.abs(dy / len || 1e-6);
      const k = Math.min(kx, ky);
      const ex = cx0 + (dx / len) * k;
      const ey = cy0 + (dy / len) * k;
      const ang = Math.atan2(dy, dx);
      ctx.translate(ex, ey);
      ctx.rotate(ang + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(-8, 4);
      ctx.lineTo(8, 4);
      ctx.closePath();
      ctx.fill();
      ctx.rotate(-(ang + Math.PI / 2));
      ctx.strokeText(distTxt, 0, 22);
      ctx.fillText(distTxt, 0, 22);
    }
    ctx.restore();
  }

  _rudderBar(ctx, cx, y, boat) {
    const w = 130;
    ctx.save();
    ctx.fillStyle = 'rgba(8,18,28,0.45)';
    roundRect(ctx, cx - w / 2, y - 7, w, 12, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillRect(cx - 1, y - 5, 2, 8);
    const r = boat.phys.out.rudderDeg / boat.phys.p.maxRudderDeg;
    ctx.fillStyle = '#ffd35c';
    ctx.beginPath();
    ctx.arc(cx + r * (w / 2 - 8), y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _minimap(ctx, cx, cy, R, game) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,22,34,0.6)';
    ctx.fill();
    ctx.clip();

    const boat = game.player.phys;
    // 视野范围
    let span = 420, mx = boat.x, mz = boat.z;
    if (game.race) {
      const c = game.race.course;
      let maxD = 100;
      for (const m of c.marks) maxD = Math.max(maxD, Math.hypot(m.x - c.center.x, m.z - c.center.z));
      span = maxD * 2.3;
      mx = c.center.x; mz = c.center.z;
    }
    const k = (R * 2) / span;
    const X = (wx) => (wx - mx) * k;
    const Y = (wz) => (wz - mz) * k;

    // 阵风叠加层(读风):暗斑 = 阵风,亮斑 = 风窝
    {
      const N = 13;
      const rr = (R * 2 / N) * 0.9;
      for (let gi = 0; gi < N; gi++) {
        for (let gj = 0; gj < N; gj++) {
          const wx = mx + (gi / (N - 1) - 0.5) * span;
          const wz = mz + (gj / (N - 1) - 0.5) * span;
          const dev = game.wind.gustFactor(wx, wz) - 1;
          if (Math.abs(dev) < 0.07) continue;
          ctx.fillStyle = dev > 0
            ? `rgba(6,14,22,${Math.min(0.42, (dev - 0.07) * 1.9).toFixed(3)})`
            : `rgba(185,215,235,${Math.min(0.28, (-dev - 0.07) * 1.3).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(X(wx), Y(wz), rr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 岛屿
    ctx.fillStyle = 'rgba(120,140,110,0.8)';
    for (const isl of game.islands) {
      ctx.beginPath();
      ctx.arc(X(isl.x), Y(isl.z), isl.r * k, 0, Math.PI * 2);
      ctx.fill();
    }

    // 赛道
    if (game.race) {
      const c = game.race.course;
      // 完整航线(淡):起航线中点 -> 各标 -> 终点线
      const route = [c.lineMid];
      for (const leg of c.legs) if (leg.type === 'mark') route.push(c.marks[leg.mark]);
      route.push(c.lineMid);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X(route[0].x), Y(route[0].z));
      for (let i = 1; i < route.length; i++) ctx.lineTo(X(route[i].x), Y(route[i].z));
      ctx.stroke();

      // 当前航段(亮)
      const entry = game.race.entries.get(game.player);
      const tgt = game.race.targetFor(game.player);
      if (entry && tgt && !entry.finished) {
        const prevLeg = c.legs[entry.leg - 1];
        const from = prevLeg?.type === 'mark' ? c.marks[prevLeg.mark] : c.lineMid;
        ctx.strokeStyle = 'rgba(255,211,92,0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(X(from.x), Y(from.z));
        ctx.lineTo(X(tgt.x), Y(tgt.z));
        ctx.stroke();
      }

      // 起航线:委员会船(白方块)- 起航标(橙点)
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(X(c.pin.x), Y(c.pin.z));
      ctx.lineTo(X(c.committee.x), Y(c.committee.z));
      ctx.stroke();
      ctx.fillStyle = '#ff8c42';
      ctx.beginPath();
      ctx.arc(X(c.pin.x), Y(c.pin.z), 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(X(c.committee.x) - 2.5, Y(c.committee.z) - 2.5, 5, 5);

      // 标记 + 编号
      ctx.font = '600 9px system-ui';
      ctx.textAlign = 'left';
      for (let i = 0; i < c.marks.length; i++) {
        ctx.fillStyle = '#ff8c42';
        ctx.beginPath();
        ctx.arc(X(c.marks[i].x), Y(c.marks[i].z), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(String(i + 1), X(c.marks[i].x) + 6, Y(c.marks[i].z) + 3);
      }

      // 玩家目标:虚线 + 呼吸圈
      if (tgt) {
        ctx.strokeStyle = 'rgba(255,211,92,0.6)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(X(boat.x), Y(boat.z));
        ctx.lineTo(X(tgt.x), Y(tgt.z));
        ctx.stroke();
        ctx.setLineDash([]);
        const pulse = 5.5 + Math.sin((game.time ?? 0) * 3) * 1.5;
        ctx.strokeStyle = 'rgba(255,211,92,0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(X(tgt.x), Y(tgt.z), pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 船
    const drawBoat = (b, color) => {
      const p = b.phys;
      ctx.save();
      ctx.translate(X(p.x), Y(p.z));
      ctx.rotate(p.psi);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(4.5, 6);
      ctx.lineTo(-4.5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    const aiColors = ['#7fc5e8', '#e8d77f', '#9fe8a8'];
    game.boats.forEach((b) => { if (b !== game.player) drawBoat(b, aiColors[(b.aiIndex ?? 0) % 3]); });
    if (game.ghost?.visual.group.visible) drawBoat({ phys: game.ghost }, 'rgba(210,225,238,0.55)');
    drawBoat(game.player, '#ffffff');

    ctx.restore();

    // 风向箭头（地图为北上）
    ctx.save();
    ctx.translate(cx, cy);
    const wa = game.wind.currentFromPsi();
    const s = Math.sin(wa), c2 = -Math.cos(wa);
    ctx.strokeStyle = '#39c6c0';
    ctx.fillStyle = '#39c6c0';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(s * (R + 12), c2 * (R + 12));
    ctx.lineTo(s * (R - 2), c2 * (R - 2));
    ctx.stroke();
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -R + 12);
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function bar(ctx, x, y, w, h, t, color) {
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, x, y, Math.max(h, w * clamp01(t)), h, h / 2);
  ctx.fill();
}

// 进度条上的"最佳值"参考刻度(白色竖线 + 小三角)
function tick(ctx, x, y, h) {
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillRect(x - 1, y - 2, 2, h + 4);
  ctx.beginPath();
  ctx.moveTo(x, y - 3);
  ctx.lineTo(x - 3.5, y - 8);
  ctx.lineTo(x + 3.5, y - 8);
  ctx.closePath();
  ctx.fill();
}
