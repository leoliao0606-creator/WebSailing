// 程序化音效引擎（WebAudio，无外部素材）：
// 分四条总线 —— SFX（风/空帆/换舷/哔声/提示音 + UI 点击）、
// SEA（船体劈水声 + 低频涌浪 + 拍岸冲刷 + 水花）、
// 环境床（海鸥等点缀）、菜单音乐（五声音阶音垫 + 琶音）。
// 每条总线独立音量,统一汇入主音量。
//
// 音色原则:海浪相关的声音一律压掉 2 kHz 以上的成分。宽带白噪声在 2–5 kHz
// 的能量正是人耳最敏感、听久了最累的区段,用带通 + 低通串联把它削掉,
// 听感才接近"水"而不是"电视雪花"。

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.volMusic = 0.5;
    this.volAmbient = 0.6;
    this.volSea = 0.7;
    this.volSfx = 0.8;
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
    // 末级限制器(limiter:信号超过阈值就自动把增益压下去的动态处理器)。
    // SEA 总线上劈水声、涌浪、拍岸三路是相加的,劈水声本身带冲刷调制,
    // 峰值能到 1.04,volSea 和主音量再都拉满,和会超过满刻度 1.0。
    // 直接送到输出就会削波(clipping:波形顶部被削平,多出刺耳的高频谐波)——
    // 正是这套音色想避免的东西。阈值 -3 dB、压缩比 20:1 接近纯限制,
    // 正常音量下完全不介入,只在快撞顶时兜底。
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.master.connect(this.limiter).connect(ctx.destination);

    // —— 四条总线 ——
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.volSfx;
    this.sfx.connect(this.master);
    this.sea = ctx.createGain();
    this.sea.gain.value = this.volSea;
    this.sea.connect(this.master);
    this.ambient = ctx.createGain();
    this.ambient.gain.value = this.volAmbient;
    this.ambient.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = this.volMusic;
    this.music.connect(this.master);

    // 共享噪声源:8 秒循环,循环周期长到听不出重复
    this._noiseBuf = this._makeNoiseBuffer(8);

    // —— 风 ——
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 480;
    this.windFilter.Q.value = 0.8;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this._noise().connect(this.windFilter).connect(this.windGain).connect(this.sfx);
    this._lfo(0.23, 120, this.windFilter.frequency);

    // —— 船体劈水声 ——
    // 带通(bandpass:只让中心频率附近的一段通过,两头都压掉)挑出中低频的
    // "哗哗"声,再串一级低通(lowpass:只让截止频率以下通过)把残留的高频
    // 嘶声压掉。Q 值控制带通那一段的宽窄:越大越窄、音色越尖,这里取 0.7
    // 是很宽的一段,听起来才像一片水声而不是一个哨音。
    // 参数经 A 计权(A-weighting:人耳各频率敏感度的标准加权)核算:满速时
    // 2 kHz 以上的能量只剩旧版(高通 1 kHz)的 1.6%,感知响度低约 9 dB。
    this.waterBand = ctx.createBiquadFilter();
    this.waterBand.type = 'bandpass';
    this.waterBand.frequency.value = 340;
    this.waterBand.Q.value = 0.7;
    this.waterTone = ctx.createBiquadFilter();
    this.waterTone.type = 'lowpass';
    this.waterTone.frequency.value = 1400;
    this.waterTone.Q.value = 0.7;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    this._noise()
      .connect(this.waterBand)
      .connect(this.waterTone)
      .connect(this.waterGain)
      .connect(this.sea);
    // 冲刷起伏:让水声一波一波,而不是一条恒定的噪声
    this.waterSwash = ctx.createOscillator();
    this.waterSwash.frequency.value = 0.42;
    this.waterSwashDepth = ctx.createGain();
    this.waterSwashDepth.gain.value = 0;
    this.waterSwash.connect(this.waterSwashDepth).connect(this.waterGain.gain);
    this.waterSwash.start();

    // —— 空帆抖动（脉冲噪声）——
    this.luffFilter = ctx.createBiquadFilter();
    this.luffFilter.type = 'bandpass';
    this.luffFilter.frequency.value = 160;
    this.luffFilter.Q.value = 1.4;
    this.luffGain = ctx.createGain();
    this.luffGain.gain.value = 0;
    this._noise().connect(this.luffFilter).connect(this.luffGain).connect(this.sfx);
    this.luffLFO = ctx.createOscillator();
    this.luffLFO.type = 'square';
    this.luffLFO.frequency.value = 9;
    this.luffDepth = ctx.createGain();
    this.luffDepth.gain.value = 0;
    this.luffLFO.connect(this.luffDepth).connect(this.luffGain.gain);
    this.luffLFO.start();

    // —— 低频涌浪:船身随浪起伏的闷响底噪 ——
    const swellF = ctx.createBiquadFilter();
    swellF.type = 'lowpass';
    swellF.frequency.value = 150;
    swellF.Q.value = 0.6;
    this.swellGain = ctx.createGain();
    this.swellGain.gain.value = 0.2;
    this._noise().connect(swellF).connect(this.swellGain).connect(this.sea);
    this._lfo(0.061, 0.07, this.swellGain.gain);

    // —— 拍岸冲刷:两个周期互不成整数倍的慢 LFO 叠加,避免机械的固定节拍 ——
    const surfBand = ctx.createBiquadFilter();
    surfBand.type = 'bandpass';
    surfBand.frequency.value = 340;
    surfBand.Q.value = 0.5;
    const surfTone = ctx.createBiquadFilter();
    surfTone.type = 'lowpass';
    surfTone.frequency.value = 1100;
    this.surfGain = ctx.createGain();
    this.surfGain.gain.value = 0.085;
    this._noise().connect(surfBand).connect(surfTone).connect(this.surfGain).connect(this.sea);
    this._lfo(0.083, 0.055, this.surfGain.gain);
    this._lfo(0.037, 0.03, this.surfGain.gain);

    this._scheduleGull();
  }

  // 粉噪声(pink noise:能量随频率升高而下降,听感比白噪声柔和)。
  // Paul Kellet 三极点近似;生成后按实测峰值归一化到 ±0.9,
  // 避免采样值超出 -1..1 被削波(clipping,波形顶部削平会多出刺耳的高频谐波)。
  _makeNoiseBuffer(seconds) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let peak = 1e-6;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      const v = b0 + b1 + b2 + w * 0.1848;
      d[i] = v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const k = 0.9 / peak;
    for (let i = 0; i < len; i++) d[i] *= k;
    return buf;
  }

  // 循环噪声源。每路给一个随机起播偏移,几条声音就不会同相叠加成很窄的音色。
  _noise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.start(0, Math.random() * (this._noiseBuf.duration || 0));
    return src;
  }

  // 低频振荡器(LFO, low-frequency oscillator:每秒振动不到一次的正弦波,
  // 慢到听不成音高,只用来推着别的参数缓慢变化)。
  // 把 target 这个参数在 ±depth 范围内来回推。
  _lfo(freq, depth, target) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(target);
    o.start();
    return o;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  // 通道名 -> (存音量的字段, 对应的总线节点属性)。两个名字都写出来:
  // 以前节点是靠"通道名恰好等于属性名"隐式找到的,改个属性名就会变成
  // 音量存得进、读得出、就是不生效,而且很难看出来。
  static CHANNELS = {
    music: { field: 'volMusic', node: 'music' },
    ambient: { field: 'volAmbient', node: 'ambient' },
    sea: { field: 'volSea', node: 'sea' },
    sfx: { field: 'volSfx', node: 'sfx' },
  };

  setChannelVolume(ch, v) {
    const spec = AudioEngine.CHANNELS[ch];
    if (!spec) return;
    this[spec.field] = v;
    const bus = this[spec.node];
    if (bus) bus.gain.value = v;
  }

  // 每帧驱动（awsKn 视风节，luff 0..1，speedKn 船速，planing 0..1）
  update(awsKn, luff, speedKn, planing) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const wind = Math.min(1, Math.pow(awsKn / 22, 1.6)) * 0.5;
    this.windGain.gain.setTargetAtTime(wind, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(380 + awsKn * 22, t, 0.3);

    // 音色随船速变亮,但带通中心封在 900 Hz 附近、低通封在 2.2 kHz,
    // 船再快也不会滑进 2–5 kHz 那段最扎耳朵的区间。速度按 12 节封顶,
    // 免得极端物理数值把频率推上去。
    const sp = Math.min(speedKn, 12);
    const water = Math.min(1, Math.pow(speedKn / 9, 1.8)) * (0.45 + planing * 0.35);
    this.waterGain.gain.setTargetAtTime(water, t, 0.25);
    this.waterBand.frequency.setTargetAtTime(340 + sp * 47, t, 0.4);
    this.waterTone.frequency.setTargetAtTime(1400 + sp * 67, t, 0.4);
    this.waterSwashDepth.gain.setTargetAtTime(water * 0.3, t, 0.3);
    this.waterSwash.frequency.setTargetAtTime(0.3 + sp * 0.06, t, 0.5);

    const luffAmt = luff * Math.min(1, awsKn / 12) * 0.5;
    this.luffGain.gain.setTargetAtTime(luffAmt * 0.5, t, 0.08);
    this.luffDepth.gain.setTargetAtTime(luffAmt * 0.45, t, 0.08);
    this.luffLFO.frequency.setTargetAtTime(7 + awsKn * 0.5, t, 0.2);
  }

  // 一次性的噪声爆发:低通挑出频段,增益从 gain 指数衰减到近零。
  // freq 就是低通截止频率,各调用点自己保证它在 2 kHz 原则之内。
  _burst(freq, dur, gain, bus = null) {
    if (!this.started) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(bus || this.sfx);
    src.start(0, Math.random() * (this._noiseBuf.duration || 0));
    src.stop(t + dur + 0.05);
  }

  gybeThunk() { this._burst(240, 0.16, 0.42); }
  splash() { this._burst(520, 1.1, 0.4, this.sea); }

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
