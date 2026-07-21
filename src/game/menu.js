// DOM 菜单：主界面 / 设置 / 暂停 / 比赛结果 / 操作说明。设置持久化 localStorage。
// 语言切换即时生效（整棵菜单 DOM 重建）；画质预设联动各细项，改细项自动变"自定义"。

import { formatTime } from '../util/math.js';
import { loadBest } from './race.js';
import { t, setLang, getLang, detectLang, LANGS } from '../i18n.js';
import { MultiplayerLobby } from './multiplayerLobby.js';

const DEFAULTS = {
  windKn: 12,
  gustiness: 0.32,
  countdown: 45,
  aiCount: 3,
  penaltyMode: 'turns', // 判罚模式:'turns' 回转处罚 / 'slow' 减速处罚
  autoHike: true,
  autoTrim: false,
  coach: true,          // 新手教练提示(最佳帆/板参考 + 操作提示)
  ghost: true,
  volume: 0.7,
  volMusic: 0.5,
  volAmbient: 0.6,
  lang: null,           // null = 首次启动按浏览器语言
  quality: 'high',      // low/medium/high/ultra/custom
  resScale: 1.0,        // 渲染分辨率缩放（× devicePixelRatio）
  shadowQ: 'high',      // off/medium/high/ultra
  waterDetail: 'high',  // low/medium/high
  effects: true,        // 浪花/尾流粒子
  clouds: true,         // 程序化云层
  dynamicRes: true,     // 掉帧时自动降分辨率
  showFps: false,
};

// 画质预设 -> 细项。改任何细项后预设显示为 custom。
export const QUALITY_PRESETS = {
  low:    { resScale: 0.7,  shadowQ: 'off',    waterDetail: 'low',    effects: false, clouds: false },
  medium: { resScale: 0.85, shadowQ: 'medium', waterDetail: 'medium', effects: true,  clouds: true },
  high:   { resScale: 1.0,  shadowQ: 'high',   waterDetail: 'high',   effects: true,  clouds: true },
  ultra:  { resScale: 1.3,  shadowQ: 'ultra',  waterDetail: 'high',   effects: true,  clouds: true },
};

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('windchaser.settings') || '{}');
  } catch { /* 损坏则用默认 */ }
  const s = { ...DEFAULTS, ...stored };
  // 旧版只有 quality 预设：迁移到细项
  if (QUALITY_PRESETS[s.quality] && !('shadowQ' in stored)) {
    Object.assign(s, QUALITY_PRESETS[s.quality]);
  }
  s.lang ??= detectLang();
  setLang(s.lang);
  return s;
}
export function saveSettings(s) {
  localStorage.setItem('windchaser.settings', JSON.stringify(s));
}

