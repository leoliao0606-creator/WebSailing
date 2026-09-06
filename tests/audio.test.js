import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioEngine } from '../src/game/audio.js';

// —— 最小 WebAudio 桩(stub:替身实现,只记录接线和参数,不真的出声) ——

// AudioParam(音频参数,例如增益节点的 gain):按 WebAudio 规范,它的实际值是
// "自己设定的值 + 所有连到它上面的信号"。setTargetAtTime 只改前一半,
// 所以桩必须同时记下谁连了进来(ins),否则测不到任何调制。
class FakeParam {
  constructor(v = 0) { this.value = v; this.ins = []; }
  setValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
}

function node(kind, extra = {}) {
  return {
    kind,
    outs: [],
    ins: [],
    connect(dest) {
      this.outs.push(dest);
      dest.ins?.push(this);
      return dest;
    },
    disconnect() { this.outs.length = 0; },
    ...extra,
  };
}

class FakeAudioContext {
  constructor() {
    this.sampleRate = 8000; // 测试用低采样率,噪声缓冲区生成得快
    this.currentTime = 0;
    this.destination = node('destination');
    this.created = [];
  }

  _track(n) { this.created.push(n); return n; }

  createGain() { return this._track(node('gain', { gain: new FakeParam(1) })); }

  createBiquadFilter() {
    return this._track(node('biquad', {
      type: 'lowpass',
      frequency: new FakeParam(350),
      Q: new FakeParam(1),
      detune: new FakeParam(0),
    }));
  }

  createOscillator() {
    return this._track(node('oscillator', {
      type: 'sine',
      frequency: new FakeParam(440),
      detune: new FakeParam(0),
      start() {}, stop() {},
    }));
  }

  createDynamicsCompressor() {
    return this._track(node('compressor', {
      threshold: new FakeParam(-24),
      knee: new FakeParam(30),
      ratio: new FakeParam(12),
      attack: new FakeParam(0.003),
      release: new FakeParam(0.25),
      reduction: 0,
    }));
  }

  createBufferSource() {
    return this._track(node('bufferSource', {
      buffer: null, loop: false, start() {}, stop() {},
    }));
  }

  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => data,
    };
  }

  resume() {}
}

// 信号峰值:振荡器和噪声源按 ±1 算;增益节点 = 上游峰值之和 × 自己的增益;
// 滤波器按不改变幅度算(实际上 Q 会带来小幅提升,所以这里得到的是个下界)。
function signalPeak(n, seen = new Set()) {
  if (!n || seen.has(n)) return 0;
  seen.add(n);
  if (n.kind === 'oscillator' || n.kind === 'bufferSource') return 1;
  const upstream = (n.ins || []).reduce((sum, u) => sum + signalPeak(u, seen), 0);
  return n.kind === 'gain' ? upstream * paramPeak(n.gain) : upstream;
}

// AudioParam 合成后的峰值 = 设定值 + 所有连进来的信号峰值。
function paramPeak(p) {
  return p.value + (p.ins || []).reduce((sum, u) => sum + signalPeak(u), 0);
}

// 沿 connect 边向下游走,判断 from 能不能走到 target
function reaches(from, target) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop();
    if (n === target) return true;
    if (!n || seen.has(n) || !n.outs) continue;
    seen.add(n);
    stack.push(...n.outs);
  }
  return false;
}

function startEngine(t) {
  globalThis.window = { AudioContext: FakeAudioContext };
  const engine = new AudioEngine();
  engine.start();
  t.after(() => {
    clearTimeout(engine._gullTimer);
    engine.stopMenuMusic();
    delete globalThis.window;
  });
  return engine;
}

test('四条总线各自汇入主音量,主音量接到输出', (t) => {
  const e = startEngine(t);
  for (const bus of [e.sfx, e.sea, e.ambient, e.music]) {
    assert.ok(reaches(bus, e.master), '总线没有接到 master');
  }
  assert.ok(reaches(e.master, e.ctx.destination));
});

test('噪声缓冲区归一化,不会超出 -1..1 被削波', (t) => {
  const e = startEngine(t);
  const data = e._noiseBuf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  assert.ok(peak <= 0.9 + 1e-6, `峰值 ${peak} 超出 0.9`);
  assert.ok(peak > 0.5, '归一化后峰值过小,噪声几乎没有能量');
});

test('海浪链路走带通 + 低通,不再用高通放行全部高频', (t) => {
  const e = startEngine(t);
  assert.equal(e.waterBand.type, 'bandpass');
  assert.equal(e.waterTone.type, 'lowpass');
  assert.ok(e.waterTone.frequency.value <= 1500, '静止时低通截止不应超过 1.5 kHz');
});

