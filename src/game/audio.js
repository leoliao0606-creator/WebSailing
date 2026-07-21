// 程序化音效引擎（WebAudio，无外部素材）：
// 分三条总线 —— SFX（风/水/空帆/换舷/水花/哔声/提示音 + UI 点击）、
// 环境床（低频涌浪 + 随机海鸥）、菜单音乐（五声音阶音垫 + 琶音）。
// 每条总线独立音量,统一汇入主音量。

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.volMusic = 0.5;
    this.volAmbient = 0.6;
    this.started = false;
    this._gullTimer = null;
    this._musicTimer = null;
  }

  // 需在用户手势后调用
  start() {
    if (this.started) return;
    this.started = true;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    ctx.resume?.();
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // —— 三条总线 ——
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);
    this.ambient = ctx.createGain();
    this.ambient.gain.value = this.volAmbient;
    this.ambient.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = this.volMusic;
    this.music.connect(this.master);

    // 共享噪声源
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // 偏粉噪声（低频多一点）
      const w = Math.random() * 2 - 1;
      last = last * 0.94 + w * 0.06;
      d[i] = last * 3.2 + w * 0.25;
    }
    this._noiseBuf = buf;

    const mkNoise = () => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.start();
      return src;
    };

    // —— 风 ——
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 480;
    this.windFilter.Q.value = 0.8;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    mkNoise().connect(this.windFilter).connect(this.windGain).connect(this.sfx);
    // 风声起伏 LFO
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 120;
    lfo.connect(lfoG).connect(this.windFilter.frequency);
    lfo.start();

    // —— 水流 ——
    this.waterFilter = ctx.createBiquadFilter();
    this.waterFilter.type = 'highpass';
    this.waterFilter.frequency.value = 1000;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    mkNoise().connect(this.waterFilter).connect(this.waterGain).connect(this.sfx);

    // —— 空帆抖动（脉冲噪声）——
    this.luffFilter = ctx.createBiquadFilter();
    this.luffFilter.type = 'bandpass';
    this.luffFilter.frequency.value = 160;
    this.luffFilter.Q.value = 1.4;
    this.luffGain = ctx.createGain();
    this.luffGain.gain.value = 0;
    mkNoise().connect(this.luffFilter).connect(this.luffGain).connect(this.sfx);
    this.luffLFO = ctx.createOscillator();
    this.luffLFO.type = 'square';
    this.luffLFO.frequency.value = 9;
    this.luffDepth = ctx.createGain();
    this.luffDepth.gain.value = 0;
    this.luffLFO.connect(this.luffDepth).connect(this.luffGain.gain);
    this.luffLFO.start();

    // —— 环境床:低频涌浪(慢起伏的低通噪声)——
    const swellF = ctx.createBiquadFilter();
    swellF.type = 'lowpass';
    swellF.frequency.value = 220;
    const swellG = ctx.createGain();
    swellG.gain.value = 0.22;
    mkNoise().connect(swellF).connect(swellG).connect(this.ambient);
    const swellLFO = ctx.createOscillator();
    swellLFO.frequency.value = 0.12;
    const swellLFOG = ctx.createGain();
    swellLFOG.gain.value = 0.12;
    swellLFO.connect(swellLFOG).connect(swellG.gain);
    swellLFO.start();
    this._scheduleGull();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  // ch: 'music' | 'ambient'
  setChannelVolume(ch, v) {
    if (ch === 'music') { this.volMusic = v; if (this.music) this.music.gain.value = v; }
    else if (ch === 'ambient') { this.volAmbient = v; if (this.ambient) this.ambient.gain.value = v; }
  }

  // 每帧驱动（awsKn 视风节，luff 0..1，speedKn 船速，planing 0..1）
  update(awsKn, luff, speedKn, planing) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const wind = Math.min(1, Math.pow(awsKn / 22, 1.6)) * 0.55;
    this.windGain.gain.setTargetAtTime(wind, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(380 + awsKn * 22, t, 0.3);
    const water = Math.min(1, Math.pow(speedKn / 9, 1.8)) * (0.28 + planing * 0.25);
    this.waterGain.gain.setTargetAtTime(water, t, 0.15);
    const luffAmt = luff * Math.min(1, awsKn / 12) * 0.5;
    this.luffGain.gain.setTargetAtTime(luffAmt * 0.5, t, 0.08);
    this.luffDepth.gain.setTargetAtTime(luffAmt * 0.45, t, 0.08);
    this.luffLFO.frequency.setTargetAtTime(7 + awsKn * 0.5, t, 0.2);
  }

  _burst(freq, dur, gain, type = 'lowpass') {
    if (!this.started) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start();
    src.stop(t + dur + 0.05);
  }

  gybeThunk() { this._burst(240, 0.16, 0.5); }
  splash() { this._burst(900, 0.9, 0.65); }
  spray() { this._burst(2400, 0.25, 0.12, 'highpass'); }

  // UI 点击音:短促低增益方波 blip
  click() { this.beep(660, 0.05, 0.12); }

  beep(freq = 880, dur = 0.12, gain = 0.25) {
    if (!this.started) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.sfx);
    o.start();
    o.stop(t + dur + 0.02);
  }

  chime() {
    this.beep(1175, 0.1, 0.18);
    setTimeout(() => this.beep(1568, 0.18, 0.18), 110);
  }

  // 海鸥:3.2k→2.2k 下滑 + 颤音,随机 8–25s 调度
  _scheduleGull() {
    if (!this.started) return;
    const delay = 8000 + Math.random() * 17000;
    this._gullTimer = setTimeout(() => {
      this._gull();
      this._scheduleGull();
    }, delay);
  }

  _gull() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const calls = 2 + (Math.random() * 3 | 0);
    for (let i = 0; i < calls; i++) {
      const t0 = t + i * 0.22;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(3200 + Math.random() * 400, t0);
      o.frequency.exponentialRampToValueAtTime(2200, t0 + 0.16);
      const vib = ctx.createOscillator();
      vib.frequency.value = 28;
      const vibG = ctx.createGain();
      vibG.gain.value = 120;
      vib.connect(vibG).connect(o.frequency);
      vib.start(t0); vib.stop(t0 + 0.2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.2);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 2600;
      f.Q.value = 3;
      o.connect(f).connect(g).connect(this.ambient);
      o.start(t0); o.stop(t0 + 0.22);
    }
  }

  // —— 菜单音乐:五声音阶音垫 + 琶音(仅菜单)——
  startMenuMusic() {
    if (!this.started || this._musicTimer) return;
    const scale = [0, 2, 4, 7, 9]; // 大调五声(半音)
    const root = 220; // A3
    const semis = (n) => root * Math.pow(2, n / 12);
    let step = 0;
    const beat = 0.5;
    const play = () => {
      if (!this.started || !this._musicTimer) return;
      const ctx = this.ctx;
      const t = ctx.currentTime + 0.05;
      // 每 8 拍换一次音垫根音
      if (step % 8 === 0) this._pad(semis(scale[(step / 8 | 0) % scale.length] - 12), beat * 8);
      // 琶音音符
      const deg = scale[(step * 2 + (step / 3 | 0)) % scale.length];
      const oct = step % 4 === 3 ? 12 : 0;
      this._pluck(semis(deg + oct), t);
      step++;
      this._musicTimer = setTimeout(play, beat * 1000);
    };
    this._musicTimer = setTimeout(play, 0);
  }

  stopMenuMusic() {
    if (this._musicTimer) { clearTimeout(this._musicTimer); this._musicTimer = null; }
  }

  _pad(freq, dur) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.6);
    g.gain.setTargetAtTime(0.0001, t + dur - 0.8, 0.4);
    g.connect(this.music);
    for (const detune of [-4, 4]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(g);
      o.start(t); o.stop(t + dur);
    }
  }

  _pluck(freq, t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.5);
    o.connect(g).connect(this.music);
    o.start(t); o.stop(t + 0.55);
  }
}