export class Menu {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('menus');
    this.multiplayerLobby = new MultiplayerLobby({
      app,
      showScreen: (id) => this.show(id),
    });
    // 全局委托:任意按钮点击播放 UI 音效(捕获阶段,先于各屏 data-act 处理)
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target?.closest?.('button')) this.app.audio.click();
    }, true);
    this._buildAll();
  }

  _buildAll() {
    this.root.innerHTML = '';
    this._buildMain();
    this._buildSettings();
    this._buildPause();
    this._buildResults();
    this.multiplayerLobby.mount(this.root);
  }

  // 语言切换后重建全部菜单 DOM，保持当前屏幕
  rebuild() {
    const current = [...this.root.children].find((c) => c.classList.contains('show'))?.id ?? null;
    this._buildAll();
    this.show(current);
    if (current === 'menu-main') this.refreshBest();
  }

  show(id) {
    for (const el of this.root.children) el.classList.toggle('show', el.id === id);
    this.root.classList.toggle('active', !!id);
  }
  hideAll() { this.show(null); }

  _buildMain() {
    const el = document.createElement('div');
    el.id = 'menu-main';
    el.className = 'screen';
    el.innerHTML = `
      <div class="title-block">
        <h1>${t('title.game')}</h1>
        <div class="subtitle">${t('title.sub')}</div>
      </div>
      <div class="btn-col">
        <button data-act="free">${t('menu.free')}</button>
        <button data-act="trial">${t('menu.trial')}</button>
        <button data-act="race">${t('menu.race')}</button>
        <button data-act="multiplayer" data-testid="multiplayer-button">${t('menu.multiplayer')}</button>
        <button data-act="tutorial">${t('menu.tutorial')}</button>
        <button data-act="settings">${t('menu.settings')}</button>
        <button data-act="help">${t('menu.help')}</button>
      </div>
      <div class="best-line" id="best-line"></div>
      <div class="menu-tip">${t('menu.tip')}</div>`;
    el.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      this.app.audio.start();
      if (act === 'free') this.app.startFree();
      else if (act === 'trial') this.app.startRace(0);
      else if (act === 'race') this.app.startRace(this.app.settings.aiCount || 3);
      else if (act === 'multiplayer') void this.multiplayerLobby.open();
      else if (act === 'tutorial') this.app.startTutorial();
      else if (act === 'settings') { this.backTo = 'menu-main'; this.show('menu-settings'); }
      else if (act === 'help') this.app.hud.toggleHelp();
    });
    this.root.appendChild(el);
  }

  refreshBest() {
    const s = this.app.settings;
    const b0 = loadBest(s.windKn, 0);
    const b3 = loadBest(s.windKn, s.aiCount || 3);
    const line = [];
    if (b0 !== null) line.push(t('best.trial', { t: formatTime(b0) }));
    if (b3 !== null) line.push(t('best.race', { t: formatTime(b3) }));
    const el = document.getElementById('best-line');
    if (el) el.textContent = line.length ? `${t('best.wind', { kn: s.windKn })} · ${line.join(' · ')}` : '';
  }

  _buildSettings() {
    const el = document.createElement('div');
    el.id = 'menu-settings';
    el.className = 'screen';
    const s = this.app.settings;
    const opt = (v, cur, label) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
    el.innerHTML = `
      <h2>${t('set.title')}</h2>
      <div class="form">
        <div class="form-section">${t('set.game')}</div>
        <label>${t('set.lang')}
          <select id="s-lang">${LANGS.map((l) => opt(l.code, getLang(), l.label)).join('')}</select></label>
        <label><span>${t('set.wind')} <output id="o-wind">${s.windKn}</output> ${t('set.windUnit')}</span>
          <input type="range" id="s-wind" min="5" max="25" step="1" value="${s.windKn}"></label>
        <label><span>${t('set.gust')} <output id="o-gust">${Math.round(s.gustiness * 100)}</output>%</span>
          <input type="range" id="s-gust" min="0" max="50" step="5" value="${s.gustiness * 100}"></label>
        <label>${t('set.countdown')}
          <select id="s-count">${[30, 45, 60].map((v) => opt(v, s.countdown, t('set.seconds', { s: v }))).join('')}</select></label>
        <label>${t('set.ai')}
          <select id="s-ai">${[1, 2, 3].map((v) => opt(v, s.aiCount, v)).join('')}</select></label>
        <label>${t('set.penaltyMode')}
          <select id="s-penalty">${['turns', 'slow'].map((v) => opt(v, s.penaltyMode, t('pen.' + v))).join('')}</select></label>
        <label class="check"><input type="checkbox" id="s-hike" ${s.autoHike ? 'checked' : ''}> ${t('set.autoHike')}</label>
        <label class="check"><input type="checkbox" id="s-trim" ${s.autoTrim ? 'checked' : ''}> ${t('set.autoTrim')}</label>
        <label class="check"><input type="checkbox" id="s-coach" ${s.coach ? 'checked' : ''}> ${t('set.coach')}</label>
        <label class="check"><input type="checkbox" id="s-ghost" ${s.ghost ? 'checked' : ''}> ${t('set.ghost')}</label>
        <label><span>${t('set.volume')} <output id="o-vol">${Math.round(s.volume * 100)}</output>%</span>
          <input type="range" id="s-vol" min="0" max="100" step="5" value="${s.volume * 100}"></label>
        <label><span>${t('set.volMusic')} <output id="o-volm">${Math.round(s.volMusic * 100)}</output>%</span>
          <input type="range" id="s-volm" min="0" max="100" step="5" value="${s.volMusic * 100}"></label>
        <label><span>${t('set.volAmbient')} <output id="o-vola">${Math.round(s.volAmbient * 100)}</output>%</span>
          <input type="range" id="s-vola" min="0" max="100" step="5" value="${s.volAmbient * 100}"></label>

        <div class="form-section">${t('set.graphics')}</div>
        <label>${t('set.quality')}
          <select id="s-quality">
            ${['low', 'medium', 'high', 'ultra', 'custom'].map((v) => opt(v, s.quality, t('q.' + v))).join('')}
          </select></label>
        <label><span>${t('set.resScale')} <output id="o-res">${Math.round(s.resScale * 100)}</output>%</span>
          <input type="range" id="s-res" min="50" max="150" step="5" value="${s.resScale * 100}"></label>
        <label>${t('set.shadow')}
          <select id="s-shadow">${['off', 'medium', 'high', 'ultra'].map((v) => opt(v, s.shadowQ, t('sh.' + v))).join('')}</select></label>
        <label>${t('set.water')}
          <select id="s-water">${['low', 'medium', 'high'].map((v) => opt(v, s.waterDetail, t('w.' + v))).join('')}</select></label>
        <label class="check"><input type="checkbox" id="s-fx" ${s.effects ? 'checked' : ''}> ${t('set.effects')}</label>
        <label class="check"><input type="checkbox" id="s-clouds" ${s.clouds ? 'checked' : ''}> ${t('set.clouds')}</label>
        <label class="check"><input type="checkbox" id="s-dynres" ${s.dynamicRes ? 'checked' : ''}> ${t('set.dynRes')}</label>
        <label class="check"><input type="checkbox" id="s-fps" ${s.showFps ? 'checked' : ''}> ${t('set.showFps')}</label>
      </div>
      <div class="btn-row"><button id="s-back">${t('set.back')}</button></div>`;

    const bind = (slider, output) => el.querySelector(slider).addEventListener('input', (e) => {
      el.querySelector(output).textContent = e.target.value;
    });
    bind('#s-wind', '#o-wind');
    bind('#s-gust', '#o-gust');
    bind('#s-vol', '#o-vol');
    bind('#s-volm', '#o-volm');
    bind('#s-vola', '#o-vola');
    bind('#s-res', '#o-res');

    // 预设 -> 细项联动
    el.querySelector('#s-quality').addEventListener('change', (e) => {
      const p = QUALITY_PRESETS[e.target.value];
      if (!p) return;
      el.querySelector('#s-res').value = p.resScale * 100;
      el.querySelector('#o-res').textContent = Math.round(p.resScale * 100);
      el.querySelector('#s-shadow').value = p.shadowQ;
      el.querySelector('#s-water').value = p.waterDetail;
      el.querySelector('#s-fx').checked = p.effects;
      el.querySelector('#s-clouds').checked = p.clouds;
    });
    // 改细项 -> 预设变自定义
    for (const id of ['#s-res', '#s-shadow', '#s-water', '#s-fx', '#s-clouds']) {
      el.querySelector(id).addEventListener('change', () => {
        el.querySelector('#s-quality').value = 'custom';
      });
    }

    // 语言即时切换
    el.querySelector('#s-lang').addEventListener('change', (e) => {
      this._commit(el);
      setLang(e.target.value);
      this.app.onLanguageChanged();
      this.rebuild();
      this.show('menu-settings');
    });

    el.querySelector('#s-back').addEventListener('click', () => {
      this._commit(el);
      this.app.applySettings();
      this.show(this.backTo || 'menu-main');
      if (this.backTo === 'menu-main') this.refreshBest();
    });
    this.root.appendChild(el);
  }

  // 表单 -> settings 并持久化
  _commit(el) {
    const st = this.app.settings;
    st.lang = el.querySelector('#s-lang').value;
    st.windKn = Number(el.querySelector('#s-wind').value);
    st.gustiness = Number(el.querySelector('#s-gust').value) / 100;
    st.countdown = Number(el.querySelector('#s-count').value);
    st.aiCount = Number(el.querySelector('#s-ai').value);
    st.penaltyMode = el.querySelector('#s-penalty').value;
    st.autoHike = el.querySelector('#s-hike').checked;
    st.autoTrim = el.querySelector('#s-trim').checked;
    st.coach = el.querySelector('#s-coach').checked;
    st.ghost = el.querySelector('#s-ghost').checked;
    st.volume = Number(el.querySelector('#s-vol').value) / 100;
    st.volMusic = Number(el.querySelector('#s-volm').value) / 100;
    st.volAmbient = Number(el.querySelector('#s-vola').value) / 100;
    st.quality = el.querySelector('#s-quality').value;
    st.resScale = Number(el.querySelector('#s-res').value) / 100;
    st.shadowQ = el.querySelector('#s-shadow').value;
    st.waterDetail = el.querySelector('#s-water').value;
    st.effects = el.querySelector('#s-fx').checked;
    st.clouds = el.querySelector('#s-clouds').checked;
    st.dynamicRes = el.querySelector('#s-dynres').checked;
    st.showFps = el.querySelector('#s-fps').checked;
    saveSettings(st);
  }

  _buildPause() {
    const el = document.createElement('div');
    el.id = 'menu-pause';
    el.className = 'screen';
    el.innerHTML = `
      <h2>${t('pause.title')}</h2>
      <div class="btn-col">
        <button data-act="resume">${t('pause.resume')}</button>
        <button data-act="restart">${t('pause.restart')}</button>
        <button data-act="settings">${t('menu.settings').replace('⚙️ ', '')}</button>
        <button data-act="main">${t('pause.main')}</button>
      </div>`;
    el.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      if (act === 'resume') this.app.resume();
      else if (act === 'restart') this.app.restartMode();
      else if (act === 'settings') { this.backTo = 'menu-pause'; this.show('menu-settings'); }
      else if (act === 'main') this.app.toMainMenu();
    });
    this.root.appendChild(el);
  }

  _buildResults() {
    const el = document.createElement('div');
    el.id = 'menu-results';
    el.className = 'screen';
    el.innerHTML = `<h2>${t('results.title')}</h2><div id="results-body"></div>
      <div class="btn-col">
        <button data-act="again">${t('results.again')}</button>
        <button data-act="main">${t('pause.main')}</button>
      </div>`;
    el.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      if (act === 'again') this.app.restartMode();
      else if (act === 'main') this.app.toMainMenu();
    });
    this.root.appendChild(el);
  }

  showResults(rows, newBest) {
    const body = document.getElementById('results-body');
    const table = document.createElement('table');
    table.classList.add('results');
    for (let index = 0; index < rows.length; index += 1) {
      const result = rows[index];
      const row = document.createElement('tr');
      if (result.isPlayer) row.classList.add('me');
      const position = document.createElement('td');
      position.textContent = String(index + 1);
      const name = document.createElement('td');
      name.textContent = String(result.name);
      const time = document.createElement('td');
      time.textContent = result.time !== null ? formatTime(result.time) : t('results.dnf');
      row.append(position, name, time);
      table.append(row);
    }
    const content = [table];
    if (newBest) {
      const badge = document.createElement('div');
      badge.classList.add('new-best');
      badge.textContent = t('results.newBest');
      content.push(badge);
    }
    body.replaceChildren(...content);
    this.show('menu-results');
  }
}
