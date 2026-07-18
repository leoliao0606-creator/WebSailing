// 程序化音效引擎（WebAudio，无外部素材）：
// 风声（带通噪声，随视风增强）、水流声（随船速）、空帆抖动、帆杠换舷闷响、
// 翻船水花、倒计时哔声、绕标提示音。

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.started = false;
  }

  // 需在用户手势后调用
  start() {
    if (this.started) return;
    this.started = true;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

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
    mkNoise().connect(this.windFilter).connect(this.windGain).connect(this.master);
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
    mkNoise().connect(this.waterFilter).connect(this.waterGain).connect(this.master);

    // —— 空帆抖动（脉冲噪声）——
    this.luffFilter = ctx.createBiquadFilter();
    this.luffFilter.type = 'bandpass';
    this.luffFilter.frequency.value = 160;
    this.luffFilter.Q.value = 1.4;
    this.luffGain = ctx.createGain();
    this.luffGain.gain.value = 0;
    mkNoise().connect(this.luffFilter).connect(this.luffGain).connect(this.master);
    this.luffLFO = ctx.createOscillator();
    this.luffLFO.type = 'square';
    this.luffLFO.frequency.value = 9;
    this.luffDepth = ctx.createGain();
    this.luffDepth.gain.value = 0;
    this.luffLFO.connect(this.luffDepth).connect(this.luffGain.gain);
    this.luffLFO.start();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
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
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(t + dur + 0.05);
  }

  gybeThunk() { this._burst(240, 0.16, 0.5); }
  splash() { this._burst(900, 0.9, 0.65); }
  spray() { this._burst(2400, 0.25, 0.12, 'highpass'); }

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
    o.connect(g).connect(this.master);
    o.start();
    o.stop(t + dur + 0.02);
  }

  chime() {
    this.beep(1175, 0.1, 0.18);
    setTimeout(() => this.beep(1568, 0.18, 0.18), 110);
  }
}