test('海浪声走 SEA 总线,可被独立调节', (t) => {
  const e = startEngine(t);
  assert.ok(reaches(e.waterGain, e.sea), '劈水声没接到 sea 总线');
  assert.ok(reaches(e.swellGain, e.sea), '涌浪没接到 sea 总线');
  assert.ok(reaches(e.surfGain, e.sea), '拍岸冲刷没接到 sea 总线');
  assert.ok(!reaches(e.waterGain, e.sfx), '劈水声不应挂在 sfx 总线上');
});

test('水花走 SEA 总线,换舷闷响走 SFX 总线', (t) => {
  const e = startEngine(t);
  let mark = e.ctx.created.length;
  e.splash();
  const splashNodes = e.ctx.created.slice(mark);
  assert.ok(splashNodes.some((n) => reaches(n, e.sea)));
  assert.ok(!splashNodes.some((n) => reaches(n, e.sfx)));

  mark = e.ctx.created.length;
  e.gybeThunk();
  assert.ok(e.ctx.created.slice(mark).some((n) => reaches(n, e.sfx)));
});

test('极端船速下水声增益和亮度都有封顶', (t) => {
  const e = startEngine(t);
  e.update(60, 1, 40, 1); // 视风 60 节、满空帆、船速 40 节、全滑行:远超正常范围
  // 冲刷起伏的 LFO 是连到 waterGain.gain 上的,按规范它和设定值相加。
  // 只看 gain.value 会漏掉调制那一半,所以这里断言合成后的峰值。
  assert.ok(e.waterGain.gain.value <= 0.80 + 1e-9, `水声设定增益 ${e.waterGain.gain.value} 过大`);
  const waterPeak = paramPeak(e.waterGain.gain);
  assert.ok(waterPeak > e.waterGain.gain.value, '调制没被计入,测试桩失效了');
  assert.ok(waterPeak <= 1.05, `水声峰值增益 ${waterPeak} 过大`);
  // 2 kHz 起是人耳最敏感、最容易听累的区间,低通必须把船速带来的提亮封在这附近
  assert.ok(e.waterTone.frequency.value <= 2300, `低通截止 ${e.waterTone.frequency.value} 过高`);
  assert.ok(e.waterBand.frequency.value <= 950, `带通中心 ${e.waterBand.frequency.value} 过高`);
});

test('SEA 总线三路相加会超过满刻度,由末级限制器兜住', (t) => {
  const e = startEngine(t);
  e.update(60, 1, 40, 1);
  // 劈水声(含冲刷调制) + 涌浪 + 拍岸,三路在 SEA 总线上是相加的
  const sum = paramPeak(e.waterGain.gain)
    + paramPeak(e.swellGain.gain)
    + paramPeak(e.surfGain.gain);
  assert.ok(sum > 1, `SEA 总线峰值和 ${sum} 没超过 1,这条测试的前提不成立了`);
  // 超过 1 就会削波,所以主音量后面必须挂一级限制器,
  // 而且不能再留绕过它直达输出的连线。
  assert.equal(e.limiter.kind, 'compressor');
  assert.ok(e.master.outs.includes(e.limiter), 'master 没接到限制器');
  assert.ok(e.limiter.outs.includes(e.ctx.destination), '限制器没接到输出');
  assert.ok(!e.master.outs.includes(e.ctx.destination), 'master 还留着绕过限制器的直连');
  assert.ok(e.limiter.ratio.value >= 10, `压缩比 ${e.limiter.ratio.value} 太低,起不到限制作用`);
});

test('setChannelVolume 各改各的总线,互不串台', (t) => {
  const e = startEngine(t);
  // 这张表在测试里独立写死,不从 AudioEngine.CHANNELS 读。
  // 否则映射表本身写错时,测试会跟着一起错。
  const buses = { music: e.music, ambient: e.ambient, sea: e.sea, sfx: e.sfx };
  for (const ch of Object.keys(buses)) {
    for (const b of Object.values(buses)) b.gain.value = 0;
    e.setChannelVolume(ch, 0.33);
    for (const [name, b] of Object.entries(buses)) {
      const want = name === ch ? 0.33 : 0;
      assert.equal(b.gain.value, want, `设 ${ch} 时 ${name} 总线的增益是 ${b.gain.value}`);
    }
    assert.equal(e[AudioEngine.CHANNELS[ch].field], 0.33, `${ch} 的音量字段没更新`);
  }
  e.setChannelVolume('nope', 0.1);
  assert.equal(e.master.gain.value, e.volume);
});

test('未 start 时设置音量只记住数值,不抛错', () => {
  const e = new AudioEngine();
  e.setVolume(0.4);
  e.setChannelVolume('sea', 0.25);
  assert.equal(e.volume, 0.4);
  assert.equal(e.volSea, 0.25);
  e.update(12, 0, 5, 0); // 未启动应直接返回
});
